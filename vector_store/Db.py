from langchain_community.vectorstores import Chroma
from dotenv import load_dotenv
from langchain_google_genai import GoogleGenerativeAIEmbeddings

load_dotenv()

from langchain_core.documents import Document
docs = [
    Document(page_content="Python is widely used in Artificial Intelligence.",metadata={"source": "python.txt"}),
    Document(page_content="Pandas is used for data analysis in Python.",metadata={"source": "pandas.txt"}),
    Document(page_content="Neural networks are used in deep learning.",metadata={"source": "deep_learning.txt"})
]

embedding_model=GoogleGenerativeAIEmbeddings(
    model="gemini-embedding-2"
)

vectorstor=Chroma.from_documents(
    documents=docs,
    embedding=embedding_model,
    persist_directory="chroma-db"
)

result = vectorstor.similarity_search("what are nueral networks",k=2)

for r in result:
    print(r)