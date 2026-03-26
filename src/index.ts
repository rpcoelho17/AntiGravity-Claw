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
    onStart: async (botInfo) => {
        console.log(`✅ Bot started as @${botInfo.username}`);
        console.log(`   Send a message on Telegram to begin.\n`);

        // ── 0. CLEAR PENDING CONFIRMATIONS ──
        // Ensure a fresh state on startup to avoid annoying the user with old prompts
        try {
            const { clearPendingConfirmation } = await import("./memory/index.js");
            clearPendingConfirmation("tg");
            console.log("🧹 Startup: Pending confirmations cleared.");
        } catch (err) {
            console.warn("⚠️ Failed to clear pending confirmations:", err);
        }

        // ── 0.5 STARTUP DRIFT CHECK ──
        // Check for model drift IMMEDIATELY on startup
        try {
            const { checkModelDrift } = await import("./memory/index.js");
            const drift = await checkModelDrift();
            if (drift) {
                console.log("⚠️ STARTUP: Embedding model change detected. Notifying users...");
                const msg = `⚠️ **EMBEDDING MODEL CHANGE DETECTED**\n\nI've detected that your default embedding model has changed.\n\nShould I switch to the new model? This will wipe clean your **memory.db** and all the ingestions!\n\nRespond by typing **Yes** or **no**.`;
                
                for (const userId of config.ALLOWED_USER_IDS) {
                    await bot.api.sendMessage(userId, msg, { parse_mode: "Markdown" }).catch(err => {
                        console.warn(`⚠️ Failed to notify user ${userId}:`, err.message);
                    });
                }
            }
        } catch (err) {
            console.warn("⚠️ Failed to perform startup drift check:", err);
        }
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
