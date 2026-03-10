import { db, getSetting, getChannelCollections } from "./db.js";
import { search, formatSearchContext } from "./search.js";
import { getMessageCount } from "./store.js";

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

    // 1. Resolve Target Collections (Links + Pastes)
    const linkedCollections = getChannelCollections(channel);
    
    // 2. Build the list of Search Passes
    interface SearchPass {
        name: string;
        type: 'M' | 'R';
        collection?: string;
    }
    
    const passes: SearchPass[] = [];
    
    // Pass A: Message History (if exists)
    if (getMessageCount(channel) > 0) {
        passes.push({ name: "Message History", type: 'M' });
    }
    
    // Pass B: Each Linked Collection/Paste
    for (const col of linkedCollections) {
        const exists = db.prepare("SELECT doc_id FROM documents WHERE collection=? LIMIT 1").get(col);
        if (exists) {
            passes.push({ name: col, type: 'R', collection: col });
        }
    }

    if (passes.length === 0) {
        return "No message history or document collections found for this channel. Ingest some documents or link existing collections first.";
    }

    // ── PASS 1: Executing individual searches ───────────────────

    const resultsByPass: Array<{
        name: string;
        type: string;
        formatted: string;
        tokenCount: number;
    }> = [];

    for (const pass of passes) {
        // Run search with specific constraints
        const results = await search(query, {
            channel,
            collections: pass.type === 'R' ? [pass.collection!] : [],
            topK: topKPerCollection
        });
        
        // If searching history, filter for type='M' only
        const filtered = pass.type === 'M' ? results.filter(r => r.type === 'M') : results;

        if (filtered.length === 0) {
            resultsByPass.push({
                name: pass.name,
                type: pass.type === 'M' ? "Conversation History" : "Document Collection",
                formatted: "(no relevant content found)",
                tokenCount: 5
            });
            continue;
        }

        const formatted = formatSearchContext(filtered);
        resultsByPass.push({
            name: pass.name,
            type: pass.type === 'M' ? "Conversation History" : "Document Collection",
            formatted,
            tokenCount: estimateTokens(formatted)
        });
    }

    const totalTokens = resultsByPass.reduce((sum, r) => sum + r.tokenCount, 0);
    const threshold = parseInt(getSetting("deep_memory_search_token_threshold") ?? "4000");

    // ── SINGLE PASS (under threshold) ────────────────────────────

    if (totalTokens <= threshold) {
        const displayChannel = channel === "D" ? "Default" : channel;
        const parts = [
            `Deep memory search in [${displayChannel}] channel for: "${query}"\n`,
            `Estimated total tokens: ${totalTokens} (under ${threshold} threshold — single pass)\n`
        ];
        for (const r of resultsByPass) {
            parts.push(`═══ Source: ${r.name} (${r.type}) ═══`);
            parts.push(r.formatted);
        }
        return parts.join("\n\n");
    }

    // ── TWO-PASS SYNTHESIS (over threshold) ──────────────────────

    const perSourceSummaries: string[] = [];

    for (const r of resultsByPass) {
        if (r.formatted === "(no relevant content found)") {
            perSourceSummaries.push(
                `[${r.name}]: No relevant content found for this query.`
            );
            continue;
        }

        const summaryPrompt = `You are summarizing search results from the "${r.name}" source (${r.type}) in the context of a deep memory search.
The user's research question is: "${query}"

Below are the most relevant excerpts.
Summarize what THIS specific source says about the topic.
Be concise but complete. Preserve specific facts, names, and concepts.
Do not add information from outside these excerpts.

Excerpts:
${r.formatted}

Summary of findings from [${r.name}] for "${query}":`;

        if (!_callSummarizationLLM) {
            throw new Error("deepMemorySearch requires initialization via initDeepSearch");
        }
        const summary = await _callSummarizationLLM(summaryPrompt);
        perSourceSummaries.push(`[${r.name}]: ${summary.trim()}`);
    }

    // Return structured summaries for the model to synthesize
    const displayChannel = channel === "D" ? "Default" : channel;
    const output = [
        `Deep memory search in [${displayChannel}] channel for: "${query}"`,
        `Estimated total tokens: ${totalTokens} (over ${threshold} threshold — two-pass synthesis used)`,
        `Aggregated findings from ${resultsByPass.length} source(s):\n`,
        ...perSourceSummaries
    ];

    return output.join("\n\n");
}
