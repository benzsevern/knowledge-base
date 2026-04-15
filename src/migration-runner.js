// One-off migration: kb_index.json + kb_embeddings.json -> Postgres.
// Invoked via POST /api/admin/migrate-data so it runs inside Railway with
// access to /app/vault and the internal Postgres network.
//
// Design constraints:
// - kb_embeddings.json on Railway is multi-GB (700K × 1536-dim vectors).
//   We stream it line-by-line — never hold the full parsed array in memory.
// - kb_index.json is ~100MB once 912K relations are present. We load it via
//   fs-utils.readJson which stream-parses files >50MB.
// - All inserts are batched with multi-VALUES to minimize round trips.
// - HNSW vector index is deferred to the end — 10-100× faster than building
//   incrementally during insert.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { readJson } from "./fs-utils.js";
import { db, hasDatabase } from "./db.js";

const VAULT = process.env.KB_VAULT_ROOT || "/app/vault";
const INDEX_FILE = path.join(VAULT, "kb_index.json");
const EMBEDDINGS_FILE = path.join(VAULT, "kb_embeddings.json");
const REPOS_DIR = path.join(VAULT, "repos");

const ENTITY_BATCH = 500;
const RELATION_BATCH = 2000;
const EMBEDDING_BATCH = 200;

// Yield to the event loop so /api/ping and /api/jobs/:id can respond during
// heavy batch inserts. Without this, Railway healthchecks can time out and
// kill the container mid-migration.
function yieldLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Postgres TEXT and JSONB columns reject raw NUL bytes (0x00). Marker-extracted
// PDF text occasionally contains them as control-character noise. Strip them
// before any INSERT — they carry no meaning in our corpus.
function stripNul(value) {
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

// ---------------------------------------------------------------------------
// Batch insert helpers. Build a multi-VALUES statement with positional
// parameters and execute in one round trip.
// ---------------------------------------------------------------------------

async function insertEntities(client, rows) {
  if (!rows.length) return 0;
  const cols = ["id", "type", "slug", "title", "meta"];
  const values = [];
  const placeholders = [];
  rows.forEach((r, i) => {
    const base = i * cols.length;
    placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`);
    values.push(
      stripNul(r.id),
      stripNul(r.type),
      stripNul(r.slug),
      stripNul(r.title ?? r.slug ?? r.id),
      JSON.stringify(stripNul(r.meta ?? {})),
    );
  });
  const sql =
    `INSERT INTO entities (${cols.join(",")}) VALUES ${placeholders.join(",")} ` +
    `ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, slug = EXCLUDED.slug, ` +
    `title = EXCLUDED.title, meta = EXCLUDED.meta, updated_at = now()`;
  await client.query(sql, values);
  return rows.length;
}

async function insertRelations(client, rows) {
  if (!rows.length) return 0;
  const cols = ["from_id", "to_id", "relation_type", "score", "evidence", "note_path"];
  const values = [];
  const placeholders = [];
  rows.forEach((r, i) => {
    const base = i * cols.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`,
    );
    values.push(
      stripNul(r.fromId),
      stripNul(r.toId),
      stripNul(r.relationType),
      r.score ?? null,
      JSON.stringify(stripNul(r.evidence ?? null)),
      stripNul(r.notePath ?? null),
    );
  });
  const sql =
    `INSERT INTO relations (${cols.join(",")}) VALUES ${placeholders.join(",")} ` +
    `ON CONFLICT (from_id, to_id, relation_type) DO UPDATE SET ` +
    `score = EXCLUDED.score, evidence = EXCLUDED.evidence, note_path = EXCLUDED.note_path, updated_at = now()`;
  await client.query(sql, values);
  return rows.length;
}

