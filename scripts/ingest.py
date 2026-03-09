#!/usr/bin/env python3
"""
scripts/ingest.py — Document ingestion script
Extracts text and performs semantic chunking.
Calls the local BGE-M3 HTTP server for embeddings.
"""

import sys
import os
import json
import http.client
import time

# ── Configuration ────────────────────────────────────────────────────

EMBED_SERVER_URL = "127.0.0.1"
EMBED_SERVER_PORT = 11435

# ── Text Extraction ──────────────────────────────────────────────────

try:
    import pypdf
    from docx import Document as DocxDocument
    from bs4 import BeautifulSoup
except ImportError:
    print("WARN: Missing extraction libraries (pypdf, python-docx, or beautifulsoup4)", file=sys.stderr)

def extract_text(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    text = ""
    if ext == ".pdf":
        with open(file_path, "rb") as f:
            reader = pypdf.PdfReader(f)
            for page in reader.pages:
                text += (page.extract_text() or "") + "\n"
    elif ext == ".docx":
        doc = DocxDocument(file_path)
        for para in doc.paragraphs:
            text += para.text + "\n"
    elif ext in [".txt", ".md"]:
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                text = f.read()
        except UnicodeDecodeError:
            with open(file_path, "r", encoding="utf-16") as f:
                text = f.read()
    elif ext in [".html", ".htm"]:
        with open(file_path, "r", encoding="utf-8") as f:
            soup = BeautifulSoup(f.read(), "html.parser")
            text = soup.get_text()
    return text

# ── Local Embedding Client ───────────────────────────────────────────

def get_embeddings(texts):
    """Call the persistent embedding server in batches."""
    all_embeddings = []
    batch_size = 100
    
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        print(f"DEBUG: Embedding batch {i//batch_size + 1} ({len(batch)} texts)...", file=sys.stderr, flush=True)
        
        try:
            conn = http.client.HTTPConnection(EMBED_SERVER_URL, EMBED_SERVER_PORT, timeout=300)
            body = json.dumps({"texts": batch})
            conn.request("POST", "/embed", body, {"Content-Type": "application/json"})
            res = conn.getresponse()
            if res.status != 200:
                raise Exception(f"Server error: {res.status} {res.read().decode()}")
            
            data = json.loads(res.read().decode())
            all_embeddings.extend(data["embeddings"])
            conn.close()
        except Exception as e:
            print(f"ERROR: Embedding server error: {e}", file=sys.stderr, flush=True)
            raise
            
    return all_embeddings

# ── Semantic Chunking ────────────────────────────────────────────────

def semantic_chunking(text):
    """
    Split text based on topic transitions using the local embedding server.
    """
    # Simple split into lines/blocks
    blocks = [b.strip() for b in text.replace("\r", "").split("\n") if b.strip()]
    if not blocks:
        return [], []

    print(f"ANALYZING: Analyzing {len(blocks)} blocks for semantic transitions...", file=sys.stderr)

    # We need embeddings for each block to calculate transitions
    embeddings = get_embeddings(blocks)
    
    # Calculate similarities and find breaks
    import math

    def dot(a, b): return sum(x*y for x, y in zip(a, b))
    def mag(a): return math.sqrt(sum(x*x for x in a))
    def cos_sim(a, b): return dot(a, b) / (mag(a) * mag(b) + 1e-9)

    chunks = []
    current_chunk = [blocks[0]]
    current_len = len(blocks[0])

    for i in range(1, len(blocks)):
        sim = cos_sim(embeddings[i], embeddings[i-1])
        
        # Break if topic shifts (sim < 0.6) OR chunk is too large (1500 chars)
        if sim < 0.6 or current_len + len(blocks[i]) > 1500:
            chunks.append("\n".join(current_chunk))
            current_chunk = [blocks[i]]
            current_len = len(blocks[i])
        else:
            current_chunk.append(blocks[i])
            current_len += len(blocks[i]) + 1 # +1 for newline

    if current_chunk:
        chunks.append("\n".join(current_chunk))

    # Batch embed the final chunks
    print(f"INDEXING: Indexing {len(chunks)} final chunks...", file=sys.stderr)
    chunk_embeddings = get_embeddings(chunks)

    return chunks, chunk_embeddings

# ── Main ─────────────────────────────────────────────────────────────

def main():
    print("DEBUG: Ingest script starting...", file=sys.stderr, flush=True)
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"error": "No file path provided"}), flush=True)
            return

        file_path = sys.argv[1]
        print(f"DEBUG: Processing {file_path}", file=sys.stderr, flush=True)

        if not os.path.exists(file_path):
            print(json.dumps({"error": f"File not found: {file_path}"}), flush=True)
            return

        start_time = time.time()
        print(f"EXTRACTING: Extracting text from {os.path.basename(file_path)}...", file=sys.stderr, flush=True)
        text = extract_text(file_path)
        
        if not text.strip():
            print(json.dumps({"error": "No text extracted"}), flush=True)
            return

        chunks, embeddings = semantic_chunking(text)
        
        output = {
            "file_name": os.path.basename(file_path),
            "text": text,
            "chunks": chunks,
            "embeddings": embeddings
        }
        
        # Output ONLY JSON to stdout with explicit flush
        json_output = json.dumps(output)
        print(json_output, flush=True)
        
        elapsed = time.time() - start_time
        print(f"SUCCESS: Finished in {elapsed:.1f}s", file=sys.stderr, flush=True)

    except Exception as e:
        # Errors also go to JSON on stdout so Node can catch them properly
        print(json.dumps({"error": str(e)}), flush=True)
        print(f"ERROR: Error during ingestion: {e}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    main()
