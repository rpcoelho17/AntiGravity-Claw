/**
 * tools/memory_tools.ts — Tools for manual fact extraction (MEMORY.md)
 */

import { defineTool } from "./registry.js";
import { MEMORY_MD_PATH } from "../memory/index.js";
import fs from "fs";

export const remember_fact = defineTool({
    name: "remember_fact",
    description: "Records a durable fact, user preference, or project decision into the core MEMORY.md file. Use this for information that must survive database wipes or model migrations.",
    parameters: {
        type: "object",
        properties: {
            fact: { type: "string", description: "The fact to remember (e.g., 'The user prefers dark mode' or 'Project X uses port 8080')." },
            category: { type: "string", description: "The section header to place this fact under (e.g., 'User Profile', 'Project Notes', 'Conventions'). Defaults to 'General Facts'." }
        },
        required: ["fact"]
    },
    execute: async ({ fact, category = "General Facts" }) => {
        try {
            let content = "";
            if (fs.existsSync(MEMORY_MD_PATH)) {
                content = fs.readFileSync(MEMORY_MD_PATH, "utf-8");
            } else {
                content = "# Memory\n\nCurated facts about the user.\n";
            }

            const header = `## ${category}`;
            const factLine = `- ${fact}`;

            if (content.includes(header)) {
                // Find the header and append the fact
                const lines = content.split("\n");
                const index = lines.findIndex(l => l.trim() === header);
                lines.splice(index + 1, 0, factLine);
                content = lines.join("\n");
            } else {
                // Add new header and fact
                content += `\n${header}\n${factLine}\n`;
            }

            fs.writeFileSync(MEMORY_MD_PATH, content, "utf-8");
            return `✅ I've recorded that fact in my core memory under "${category}".`;
        } catch (err: any) {
            return `❌ Failed to record fact: ${err.message}`;
        }
    }
});

export const allMemoryTools = [remember_fact];
