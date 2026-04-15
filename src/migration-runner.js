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

const ENTITY_BATCH = 500;
const RELATION_BATCH = 2000;
const EMBEDDING_BATCH = 200;

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
    values.push(r.id, r.type, r.slug, r.title, JSON.stringify(r.meta));
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
      r.fromId,
      r.toId,
      r.relationType,
      r.score ?? null,
      JSON.stringify(r.evidence ?? null),
      r.notePath ?? null,
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
    values.push(r.id, r.entityId, r.kind, r.chunkIndex ?? null, r.text ?? null, vecLiteral);
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
  const stream = fs.createReadStream(filepath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let inEntries = false;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!inEntries) {
      if (/^"entries":\s*\[$/.test(line)) {
        inEntries = true;
      }
      continue;
    }
    if (line === "]" || line === "],") break;
    if (line.startsWith("{")) {
      const clean = line.endsWith(",") ? line.slice(0, -1) : line;
      try {
        yield JSON.parse(clean);
      } catch {
        // Skip malformed line — the source index can be noisy at the edges.
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

    if (!dryRun) {
      // Entities — one pass per type (not strictly necessary, but keeps
      // stats clean). Upserts are idempotent so reruns are safe.
      for (const [type, arr] of [["paper", papers], ["repo", repos], ["docs", docs]]) {
        for (let i = 0; i < arr.length; i += ENTITY_BATCH) {
          const slice = arr.slice(i, i + ENTITY_BATCH).map((r) => entityRow(r, type));
          await insertEntities(client, slice);
          stats[type === "docs" ? "docs" : `${type}s`] += slice.length;
          if (i % (ENTITY_BATCH * 10) === 0) {
            onProgress({ stage: `entities-${type}`, written: stats, elapsedMs: Date.now() - startedAt });
          }
        }
      }
      onProgress({ stage: "entities-done", stats });

      // Relations — big. Disable triggers / FK during bulk? Not needed;
      // entities are already loaded and FK checks on insert are fast.
      for (let i = 0; i < relations.length; i += RELATION_BATCH) {
        const slice = relations.slice(i, i + RELATION_BATCH);
        await insertRelations(client, slice);
        stats.relations += slice.length;
        if (i % (RELATION_BATCH * 10) === 0) {
          onProgress({ stage: "relations", written: stats.relations, total: relations.length, elapsedMs: Date.now() - startedAt });
        }
      }
      onProgress({ stage: "relations-done", stats });
    }

    // -------------------------------------------------------------------
    // Pass 2: embeddings — streamed
    // -------------------------------------------------------------------
    if (fs.existsSync(EMBEDDINGS_FILE)) {
      onProgress({ stage: "embeddings-start" });
      const buffer = [];
      let seen = 0;
      let skipped = 0;
      for await (const entry of streamEmbeddingEntries(EMBEDDINGS_FILE)) {
        seen += 1;
        if (!entry.embedding || !Array.isArray(entry.embedding) || entry.embedding.length !== 1536) {
          skipped += 1;
          continue;
        }
        if (!entry.entityId) {
          skipped += 1;
          continue;
        }
        const row = {
          id: entry.id ?? `${entry.entityId}:${entry.chunkIndex ?? 0}`,
          entityId: entry.entityId,
          kind: entry.kind ?? (entry.chunkIndex != null ? "chunk" : "summary"),
          chunkIndex: entry.chunkIndex ?? null,
          text: entry.text ?? null,
          embedding: entry.embedding,
        };
        buffer.push(row);
        if (buffer.length >= EMBEDDING_BATCH) {
          if (!dryRun) {
            try {
              await insertEmbeddings(client, buffer);
              stats.embeddings += buffer.length;
            } catch (err) {
              // Individual batch failures (missing parent entity, etc.) —
              // fall back to per-row so one bad row doesn't kill a batch.
              for (const row of buffer) {
                try {
                  await insertEmbeddings(client, [row]);
                  stats.embeddings += 1;
                } catch {
                  skipped += 1;
                }
              }
            }
          } else {
            stats.embeddings += buffer.length;
          }
          buffer.length = 0;
          if (stats.embeddings % (EMBEDDING_BATCH * 25) === 0) {
            onProgress({
              stage: "embeddings",
              seen,
              written: stats.embeddings,
              skipped,
              elapsedMs: Date.now() - startedAt,
            });
          }
        }
      }
      if (buffer.length) {
        if (!dryRun) {
          try {
            await insertEmbeddings(client, buffer);
            stats.embeddings += buffer.length;
          } catch {
            for (const row of buffer) {
              try {
                await insertEmbeddings(client, [row]);
                stats.embeddings += 1;
              } catch {
                skipped += 1;
              }
            }
          }
        } else {
          stats.embeddings += buffer.length;
        }
      }
      onProgress({ stage: "embeddings-done", seen, skipped, stats });
    } else {
      onProgress({ stage: "embeddings-skipped", reason: "file-missing" });
    }

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
