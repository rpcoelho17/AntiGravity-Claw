import fs from 'fs';
import path from 'path';
import https from 'https';

// --- CONFIGURATION ---
const REPO_OWNER = 'rpcoelho17';
const REPO_NAME = 'AntiGravity-Claw';
const BRANCH = 'main';

// 1. Read token from .env
const envContent = fs.readFileSync('.env', 'utf-8');
const tokenMatch = envContent.match(/Github_Access_Token=(ghp_[a-zA-Z0-9]+)/);
if (!tokenMatch) {
    console.error("❌ ERR: Could not find Github_Access_Token in .env");
    process.exit(1);
}
const TOKEN = tokenMatch[1];

// 2. Define files to push
const filesToPush = [
    'README.md',
    'requirements.txt',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.env.example',
    '.gitignore',
    'AntiGravityClaw_UserManual.md',
    'OPENCLAW_INFINITE_MEMORY_SPEC_V4.md',
    
    // src
    'src/index.ts',
    'src/bot.ts',
    'src/agent.ts',
    'src/llm.ts',
    'src/config.ts',
    'src/test_local_ingest.ts',
    
    // src/memory
    'src/memory/chunker.ts',
    'src/memory/confirm.ts',
    'src/memory/db.ts',
    'src/memory/deep-search.ts',
    'src/memory/embed.ts',
    'src/memory/index.ts',
    'src/memory/ingest.ts',
    'src/memory/search.ts',
    'src/memory/store.ts',
    'src/memory/upload.ts',
    
    // src/services
    'src/services/audio.ts',
    'src/services/search.ts',
    
    // src/tools
    'src/tools/registry.ts',
    'src/tools/file_tools.ts',
    'src/tools/get-current-time.ts',
    'src/tools/memory_tools.ts',
    'src/tools/web_search.ts',
    
    // scripts
    'scripts/embed_server.py',
    'scripts/ingest.py'
];

async function uploadFile(filePath) {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
        console.warn(`⚠️  Skip: File not found: ${filePath}`);
        return;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const base64Content = Buffer.from(content).toString('base64');
    
    const payload = JSON.stringify({
        message: `Upload ${filePath}`,
        content: base64Content,
        branch: BRANCH
    });

    const options = {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
        method: 'PUT',
        headers: {
            'Authorization': `token ${TOKEN}`,
            'User-Agent': 'AntiGravity-Claw-Pusher',
            'Content-Type': 'application/json',
            'Content-Length': payload.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 201) {
                    console.log(`✅ Success: ${filePath}`);
                    resolve();
                } else {
                    console.error(`❌ Fail: ${filePath} (${res.statusCode})`);
                    console.error(data);
                    reject(new Error(`GitHub API failed with status ${res.statusCode}`));
                }
            });
        });

        req.on('error', (err) => {
            console.error(`❌ Network Err: ${filePath}`, err);
            reject(err);
        });

        req.write(payload);
        req.end();
    });
}

async function run() {
    console.log(`🚀 Starting push to ${REPO_OWNER}/${REPO_NAME}...`);
    for (const file of filesToPush) {
        try {
            await uploadFile(file);
        } catch (e) {
            console.error(`🛑 Stopping due to error at ${file}`);
            process.exit(1);
        }
    }
    console.log("\n🎊 ALL FILES PUSHED SUCCESSFULLY!");
}

run();
