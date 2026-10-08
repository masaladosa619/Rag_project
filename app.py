"""
DocQuery — RAG-powered document Q&A web interface.

Run:
    python app.py
    → http://localhost:8000
"""

import asyncio
import json
import os
import shutil
import traceback
from pathlib import Path
from typing import AsyncGenerator

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_community.document_loaders import PyPDFLoader
from langchain_community.vectorstores import Chroma
from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel

load_dotenv()

# ── Paths ────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
CHROMA_DIR = str(BASE_DIR / "chroma-db")
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
STATIC_DIR = BASE_DIR / "static"

# ── LangChain components ────────────────────────────────────
embedding_model = GoogleGenerativeAIEmbeddings(model="gemini-embedding-2")

llm = ChatGoogleGenerativeAI(model="gemini-3.8-flash", streaming=True)

prompt_template = ChatPromptTemplate.from_messages([
    ("system",
     "You are a helpful AI assistant.\n"
     "Use ONLY the provided context to answer the question.\n"
     "If the answer is not in the context, say: "
     "\"I could not find the answer in the document.\""),
    ("human",
     "Context:\n{context}\n\nQuestion: {question}"),
])


def _vectorstore():
    return Chroma(persist_directory=CHROMA_DIR, embedding_function=embedding_model)


def _retriever():
    return _vectorstore().as_retriever(
        search_type="mmr",
        search_kwargs={"k": 4, "fetch_k": 10, "lambda_mult": 0.5},
    )


def _extract_text(content):
    """Gemini sometimes returns list[dict] instead of str — normalise."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            item.get("text", "") if isinstance(item, dict) else str(item)
            for item in content
        )
    return str(content)


def _format_size(n: int) -> str:
    if n >= 1_048_576:
        return f"{n / 1_048_576:.1f} MB"
    return f"{n / 1024:.0f} KB"


def _is_quota_error(e: Exception) -> bool:
    msg = str(e)
    return "429" in msg or "RESOURCE_EXHAUSTED" in msg or "rate" in msg.lower()


def _friendly_error(e: Exception) -> str:
    if _is_quota_error(e):
        return (
            "Embedding API quota exceeded. "
            "The free tier resets periodically — try again in a few minutes."
        )
    return "Something went wrong while generating a response."


async def _stream_response(question: str) -> AsyncGenerator[str, None]:
    """Stream the response token by token."""
    try:
        retriever = _retriever()
        docs = retriever.invoke(question)
        context = "\n\n".join(d.page_content for d in docs)

        # First send sources as a special event
        sources_data = [
            {
                "page": d.metadata.get("page", "—"),
                "source": Path(d.metadata.get("source", "")).name or "unknown",
                "snippet": d.page_content[:180],
            }
            for d in docs
        ]
        yield f"event: sources\ndata: {json.dumps(sources_data)}\n\n"

        # Stream the answer
        async for chunk in llm.astream(
            prompt_template.invoke({"context": context, "question": question})
        ):
            text = _extract_text(chunk.content) if chunk.content else ""
            if text:
                yield f"event: token\ndata: {text}\n\n"

        yield "event: done\ndata: \n\n"
    except Exception as e:
        traceback.print_exc()
        yield f"event: error\ndata: {_friendly_error(e)}\n\n"


# ── FastAPI ──────────────────────────────────────────────────
app = FastAPI(title="DocQuery")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class ChatRequest(BaseModel):
    question: str


class DeleteRequest(BaseModel):
    filename: str


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.post("/api/chat")
async def chat(req: ChatRequest):
    try:
        retriever = _retriever()
        docs = retriever.invoke(req.question)
        context = "\n\n".join(d.page_content for d in docs)

        response = llm.invoke(
            prompt_template.invoke({"context": context, "question": req.question})
        )

        return {
            "answer": _extract_text(response.content),
            "sources": [
                {
                    "page": d.metadata.get("page", "—"),
                    "source": Path(d.metadata.get("source", "")).name or "unknown",
                    "snippet": d.page_content[:180],
                }
                for d in docs
            ],
        }
    except Exception as e:
        traceback.print_exc()
        status = 429 if _is_quota_error(e) else 500
        raise HTTPException(status, _friendly_error(e))


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    return StreamingResponse(
        _stream_response(req.question),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported.")

    dest = UPLOAD_DIR / file.filename
    try:
        with open(dest, "wb") as f:
            shutil.copyfileobj(file.file, f)

        docs = PyPDFLoader(str(dest)).load()
        chunks = RecursiveCharacterTextSplitter(
            chunk_size=500, chunk_overlap=100
        ).split_documents(docs)

        vs = _vectorstore()
        # Throttled batches: each text is one embedding API call,
        # so we send 16 at a time with a delay to respect rate limits.
        for i in range(0, len(chunks), 16):
            for attempt in range(5):
                try:
                    await asyncio.sleep(0.8)
                    await asyncio.to_thread(vs.add_documents, chunks[i : i + 16])
                    break
                except Exception as inner:
                    if _is_quota_error(inner) and attempt < 4:
                        await asyncio.sleep(25 * (attempt + 1))
                    else:
                        raise

        return {
            "filename": file.filename,
            "pages": len(docs),
            "chunks": len(chunks),
        }
    except Exception as e:
        traceback.print_exc()
        status = 429 if _is_quota_error(e) else 500
        detail = (
            _friendly_error(e)
            if _is_quota_error(e)
            else f"Failed to process '{file.filename}'."
        )
        raise HTTPException(status, detail)


@app.get("/api/documents")
async def documents():
    seen = set()
    result = []

    # Root-level PDFs (sample docs, not deletable)
    for pdf in sorted(BASE_DIR.glob("*.pdf")):
        seen.add(pdf.name)
        result.append({
            "name": pdf.name,
            "size": _format_size(pdf.stat().st_size),
            "builtin": True,
        })

    # User-uploaded PDFs (deletable)
    for pdf in sorted(UPLOAD_DIR.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True):
        if pdf.name not in seen:
            result.append({
                "name": pdf.name,
                "size": _format_size(pdf.stat().st_size),
                "builtin": False,
            })

    return {"documents": result}


@app.delete("/api/documents/{filename}")
async def delete_document(filename: str):
    """Delete an uploaded document and its vectors from the database."""
    try:
        # Security: prevent path traversal
        filename = Path(filename).name

        # Only uploaded documents can be deleted, never the sample PDFs
        file_path = UPLOAD_DIR / filename
        if not file_path.is_relative_to(UPLOAD_DIR) or not file_path.exists():
            builtin = BASE_DIR / filename
            if builtin.exists() and builtin.suffix.lower() == ".pdf":
                raise HTTPException(
                    403, f"'{filename}' is a built-in document and can't be deleted."
                )
            raise HTTPException(404, f"Document '{filename}' not found")

        # Delete from vector store
        vs = _vectorstore()
        results = vs.get(where={"source": str(file_path)})
        if results and results["ids"]:
            vs.delete(ids=results["ids"])

        file_path.unlink()

        return {"success": True, "message": f"Deleted {filename}"}
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(500, f"Failed to delete document: {str(e)}")


# ── Run ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    print("\n  DocQuery running → http://localhost:8000\n")
    uvicorn.run(app, host="0.0.0.0", port=8000)