const fs = require("fs");
const path = require("path");

const sourceDir = path.join(__dirname, "..", "Frontend");
const targetDir = path.join(__dirname, "..", "public");

if (!fs.existsSync(sourceDir)) {
  throw new Error(`Frontend directory not found: ${sourceDir}`);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Copied ${sourceDir} -> ${targetDir}`);
