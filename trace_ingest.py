import sys
import os
import json
import http.client
import time

print("STEP 1: Imports", file=sys.stderr, flush=True)
import pypdf
from docx import Document as DocxDocument
from bs4 import BeautifulSoup

print("STEP 2: Starting extraction", file=sys.stderr, flush=True)
file_path = "D:/FILES/Code/AntiGravityClaw/workspace/collections/Articles/Chain_of_Draft.pdf"
with open(file_path, "rb") as f:
    reader = pypdf.PdfReader(f)
    text = ""
    for i, page in enumerate(reader.pages):
        print(f"DEBUG: Extracting page {i+1}", file=sys.stderr, flush=True)
        text += (page.extract_text() or "") + "\n"

print(f"STEP 3: Text length = {len(text)}", file=sys.stderr, flush=True)

def get_embeddings(texts):
    print(f"DEBUG: Requesting embeddings for {len(texts)} texts", file=sys.stderr, flush=True)
    conn = http.client.HTTPConnection("127.0.0.1", 11435, timeout=30)
    body = json.dumps({"texts": texts})
    conn.request("POST", "/embed", body, {"Content-Type": "application/json"})
    res = conn.getresponse()
    print(f"DEBUG: Response status = {res.status}", file=sys.stderr, flush=True)
    data = json.loads(res.read().decode())
    return data["embeddings"]

blocks = [b.strip() for b in text.replace("\r", "").split("\n") if b.strip()]
print(f"STEP 4: Blocks = {len(blocks)}", file=sys.stderr, flush=True)

if blocks:
    embeddings = get_embeddings(blocks[:5]) # just test 5 blocks
    print(f"STEP 5: Embeddings received", file=sys.stderr, flush=True)

print("STEP 6: SUCCESS", file=sys.stderr, flush=True)
