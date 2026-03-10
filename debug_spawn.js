import { spawnSync } from 'child_process';

const pythonExe = 'C:\\Python313\\python.exe';
const scriptPath = 'D:\\FILES\\Code\\AntiGravityClaw\\scripts\\ingest.py';
const filePath = 'D:\\FILES\\Code\\AntiGravityClaw\\data\\collections\\TestSpaces\\File With Spaces.txt';

console.log("Running spawnSync with DOUBLE-WRAPPED SINGLE STRING COMMAND and shell: true...");
// The outer quotes are for cmd.exe /c to preserve the inner quotes
const cmd = `""${pythonExe}" "${scriptPath}" "${filePath}""`;
const result = spawnSync(cmd, [], { shell: true });

console.log("Result:", {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.toString().substring(0, 100),
    stderr: result.stderr?.toString()
});
