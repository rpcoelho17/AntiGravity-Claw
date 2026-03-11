/**
 * memory/search.ts — Unified semantic search
 * 
 * Hybrid search: Vector (sqlite-vec) + BM25 (FTS5)
 * Merged via Reciprocal Rank Fusion with temporal decay.
 */

import { db, getSetting, getSettingNum, getChannelCollections } from "./db.js";
import { embed, embeddingToBuffer } from "./embed.js";
import { formatRecentMessages } from "./store.js";

// ── Types ───────────────────────────────────────────────────────────

export interface SearchResult {
    id: number;
    type: "M" | "R";
    channel: string;
    chunk_text: string;
    speaker: "U" | "A" | null;
    timestamp: string;
    distance: number;
    doc_name: string | null;
    file_path: string | null;
    collection: string | null;
    doc_id: number | null;
    // Contextual paragraphs for RAG chunks
    prev_paragraph: string | null;
    next_paragraph: string | null;
}

// ── Temporal Decay ──────────────────────────────────────────────────

/**
 * Returns a multiplier between 0 and 1.
 * Today = ~1.0. 90 days ago (default half-life) = ~0.37.
 * 1 year ago = ~0.06. Approaches but never reaches zero.
 * halfLifeDays=0 disables decay (always returns 1).
 */
