import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";

const mode = process.argv[2] || "dir"; // "dir" or "dist"
const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13); // YYYYMMDDTHH
const outDir = `release-${stamp}`;

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const builderArgs = [
  mode === "dist" ? undefined : "--dir",
  "--config.win.signAndEditExecutable=false",
  `--config.directories.output=${outDir}`
].filter(Boolean);

const res = spawnSync("npx", ["electron-builder", ...builderArgs], {
  stdio: "inherit",
  shell: process.platform === "win32"
});

process.exit(res.status ?? 1);

