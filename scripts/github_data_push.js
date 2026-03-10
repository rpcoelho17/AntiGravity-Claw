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

// 2. Define files in data/ to push
const filesToPush = [
    'data/MEMORY.md',
    'data/memory.db',
    'data/memory.db-shm',
    'data/memory.db-wal',
    'data/collections/Articles/Chain_of_Draft.pdf',
    'data/collections/Lean6Sigma/Certified Six Sigma Black Belt Handbook-ASQ (2009).pdf',
    'data/collections/TestSpaces/File With Spaces.txt'
];

async function uploadFile(filePath) {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
        console.warn(`⚠️  Skip: File not found: ${filePath}`);
        return;
    }

    // IMPORTANT: Read as raw Buffer for binary safety (PDF, DB)
    const content = fs.readFileSync(fullPath);
    const base64Content = content.toString('base64');
    
    const payload = JSON.stringify({
        message: `Upload data: ${filePath}`,
        content: base64Content,
        branch: BRANCH
    });

    const options = {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(filePath.replace(/\\/g, '/'))}`,
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
                } else if (res.statusCode === 422) {
                    console.warn(`⚠️  Skip (Already Exists or Conflict): ${filePath}`);
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
    console.log(`🚀 Starting DATA push to ${REPO_OWNER}/${REPO_NAME}...`);
    for (const file of filesToPush) {
        try {
            // Normalize path for GitHub API (must use /)
            const normalizedPath = file.replace(/\\/g, '/');
            await uploadFile(normalizedPath);
        } catch (e) {
            console.error(`🛑 Stopping due to error at ${file}`);
            process.exit(1);
        }
    }
    console.log("\n🎊 DATA FOLDER PUSHED SUCCESSFULLY!");
}

run();
