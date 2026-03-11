/**
 * memory/embed.ts — Embedding provider wrapper
 * 
 * Primary: Local BGE-base server (scripts/embed_server.py on GPU)
 * Fallback: Gemini `gemini-embedding-001` API (768→1024 via outputDimensionality)
 * 
 * The local server runs on http://localhost:11435 and serves BGE-base 
 * embeddings on the GPU, bypassing the AVX requirement on older CPUs.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config.js";
import { EMBEDDING_DIM } from "./db.js";

// ── Configuration ───────────────────────────────────────────────────

const LOCAL_EMBED_URL = process.env["EMBED_SERVER_URL"] ?? "http://127.0.0.1:11435";
let _useLocal: boolean | null = null; // null = not checked yet
let _loggedProvider = false;

// ── Gemini fallback setup ───────────────────────────────────────────

const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

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
    // If we're already using local, return true
    if (_useLocal === true) return true;

    // If we haven't checked or we were previously using Gemini, try to (re)connect local
    const available = await checkLocalServer();
    
    if (!available && _useLocal === null) {
        // Only log fallback message once
        console.log("⚠️  Local embedding server not ready — using Gemini API fallback");
        _useLocal = false;
    }
    
    return available;
}

/** Re-check local server availability (e.g. after startup delay). */
export function refreshLocalAvailability(): void {
    _useLocal = null;
    _loggedProvider = false;
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

// ── Gemini embedding calls ──────────────────────────────────────────

async function embedGemini(text: string): Promise<Float32Array> {
    const result = await geminiModel.embedContent({
        content: { parts: [{ text }], role: "user" },
        outputDimensionality: EMBEDDING_DIM,
    } as any);
    return new Float32Array(result.embedding.values);
}

async function embedBatchGemini(texts: string[]): Promise<Float32Array[]> {
    const BATCH_SIZE = 20;
    const allEmbeddings: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const requests = batch.map(text => ({
            content: { parts: [{ text }], role: "user" as const },
            outputDimensionality: EMBEDDING_DIM,
        }));

        let retryCount = 0;
        const maxRetries = 10;
        let success = false;

        while (retryCount < maxRetries && !success) {
            try {
                const result = await (geminiModel as any).batchEmbedContents({ requests });
                const embeddings = result.embeddings.map((e: any) => new Float32Array(e.values));
                allEmbeddings.push(...embeddings);
                success = true;
            } catch (error: any) {
                const isRateLimit = error.message?.includes("429") || error.message?.includes("Too Many Requests") || error.message?.includes("QUOTA_EXCEEDED");
                const isNetworkError = error.message?.includes("fetch failed") || error.message?.includes("ECONNRESET") || error.message?.includes("ETIMEOUT");

                if ((isRateLimit || isNetworkError) && retryCount < maxRetries - 1) {
                    const baseDelay = isRateLimit ? 10000 : 2000;
                    const delay = Math.pow(1.5, retryCount) * baseDelay + Math.random() * 2000;
                    console.warn(`${isRateLimit ? "Rate limit" : "Network error"} hit during batch embedding. Retrying in ${Math.round(delay / 1000)}s... (Attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    retryCount++;
                } else {
                    throw error;
                }
            }
        }
    }

    return allEmbeddings;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Embed a single text string.
 * Returns a Float32Array of EMBEDDING_DIM dimensions.
 */
export async function embed(text: string): Promise<Float32Array> {
    if (await isLocalEmbeddingAvailable()) {
        try {
            const results = await embedLocal([text]);
            return results[0];
        } catch (err) {
            console.warn("⚠️ Local embed failed, falling back to Gemini:", err);
            _useLocal = false;
        }
    }
    return embedGemini(text);
}

/**
 * Embed multiple texts. Uses local server batch if available.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    if (await isLocalEmbeddingAvailable()) {
        try {
            return await embedLocal(texts);
        } catch (err) {
            console.warn("⚠️ Local batch embed failed, falling back to Gemini:", err);
            _useLocal = false;
        }
    }
    return embedBatchGemini(texts);
}

/**
 * Convert Float32Array to a Buffer for sqlite-vec storage.
 * sqlite-vec expects little-endian float32 bytes.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
