import type { ToolDefinition } from "./registry.js";
import { performWebSearch } from "../services/search.js";

export const webSearchTool: ToolDefinition = {
    spec: {
        name: "web_search",
        description: "Search the web for real-time information, news, and facts.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "The search query to look up on the web.",
                },
            },
            required: ["query"],
        },
    },

    execute: async (input) => {
        const query = input.query as string;
        try {
            const results = await performWebSearch(query);
            if (results.length === 0) {
                return "No results found for your query.";
            }

            // Format results for the LLM
            let output = `Results for "${query}":\n\n`;
            results.forEach((r, i) => {
                output += `${i + 1}. [${r.title}](${r.url})\n${r.content}\n\n`;
            });

            return output;
        } catch (e: any) {
            return `Search failed: ${e.message}`;
        }
    },
};
