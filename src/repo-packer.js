import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";

import { ensureDir, listFilesRecursive } from "./fs-utils.js";
import { loadIgnoreMatcher } from "./ignore-rules.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2MB

const ignoredExtensions = new Set([
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico", ".svg",
  // Audio / video
  ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".wmv",
  // Office / docs
  ".pdf", ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls",
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  // Compiled / binary
  ".exe", ".dll", ".so", ".dylib", ".pyc", ".class", ".o", ".a",
  ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  // Models / weights
  ".pt", ".pth", ".onnx", ".safetensors", ".ckpt", ".h5",
  // Lockfiles
  ".lock",
]);

function shouldInclude(relativePath, entry, matcher) {
  if (matcher.shouldIgnore(relativePath)) {
    return false;
  }

  if (!entry.isDirectory() && ignoredExtensions.has(path.extname(relativePath).toLowerCase())) {
    return false;
  }

  return true;
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".js": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".md": "Markdown",
    ".json": "JSON",
    ".yml": "YAML",
    ".yaml": "YAML",
  }[ext] ?? "Text";
}

export async function packRepository(repoRoot, outputPath) {
  const ignoreMatcher = await loadIgnoreMatcher(repoRoot);
  const files = await listFilesRecursive(repoRoot, (relativePath, entry) => shouldInclude(relativePath, entry, ignoreMatcher));
  const summaries = [];
  const languages = new Set();
  const topLevelEntries = new Set();
  const entrypoints = [];

  await ensureDir(path.dirname(outputPath));
  const stream = createWriteStream(outputPath, { encoding: "utf8" });
  const write = (chunk) =>
    stream.write(chunk) ? Promise.resolve() : new Promise((resolve) => stream.once("drain", resolve));

  await write(`# Packed Repository Context\n\nSource: ${repoRoot}\n\n`);

  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, "/");

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content === null) {
      continue;
    }

    const language = detectLanguage(filePath);
    languages.add(language);
    topLevelEntries.add(relativePath.split("/")[0]);

    if (/^(src\/)?(main|index|app)\./i.test(relativePath) || /package\.json$|pyproject\.toml$|Cargo\.toml$/i.test(relativePath)) {
      entrypoints.push(relativePath);
    }

    summaries.push({ path: relativePath, bytes: Buffer.byteLength(content, "utf8"), language });
    await write(
      `## ${relativePath}\n\n\`\`\`${path.extname(filePath).slice(1) || "txt"}\n${content.trimEnd()}\n\`\`\`\n\n`,
    );
  }

  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });

  return {
    includedFiles: summaries,
    languages: Array.from(languages).sort(),
    keyModules: Array.from(topLevelEntries).filter(Boolean).sort(),
    entrypoints: Array.from(new Set(entrypoints)).sort(),
    ignorePatterns: ignoreMatcher.patterns,
  };
}
