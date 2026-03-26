/**
 * memory/embed.ts — Embedding provider wrapper
 * 
 * Primary: Local BGE-base server (scripts/embed_server.py on GPU)
 * 
 * The local server runs on http://localhost:11435 and serves BGE-base 
 * embeddings on the GPU, bypassing the AVX requirement on older CPUs.
 * Gemini fallback is DISABLED to prevent vector space inconsistencies.
 */

import { EMBEDDING_DIM } from "./db.js";

// ── Configuration ───────────────────────────────────────────────────

const EMBED_HOST = process.env["EMBED_SERVER_URL"] ?? "127.0.0.1";
const EMBED_PORT = process.env["EMBED_SERVER_PORT"] ?? "11435";
const LOCAL_EMBED_URL = `http://${EMBED_HOST}:${EMBED_PORT}`;
let _useLocal: boolean | null = null; // null = not checked yet

// ── Local server health check ───────────────────────────────────────

async function checkLocalServer(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${LOCAL_EMBED_URL}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
            const data = await res.json() as any;
            if (_useLocal !== true) {
                console.log(`🧠 Local BGE-base embeddings connected (${data.device}, dim=${data.dimension})`);
                _useLocal = true;
            }
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Check if local embedding server is running.
 */
export async function isLocalEmbeddingAvailable(): Promise<boolean> {
    if (_useLocal === true) return true;
    const available = await checkLocalServer();
    if (available) _useLocal = true;
    return available;
}


/** Re-check local server availability (e.g. after startup delay). */
export function refreshLocalAvailability(): void {
    _useLocal = null;
}

// ── Local embedding calls ───────────────────────────────────────────

async function embedLocal(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${LOCAL_EMBED_URL}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Local embed server error ${res.status}: ${err}`);
    }

    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings.map(e => new Float32Array(e));
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Embed a single text string.
 * Returns a Float32Array of EMBEDDING_DIM dimensions.
 */
export async function embed(text: string): Promise<Float32Array> {
    if (await isLocalEmbeddingAvailable()) {
        const results = await embedLocal([text]);
        return results[0];
    }
    throw new Error("EMBED_SERVER_NOT_READY");
}

/**
 * Embed multiple texts. Uses local server batch if available.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (await isLocalEmbeddingAvailable()) {
        return await embedLocal(texts);
    }
    throw new Error("EMBED_SERVER_NOT_READY");
}

/**
 * Convert Float32Array to a Buffer for sqlite-vec storage.
 * sqlite-vec expects little-endian float32 bytes.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
