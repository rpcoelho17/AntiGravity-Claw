#!/usr/bin/env node
import { Page, Stagehand } from '@browserbasehq/stagehand';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findLocalChrome, prepareChromeProfile, takeScreenshot, getAnthropicApiKey } from './browser-utils.js';
import { z } from 'zod/v4';
import dotenv from 'dotenv';

// Validate ES module environment
if (!import.meta.url) {
  console.error('Error: This script must be run as an ES module');
  console.error('Ensure your package.json has "type": "module" and Node.js version is 14+');
  process.exit(1);
}

// Resolve plugin root directory from script location
// In production (compiled): dist/src/cli.js -> dist/src -> dist -> plugin-root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

// Load .env from plugin root directory
dotenv.config({ path: join(PLUGIN_ROOT, '.env'), quiet: true });
// Also load .env from project root
dotenv.config({ path: join(PLUGIN_ROOT, '..', '..', '.env'), quiet: true });

console.error('[Diagnostic] Browser Automation CLI Starting...');

const apiKeyResult = getAnthropicApiKey();
const apiKey = process.env.ANTHROPIC_API_KEY || (apiKeyResult?.apiKey);
if (!apiKey) {
  console.error('Error: No API key found (ANTHROPIC_API_KEY).');
  process.exit(1);
}
process.env.ANTHROPIC_API_KEY = apiKey;

if (process.env.DEBUG) {
  console.error(apiKeyResult?.source === 'claude-code' 
    ? '🔐 Using Claude Code subscription token from keychain'
    : '🔑 Using ANTHROPIC_API_KEY from environment');
}

// Persistent browser state
let stagehandInstance: Stagehand | null = null;
let currentPage: Page | null = null;
let chromeProcess: ChildProcess | null = null;
let weStartedChrome = false; // Track if we launched Chrome vs. reused existing

