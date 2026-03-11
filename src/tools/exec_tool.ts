import { exec } from "child_process";
import { promisify } from "util";
import { ToolDefinition } from "./registry.js";

const execAsync = promisify(exec);

export const execCommandTool: ToolDefinition = {
    spec: {
        name: "exec_command",
        description: "Executes a shell command in the current workspace. Use this to install npm dependencies (e.g. `npm i -g package`), interact with git, or run CLI tools like `clawhub`.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to wait for and execute (e.g. 'npm install -g clawhub')."
                },
                timeoutMs: {
                    type: "number",
                    description: "Optional timeout in milliseconds. Defaults to 30000 (30 seconds). maximum is 120000."
                }
            },
            required: ["command"],
        },
    },
    execute: async (input: Record<string, unknown>) => {
        const { command, timeoutMs } = input;
        
        if (typeof command !== "string") {
            return "Error: param 'command' must be a string.";
        }
        
        const timeout = typeof timeoutMs === "number" ? Math.min(timeoutMs, 120000) : 30000;
        
        try {
            // Wait for the command to return output (with a generous default timeout)
            const { stdout, stderr } = await execAsync(command, { timeout });
            
            let output = "";
            if (stdout) {
               output += `STDOUT:\n${stdout}\n`;
            }
            if (stderr) {
               output += `STDERR:\n${stderr}\n`; 
            }
            
            if (!output) {
                return `Command '${command}' executed successfully with no output.`;
            }
            return output.trim();
        } catch (err: any) {
             let errorMsg = `Command '${command}' failed.\n`;
             if (err.stdout) {
                 errorMsg += `STDOUT:\n${err.stdout}\n`;
             }
             if (err.stderr) {
                 errorMsg += `STDERR:\n${err.stderr}\n`;
             }
             errorMsg += `ERROR:\n${err.message}`;
             return errorMsg;
        }
    },
};
