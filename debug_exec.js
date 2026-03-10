import { execSync } from 'child_process';

const pythonExe = 'C:\\Python313\\python.exe';
const scriptPath = 'D:\\FILES\\Code\\AntiGravityClaw\\scripts\\ingest.py';
const filePath = 'D:\\FILES\\Code\\AntiGravityClaw\\data\\collections\\TestSpaces\\File With Spaces.txt';

console.log("Running execSync with quoted command string...");
const cmd = `"${pythonExe}" "${scriptPath}" "${filePath}"`;

try {
    const stdout = execSync(cmd, { 
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: 'pipe' 
    });
    console.log("SUCCESS. Stdout length:", stdout.length);
    console.log("First 100 chars:", stdout.toString().substring(0, 100));
} catch (e) {
    console.error("FAILED.");
    console.error("Status:", e.status);
    console.error("Stderr:", e.stderr?.toString());
}
