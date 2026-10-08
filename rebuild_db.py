"""
Rebuild / resume the vector store with Gemini embeddings.
Skips chunks already indexed, so it is safe to re-run.
Throttled to stay under the free-tier rate limit (100 req/min).
"""
import time
from pathlib import Path

from dotenv import load_dotenv
from langchain_community.document_loaders import PyPDFLoader
from langchain_community.vectorstores import Chroma
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_text_splitters import RecursiveCharacterTextSplitter

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
CHROMA_DIR = str(BASE_DIR / "chroma-db")
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

embedding_model = GoogleGenerativeAIEmbeddings(model="gemini-embedding-2")

vectorstore = Chroma(
    embedding_function=embedding_model,
    persist_directory=CHROMA_DIR,
)

splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=100)

BATCH = 16       # texts per embedding request
DELAY = 0.8      # seconds between requests (~75 req/min, under the 100/min cap)


def already_indexed(path):
    """Count chunks for a given source file (exact full path)."""
    try:
        res = vectorstore.get(where={"source": str(path)})
        return len(res["ids"]) if res and res["ids"] else 0
    except Exception:
        return 0


def add_with_retry(docs):
    for attempt in range(8):
        try:
            time.sleep(DELAY)
            vectorstore.add_documents(docs)
            return
        except Exception as e:
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                wait = 25 * (attempt + 1)
                print(f"  rate-limited, waiting {wait}s...", flush=True)
                time.sleep(wait)
            else:
                raise


pdfs = sorted(BASE_DIR.glob("*.pdf")) + sorted(UPLOAD_DIR.glob("*.pdf"))

total_chunks = 0
for pdf in pdfs:
    print(f"Loading {pdf.name}...", flush=True)
    docs = PyPDFLoader(str(pdf)).load()
    chunks = splitter.split_documents(docs)
    done = already_indexed(pdf)

    if done >= len(chunks):
        print(f"  already indexed ({done}/{len(chunks)}), skipping", flush=True)
        total_chunks += len(chunks)
        continue

    print(f"  {len(docs)} pages -> {len(chunks)} chunks ({done} already done)", flush=True)

    for i in range(done, len(chunks), BATCH):
        batch = chunks[i : i + BATCH]
        add_with_retry(batch)
        n = min(i + BATCH, len(chunks))
        print(f"  indexed {n}/{len(chunks)}", flush=True)

    total_chunks += len(chunks)

print(f"\nDone. {len(pdfs)} PDFs, {total_chunks} chunks total.", flush=True)
