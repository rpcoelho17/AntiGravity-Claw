// ── Tool interface ──────────────────────────────────────────────────

export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ToolDefinition {
    /** OpenAI-compatible tool spec */
    spec: ToolSpec;
    /** Execute the tool and return a string result */
    execute: (input: Record<string, unknown>) => Promise<string>;
}

// ── Registry ────────────────────────────────────────────────────────

const registry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
    registry.set(tool.spec.name, tool);
}

/** All tool specs for passing to the LLM */
export function allToolSpecs(): ToolSpec[] {
    return Array.from(registry.values()).map((t) => t.spec);
}

/** Execute a tool by name */
export async function executeTool(
    name: string,
    input: Record<string, unknown>
): Promise<string> {
    const tool = registry.get(name);
    if (!tool) {
        return `Error: Unknown tool "${name}"`;
    }
    try {
        return await tool.execute(input);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error executing tool "${name}": ${message}`;
    }
}

// ── Auto-register all tools ─────────────────────────────────────────

import { getCurrentTimeTool } from "./get-current-time.js";
import { webSearchTool } from "./web_search.js";
import { readFileTool, writeFileTool, listFilesTool } from "./file_tools.js";
import { allMemoryTools } from "./memory_tools.js";

registerTool(getCurrentTimeTool);
registerTool(webSearchTool);
registerTool(readFileTool);
registerTool(writeFileTool);
registerTool(listFilesTool);

for (const tool of allMemoryTools) {
    registerTool(tool);
}
