import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function stableId(prefix, name) {
  return `${prefix}-${slugify(name)}`;
}

export async function sha1File(targetPath) {
  const hash = crypto.createHash("sha1");
  const data = await fs.readFile(targetPath);
  hash.update(data);
  return hash.digest("hex");
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson(targetPath, fallback) {
  if (!(await fileExists(targetPath))) {
    return fallback;
  }

  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export function escapeYaml(value) {
  return String(value ?? "").replace(/"/g, '\\"');
}

export async function listFilesRecursive(rootDir, shouldInclude) {
  const results = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      if (!shouldInclude(relativePath, entry)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

export function tokenize(text) {
  return Array.from(
    new Set(
      String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3),
    ),
  );
}
