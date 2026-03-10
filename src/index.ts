import { bot } from "./bot.js";
import { config } from "./config.js";
import { refreshLocalAvailability } from "./memory/embed.js";
import { spawn, type ChildProcess } from "child_process";
import path from "path";

// ── Embedding server management ─────────────────────────────────────

let embedServerProcess: ChildProcess | null = null;

function getPythonCmd(): string {
    if (process.platform === "win32") {
        return "C:\\Python313\\python.exe"; // Full path for GPU/CUDA reliability
    }
    return "python3";
}

function getPythonArgs(scriptPath: string): string[] {
    return ["-u", scriptPath];
}

function startEmbedServer(retryCount = 0): void {
    const scriptPath = path.join(process.cwd(), "scripts", "embed_server.py");
    console.log(`🧠 Starting local embedding server... (Attempt ${retryCount + 1})`);

    const pythonCmd = getPythonCmd();
    const args = getPythonArgs(scriptPath);

    // On Windows, use a single quoted string for robust space handling
    if (process.platform === "win32") {
        const cmd = `"${pythonCmd}" "${scriptPath}"`;
        embedServerProcess = spawn(cmd, [], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            shell: true,
        });
    } else {
        embedServerProcess = spawn(pythonCmd, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PYTHONIOENCODING: "utf-8" },
            shell: false,
        });
    }

    embedServerProcess.stdout?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`  [embed] ${msg}`);
        // If server says it's running, refresh availability shortly after
        if (msg.includes("Embedding server running")) {
            setTimeout(() => refreshLocalAvailability(), 2000);
        }
    });

    embedServerProcess.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.warn(`  [embed] ${msg}`);
    });

    embedServerProcess.on("error", (err) => {
        console.warn(`⚠️  Could not start embedding server via ${pythonCmd}: ${err.message}`);
        if (retryCount < 2) {
            console.log("   Retrying with 'python' command...");
            // Fallback strategy for retries
            const nextRetry = () => {
                if (retryCount === 0) {
                    // Try simple 'python'
                    console.log("   Trying 'python'...");
                    embedServerProcess = spawn("python", ["-u", scriptPath], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
                    // Wire up same listeners... (simplified for brevity here, but let's stick to the recursive pattern)
                }
            };
            setTimeout(() => startEmbedServer(retryCount + 1), 3000);
        } else {
            console.warn("   Falling back to Gemini API for embeddings.");
            embedServerProcess = null;
        }
    });

    embedServerProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
            console.warn(`⚠️  Embedding server exited with code ${code}`);
            if (retryCount < 2) {
                console.log("   Restarting in 5s...");
                setTimeout(() => startEmbedServer(retryCount + 1), 5000);
            }
        }
        embedServerProcess = null;
    });

    // Initial check after typical load time
    setTimeout(() => {
        refreshLocalAvailability();
    }, 20000);
}

// ── Startup banner ──────────────────────────────────────────────────

console.log(`
  ╔═══════════════════════════════════════╗
  ║         🦀 GRAVITY CLAW v1.0         ║
  ║   Lean • Secure • Fully Understood   ║
  ╚═══════════════════════════════════════╝
`);
console.log(`🔒 Allowed user IDs: [${config.ALLOWED_USER_IDS.join(", ")}]`);
console.log(`🔄 Max agent iterations: ${config.MAX_AGENT_ITERATIONS}`);

startEmbedServer();

console.log(`📡 Starting Telegram long-polling...\n`);

// ── Start bot (long-polling, no webhook, no web server) ─────────────

bot.start({
    onStart: (botInfo) => {
        console.log(`✅ Bot started as @${botInfo.username}`);
        console.log(`   Send a message on Telegram to begin.\n`);
    },
});

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(signal: string) {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

    // Kill embedding server
    if (embedServerProcess && embedServerProcess.pid) {
        console.log("   Stopping embedding server...");
        try {
            // On Windows, SIGTERM doesn't work for child processes
            if (process.platform === 'win32') {
                embedServerProcess.kill();  // sends SIGTERM which becomes TerminateProcess on Windows
            } else {
                embedServerProcess.kill("SIGTERM");
            }
        } catch {}
        embedServerProcess = null;
    }

    bot.stop();
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