async function initBrowser(): Promise<{ stagehand: Stagehand }> {
  if (stagehandInstance) {
    return { stagehand: stagehandInstance };
  }

  // Check if Browserbase credentials are available
  const useBrowserbase = process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID;

  if (useBrowserbase) {
    // Remote: Browserbase cloud browser
    console.error('Using Browserbase cloud browser');
    
    let modelName = process.env.PRIMARY_MODEL || process.env.BROWSER_MODEL || "arcee-ai/trinity-large-preview:free";
    if (!modelName.startsWith("openai/")) {
      modelName = `openai/${modelName}`;
    }
    const baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (process.env.DEBUG) console.error(`STAGEHAND CONFIG: model=${modelName}, baseURL=${baseURL}`);

    stagehandInstance = new Stagehand({
      env: "BROWSERBASE",
      apiKey: process.env.BROWSERBASE_API_KEY,
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      verbose: 0,
      model: {
        provider: "openai",
        modelName: modelName,
        apiKey: apiKey,
        baseURL: baseURL,
      } as any,
    });

    await stagehandInstance.init();
    currentPage = stagehandInstance.context.pages()[0];

    // Wait for page to be ready
    let retries = 0;
    while (retries < 30) {
      try {
        await currentPage.evaluate('document.readyState');
        break;
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
      }
    }

    return { stagehand: stagehandInstance };
  }

  // Prepare Chrome profile (copy tokens/logins from main Chrome)
  prepareChromeProfile(PLUGIN_ROOT);

  // Local: Use local Chrome browser
  const chromePath = findLocalChrome();
  if (!chromePath) {
    throw new Error('Could not find Chrome installation. Either install Chrome or set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID for cloud browser.');
  }

  const cdpPort = 9223; // Switch to 9223 to avoid conflict with default Chrome (9222)
  const tempUserDataDir = join(PLUGIN_ROOT, '.chrome-profile');

  // Check if Chrome is already running on the CDP port
  let chromeReady = false;
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (response.ok) {
      chromeReady = true;
      console.error('Reusing existing Chrome instance on port', cdpPort);
    }
  } catch (error) {
    // Chrome not running, need to launch it
  }

  // Launch Chrome if not already running
  if (!chromeReady) {
    // Quote path for Windows to handle spaces safely
    const quotedChromePath = platform() === 'win32' ? `"${chromePath}"` : chromePath;
    
    if (process.env.DEBUG) console.error(`Launching Chrome: ${quotedChromePath} on port ${cdpPort}`);

    chromeProcess = spawn(quotedChromePath, [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempUserDataDir}`,
      '--window-size=1250,900',
    ], {
      stdio: 'pipe', // Change to pipe to capture initial errors if any
      detached: true,
      shell: true, // Use shell for better window handling on Windows
      windowsHide: false,
    });

    // Capture stderr for potential launch errors
    chromeProcess.stderr?.on('data', (data) => {
      if (process.env.DEBUG) console.error(`[Chrome Stderr]: ${data}`);
    });

    // Unref to let it live past CLI exit
    chromeProcess.unref();

    // Store PID for safe cleanup later
    if (chromeProcess.pid) {
      const pidFilePath = join(PLUGIN_ROOT, '.chrome-pid');
      writeFileSync(pidFilePath, JSON.stringify({
        pid: chromeProcess.pid,
        startTime: Date.now()
      }));
    }

    // Wait for Chrome to be ready
    for (let i = 0; i < 50; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (response.ok) {
          chromeReady = true;
          weStartedChrome = true; // Mark that we started this Chrome instance
          break;
        }
      } catch (error) {
        // Still waiting
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (!chromeReady) {
      console.error(`ERROR: Chrome timed out after 15s on port ${cdpPort}.`);
      throw new Error('Chrome failed to start');
    }
  }

  // Get the WebSocket URL from Chrome's CDP endpoint
  const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const versionData = await versionResponse.json() as { webSocketDebuggerUrl: string };
  const wsUrl = versionData.webSocketDebuggerUrl;

  let modelNameLocal = process.env.PRIMARY_MODEL || process.env.BROWSER_MODEL || "arcee-ai/trinity-large-preview:free";
  if (!modelNameLocal.startsWith("openai/")) {
    modelNameLocal = `openai/${modelNameLocal}`;
  }
  const baseURLLocal = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
  const apiKeyLocal = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  
  if (process.env.DEBUG) console.error(`STAGEHAND CONFIG (LOCAL): model=${modelNameLocal}, baseURL=${baseURLLocal}`);

  // Initialize Stagehand with the WebSocket URL
  console.error('Using local Chrome browser');
  stagehandInstance = new Stagehand({
    env: "LOCAL",
    verbose: 0,
    model: {
      provider: "openai",
      modelName: modelNameLocal,
      apiKey: apiKeyLocal,
      baseURL: baseURLLocal,
    } as any,
    localBrowserLaunchOptions: {
      cdpUrl: wsUrl,
    },
  });

  await stagehandInstance.init();
  
  // Get all pages and log them for debugging
  const pages = stagehandInstance.context.pages();
  console.error(`[Diagnostic] Found ${pages.length} open pages`);
  
  let bestPageIdx = 0;
  for (let i = 0; i < pages.length; i++) {
    const url = pages[i].url();
    let title = "Unknown";
    try {
      title = await pages[i].title();
    } catch {}
    console.error(`[Diagnostic] Page ${i}: title="${title}", url="${url}"`);
    
    // If we find a "New Tab" or "Nova guia", that's likely the one the user is looking at
    if (title.includes("New Tab") || title.includes("Nova guia") || url === "chrome://newtab/" || url === "about:blank") {
       bestPageIdx = i;
    }
  }

  console.error(`[Diagnostic] Selecting Page ${bestPageIdx} as primary target`);
  currentPage = pages[bestPageIdx];
  
  // Ensure the page is focused and visible
  try {
    await (currentPage as any).bringToFront();
    // Also try a simple reload if it's a new tab to "claim" it
    if (currentPage.url().includes('newtab') || currentPage.url() === 'about:blank') {
       await currentPage.goto('about:blank');
    }
  } catch (err) {
    console.error('[Diagnostic] Failed to bring page to front or claim it:', err);
  }

  // Wait for page to be ready
  let retries = 0;
  while (retries < 30) {
    try {
      await currentPage.evaluate('document.readyState');
      break;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 100));
      retries++;
    }
  }

  // Configure downloads
  const downloadsPath = join(PLUGIN_ROOT, 'agent', 'downloads');
  if (!existsSync(downloadsPath)) {
    mkdirSync(downloadsPath, { recursive: true });
  }

  const client = currentPage.mainFrame().session;
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadsPath,
    eventsEnabled: true,
  });

  return { stagehand: stagehandInstance };
}

async function closeBrowser() {
  const cdpPort = 9223; // Use the correct port
  const pidFilePath = join(PLUGIN_ROOT, '.chrome-pid');

  // First, try to close via Stagehand if we have an instance in this process
  if (stagehandInstance) {
    try {
      await stagehandInstance.close();
    } catch (error) {
      console.error('Error closing Stagehand:', error instanceof Error ? error.message : String(error));
    }
    stagehandInstance = null;
    currentPage = null;
  }

  // If we started Chrome in this process, kill it
  if (chromeProcess && weStartedChrome) {
    try {
      chromeProcess.kill('SIGTERM');
      // Wait briefly for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (chromeProcess.exitCode === null) {
        chromeProcess.kill('SIGKILL');
      }
    } catch (error) {
      console.error('Error killing Chrome process:', error instanceof Error ? error.message : String(error));
    }
    chromeProcess = null;
    weStartedChrome = false;
  }

  // For separate CLI invocations, use graceful CDP shutdown + PID file verification
  try {
    // Step 1: Try graceful shutdown via CDP
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(2000)
    });

    if (response.ok) {
      // Get WebSocket URL for graceful shutdown
      const versionData = await response.json() as { webSocketDebuggerUrl: string };
      const wsUrl = versionData.webSocketDebuggerUrl;

      // Connect and close gracefully via Stagehand
      const tempStagehand = new Stagehand({
        env: "LOCAL",
        verbose: 0,
        model: {
          modelName: process.env.BROWSER_MODEL?.includes('/') ? process.env.BROWSER_MODEL : `anthropic/${process.env.BROWSER_MODEL || "claude-3-5-sonnet-latest"}`,
          clientOptions: {
            apiKey: process.env.ANTHROPIC_API_KEY,
            baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
          }
        } as any,
        localBrowserLaunchOptions: {
          cdpUrl: wsUrl,
        },
      });
      await tempStagehand.init();
      await tempStagehand.close();

      // Wait briefly for Chrome to close
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Check if Chrome is still running
      try {
        const checkResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
          signal: AbortSignal.timeout(1000)
        });

        // Chrome is still running, need to force close
        if (checkResponse.ok) {
          // Step 3: Use PID file if available for safe termination
          if (existsSync(pidFilePath)) {
            const pidData = JSON.parse(readFileSync(pidFilePath, 'utf8'));
            const { pid } = pidData;

            // Verify the process is actually Chrome before killing
            const isChrome = await verifyIsChromeProcess(pid);
            if (isChrome) {
              if (process.platform === 'win32') {
                const { exec } = await import('child_process');
                const { promisify } = await import('util');
                const execAsync = promisify(exec);
                await execAsync(`taskkill /PID ${pid} /F`);
              } else {
                process.kill(pid, 'SIGKILL');
              }
            }
          }
        }
      } catch {
        // Chrome successfully closed
      }
    }
  } catch (error) {
    // Chrome not running or already closed
  } finally {
    // Clean up PID file
    if (existsSync(pidFilePath)) {
      try {
        unlinkSync(pidFilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

async function verifyIsChromeProcess(pid: number): Promise<boolean> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { stdout } = await execAsync(`ps -p ${pid} -o comm=`);
      const processName = stdout.trim().toLowerCase();
      return processName.includes('chrome') || processName.includes('chromium');
    } else if (process.platform === 'win32') {
      const { stdout } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);
      return stdout.toLowerCase().includes('chrome');
    }
    return false;
  } catch {
    return false;
  }
}

// CLI commands
async function navigate(url: string) {
  try {
    const { stagehand } = await initBrowser();
    await stagehand.context.pages()[0].goto(url);

    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);

    return {
      success: true,
      message: `Successfully navigated to ${url}`,
      screenshot: screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function act(action: string) {
  try {
    const { stagehand } = await initBrowser();
    await stagehand.act(action);
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return {
      success: true,
      message: `Successfully performed action: ${action}`,
      screenshot: screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function extract(instruction: string, schema?: Record<string, string>) {
  try {
    const { stagehand } = await initBrowser();

    let zodSchemaObject;

    // Try to convert schema to Zod if provided
    if (schema) {
      try {
        const zodSchema: Record<string, any> = {};
        let hasValidTypes = true;

        for (const [key, type] of Object.entries(schema)) {
          switch (type) {
            case "string":
              zodSchema[key] = z.string();
              break;
            case "number":
              zodSchema[key] = z.number();
              break;
            case "boolean":
              zodSchema[key] = z.boolean();
              break;
            default:
              console.error(`Warning: Unsupported schema type "${type}" for field "${key}". Proceeding without schema validation.`);
              hasValidTypes = false;
              break;
          }
        }

        if (hasValidTypes && Object.keys(zodSchema).length > 0) {
          zodSchemaObject = z.object(zodSchema);
        }
      } catch (schemaError) {
        console.error('Warning: Failed to convert schema. Proceeding without schema validation:',
          schemaError instanceof Error ? schemaError.message : String(schemaError));
      }
    }

    // Extract with or without schema
    const extractOptions: any = { instruction };
    if (zodSchemaObject) {
      extractOptions.schema = zodSchemaObject;
    }

    const result = await stagehand.extract(extractOptions);

    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return {
      success: true,
      message: `Successfully extracted data: ${JSON.stringify(result)}`,
      screenshot: screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function observe(query: string) {
  try {
    const { stagehand } = await initBrowser();
    const actions = await stagehand.observe(query);
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return {
      success: true,
      message: `Successfully observed: ${actions}`,
      screenshot: screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function screenshot() {
  try {
    const { stagehand } = await initBrowser();
    const screenshotPath = await takeScreenshot(stagehand, PLUGIN_ROOT);
    return {
      success: true,
      screenshot: screenshotPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// Main CLI handler
async function main() {
  // Prepare Chrome profile on first run
  prepareChromeProfile(PLUGIN_ROOT);

  const args = process.argv.slice(2);
  const command = args[0];

  try {
    let result: { success: boolean; [key: string]: any };

    switch (command) {
      case 'navigate':
        if (args.length < 2) {
          throw new Error('Usage: browser navigate <url>');
        }
        result = await navigate(args[1]);
        break;

      case 'act':
        if (args.length < 2) {
          throw new Error('Usage: browser act "<action>"');
        }
        result = await act(args.slice(1).join(' '));
        break;

      case 'extract':
        if (args.length < 2) {
          throw new Error('Usage: browser extract "<instruction>" [\'{"field": "type"}\']');
        }
        const instruction = args[1];
        const schema = args[2] ? JSON.parse(args[2]) : undefined;
        result = await extract(instruction, schema);
        break;

      case 'observe':
        if (args.length < 2) {
          throw new Error('Usage: browser observe "<query>"');
        }
        result = await observe(args.slice(1).join(' '));
        break;

      case 'screenshot':
        result = await screenshot();
        break;

      case 'close':
        await closeBrowser();
        result = { success: true, message: 'Browser closed' };
        break;

      default:
        throw new Error(`Unknown command: ${command}\nAvailable commands: navigate, act, extract, observe, screenshot, close`);
    }

    console.log(JSON.stringify(result, null, 2));

    // Browser stays open between commands - only closes on explicit 'close' command
    // This allows for faster sequential operations and preserves browser state

    // Exit immediately after printing result
    process.exit(0);
  } catch (error) {
    // Close browser on error too
    await closeBrowser();

    console.error(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }, null, 2));
    process.exit(1);
  }
}

// Handle cleanup
process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

main().catch(console.error);
