import { db, getSetting } from "./db.js";
import { search, formatSearchContext } from "./search.js";

// ── SUMMARIZATION HELPER ──────────────────────────────────────
// Wraps the gateway's LLM caller with the correct signature.
// The gateway must inject this dependency when initializing.

let _callSummarizationLLM: (prompt: string) => Promise<string>;

export function initDeepSearch(
    summarizer: (prompt: string) => Promise<string>
): void {
    _callSummarizationLLM = summarizer;
}

// ── TOKEN ESTIMATOR ───────────────────────────────────────────
// Tuned for English (~1.3 tokens/word) and Portuguese (~1.5 tokens/word).

function estimateTokens(text: string): number {
    const words = text.split(/\s+/).filter(Boolean).length;
    const ptPattern = /[àáâãçéêíóôõúü]|ção|ções|mente\b|ando\b|endo\b|indo\b/i;
    const multiplier = ptPattern.test(text) ? 1.5 : 1.3;
    return Math.ceil(words * multiplier);
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────

export async function deepMemorySearch(
    query: string,
    topKPerCollection = 5,
    channel: string
): Promise<string> {

    // Get all non-paste collections that have chunks in this channel's documents
    const collections = db.prepare(`
    SELECT DISTINCT d.collection, COUNT(m.id) as chunk_count
    FROM documents d
    JOIN memory m ON m.doc_id = d.doc_id
    WHERE d.collection NOT LIKE 'p:%'
    GROUP BY d.collection
    ORDER BY d.collection ASC
  `).all() as { collection: string; chunk_count: number }[];

    if (collections.length === 0) {
        return "No document collections found. Ingest some documents first.";
    }

    // ── PASS 1: Query each collection independently ───────────────

    const collectionResults: Array<{
        collection: string;
        chunk_count: number;
        formatted: string;
        tokenCount: number;
    }> = [];

    for (const col of collections) {
        const results = await search(query, {
            channel,
            collections: [col.collection],
            topK: topKPerCollection
        });

        if (results.length === 0) {
            collectionResults.push({
                collection: col.collection,
                chunk_count: col.chunk_count,
                formatted: "(no relevant content found)",
                tokenCount: 5
            });
            continue;
        }

        const formatted = formatSearchContext(results);
        collectionResults.push({
            collection: col.collection,
            chunk_count: col.chunk_count,
            formatted,
            tokenCount: estimateTokens(formatted)
        });
    }

    const totalTokens = collectionResults.reduce((sum, r) => sum + r.tokenCount, 0);
    const threshold = parseInt(getSetting("deep_memory_search_token_threshold") ?? "4000");

    // ── SINGLE PASS (under threshold) ────────────────────────────

    if (totalTokens <= threshold) {
        const parts = [
            `Deep memory search across ${collections.length} collection(s) for: "${query}"\n`,
            `Estimated tokens: ${totalTokens} (under ${threshold} threshold — single pass)\n`
        ];
        for (const r of collectionResults) {
            parts.push(`═══ Collection: ${r.collection} (${r.chunk_count} total chunks) ═══`);
            parts.push(r.formatted);
        }
        return parts.join("\n\n");
    }

    // ── TWO-PASS SYNTHESIS (over threshold) ──────────────────────

    const perCollectionSummaries: string[] = [];

    for (const r of collectionResults) {
        if (r.formatted === "(no relevant content found)") {
            perCollectionSummaries.push(
                `[${r.collection}]: No relevant content found for this query.`
            );
            continue;
        }

        const summaryPrompt = `You are summarizing search results from the "${r.collection}" document collection.
The user's research question is: "${query}"

Below are the most relevant passages retrieved from this collection.
Summarize what THIS collection specifically says about the topic.
Be concise but complete. Preserve specific facts, definitions, numbers, and named concepts.
Do not add information from outside these passages.

Passages:
${r.formatted}

Summary of what [${r.collection}] says about "${query}":`;

        if (!_callSummarizationLLM) {
            throw new Error("deepMemorySearch requires initialization via initDeepSearch");
        }
        const summary = await _callSummarizationLLM(summaryPrompt);
        perCollectionSummaries.push(`[${r.collection}]: ${summary.trim()}`);
    }

    // Return structured per-collection summaries for the LLM to synthesize
    const output = [
        `Deep memory search across ${collections.length} collection(s) for: "${query}"`,
        `Estimated tokens: ${totalTokens} (over ${threshold} threshold — two-pass synthesis used)`,
        `Per-collection findings:\n`,
        ...perCollectionSummaries
    ];

    return output.join("\n\n");
}
