from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_community.document_loaders import PyPDFLoader 
from langchain_core.prompts import ChatPromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_huggingface import HuggingFaceEndpointEmbeddings




load_dotenv()

embedding_model = HuggingFaceEndpointEmbeddings(
    model="Qwen/Qwen3-Embedding-0.6B",
    task="feature-extraction"
)

vectorstore=Chroma(
    persist_directory="/home/masaladosa/Rag_project/chroma-db",
    embedding_function=embedding_model
)

retriver=vectorstore.as_retriever(
    search_type="mmr",
    search_kwargs={
        "k":4,
        "fetch_k":10,
        "lambda_mult":0.5
    }
)


model = ChatGoogleGenerativeAI(
    model = "gemini-3.8-flash",
)

template = ChatPromptTemplate.from_messages([
    ("system",
    """You are a helpful AI assistant.
    Us ONLY the provided context to answer the question.
    If the answer is not present in the context, say:
    "I could not find the answer in the document."
    """
    ),
    ("human","""
    Context:{context}
    Question:{question}
    """
    )
])


print("RAG SYSTEM CREATED")
print("0 to exit the system")

while True:
    query=input("YOU : ")
    if query== "0":
        break

    docs=retriver.invoke(query)
    context="\n\n".join(
        [doc.page_content for doc in docs]
    )

    final_prompt=template.invoke({
        "context" : context,
        "question" : query
    })
    response=model.invoke(final_prompt)
    print(f"\n AI : {response.text}")