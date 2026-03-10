#!/usr/bin/env python3
"""
scripts/embed_server.py — Local BGE-M3 embedding HTTP server
Runs on CUDA (GPU) to bypass AVX requirement on older CPUs.
Serves POST /embed and GET /health on localhost:11435.
"""

import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Configuration ────────────────────────────────────────────────────

PORT = int(os.environ.get("EMBED_SERVER_PORT", "11435"))
MODEL_NAME = os.environ.get("EMBED_MODEL", "models/bge-base-en-v1.5")
DEVICE = None  # set after torch import

# ── Load model at startup ────────────────────────────────────────────

print(f"INFO: Loading {MODEL_NAME}...", flush=True)
start = time.time()

try:
    import torch
    from sentence_transformers import SentenceTransformer
except Exception as e:
    print(f"ERROR: FATAL ERROR during import: {e}", flush=True)
    import traceback
    traceback.print_exc()
    sys.exit(1)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cpu":
    print("WARN: CUDA not available — running on CPU (will be slow)", flush=True)
else:
    gpu_name = torch.cuda.get_device_name(0)
    vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
    print(f"GPU: Using GPU: {gpu_name} ({vram:.1f} GB VRAM)", flush=True)

model = SentenceTransformer(MODEL_NAME, device=DEVICE, local_files_only=True)
dim = model.get_sentence_embedding_dimension()
elapsed = time.time() - start
print(f"SUCCESS: Model loaded in {elapsed:.1f}s — dimension={dim}, device={DEVICE}", flush=True)

# ── HTTP Handler ─────────────────────────────────────────────────────

class EmbedHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default access logs (too noisy)
        pass

    def _send_json(self, code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "model": MODEL_NAME,
                "device": DEVICE,
                "dimension": dim
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body)

            texts = data.get("texts", [])
            if not texts or not isinstance(texts, list):
                self._send_json(400, {"error": "Missing or invalid 'texts' array"})
                return

            # Encode on GPU
            embeddings = model.encode(texts, convert_to_numpy=True, normalize_embeddings=True)

            # Return as nested list of floats
            self._send_json(200, {
                "embeddings": embeddings.tolist(),
                "dimension": dim,
                "count": len(texts)
            })

        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
        except Exception as e:
            print(f"ERROR: Embedding error: {e}", flush=True)
            self._send_json(500, {"error": str(e)})

# ── Main ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        server = HTTPServer(("127.0.0.1", PORT), EmbedHandler)
        print(f"INFO: Embedding server running on http://127.0.0.1:{PORT}", flush=True)
        print(f"   POST /embed  — {{\"texts\": [\"...\"]}}  →  {{\"embeddings\": [[...]]}}", flush=True)
        print(f"   GET  /health  — readiness check", flush=True)
        server.serve_forever()
    except Exception as e:
        print(f"ERROR: Server crash: {e}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nSTOP: Embedding server stopped.", flush=True)
        server.server_close()
