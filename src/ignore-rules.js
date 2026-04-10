import fs from "node:fs/promises";
import path from "node:path";

import { fileExists } from "./fs-utils.js";

const defaultPatterns = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "vendor/",
  ".bundle/",
  ".gradle/",
  "target/",
  "logs/",
  "*.log",
  "coverage/",
  ".nyc_output/",
  ".grunt/",
  ".npm/",
  ".eslintcache",
  ".rollup.cache/",
  ".webpack.cache/",
  ".parcel-cache/",
  ".sass-cache/",
  "*.cache",
  ".next/",
  ".nuxt/",
  ".serverless/",
  "dist/",
  ".DS_Store",
  "Thumbs.db",
  ".idea/",
  ".vscode/",
  "*.swp",
  "*.swo",
  "*.bak",
  "build/",
  "out/",
  "tmp/",
  "temp/",
  "repomix-output.*",
  "repopack-output.*",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  "venv/",
  ".venv/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ipynb_checkpoints/",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
];

function normalizePattern(pattern) {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function patternMatches(relativePath, pattern) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const normalizedPattern = normalizePattern(pattern);

  if (!normalizedPattern || normalizedPattern.startsWith("#")) {
    return false;
  }

  if (normalizedPattern.endsWith("/")) {
    const dirPattern = normalizedPattern.slice(0, -1);
    return normalizedPath === dirPattern || normalizedPath.startsWith(`${dirPattern}/`) || normalizedPath.includes(`/${dirPattern}/`);
  }

  if (normalizedPattern.startsWith("*.")) {
    return normalizedPath.endsWith(normalizedPattern.slice(1));
  }

  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`(^|/)${escaped}$`).test(normalizedPath);
  }

  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.endsWith(`/${normalizedPattern}`) ||
    normalizedPath.startsWith(`${normalizedPattern}/`)
  );
}

export async function loadIgnoreMatcher(repoRoot) {
  const patterns = [...defaultPatterns];
  const ignoreFiles = [".gitignore", ".kbignore"];

  for (const ignoreFile of ignoreFiles) {
    const filePath = path.join(repoRoot, ignoreFile);
    if (!(await fileExists(filePath))) {
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    patterns.push(...content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }

  const compiledPatterns = patterns.map(normalizePattern).filter(Boolean);

  return {
    patterns: compiledPatterns,
    shouldIgnore(relativePath) {
      return compiledPatterns.some((pattern) => patternMatches(relativePath, pattern));
    },
  };
}