function temporalDecay(timestamp: string, halfLifeDays: number): number {
    if (halfLifeDays <= 0) return 1.0;
    const ageMs = Date.now() - new Date(timestamp).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.exp(-ageDays / halfLifeDays);
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────

function reciprocalRankFusion(
    vectorResults: SearchResult[],
    bm25Results: SearchResult[],
    vectorWeight: number,
    bm25Weight: number,
    halfLifeDays: number,
    k = 60
): SearchResult[] {
    const scores = new Map<number, number>();

    vectorResults.forEach((r, rank) => {
        const decay = r.type === "M" ? temporalDecay(r.timestamp, halfLifeDays) : 1.0;
        scores.set(r.id, (scores.get(r.id) ?? 0) + vectorWeight * (1 / (k + rank + 1)) * decay);
    });

    bm25Results.forEach((r, rank) => {
        const decay = r.type === "M" ? temporalDecay(r.timestamp, halfLifeDays) : 1.0;
        scores.set(r.id, (scores.get(r.id) ?? 0) + bm25Weight * (1 / (k + rank + 1)) * decay);
    });

    // Deduplicate by id, keep the first occurrence
    const allById = new Map<number, SearchResult>();
    [...vectorResults, ...bm25Results].forEach(r => {
        if (!allById.has(r.id)) allById.set(r.id, r);
    });

    return [...allById.values()].sort(
        (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
    );
}

// ── Vector Search ───────────────────────────────────────────────────

function vectorSearch(
    queryBuffer: Buffer,
    channel: string,
    collections: string[] | undefined,
    topK: number,
    beforeId?: number
): SearchResult[] {
    // sqlite-vec requires raw vector query via MATCH syntax
    // We need to handle channel/collection filtering in application code
    // because sqlite-vec doesn't support complex WHERE with MATCH well.
    let sql = `
        SELECT
            m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
            e.distance,
            d.name AS doc_name, d.file_path, d.collection, d.doc_id
        FROM memory_embeddings e
        JOIN memory m ON m.id = e.rowid
        LEFT JOIN documents d ON d.doc_id = m.doc_id
        WHERE e.embedding MATCH ?
    `;

    const params: any[] = [queryBuffer];

    sql += ` AND k = CAST(? AS INTEGER) ORDER BY e.distance ASC `;
    // Fetch a larger pool because we do channel/collection/id filtering in JS
    // We use a minimum of 100 to prevent conversational history from flooding out RAG documents
    params.push(Math.max(100, topK * 10));

    const rows = db.prepare(sql).all(...params) as any[];

    // Post-filter by channel/collection and deduplicate recent messages
    const filtered = rows.filter(r => {
        // Filter out recent verbatim conversation history
        if (beforeId !== undefined && beforeId !== Infinity) {
            if (r.type === "M" && r.id >= beforeId) return false;
        }

        if (r.type === "M") return r.channel === channel;
        if (r.type === "R") {
            if (!collections || collections.length === 0) return true;
            return collections.includes(r.collection);
        }
        return false;
    });

    return filtered.slice(0, topK * 5).map(r => ({
        ...r,
        prev_paragraph: null,
        next_paragraph: null,
    }));
}

// ── BM25 Search ──────────────────────────────────────────────────────

function bm25Search(
    query: string,
    channel: string,
    collections: string[] | undefined,
    topK: number,
    beforeId?: number
): SearchResult[] {
    // Escape FTS5 special chars for safe matching by removing all non-alphanumeric chars
    const safeQuery = query
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .replace(/\bAND\b|\bOR\b|\bNOT\b/gi, " ")
        .split(/\s+/)
        .filter(w => w.length > 1)
        .map(w => `"${w}"*`)
        .join(" OR ");

    if (!safeQuery.trim()) return [];

    try {
        let sql = `
            WITH fts_results AS (
                SELECT rowid, bm25(memory_fts) AS distance
                FROM memory_fts
                WHERE memory_fts MATCH ?
                ORDER BY distance ASC
                LIMIT CAST(? AS INTEGER)
            )
            SELECT
                m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
                f.distance,
                d.name AS doc_name, d.file_path, d.collection, d.doc_id
            FROM fts_results f
            JOIN memory m ON m.id = f.rowid
            LEFT JOIN documents d ON d.doc_id = m.doc_id
            WHERE 1=1
        `;

        // We use a minimum of 100 to prevent conversational history from flooding out RAG documents
        const params: any[] = [safeQuery, Math.max(100, topK * 10)];

        const rows = db.prepare(sql).all(...params) as any[];

        // Post-filter by channel/collection and exclude recent messages
        const filtered = rows.filter(r => {
            // Filter out recent verbatim conversation history
            if (beforeId !== undefined && beforeId !== Infinity) {
                if (r.type === "M" && r.id >= beforeId) return false;
            }

            if (r.type === "M") return r.channel === channel;
            if (r.type === "R") {
                if (!collections || collections.length === 0) return true;
                return collections.includes(r.collection);
            }
            return false;
        });

        return filtered.slice(0, topK).map(r => ({
            ...r,
            prev_paragraph: null,
            next_paragraph: null,
        }));
    } catch (err) {
        console.warn("⚠️ BM25 search failed:", err);
        return [];
    }
}

// ── Contextual Paragraph Retrieval (RAG only) ───────────────────────

function enrichWithContext(results: SearchResult[]): SearchResult[] {
    return results.map(result => {
        if (result.type !== "R" || !result.doc_id) return result;

        const prevChunk = db.prepare(`
            SELECT chunk_text FROM memory
            WHERE doc_id = ? AND id < ? AND type = 'R'
            ORDER BY id DESC LIMIT 1
        `).get(result.doc_id, result.id) as { chunk_text: string } | undefined;

        const nextChunk = db.prepare(`
            SELECT chunk_text FROM memory
            WHERE doc_id = ? AND id > ? AND type = 'R'
            ORDER BY id ASC LIMIT 1
        `).get(result.doc_id, result.id) as { chunk_text: string } | undefined;

        const prevParagraph = prevChunk
            ? prevChunk.chunk_text.split("\n\n").filter(Boolean).at(-1) ?? null
            : null;
        const nextParagraph = nextChunk
            ? nextChunk.chunk_text.split("\n\n").filter(Boolean).at(0) ?? null
            : null;

        return { ...result, prev_paragraph: prevParagraph, next_paragraph: nextParagraph };
    });
}

// ── Main Search Function ────────────────────────────────────────────

export async function search(
    query: string,
    options: {
        channel: string;
        collections?: string[];
        topK?: number;
        beforeId?: number;
    }
): Promise<SearchResult[]> {
    const topK = options.topK ?? getSettingNum("semantic_search_top_k", 5);
    const vectorWeight = parseFloat(String(getSettingNum("vector_weight", 7) / 10));

    const bm25Weight = parseFloat(String(getSettingNum("bm25_weight", 3) / 10));
    const halfLifeDays = getSettingNum("memory_decay_halflife_days", 90);

    // If no collections specified, use the channel's linked collections
    const collections = options.collections ?? getChannelCollections(options.channel);

    let vecResults: SearchResult[] = [];
    try {
        // Generate query embedding
        const queryEmbedding = await embed(query);
        const queryBuffer = embeddingToBuffer(queryEmbedding);

        // Run vector search
        vecResults = vectorSearch(queryBuffer, options.channel, collections, topK, options.beforeId);
    } catch (err: any) {
        if (err?.status === 429) {
            console.warn("⚠️ Vector search unavailable due to API rate limit (429). Falling back to BM25 only.");
        } else {
            console.warn("⚠️ Vector search failed:", err);
        }
    }

    // Run BM25 search
    const bm25Results = bm25Search(query, options.channel, collections, topK, options.beforeId);

    // Merge via RRF
    let merged = reciprocalRankFusion(
        vecResults, bm25Results, vectorWeight, bm25Weight, halfLifeDays
    );

    // Prevent conversational flood from wiping out RAG documents
    const bestDocs = merged.filter(r => r.type === "R").slice(0, topK);
    const bestMsgs = merged.filter(r => r.type === "M").slice(0, Math.max(2, Math.floor(topK / 2)));

    // Re-combine (keeping relative RRF order since they were extracted from merged)
    merged = merged.filter(r => bestDocs.includes(r) || bestMsgs.includes(r));

    // Enrich RAG chunks with surrounding context
    merged = enrichWithContext(merged);

    return merged;
}

// ── Format Results for Prompt ───────────────────────────────────────

export function formatSearchContext(results: SearchResult[]): string {
    const messages = results.filter(r => r.type === "M");
    const docs = results.filter(r => r.type === "R");

    const parts: string[] = [];

    if (messages.length > 0) {
        parts.push("--- Relevant conversation history ---");
        messages.forEach(m => {
            const speaker = m.speaker === "U" ? "User" : "Assistant";
            parts.push(`${speaker}: ${m.chunk_text}`);
        });
    }

    if (docs.length > 0) {
        parts.push("--- Relevant documents ---");
        docs.forEach(d => {
            parts.push(`[${d.doc_name} — collection: ${d.collection}]`);
            if (d.prev_paragraph) parts.push(`...${d.prev_paragraph}...\n─────`);
            parts.push(d.chunk_text);
            if (d.next_paragraph) parts.push(`─────\n...${d.next_paragraph}...`);
        });
    }

    return parts.join("\n\n");
}
