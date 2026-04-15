import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { vaultRoot } from "./config.js";
import { ensureDir, fileExists } from "./fs-utils.js";
import { loadIndex } from "./indexer.js";

const EMBEDDINGS_PATH = path.join(vaultRoot, "kb_embeddings.json");
const EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = process.env.KB_EMBEDDING_MODEL ?? "text-embedding-3-small";
const CHUNK_MAX_CHARS = 2000; // ~500 tokens
const MAX_BATCH_TOKENS = 80_000; // very conservative; code is ~2x denser than 4 chars/token
const EMBED_CONCURRENCY = 4; // parallel requests; lower to avoid 429 rate limits

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

export function chunkText(text) {
  const paragraphs = String(text ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let buffer = "";
  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > CHUNK_MAX_CHARS && buffer) {
      chunks.push(buffer);
      buffer = "";
    }
    if (para.length > CHUNK_MAX_CHARS) {
      // Hard-split a single huge paragraph.
      for (let i = 0; i < para.length; i += CHUNK_MAX_CHARS) {
        chunks.push(para.slice(i, i + CHUNK_MAX_CHARS));
      }
      continue;
    }
    buffer = buffer ? `${buffer}\n\n${para}` : para;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

async function readPaperMarkdown(paper) {
  const paperDir = path.dirname(paper.notePath);
  const rawDir = path.join(paperDir, "raw");
  const files = await fs.readdir(rawDir).catch(() => []);
  const md = files.find((name) => name.endsWith(".md"));
  if (!md) return paper.markdownExcerpt ?? "";
  return await fs.readFile(path.join(rawDir, md), "utf8").catch(() => paper.markdownExcerpt ?? "");
}

function repoSummaryText(repo) {
  // Cap list fields to keep summary under the embedding model's 8192 token limit.
  // Assume ~4 chars/token → ~28KB max. We cap well below that.
  const MAX_LIST_CHARS = 4000;
  const capList = (items) => {
    const joined = (items ?? []).join(", ");
    return joined.length > MAX_LIST_CHARS ? joined.slice(0, MAX_LIST_CHARS) + "..." : joined;
  };

  const text = [
    `# ${repo.title}`,
    (repo.summary ?? "").slice(0, 2000),
    `Languages: ${(repo.languages ?? []).slice(0, 20).join(", ")}`,
    `Key modules: ${capList(repo.keyModules)}`,
    `Entrypoints: ${capList(repo.entrypoints)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Hard cap at 24 KB (~6000 tokens, well under the 8192 limit).
  return text.length > 24000 ? text.slice(0, 24000) : text;
}

async function callEmbeddingsRaw(inputs, retries = 5) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set.");
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(EMBEDDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
    });
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(2 ** attempt * 2000, 30000);
      process.stderr.write(`Embeddings rate limited, retrying in ${wait / 1000}s...\n`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI embeddings ${res.status}: ${errText.slice(0, 500)}`);
    }
    const json = await res.json();
    return json.data.map((row) => row.embedding);
  }
}

// Estimate tokens from text. Use ~2 chars/token for code-heavy content
// (code has more punctuation/symbols, and one BPE token can cover only 1-2 chars).
function estimateTokens(text) {
  return Math.ceil(text.length / 2);
}

// Maximum tokens per single input (OpenAI's 8191 limit, with safety margin).
const MAX_INPUT_TOKENS = 7000;

// Split texts into batches that fit under MAX_BATCH_TOKENS.
// Drops any single text exceeding MAX_INPUT_TOKENS (would 400 the entire batch).
function batchByTokens(texts) {
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (tokens > MAX_INPUT_TOKENS) continue; // skip oversized chunks
    if (current.length > 0 && currentTokens + tokens > MAX_BATCH_TOKENS) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

const callEmbeddings = callEmbeddingsRaw;

// Public: embed a single query string. Used by PG-backed semantic search
// so callers don't need to touch the internal batching helpers.
export async function embedQuery(query) {
  const [vector] = await callEmbeddings([query]);
  return vector;
}

export async function loadEmbeddings() {
  if (!(await fileExists(EMBEDDINGS_PATH))) {
    return { model: EMBEDDING_MODEL, generatedAt: null, entries: [] };
  }
  // Stream-parse to avoid "Invalid string length" on large embedding files.
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: createReadStream(EMBEDDINGS_PATH, { encoding: "utf8" }), crlfDelay: Infinity });
  const store = { model: EMBEDDING_MODEL, generatedAt: null, entries: [] };
  let inEntries = false;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!inEntries) {
      const modelMatch = trimmed.match(/^"model"\s*:\s*"(.+?)"/);
      if (modelMatch) store.model = modelMatch[1];
      const dateMatch = trimmed.match(/^"generatedAt"\s*:\s*"(.+?)"/);
      if (dateMatch) store.generatedAt = dateMatch[1];
      if (trimmed.startsWith('"entries"')) inEntries = true;
    } else {
      if (trimmed === "]" || trimmed === "]}") break;
      if (trimmed.startsWith("{")) {
        const clean = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
        try { store.entries.push(JSON.parse(clean)); } catch {}
      }
    }
  }
  return store;
}

