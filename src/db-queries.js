// Postgres-backed read queries. Mirrors the shape of the JSON-backed
// functions in indexer.js + embeddings.js so call sites can swap cleanly.
//
// The feature flag `useDbReads()` is the single toggle — returns true when
// DATABASE_URL is set AND the entities table has rows. That way a misconfigured
// deploy (env var set but migration not run) transparently falls back to JSON.

import { stripNul } from "./fs-utils.js";
import { db, hasDatabase } from "./db.js";

let _cachedReady = null;
let _cachedReadyAt = 0;
const READY_CACHE_MS = 30_000;

export async function useDbReads() {
  if (!hasDatabase()) return false;
  const now = Date.now();
  if (_cachedReady !== null && now - _cachedReadyAt < READY_CACHE_MS) {
    return _cachedReady;
  }
  try {
    const { rows } = await db().query("SELECT count(*)::int AS c FROM entities");
    _cachedReady = rows[0].c > 0;
  } catch {
    _cachedReady = false;
  }
  _cachedReadyAt = now;
  return _cachedReady;
}

// Force the readiness probe to re-run — useful immediately after migration.
export function resetReadyCache() {
  _cachedReady = null;
}

// ---------------------------------------------------------------------------
// Row → record: inflate an entities row back into the JSON-shaped record
// callers expect. `meta` JSONB carries everything that isn't id/type/slug/title.
// ---------------------------------------------------------------------------
function inflate(row) {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    title: row.title,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    ...row.meta,
  };
}

