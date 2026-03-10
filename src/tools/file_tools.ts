/**
 * tools/file_tools.ts — File read/write/list tools
 * 
 * Lets the agent interact with the user's workspace from Telegram.
 * All paths are resolved relative to the project root.
 */

import type { ToolDefinition } from "./registry.js";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { getSetting } from "../memory/index.js";

// Secure base path for all bot projects
const BASE_PROJECT_PATH = config.BASE_PROJECT_PATH;

/**
 * Resolve a user-provided path to an absolute path within a channel's root.
 * Blocks access if the channel is not linked to a project.
 */
function safePath(userPath: string): string {
    const channel = getSetting("active_channel:tg") ?? "D";
    const channelRoot = getSetting(`channel_root:${channel}`);

    if (!channelRoot) {
        throw new Error(
            `This channel ("${channel === "D" ? "Default" : channel}") is not linked to a project. ` +
            `Use "link this channel to [folder]" to enable file tools.`
        );
    }

    // Always resolve relative to BASE_PROJECT_PATH/channelRoot
    const targetRoot = path.resolve(BASE_PROJECT_PATH, channelRoot);

    // Ensure the channel folder itself is still under BASE_PROJECT_PATH
    if (!targetRoot.startsWith(BASE_PROJECT_PATH)) {
        throw new Error("Security violation: Channel root is outside the base project directory.");
    }

    const resolved = path.resolve(targetRoot, userPath);

    // Ensure the final file path is still under the specifically selected channelRoot
    if (!resolved.startsWith(targetRoot)) {
        throw new Error("Path escapes the project directory. Access denied.");
    }

    return resolved;
}

// ── Read File ───────────────────────────────────────────────────────

export const readFileTool: ToolDefinition = {
    spec: {
        name: "read_file",
        description:
            "Read the contents of a file from the project workspace. " +
            "Requires the channel to be linked to a project. " +
            "Use relative paths from the project root (e.g. 'src/agent.ts'). " +
            "Returns the file contents as text.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Relative path to the file to read",
                },
                start_line: {
                    type: "number",
                    description: "Optional: start line (1-indexed) to read from",
                },
                end_line: {
                    type: "number",
                    description: "Optional: end line (1-indexed) to read to",
                },
            },
            required: ["path"],
        },
    },

    execute: async (input) => {
        const filePath = safePath(input.path as string);

        if (!fs.existsSync(filePath)) {
            return JSON.stringify({ error: `File not found: ${input.path}` });
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return JSON.stringify({ error: `${input.path} is a directory, not a file. Use list_files instead.` });
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        const startLine = (input.start_line as number | undefined) ?? 1;
        const endLine = (input.end_line as number | undefined) ?? lines.length;

        const selected = lines.slice(startLine - 1, endLine);

        return JSON.stringify({
            path: input.path,
            total_lines: lines.length,
            showing: `${startLine}-${endLine}`,
            content: selected.join("\n"),
        });
    },
};

// ── Write File ──────────────────────────────────────────────────────

export const writeFileTool: ToolDefinition = {
    spec: {
        name: "write_file",
        description:
            "Create or overwrite a file in the project workspace. " +
            "Requires the channel to be linked to a project. " +
            "Parent directories are created automatically. " +
            "Use relative paths from the project root (e.g. 'src/utils/helper.ts').",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Relative path to the file to write",
                },
                content: {
                    type: "string",
                    description: "The full content to write to the file",
                },
            },
            required: ["path", "content"],
        },
    },

    execute: async (input) => {
        const filePath = safePath(input.path as string);
        const content = input.content as string;

        // Create parent directories
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");

        const lines = content.split("\n").length;
        return JSON.stringify({
            success: true,
            path: input.path,
            lines_written: lines,
            bytes: Buffer.byteLength(content, "utf-8"),
        });
    },
};

// ── List Files ──────────────────────────────────────────────────────

export const listFilesTool: ToolDefinition = {
    spec: {
        name: "list_files",
        description:
            "List files and directories in the project workspace. " +
            "Requires the channel to be linked to a project. " +
            "Use relative paths from the project root. Use '.' for the root directory. " +
            "Returns names, types (file/directory), and sizes.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Relative directory path to list (default: '.')",
                },
                recursive: {
                    type: "boolean",
                    description: "If true, list files recursively (max 2 levels deep). Default: false",
                },
            },
            required: [],
        },
    },

    execute: async (input) => {
        const dirPath = safePath((input.path as string | undefined) ?? ".");

        if (!fs.existsSync(dirPath)) {
            return JSON.stringify({ error: `Directory not found: ${input.path ?? "."}` });
        }

        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) {
            return JSON.stringify({ error: `${input.path} is a file, not a directory. Use read_file instead.` });
        }

        const isRecursive = (input.recursive as boolean | undefined) ?? false;
        const entries = listEntries(dirPath, isRecursive ? 2 : 1, 0);

        // Filter out common noise
        const filtered = entries.filter(e =>
            !e.name.startsWith(".") &&
            e.name !== "node_modules" &&
            e.name !== "dist" &&
            e.name !== ".git"
        );

        return JSON.stringify({
            path: input.path ?? ".",
            entries: filtered.slice(0, 100), // Cap at 100 entries
            total: filtered.length,
        });
    },
};

interface FileEntry {
    name: string;
    type: "file" | "directory";
    size?: number;
    children?: FileEntry[];
}

function listEntries(dirPath: string, maxDepth: number, currentDepth: number): FileEntry[] {
    if (currentDepth >= maxDepth) return [];

    const items = fs.readdirSync(dirPath);
    const entries: FileEntry[] = [];

    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                const entry: FileEntry = { name: item, type: "directory" };
                if (currentDepth + 1 < maxDepth) {
                    entry.children = listEntries(fullPath, maxDepth, currentDepth + 1);
                }
                entries.push(entry);
            } else {
                entries.push({ name: item, type: "file", size: stat.size });
            }
        } catch {
            // Skip files we can't stat (permissions, etc.)
        }
    }

    return entries;
}
