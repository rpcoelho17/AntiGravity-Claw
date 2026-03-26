/**
 * tools/search_tools.ts — Tools for searching the memory database
 */

import { defineTool } from "./registry.js";
import { search, deepMemorySearch, getSetting } from "../memory/index.js";

export const search_memory = defineTool({
    name: "search_memory",
    description: "Performs a hybrid (vector + keyword) search of the recent conversation and linked document collections. Use this for quick lookups when you expect the answer to be in the immediate context.",
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "The search query." },
            top_k: { type: "number", description: "Number of results to return (default: 5)." }
        },
        required: ["query"]
    },
    execute: async ({ query, top_k }) => {
        const channel = getSetting("active_channel:tg") ?? "D";
        const results = await search(query, { channel, topK: top_k });
        if (results.length === 0) return "No relevant information found in recent history or linked collections.";
        
        const { formatSearchContext } = await import("../memory/index.js");
        return formatSearchContext(results);
    }
});

export const deep_memory_search = defineTool({
    name: "deep_memory_search",
    description: "A more thorough, recursive search across all linked collections. If results are too large, it automatically summarizes them in multiple passes to fit your context window. Use this for complex research or when search_memory yields no results.",
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "The complex research question or topic to investigate." }
        },
        required: ["query"]
    },
    execute: async ({ query }) => {
        const channel = getSetting("active_channel:tg") ?? "D";
        try {
            return await deepMemorySearch(query, 5, channel);
        } catch (err: any) {
            return `❌ Deep search failed: ${err.message}`;
        }
    }
});

export const allSearchTools = [search_memory, deep_memory_search];