function inflateRelation(row) {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    relationType: row.relation_type,
    score: row.score,
    evidence: row.evidence,
    notePath: row.note_path,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Status — cheap COUNTs only, avoids pulling entities.
// ---------------------------------------------------------------------------
export async function statusCounts() {
  const pool = db();
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM entities WHERE type = 'paper')  AS papers,
      (SELECT count(*)::int FROM entities WHERE type = 'repo')   AS repos,
      (SELECT count(*)::int FROM entities WHERE type = 'docs')   AS docs,
      (SELECT count(*)::int FROM relations)                      AS relations,
      (SELECT count(*)::int FROM embeddings)                     AS embeddings
  `);
  return rows[0];
}

// ---------------------------------------------------------------------------
// loadIndexPG — returns the same shape as indexer.loadIndex().
// Only use this when callers need the full graph; most read paths should
// use the narrower helpers below.
// ---------------------------------------------------------------------------
export async function loadIndexPG() {
  const pool = db();
  const [papersQ, reposQ, docsQ, relsQ] = await Promise.all([
    pool.query("SELECT * FROM entities WHERE type = 'paper'"),
    pool.query("SELECT * FROM entities WHERE type = 'repo'"),
    pool.query("SELECT * FROM entities WHERE type = 'docs'"),
    pool.query("SELECT * FROM relations"),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    papers: papersQ.rows.map(inflate),
    repos: reposQ.rows.map(inflate),
    docs: docsQ.rows.map(inflate),
    relations: relsQ.rows.map(inflateRelation),
  };
}

// ---------------------------------------------------------------------------
// findEntityPG — resolve by id, slug, title, or repoName.
// ---------------------------------------------------------------------------
export async function findEntityPG(identifier) {
  if (!identifier) return null;
  const { rows } = await db().query(
    `SELECT * FROM entities
     WHERE id = $1 OR slug = $1 OR title = $1 OR meta->>'repoName' = $1
     LIMIT 1`,
    [identifier],
  );
  return rows[0] ? inflate(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// linkedEntitiesPG — resolve relations involving an entity. Returns the list
// of linked records (already inflated), in both directions. Used by
// /api/context/:id and the topic-brief / literature-review paths.
// ---------------------------------------------------------------------------
export async function linkedEntitiesPG(entityId) {
  const { rows } = await db().query(
    `SELECT e.*, r.relation_type, r.score
       FROM relations r
       JOIN entities e ON e.id = (CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END)
       WHERE r.from_id = $1 OR r.to_id = $1`,
    [entityId],
  );
  return rows.map((r) => ({ ...inflate(r), relationType: r.relation_type, relationScore: r.score }));
}

// ---------------------------------------------------------------------------
// semanticSearchPG — pgvector KNN over the embeddings table, with optional
// filters:
//   - types:  ['paper','repo','docs']  — entity-type filter (joins entities)
//   - scope:  ['repoId1', 'repoSlug2'] — restrict to chunks from specific repos
//   - deep:   boolean                  — include 'deep' kind chunks (default off)
//
// By default we search 'summary' + 'chunk' embeddings; 'deep' is opt-in via
// scope or deep=true because it's the bulk of the rows.
// ---------------------------------------------------------------------------
export async function semanticSearchPG(queryVector, { topK = 10, types = null, scope = null, deep = false } = {}) {
  const pool = db();
  const client = await pool.connect();
  const vecLiteral = `[${queryVector.join(",")}]`;

  try {
    // IVFFlat with lists=900; default probes=1 scans one cluster (~900 vectors),
    // too sparse. `probes = sqrt(lists)` ≈ 30 is the standard guidance; 15 is a
    // good speed/recall tradeoff. SET LOCAL requires an explicit transaction —
    // without BEGIN the setting resets before the next statement (autocommit).
    await client.query("BEGIN");
    await client.query("SET LOCAL ivfflat.probes = 15");

    // Resolve scope (repo IDs or slugs) to canonical IDs up front.
    let scopeIds = null;
    if (scope && scope.length) {
      const { rows } = await client.query(
        `SELECT id FROM entities WHERE type = 'repo' AND (id = ANY($1) OR slug = ANY($1))`,
        [scope],
      );
      scopeIds = rows.map((r) => r.id);
    }

    const conditions = [];
    const params = [vecLiteral];
    let p = 2;

    // Deep/content chunks were written with kind='content' by buildContentIndex
    // (migrated as-is). Include both spellings so legacy/future data works.
    const kinds = deep || scopeIds?.length
      ? ["summary", "chunk", "deep", "content"]
      : ["summary", "chunk"];
    conditions.push(`em.kind = ANY($${p}::text[])`);
    params.push(kinds);
    p += 1;

    if (types && types.length) {
      conditions.push(`e.type = ANY($${p}::text[])`);
      params.push(types);
      p += 1;
    }
    if (scopeIds?.length) {
      conditions.push(`em.entity_id = ANY($${p}::text[])`);
      params.push(scopeIds);
      p += 1;
    }

    const sql = `
      SELECT em.id, em.entity_id, em.kind, em.chunk_index, em.text,
             e.type, e.title,
             1 - (em.embedding <=> $1::vector) AS score
      FROM embeddings em
      JOIN entities e ON e.id = em.entity_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY em.embedding <=> $1::vector
      LIMIT $${p}
    `;
    params.push(topK);

    const { rows } = await client.query(sql, params);
    await client.query("COMMIT");
    // Return shape matches the JSON-era semanticSearch:
    //   [{ score, entry: { entityId, entityTitle, type, kind, text, ... } }]
    return rows.map((r) => ({
      score: r.score,
      entry: {
        id: r.id,
        entityId: r.entity_id,
        entityTitle: r.title,
        type: r.type,
        kind: r.kind,
        chunkIndex: r.chunk_index,
        text: r.text,
      },
    }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// listEntityEmbeddingsPG — one representative vector per entity.
//   - Prefers the kind='summary' row when it exists (today: only repos).
//   - Falls back to the centroid (avg) of all chunks for entities without one.
//
// Consumers need "a vector that represents this entity as a whole" — summary
// when available is cleanest, centroid is the natural fallback. Used by
// golden-showcase's knowledge-map generator to UMAP-project all entities
// to 2D in one shot. Not paginated — corpus is ~1.5K entities.
// Vector is serialized via ::text and parsed client-side.
// ---------------------------------------------------------------------------
export async function listEntityEmbeddingsPG() {
  const pool = db();
  const { rows } = await pool.query(`
    WITH summary AS (
      SELECT entity_id, embedding
      FROM embeddings
      WHERE kind = 'summary'
    ),
    centroid AS (
      SELECT entity_id, avg(embedding) AS embedding
      FROM embeddings
      GROUP BY entity_id
    )
    SELECT e.id, e.type, e.title, e.slug,
           e.meta->>'year' AS year,
           COALESCE(s.embedding, c.embedding)::text AS vector_text,
           CASE WHEN s.embedding IS NOT NULL THEN 'summary' ELSE 'centroid' END AS source
    FROM entities e
    LEFT JOIN summary s  ON s.entity_id = e.id
    LEFT JOIN centroid c ON c.entity_id = e.id
    WHERE COALESCE(s.embedding, c.embedding) IS NOT NULL
    ORDER BY e.id
  `);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    slug: r.slug,
    year: r.year ?? null,
    source: r.source,
    vector: JSON.parse(r.vector_text),
  }));
}

// ---------------------------------------------------------------------------
// loadEntitiesOnlyPG — same shape as loadIndexPG but omits relations.
// Used by Phase 4 ingest paths so we never load the 913K-relation JSON.
// ---------------------------------------------------------------------------
export async function loadEntitiesOnlyPG() {
  const pool = db();
  const [papersQ, reposQ, docsQ] = await Promise.all([
    pool.query("SELECT * FROM entities WHERE type = 'paper'"),
    pool.query("SELECT * FROM entities WHERE type = 'repo'"),
    pool.query("SELECT * FROM entities WHERE type = 'docs'"),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    papers: papersQ.rows.map(inflate),
    repos: reposQ.rows.map(inflate),
    docs: docsQ.rows.map(inflate),
    relations: [],
  };
}

// ---------------------------------------------------------------------------
// upsertEntityPG — dual-write a single entity alongside the JSON index update.
// ---------------------------------------------------------------------------
export async function upsertEntityPG(entity, type) {
  const { id, slug, title, createdAt, updatedAt, type: _type, ...meta } = entity;
  // stripNul: Marker PDF extraction can produce \u0000 bytes; Postgres JSONB rejects them.
  await db().query(
    `INSERT INTO entities (id, type, slug, title, meta, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       slug = EXCLUDED.slug, title = EXCLUDED.title,
       meta = EXCLUDED.meta, updated_at = EXCLUDED.updated_at`,
    [
      stripNul(id),
      type,
      stripNul(slug ?? id),
      stripNul(title ?? id),
      JSON.stringify(stripNul(meta)),
      createdAt ? new Date(createdAt) : new Date(),
      updatedAt ? new Date(updatedAt) : new Date(),
    ],
  );
}

// ---------------------------------------------------------------------------
// replaceRelationsPG — atomically replace all relations in one transaction.
// Relation objects must have: fromId, toId, relationType, score, evidence, notePath.
// ---------------------------------------------------------------------------
// Insert a single batch of relation rows. Used by rebuildLinks streaming path.
export async function insertRelationBatchPG(batch) {
  if (!batch.length) return;
  const cols = ["from_id", "to_id", "relation_type", "score", "evidence", "note_path"];
  const values = [];
  const placeholders = [];
  batch.forEach((r, j) => {
    const base = j * cols.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`,
    );
    values.push(
      r.fromId,
      r.toId,
      r.relationType,
      r.score ?? null,
      JSON.stringify(r.evidence ?? []),
      r.notePath ?? null,
    );
  });
  await db().query(
    `INSERT INTO relations (${cols.join(",")}) VALUES ${placeholders.join(",")}
     ON CONFLICT (from_id, to_id, relation_type) DO UPDATE SET
       score = EXCLUDED.score, evidence = EXCLUDED.evidence,
       note_path = EXCLUDED.note_path, updated_at = now()`,
    values,
  );
}