async function saveEmbeddings(store) {
  await ensureDir(path.dirname(EMBEDDINGS_PATH));
  // Stream JSON to avoid "Invalid string length" on large embedding indexes.
  const { createWriteStream } = await import("node:fs");
  const ws = createWriteStream(EMBEDDINGS_PATH, { encoding: "utf8" });
  const write = (s) => new Promise((resolve, reject) => {
    if (!ws.write(s)) ws.once("drain", resolve);
    else resolve();
  });
  await write(`{\n  "model": ${JSON.stringify(store.model)},\n  "generatedAt": ${JSON.stringify(store.generatedAt)},\n  "entries": [\n`);
  for (let i = 0; i < store.entries.length; i++) {
    const line = JSON.stringify(store.entries[i]);
    await write(`    ${line}${i < store.entries.length - 1 ? "," : ""}\n`);
  }
  await write("  ]\n}\n");
  await new Promise((resolve, reject) => { ws.end(resolve); ws.on("error", reject); });
}

export async function buildEmbeddingIndex({ force = false } = {}) {
  const index = await loadIndex();
  const existing = await loadEmbeddings();
  const previousByHash = new Map(existing.entries.map((entry) => [entry.id, entry]));

  const desired = [];

  for (const paper of index.papers) {
    const md = await readPaperMarkdown(paper);
    const chunks = chunkText(md);
    chunks.forEach((text, i) => {
      desired.push({
        id: `${paper.id}#chunk-${i}`,
        entityId: paper.id,
        entityTitle: paper.title,
        type: "paper",
        kind: "chunk",
        chunkIndex: i,
        text,
        hash: sha1(text),
      });
    });
  }

  for (const repo of index.repos) {
    const text = repoSummaryText(repo);
    desired.push({
      id: `${repo.id}#summary`,
      entityId: repo.id,
      entityTitle: repo.title,
      type: "repo",
      kind: "summary",
      chunkIndex: 0,
      text,
      hash: sha1(text),
    });
  }

  for (const doc of index.docs ?? []) {
    // Read all page files and chunk each one
    const pageFiles = await fs.readdir(doc.pagesDir).catch(() => []);
    let chunkIndex = 0;
    for (const file of pageFiles.filter((f) => f.endsWith(".md"))) {
      const content = await fs.readFile(path.join(doc.pagesDir, file), "utf8").catch(() => "");
      if (!content) continue;
      const chunks = chunkText(content);
      for (const text of chunks) {
        desired.push({
          id: `${doc.id}#chunk-${chunkIndex}`,
          entityId: doc.id,
          entityTitle: doc.title,
          type: "docs",
          kind: "chunk",
          chunkIndex,
          text,
          hash: sha1(text),
          sourceFile: file,
        });
        chunkIndex += 1;
      }
    }
  }

  // Decide which entries need (re)embedding.
  const toEmbed = [];
  const finalEntries = [];
  for (const entry of desired) {
    const prior = previousByHash.get(entry.id);
    if (!force && prior && prior.hash === entry.hash && Array.isArray(prior.vector)) {
      finalEntries.push({ ...entry, vector: prior.vector });
    } else {
      toEmbed.push(entry);
    }
  }

  let embeddedCount = 0;
  // Token-aware batching to avoid OpenAI 400 errors.
  const textBatches = batchByTokens(toEmbed.map((e) => e.text));
  // Map text batches back to entry batches.
  const entryBatches = [];
  let offset = 0;
  for (const tb of textBatches) {
    entryBatches.push(toEmbed.slice(offset, offset + tb.length));
    offset += tb.length;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(EMBED_CONCURRENCY, entryBatches.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= entryBatches.length) return;
      const batch = entryBatches[idx];
      const vectors = await callEmbeddings(batch.map((entry) => entry.text));
      batch.forEach((entry, j) => {
        finalEntries.push({ ...entry, vector: vectors[j] });
      });
      embeddedCount += batch.length;
    }
  });
  await Promise.all(workers);

  finalEntries.sort((a, b) => a.id.localeCompare(b.id));

  const store = {
    model: EMBEDDING_MODEL,
    generatedAt: new Date().toISOString(),
    entries: finalEntries,
  };
  await saveEmbeddings(store);

  return {
    total: finalEntries.length,
    embedded: embeddedCount,
    reused: finalEntries.length - embeddedCount,
  };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function repoContentPath(repoSlug) {
  return path.join(vaultRoot, "repos", repoSlug, "embeddings.json");
}

