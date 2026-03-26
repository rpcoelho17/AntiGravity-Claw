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

    // Skills are globally available regardless of project linking
    const normalizedPath = userPath.replace(/\\/g, "/");
    const isGlobalSkill = normalizedPath === "workspace/skills" || normalizedPath.startsWith("workspace/skills/");

    if (!channelRoot && !isGlobalSkill) {
        throw new Error(
            `Access Denied: Use the 'search' tool for documents in 'workspace/collections/'. 
The 'read_file'/'list_files' tools are ONLY for reading code and project files when a channel is linked to a project root (via 'propose_link_project'). 
Note: 'workspace/skills/' remains GLOBALLY accessible via 'read_file' at any time.`
        );
    }

    const effectiveRoot = isGlobalSkill ? "." : (channelRoot || "");
    const targetRoot = path.resolve(BASE_PROJECT_PATH, effectiveRoot);

    if (!targetRoot.startsWith(BASE_PROJECT_PATH)) {
        throw new Error("Security violation: Channel root is outside the base project directory.");
    }

    const resolved = path.resolve(BASE_PROJECT_PATH, userPath);
    console.log(`[DEBUG safePath] BASE_PROJECT_PATH = ${BASE_PROJECT_PATH}`);
    console.log(`[DEBUG safePath] userPath = ${userPath}`);
    console.log(`[DEBUG safePath] resolved = ${resolved}`);

    // Ensure the final file path is still under the specifically selected channelRoot
    // If it's a global skill, it only needs to be under BASE_PROJECT_PATH/workspace/skills
    const requiredPrefix = isGlobalSkill 
        ? path.resolve(BASE_PROJECT_PATH, "workspace", "skills") 
        : targetRoot;
        
    console.log(`[DEBUG safePath] requiredPrefix = ${requiredPrefix}`);
    console.log(`[DEBUG safePath] valid? = ${resolved.startsWith(requiredPrefix)}`);

    if (!resolved.startsWith(requiredPrefix)) {
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
            "Requires the channel to be linked to a project (except for 'workspace/skills/' which is always accessible). " +
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
            "Requires the channel to be linked to a project (except for 'workspace/skills/' which is always accessible). " +
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
