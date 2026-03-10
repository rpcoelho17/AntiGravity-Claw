import { runIngestion } from './memory/ingest.js';
import path from 'path';

async function test() {
    console.log("Starting Local BGE Ingestion Test (Six Sigma Handbook)...");
    const testFile = "D:/FILES/Code/AntiGravityClaw/workspace/collections/Lean6Sigma/Certified Six Sigma Black Belt Handbook-ASQ (2009).pdf";
    try {
        const result = await runIngestion(testFile, "Lean6Sigma", (msg) => {
            console.log(`[PROGRESS] ${msg}`);
        });
        console.log("SUCCESS:", result);
    } catch (e: any) {
        console.error("FAILED:", e.message);
        process.exit(1);
    }
}

test();
