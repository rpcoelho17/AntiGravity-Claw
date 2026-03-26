#!/usr/bin/env python3
"""
scripts/ingest.py — Document ingestion script (Direct-to-SQLite)

Extracts text, chunks with structural splitter, embeds via local GPU server,
and writes chunks + embeddings directly to memory.db.

No temp files, no JSON handoff. Python does the full pipeline.

Usage:
  python ingest.py <file_path> --db <path_to_memory.db> --collection <name> --vec-ext <path_to_vec0.dll>
"""

import sys
import os
import json
import http.client
import time
import re
import struct
import sqlite3

# ── Global Metadata (Populated from server) ──────────────────────────
EMBED_SERVER_URL = os.environ.get("EMBED_SERVER_URL", "127.0.0.1")
EMBED_SERVER_PORT = int(os.environ.get("EMBED_SERVER_PORT", "11435"))
MODEL_MAX_SEQ_LENGTH = 512
MODEL_DIMENSION = 768

# ── Target ratios for chunking ───────────────────────────────────────
# We aim for ~80% of max context to leave room for overhead/templates
TARGET_RATIO = 0.7 
MAX_RATIO = 0.9

# These will be calculated dynamically based on MODEL_MAX_SEQ_LENGTH
TARGET_CHUNK_SIZE = 1200    # Default chars (approx 300 tokens)
MAX_CHUNK_SIZE = 1800       # Default hard max
MIN_CHUNK_SIZE = 80         # Static minimum
OVERLAP_SIZE = 100          # Static overlap

# ── Text Extraction ──────────────────────────────────────────────────

try:
    import pypdf
    from docx import Document as DocxDocument
    from bs4 import BeautifulSoup
except ImportError:
    print("WARN: Missing extraction libraries (pypdf, python-docx, or beautifulsoup4)", file=sys.stderr)

def fetch_model_metadata():
    """Query the embedding server for model capabilities."""
    global TARGET_CHUNK_SIZE, MAX_CHUNK_SIZE, MODEL_MAX_SEQ_LENGTH, MODEL_DIMENSION
    print(f"INFO: Fetching model metadata from {EMBED_SERVER_URL}:{EMBED_SERVER_PORT}...", file=sys.stderr)
    try:
        conn = http.client.HTTPConnection(EMBED_SERVER_URL, EMBED_SERVER_PORT, timeout=5)
        conn.request("GET", "/health")
        res = conn.getresponse()
        if res.status == 200:
            data = json.loads(res.read().decode())
            MODEL_MAX_SEQ_LENGTH = data.get("max_seq_length", 512)
            MODEL_DIMENSION = data.get("dimension", 768)
            
            # Heuristic: 1 token is roughly 4 characters in English
            # We scale our character-based chunking accordingly
            TARGET_CHUNK_SIZE = int(MODEL_MAX_SEQ_LENGTH * 4 * TARGET_RATIO)
            MAX_CHUNK_SIZE = int(MODEL_MAX_SEQ_LENGTH * 4 * MAX_RATIO)
            
            print(f"SUCCESS: Model '{data.get('model')}' detected.", file=sys.stderr)
            print(f"         Context: {MODEL_MAX_SEQ_LENGTH} tokens", file=sys.stderr)
            print(f"         Dynamically set TARGET_CHUNK_SIZE={TARGET_CHUNK_SIZE} chars", file=sys.stderr)
        conn.close()
    except Exception as e:
        print(f"WARN: Could not fetch metadata ({e}). Using defaults.", file=sys.stderr)

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

def get_embeddings(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    """Call the persistent embedding server in batches."""
    all_embeddings = []
    batch_size = 32
    
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(texts) + batch_size - 1) // batch_size
        print(f"EMBEDDING: Batch {batch_num}/{total_batches} ({len(batch)} chunks)...", file=sys.stderr, flush=True)
        
        try:
            conn = http.client.HTTPConnection(EMBED_SERVER_URL, EMBED_SERVER_PORT, timeout=1200)
            body = json.dumps({"texts": batch})
            conn.request("POST", "/embed", body, {"Content-Type": "application/json"})
            res = conn.getresponse()
            body_str = res.read().decode()
            if res.status != 200:
                raise Exception(f"Server error: {res.status} {body_str}")
            
            data = json.loads(body_str)
            all_embeddings.extend(data["embeddings"])
            conn.close()
        except Exception as e:
            print(f"ERROR: Embedding server error: {e}", file=sys.stderr, flush=True)
            raise
            
    return all_embeddings

# ── Structural Chunking ─────────────────────────────────────────────

# Patterns that indicate section/heading boundaries
HEADING_PATTERNS = [
    re.compile(r'^#{1,6}\s'),                           # Markdown headers
    re.compile(r'^[A-Z][A-Z\s]{4,}$'),                  # ALL CAPS lines (5+ chars)
    re.compile(r'^\d+(\.\d+)*\.?\s+[A-Z]'),             # Numbered headings: "1.2 Title"
    re.compile(r'^(Chapter|Section|Part|Appendix)\s', re.I),  # Named sections
    re.compile(r'^(CHAPTER|SECTION|PART|APPENDIX)\s'),   # ALL CAPS named sections
]