async function insertEmbeddings(client, rows) {
  if (!rows.length) return 0;
  const cols = ["id", "entity_id", "kind", "chunk_index", "text", "embedding"];
  const values = [];
  const placeholders = [];
  rows.forEach((r, i) => {
    const base = i * cols.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector)`,
    );
    // pgvector accepts "[0.1,0.2,...]" string form
    const vecLiteral = `[${r.embedding.join(",")}]`;
    values.push(
      stripNul(r.id),
      stripNul(r.entityId),
      stripNul(r.kind),
      r.chunkIndex ?? null,
      stripNul(r.text ?? null),
      vecLiteral,
    );
  });
  const sql =
    `INSERT INTO embeddings (${cols.join(",")}) VALUES ${placeholders.join(",")} ` +
    `ON CONFLICT (id) DO NOTHING`;
  await client.query(sql, values);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Entity + relation shapes: map the on-disk record to the DB row shape.
// On-disk entities keep many fields (authors, year, languages, etc.) — those
// go into `meta` as JSONB so we don't need to schema-evolve for every new
// field.
// ---------------------------------------------------------------------------

function entityRow(record, type) {
  // Pull out the columns we query on, leave the rest in meta.
  const { id, slug, title, type: _type, ...rest } = record;
  return {
    id,
    type,
    slug,
    title: title ?? slug ?? id,
    meta: rest, // everything else
  };
}

// ---------------------------------------------------------------------------
// Streaming embeddings reader. kb_embeddings.json is written by fs-utils.js
// writeJson() with one entry per line inside the "entries" array:
//
//   {
//     "model": "text-embedding-3-small",
//     "generatedAt": "...",
//     "entries": [
//       {"id": "...", "entityId": "...", ...},    <-- one per line
//       {"id": "...", "entityId": "...", ...},
//       ...
//     ]
//   }
//
// We line-scan, detect the `entries` array open/close, and yield parsed
// entries one at a time. Each line holds one full JSON object.
// ---------------------------------------------------------------------------

async function* streamEmbeddingEntries(filepath) {
  // Brace/quote-aware streaming parser — tolerates both the compact format
  // (one JSON object per line) produced by fs-utils.writeJson() AND the
  // pretty-printed format produced by plain JSON.stringify(data, null, 2).
  //
  // Approach: read the file as a character stream, skip until we're inside
  // the "entries": [ ... ] array, then yield each balanced {...} block.
  const stream = fs.createReadStream(filepath, { encoding: "utf8", highWaterMark: 1024 * 1024 });

  let inEntries = false;
  let depth = 0;          // brace depth inside current entry (0 = between entries)
  let inString = false;   // inside a JSON string
  let escaped = false;    // previous char was a backslash
  let buf = "";           // accumulates current entry

  // Look for the sentinel '"entries":'. We'll treat the next '[' as the
  // start of the entries array.
  const SENTINEL = '"entries"';
  let sentinelHit = false;

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (!inEntries) {
        if (!sentinelHit) {
          // Crude substring search via a rolling buffer. entries token
          // appears exactly once at top level.
          buf += ch;
          if (buf.length > SENTINEL.length + 2) buf = buf.slice(-SENTINEL.length - 2);
          if (buf.includes(SENTINEL)) {
            sentinelHit = true;
            buf = "";
          }
        } else if (ch === "[") {
          inEntries = true;
          buf = "";
        }
        continue;
      }

      // We're inside the entries array.
      if (depth === 0) {
        if (ch === "]") return;           // end of array — done
        if (ch === "{") {
          depth = 1;
          buf = "{";
        }
        // skip whitespace and commas between entries
        continue;
      }

      // depth >= 1 — accumulating one entry
      buf += ch;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            yield JSON.parse(buf);
          } catch {
            // Skip malformed entry — single bad object shouldn't abort the run.
          }
          buf = "";
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main migration entry point. Yields progress snapshots via onProgress().
// ---------------------------------------------------------------------------

export async function runDataMigration({ onProgress = () => {}, dryRun = false } = {}) {
  if (!hasDatabase()) throw new Error("DATABASE_URL not set");

  const startedAt = Date.now();
  const stats = {
    papers: 0,
    repos: 0,
    docs: 0,
    relations: 0,
    embeddings: 0,
    hnswBuildMs: 0,
    vacuumMs: 0,
    durationMs: 0,
    indexFile: INDEX_FILE,
    embeddingsFile: EMBEDDINGS_FILE,
    dryRun,
  };

  const pool = db();
  const client = await pool.connect();

  try {
    // -------------------------------------------------------------------
    // Pass 1: entities + relations from kb_index.json
    // -------------------------------------------------------------------
    onProgress({ stage: "load-index", stats });
    if (!fs.existsSync(INDEX_FILE)) throw new Error(`Missing ${INDEX_FILE}`);
    const index = await readJson(INDEX_FILE, null);
    if (!index) throw new Error("Index failed to parse");

    const papers = index.papers ?? [];
    const repos = index.repos ?? [];
    const docs = index.docs ?? [];
    const relations = index.relations ?? [];

    onProgress({
      stage: "index-loaded",
      counts: {
        papers: papers.length,
        repos: repos.length,
        docs: docs.length,
        relations: relations.length,
      },
    });

    // Entities — one pass per type. Upserts are idempotent, so reruns are safe.
    for (const [type, arr] of [["paper", papers], ["repo", repos], ["docs", docs]]) {
      const statsKey = type === "docs" ? "docs" : `${type}s`;
      for (let i = 0; i < arr.length; i += ENTITY_BATCH) {
        const slice = arr.slice(i, i + ENTITY_BATCH).map((r) => entityRow(r, type));
        if (!dryRun) await insertEntities(client, slice);
        stats[statsKey] += slice.length;
        await yieldLoop();
        if (i % (ENTITY_BATCH * 10) === 0) {
          onProgress({ stage: `entities-${type}`, written: stats, elapsedMs: Date.now() - startedAt });
        }
      }
    }
    onProgress({ stage: "entities-done", stats });

    // Relations — big. Entities are already loaded, FK checks on insert are cheap.
    for (let i = 0; i < relations.length; i += RELATION_BATCH) {
      const slice = relations.slice(i, i + RELATION_BATCH);
      if (!dryRun) await insertRelations(client, slice);
      stats.relations += slice.length;
      await yieldLoop();
      if (i % (RELATION_BATCH * 10) === 0) {
        onProgress({ stage: "relations", written: stats.relations, total: relations.length, elapsedMs: Date.now() - startedAt });
      }
    }
    onProgress({ stage: "relations-done", stats });

    // -------------------------------------------------------------------
    // Pass 2: embeddings
    //   2a: kb_embeddings.json     — paper chunks + repo/docs summaries (~27K)
    //   2b: vault/repos/*/embeddings.json — per-repo deep content chunks (~680K)
    // -------------------------------------------------------------------
    async function drainBuffer(buffer, skipCounter, force = false) {
      if (!buffer.length) return;
      if (!force && buffer.length < EMBEDDING_BATCH) return;
      if (dryRun) {
        stats.embeddings += buffer.length;
        buffer.length = 0;
        return;
      }
      try {
        await insertEmbeddings(client, buffer);
        stats.embeddings += buffer.length;
      } catch {
        for (const row of buffer) {
          try {
            await insertEmbeddings(client, [row]);
            stats.embeddings += 1;
          } catch {
            skipCounter.v += 1;
          }
        }
      }
      buffer.length = 0;
    }

    function coerceEntry(entry) {
      // Handle both field names — `vector` is the actual on-disk name, but
      // future writers might use `embedding`. Accept either.
      const vec = entry.vector ?? entry.embedding;
      if (!vec || !Array.isArray(vec) || vec.length !== 1536) return null;
      if (!entry.entityId) return null;
      return {
        id: entry.id ?? `${entry.entityId}:${entry.chunkIndex ?? 0}`,
        entityId: entry.entityId,
        kind: entry.kind ?? (entry.chunkIndex != null ? "chunk" : "summary"),
        chunkIndex: entry.chunkIndex ?? null,
        text: entry.text ?? null,
        embedding: vec,
      };
    }

    const skipCounter = { v: 0 };

    if (fs.existsSync(EMBEDDINGS_FILE)) {
      onProgress({ stage: "embeddings-summary-start" });
      const buffer = [];
      let seen = 0;
      for await (const entry of streamEmbeddingEntries(EMBEDDINGS_FILE)) {
        seen += 1;
        const row = coerceEntry(entry);
        if (!row) {
          skipCounter.v += 1;
          continue;
        }
        buffer.push(row);
        if (buffer.length >= EMBEDDING_BATCH) {
          await drainBuffer(buffer, skipCounter);
          await yieldLoop();
          if (stats.embeddings % (EMBEDDING_BATCH * 25) === 0) {
            onProgress({
              stage: "embeddings-summary",
              seen,
              written: stats.embeddings,
              skipped: skipCounter.v,
              elapsedMs: Date.now() - startedAt,
            });
          }
        }
      }
      await drainBuffer(buffer, skipCounter, true);
      onProgress({ stage: "embeddings-summary-done", seen, skipped: skipCounter.v, written: stats.embeddings });
    } else {
      onProgress({ stage: "embeddings-summary-skipped", reason: "file-missing" });
    }

    // 2b: per-repo deep content embeddings
    onProgress({ stage: "embeddings-deep-start" });
    const repoSlugs = await fsp.readdir(REPOS_DIR).catch(() => []);
    let reposProcessed = 0;
    let reposWithEmbeddings = 0;
    for (const slug of repoSlugs) {
      const p = path.join(REPOS_DIR, slug, "embeddings.json");
      if (!fs.existsSync(p)) continue;
      reposWithEmbeddings += 1;
      try {
        const buffer = [];
        for await (const entry of streamEmbeddingEntries(p)) {
          const row = coerceEntry(entry);
          if (!row) {
            skipCounter.v += 1;
            continue;
          }
          buffer.push(row);
          if (buffer.length >= EMBEDDING_BATCH) {
            await drainBuffer(buffer, skipCounter);
            await yieldLoop();
          }
        }
        await drainBuffer(buffer, skipCounter, true);
      } catch (err) {
        onProgress({ stage: "embeddings-deep-repo-error", slug, error: err.message });
      }
      reposProcessed += 1;
      if (reposProcessed % 50 === 0) {
        onProgress({
          stage: "embeddings-deep",
          reposProcessed,
          reposWithEmbeddings,
          totalRepos: repoSlugs.length,
          written: stats.embeddings,
          skipped: skipCounter.v,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
    onProgress({
      stage: "embeddings-deep-done",
      reposProcessed,
      reposWithEmbeddings,
      written: stats.embeddings,
      skipped: skipCounter.v,
    });
    stats.skippedEmbeddings = skipCounter.v;

    // -------------------------------------------------------------------
    // Pass 3: build HNSW index + VACUUM ANALYZE
    // -------------------------------------------------------------------
    if (!dryRun) {
      onProgress({ stage: "hnsw-build-start" });
      const hnswStart = Date.now();
      await client.query(
        "CREATE INDEX IF NOT EXISTS embeddings_vec_idx ON embeddings USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)",
      );
      stats.hnswBuildMs = Date.now() - hnswStart;
      onProgress({ stage: "hnsw-build-done", ms: stats.hnswBuildMs });

      onProgress({ stage: "vacuum-start" });
      const vacuumStart = Date.now();
      // VACUUM can't run in a transaction — release the dedicated client
      // and use the pool default for this.
      await client.query("VACUUM ANALYZE entities");
      await client.query("VACUUM ANALYZE relations");
      await client.query("VACUUM ANALYZE embeddings");
      stats.vacuumMs = Date.now() - vacuumStart;
      onProgress({ stage: "vacuum-done", ms: stats.vacuumMs });
    }

    stats.durationMs = Date.now() - startedAt;
    return stats;
  } finally {
    client.release();
  }
}