async function loadRepoContent(repoSlug) {
  const p = repoContentPath(repoSlug);
  if (!(await fileExists(p))) return null;
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function saveRepoContent(repoSlug, store) {
  const p = repoContentPath(repoSlug);
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function buildContentIndex({ repoIds = null, force = false } = {}) {
  const index = await loadIndex();
  const targets = repoIds
    ? index.repos.filter((r) => repoIds.includes(r.id) || repoIds.includes(r.slug))
    : index.repos;

  const summary = [];
  for (const repo of targets) {
    const packedPath = repo.packedContextPath;
    if (!packedPath || !(await fileExists(packedPath))) {
      summary.push({ repo: repo.id, skipped: "no packed-context" });
      continue;
    }

    const stat = await fs.stat(packedPath);
    const sourceMtime = stat.mtimeMs;
    const MAX_CONTENT_SIZE = 30 * 1024 * 1024; // 30 MB cap
    if (stat.size > MAX_CONTENT_SIZE) {
      summary.push({ repo: repo.id, skipped: `too large (${(stat.size / 1024 / 1024).toFixed(0)} MB)` });
      continue;
    }

    const existing = await loadRepoContent(repo.slug);
    if (!force && existing && existing.sourceMtime === sourceMtime) {
      summary.push({ repo: repo.id, chunks: existing.entries.length, reused: true });
      continue;
    }

    try {
      const content = await fs.readFile(packedPath, "utf8");
      const chunks = chunkText(content);
      if (!chunks.length) {
        summary.push({ repo: repo.id, skipped: "no chunks" });
        continue;
      }

      const entries = [];
      // Token-aware batching with offsets for chunk IDs.
      const tokenBatches = batchByTokens(chunks);
      const contentBatches = [];
      let chunkOffset = 0;
      for (const tb of tokenBatches) {
        contentBatches.push({ offset: chunkOffset, texts: tb });
        chunkOffset += tb.length;
      }
      let contentCursor = 0;
      const contentWorkers = Array.from({ length: Math.min(EMBED_CONCURRENCY, contentBatches.length) }, async () => {
        while (true) {
          const idx = contentCursor++;
          if (idx >= contentBatches.length) return;
          const { offset, texts } = contentBatches[idx];
          const vectors = await callEmbeddings(texts);
          texts.forEach((text, j) => {
            entries.push({
              id: `${repo.id}#content-${offset + j}`,
              entityId: repo.id,
              entityTitle: repo.title,
              type: "repo",
              kind: "content",
              chunkIndex: offset + j,
              text,
              hash: sha1(text),
              vector: vectors[j],
            });
          });
        }
      });
      await Promise.all(contentWorkers);

      await saveRepoContent(repo.slug, {
        model: EMBEDDING_MODEL,
        generatedAt: new Date().toISOString(),
        sourceMtime,
        entries,
      });
      summary.push({ repo: repo.id, chunks: entries.length, reused: false });
    } catch (err) {
      summary.push({ repo: repo.id, skipped: `error: ${err.message ?? err}`.slice(0, 200) });
    }
  }

  return summary;
}

export async function semanticSearch(query, { topK = 10, types = null, scope = null, deep = false } = {}) {
  const store = await loadEmbeddings();
  if (!store.entries.length) {
    throw new Error("Embedding index is empty. Run `kb embed` first.");
  }
  const [vector] = await callEmbeddings([query]);

  let pool = types ? store.entries.filter((e) => types.includes(e.type)) : store.entries.slice();

  // Pull in repo content chunks if scope or deep is set.
  if (scope || deep) {
    const index = await loadIndex();
    const repos = scope
      ? index.repos.filter((r) => scope.includes(r.id) || scope.includes(r.slug))
      : index.repos;
    for (const repo of repos) {
      const contentStore = await loadRepoContent(repo.slug);
      if (contentStore?.entries?.length) {
        pool = pool.concat(contentStore.entries);
      }
    }
  }

  const scored = pool.map((entry) => ({
    score: cosine(vector, entry.vector),
    entry,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
