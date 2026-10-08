from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter

data=PyPDFLoader("/home/masaladosa/Rag_project/notes.pdf")
docs=data.load()

splitter = RecursiveCharacterTextSplitter(
    chunk_size=10,
    chunk_overlap=10
)

chunks=splitter.split_documents(docs)

print(docs[0].page_content)