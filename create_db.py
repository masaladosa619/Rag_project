"""
load pdf
create chunks
create embeddings
store in vectordb
"""
from dotenv import load_dotenv
from langchain_community.vectorstores import Chroma
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_community.document_loaders import PyPDFLoader 
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_huggingface import HuggingFaceEndpointEmbeddings


load_dotenv()

data=PyPDFLoader("/home/masaladosa/Rag_project/deep_learning.pdf")
docs=data.load()

splitter=RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=100
)
chunks=splitter.split_documents(docs)

embedding_model = HuggingFaceEndpointEmbeddings(
    model="Qwen/Qwen3-Embedding-0.6B",
    task="feature-extraction"
)


vectorstor=Chroma(
    embedding_function=embedding_model,
    persist_directory="chroma-db"
)

for i in range(0, len(chunks), 500):

    batch = chunks[i:i+500]
    vectorstor.add_documents(batch)
    print(f"Added {i} → {i + len(batch)}")