// ---------------------------------------------------------------------------
// Embedding writes: dual-write from buildEmbeddingIndex / buildContentIndex.
// Rows must have: id, entityId, kind, chunkIndex, text, vector (1536-dim array).
// ON CONFLICT updates the embedding+text so re-embed (force=true) overwrites.
// ---------------------------------------------------------------------------
export async function upsertEmbeddingBatchPG(batch) {
  if (!batch.length) return;
  const cols = ["id", "entity_id", "kind", "chunk_index", "text", "embedding"];
  const values = [];
  const placeholders = [];
  batch.forEach((r, j) => {
    const base = j * cols.length;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector)`,
    );
    values.push(
      stripNul(r.id),
      stripNul(r.entityId),
      stripNul(r.kind),
      r.chunkIndex ?? null,
      stripNul(r.text ?? null),
      `[${r.vector.join(",")}]`,
    );
  });
  await db().query(
    `INSERT INTO embeddings (${cols.join(",")}) VALUES ${placeholders.join(",")}
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind, chunk_index = EXCLUDED.chunk_index,
       text = EXCLUDED.text, embedding = EXCLUDED.embedding`,
    values,
  );
}

// Remove all embedding rows for a given entity. Used when an entity is
// deleted, or before a force re-embed to clear stale orphan chunks.
export async function deleteEmbeddingsForEntityPG(entityId) {
  if (!entityId) return 0;
  const { rowCount } = await db().query(
    "DELETE FROM embeddings WHERE entity_id = $1",
    [entityId],
  );
  return rowCount ?? 0;
}

// Hard-delete an entity and anything referencing it. Relations FK is
// ON DELETE CASCADE on entities? Check migration — if not, delete explicitly.
export async function deleteEntityPG(entityId) {
  if (!entityId) return false;
  const pool = db();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM relations WHERE from_id = $1 OR to_id = $1",
      [entityId],
    );
    // embeddings has ON DELETE CASCADE on entity_id, so deleting the entity
    // row removes them. But belt-and-suspenders:
    await client.query("DELETE FROM embeddings WHERE entity_id = $1", [entityId]);
    const { rowCount } = await client.query(
      "DELETE FROM entities WHERE id = $1",
      [entityId],
    );
    await client.query("COMMIT");
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
