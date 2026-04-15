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
  // Stream large JSON to avoid "Invalid string length" on big indexes.
  const { createWriteStream } = await import("node:fs");
  const ws = createWriteStream(targetPath, { encoding: "utf8" });
  const write = (s) => new Promise((resolve) => {
    if (!ws.write(s)) ws.once("drain", resolve);
    else resolve();
  });
  await write("{\n");
  const keys = Object.keys(value);
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    const val = value[key];
    const comma = ki < keys.length - 1 ? "," : "";
    if (Array.isArray(val)) {
      await write(`  ${JSON.stringify(key)}: [\n`);
      for (let i = 0; i < val.length; i++) {
        const line = JSON.stringify(val[i]);
        await write(`    ${line}${i < val.length - 1 ? "," : ""}\n`);
      }
      await write(`  ]${comma}\n`);
    } else {
      await write(`  ${JSON.stringify(key)}: ${JSON.stringify(val)}${comma}\n`);
    }
  }
  await write("}\n");
  await new Promise((resolve, reject) => { ws.end(resolve); ws.on("error", reject); });
}

export async function readJson(targetPath, fallback) {
  if (!(await fileExists(targetPath))) {
    return fallback;
  }
  // Stream-parse to handle large files that exceed Node's string length limit.
  const stat = await fs.stat(targetPath);
  if (stat.size < 50 * 1024 * 1024) {
    // Under 50MB — safe to parse normally.
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  }
  // Large file — stream line-by-line.
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: createReadStream(targetPath, { encoding: "utf8" }), crlfDelay: Infinity });
  const result = {};
  let currentKey = null;
  let currentArray = null;
  for await (const line of rl) {
    const trimmed = line.trim();
    const keyArrayMatch = trimmed.match(/^"(\w+)":\s*\[$/);
    if (keyArrayMatch) {
      currentKey = keyArrayMatch[1];
      currentArray = [];
      continue;
    }
    if (currentArray !== null) {
      if (trimmed === "]" || trimmed === "],") {
        result[currentKey] = currentArray;
        currentArray = null;
        currentKey = null;
        continue;
      }
      if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
        const clean = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
        try { currentArray.push(JSON.parse(clean)); } catch {}
      }
      continue;
    }
    const kvMatch = trimmed.match(/^"(\w+)":\s*(.+?),?$/);
    if (kvMatch) {
      try { result[kvMatch[1]] = JSON.parse(kvMatch[2].replace(/,$/, "")); } catch {}
    }
  }
  return result;
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


// Recursively strip NUL bytes (\u0000) from strings/arrays/objects.
// Postgres TEXT and JSONB reject \u0000 — Marker PDF extraction can produce them.
export function stripNul(value) {
  if (value == null) return value;
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (Array.isArray(value)) return value.map(stripNul);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNul(v);
    return out;
  }
  return value;
}