def is_heading(line):
    """Check if a line looks like a section heading."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    return any(p.match(stripped) for p in HEADING_PATTERNS)

def split_at_sentences(text, max_size):
    """Split a large text block at sentence boundaries to stay under max_size."""
    sentence_ends = re.compile(r'(?<=[.!?])\s+(?=[A-Z])')
    sentences = sentence_ends.split(text)
    
    chunks = []
    current = []
    current_len = 0
    
    for sent in sentences:
        if current_len + len(sent) > max_size and current:
            chunks.append(" ".join(current))
            current = [sent]
            current_len = len(sent)
        else:
            current.append(sent)
            current_len += len(sent) + 1
    
    if current:
        chunks.append(" ".join(current))
    
    return chunks

def structural_chunking(text):
    """
    Split text into chunks using document structure signals.
    No embedding calls needed — pure text analysis.
    """
    # Split into paragraphs (double newline or form feed)
    raw_paragraphs = re.split(r'\n\s*\n|\f', text)
    raw_paragraphs = [p.strip() for p in raw_paragraphs if p.strip()]
    
    print(f"CHUNKING: {len(raw_paragraphs)} paragraphs detected", file=sys.stderr, flush=True)
    
    chunks = []
    current_chunk = []
    current_len = 0
    
    for para in raw_paragraphs:
        # Check for heading — start new chunk
        lines = para.split('\n')
        starts_with_heading = is_heading(lines[0])
        
        if starts_with_heading and current_chunk:
            # Flush current chunk
            chunk_text = "\n\n".join(current_chunk).strip()
            if len(chunk_text) >= MIN_CHUNK_SIZE:
                chunks.append(chunk_text)
            current_chunk = [para]
            current_len = len(para)
        elif current_len + len(para) > TARGET_CHUNK_SIZE and current_chunk:
            # Current chunk is big enough, flush and start new
            chunk_text = "\n\n".join(current_chunk).strip()
            if len(chunk_text) >= MIN_CHUNK_SIZE:
                chunks.append(chunk_text)
            current_chunk = [para]
            current_len = len(para)
        else:
            current_chunk.append(para)
            current_len += len(para) + 2
    
    # Flush remaining
    if current_chunk:
        chunk_text = "\n\n".join(current_chunk).strip()
        if len(chunk_text) >= MIN_CHUNK_SIZE:
            chunks.append(chunk_text)
    
    # Split oversized chunks at sentence boundaries
    final_chunks = []
    for chunk in chunks:
        if len(chunk) > MAX_CHUNK_SIZE:
            sub_chunks = split_at_sentences(chunk, TARGET_CHUNK_SIZE)
            final_chunks.extend(sub_chunks)
        else:
            final_chunks.append(chunk)
    
    # Add overlap between consecutive chunks for retrieval continuity
    if OVERLAP_SIZE > 0 and len(final_chunks) > 1:
        overlapped = [final_chunks[0]]
        for i in range(1, len(final_chunks)):
            prev_tail = final_chunks[i - 1][-OVERLAP_SIZE:]
            overlapped.append(prev_tail + " " + final_chunks[i])
        final_chunks = overlapped
    
    print(f"CHUNKING: Created {len(final_chunks)} final chunks", file=sys.stderr, flush=True)
    
    # Now embed the final chunks
    if final_chunks:
        print(f"EMBEDDING: Embedding {len(final_chunks)} chunks via GPU server...", file=sys.stderr, flush=True)
        embeddings = get_embeddings(final_chunks)
    else:
        embeddings = []
    
    return final_chunks, embeddings

# ── Direct SQLite Storage ────────────────────────────────────────────

def embedding_to_bytes(values: list[float]) -> bytes:
    """Convert a list of floats to little-endian float32 bytes for sqlite-vec."""
    return struct.pack(f'<{len(values)}f', *values)

def store_in_db(db_path: str, vec_ext_path: str, file_name: str, collection: str, 
                text_preview: str, chunks: list[str], embeddings: list[list[float]]):
    """Open memory.db, load sqlite-vec, and insert chunks + embeddings directly."""
    
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.enable_load_extension(True)
    conn.load_extension(vec_ext_path)
    conn.enable_load_extension(False)
    
    cursor = conn.cursor()
    
    # Ensure tables exist (Python is self-sufficient — doesn't need Node to create them)
    dim = MODEL_DIMENSION
    cursor.executescript(f"""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            collection  TEXT NOT NULL,
            file_path   TEXT NOT NULL,
            description TEXT,
            status      TEXT DEFAULT 'pending',
            ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            chunk_count INTEGER DEFAULT 0,
            UNIQUE(name, collection)
        );

        CREATE TABLE IF NOT EXISTS memory (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT NOT NULL,
            channel     TEXT NOT NULL,
            doc_id      INTEGER REFERENCES documents(doc_id) ON DELETE CASCADE,
            chunk_text  TEXT NOT NULL,
            speaker     TEXT,
            embedding_status TEXT DEFAULT 'ok',
            timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    """)
    
    # Create vec0 table separately (executescript can't handle virtual tables well)
    try:
        cursor.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(embedding FLOAT[{dim}])")
    except Exception:
        pass  # Already exists

    # Migration: add status column if it doesn't exist (old schema)
    try:
        cursor.execute("SELECT status FROM documents LIMIT 0")
    except sqlite3.OperationalError:
        cursor.execute("ALTER TABLE documents ADD COLUMN status TEXT DEFAULT 'pending'")
    
    # Register or update document
    cursor.execute("""
        INSERT OR IGNORE INTO documents (name, collection, file_path, description, status)
        VALUES (?, ?, ?, ?, 'ingesting')
    """, (file_name, collection, os.path.join("collections", collection, file_name), text_preview[:500]))
    
    if cursor.rowcount == 0:
        # Document already exists — clear old data and re-ingest
        cursor.execute("SELECT doc_id FROM documents WHERE name = ? AND collection = ?", (file_name, collection))
        doc_id = cursor.fetchone()[0]
        cursor.execute("DELETE FROM memory WHERE doc_id = ?", (doc_id,))
        cursor.execute("UPDATE documents SET status = 'ingesting' WHERE doc_id = ?", (doc_id,))
    else:
        doc_id = cursor.lastrowid
    
    print(f"STORING: Inserting {len(chunks)} chunks into memory.db (doc_id={doc_id})...", file=sys.stderr, flush=True)
    
    # Insert chunks and embeddings in a transaction
    for i, (chunk, emb) in enumerate(zip(chunks, embeddings)):
        cursor.execute(
            "INSERT INTO memory (type, channel, doc_id, chunk_text, speaker) VALUES ('R', '__rag__', ?, ?, NULL)",
            (doc_id, chunk)
        )
        row_id = cursor.lastrowid
        emb_bytes = embedding_to_bytes(emb)
        cursor.execute(
            "INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)",
            (row_id, emb_bytes)
        )
    
    # Update document status
    cursor.execute("UPDATE documents SET chunk_count=?, status='ready' WHERE doc_id=?", (len(chunks), doc_id))
    
    conn.commit()
    conn.close()
    
    print(f"STORED: {len(chunks)} chunks + embeddings saved to DB", file=sys.stderr, flush=True)

# ── Main ─────────────────────────────────────────────────────────────

def main():
    try:
        print("DEBUG: Ingest script starting...", file=sys.stderr, flush=True)
        
        # Parse args
        if len(sys.argv) < 2:
            print(json.dumps({"error": "Usage: ingest.py <file_path> --db <db_path> --collection <name> --vec-ext <vec0_path>"}), flush=True)
            return
        
        # Parse named arguments
        file_path = sys.argv[1]
        db_path = None
        collection = "default"
        vec_ext_path = None
        
        i = 2
        while i < len(sys.argv):
            if sys.argv[i] == "--db" and i + 1 < len(sys.argv):
                db_path = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--collection" and i + 1 < len(sys.argv):
                collection = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--vec-ext" and i + 1 < len(sys.argv):
                vec_ext_path = sys.argv[i + 1]
                i += 2
            else:
                i += 1
        
        if not db_path:
            print(json.dumps({"error": "Missing --db argument"}), flush=True)
            return
        if not vec_ext_path:
            print(json.dumps({"error": "Missing --vec-ext argument"}), flush=True)
            return
        
        # Health check: is the embed server running?
        import socket
        try:
            sock = socket.create_connection((EMBED_SERVER_URL, EMBED_SERVER_PORT), timeout=2)
            sock.close()
            print(f"DEBUG: Embedding server is reachable", file=sys.stderr, flush=True)
        except (ConnectionRefusedError, TimeoutError, OSError) as e:
            error_msg = f"Embedding server not available at {EMBED_SERVER_URL}:{EMBED_SERVER_PORT} -- please start embed_server.py first. ({e})"
            print(json.dumps({"error": error_msg}), flush=True)
            print(f"ERROR: {error_msg}", file=sys.stderr, flush=True)
            return

        # Fetch metadata and adjust chunking
        fetch_model_metadata()

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

        extract_time = time.time() - start_time
        print(f"EXTRACTING: Done in {extract_time:.1f}s ({len(text)} chars)", file=sys.stderr, flush=True)

        chunks, embeddings = structural_chunking(text)
        
        if not chunks:
            print(json.dumps({"error": "No chunks produced"}), flush=True)
            return

        # Write directly to SQLite
        store_in_db(db_path, vec_ext_path, os.path.basename(file_path), collection, text[:5000], chunks, embeddings)
        
        elapsed = time.time() - start_time
        
        # Print success summary as JSON on stdout for Node to read
        result = {
            "status": "ok",
            "file_name": os.path.basename(file_path),
            "chunks": len(chunks),
            "time": round(elapsed, 1),
            "collection": collection
        }
        print(json.dumps(result), flush=True)
        print(f"SUCCESS: Finished in {elapsed:.1f}s ({len(chunks)} chunks)", file=sys.stderr, flush=True)

    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        print(f"ERROR: Error during ingestion: {e}", file=sys.stderr, flush=True)
        import traceback
        traceback.print_exc(file=sys.stderr)

if __name__ == "__main__":
    main()
