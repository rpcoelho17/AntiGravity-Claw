import { runIngestion } from './src/memory/ingest.js';
import fs from 'fs';
import path from 'path';

async function test_space() {
    console.log("Starting Space Filename Ingestion Test...");
    const baseDir = "d:/FILES/Code/AntiGravityClaw/data/collections/TestSpaces";
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    
    // Create a dummy file with spaces
    const testFile = path.join(baseDir, "File With Spaces.txt");
    fs.writeFileSync(testFile, "This is a test document with spaces in the filename.");
    
    try {
        console.log(`Testing ingestion of: ${testFile}`);
        const result = await runIngestion(testFile, "TestSpaces");
        console.log("SUCCESS:", result);
    } catch (e: any) {
        console.error("FAILED:", e.message);
        process.exit(1);
    } finally {
        // Cleanup if needed, but maybe leave it for the user to see
    }
}

test_space();
