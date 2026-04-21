# Postgres + pgvector migration plan

**Status:** draft — awaiting execution approval
**Goal:** move entities, relations, and embeddings out of JSON files and into Postgres with pgvector. Fix the `rebuildLinks` OOM at 912K relations. Make search scale without loading the full vector index into memory.

---

## Scale (live Railway)

- 202 papers + 1321 repos + 17 docs = ~1.5K entities
- 913K relations
- 27.5K summary chunks + 680K deep-content chunks ≈ 700K embedding rows at 1536 dims
- Raw vector bytes: 700K × 1536 × 4 = **~4.3 GB** (plus pgvector overhead, ~6–8 GB on disk)
- Current OOM trigger: `rebuildLinks()` loads + rewrites the full `kb_index.json` (relations dominate size)

---

## Non-goals

- Don't change the MCP surface. `kb_search`, `kb_chat`, `kb_ingest_*` keep the same request/response shapes.
- Don't rewrite the CLI. `src/cli.js` keeps its current commands; it just talks to Postgres under the hood.
- Don't change Marker/ingestion behavior. PDFs, packed repos, docs pages still live on the vault volume — Postgres stores metadata + relations + embeddings only.
- Don't introduce an ORM. Raw SQL via `pg`, following the existing zero-dep / direct-httpx spirit.

---

## Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE entities (
  id          TEXT PRIMARY KEY,              -- e.g. "paper-arxiv-2508-08322"
  type        TEXT NOT NULL,                 -- 'paper' | 'repo' | 'docs'
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}',   -- everything else (authors, year, summary, etc.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX entities_type_idx ON entities(type);
CREATE INDEX entities_slug_idx ON entities(slug);

CREATE TABLE relations (
  from_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id          TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL,              -- 'paper-repo' | 'related' | ...
  score          REAL,
  evidence       JSONB,
  note_path      TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, relation_type)
);
CREATE INDEX relations_from_idx ON relations(from_id);
CREATE INDEX relations_to_idx   ON relations(to_id);
CREATE INDEX relations_type_idx ON relations(relation_type);

CREATE TABLE embeddings (
  id           TEXT PRIMARY KEY,              -- "entityId" or "entityId:chunkN"
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                 -- 'summary' | 'chunk' | 'deep'
  chunk_index  INTEGER,
  text         TEXT,                          -- the text that was embedded
  embedding    vector(1536) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX embeddings_entity_idx ON embeddings(entity_id);
CREATE INDEX embeddings_kind_idx   ON embeddings(kind);
-- HNSW index for ANN search. Built AFTER initial bulk load (much faster).
CREATE INDEX embeddings_vec_idx ON embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**Why this shape:**
- `entities.meta` as JSONB — the record shapes vary by type (paper has `authors`/`year`, repo has `languages`/`entrypoints`, docs has `pageCount`). Keeping the variable fields in JSONB avoids schema churn. Add columns later if we start filtering on them.
- `relations` with a composite PK makes upsert-by-triple natural and prevents duplicates.
- `embeddings.id` stays string-keyed to match the existing "entityId:chunkN" convention — smooth migration.
- `ON DELETE CASCADE` means `/api/delete-entity` becomes a one-liner.

---

## Phased execution

Each phase is independently shippable with a verification gate. We stop if a gate fails.

### Phase 0 — Infrastructure (est. 20 min)

1. Add a Railway Postgres service to the `knowledge-base` project.
2. Enable pgvector on that database (Railway's Postgres 16 ships with it; `CREATE EXTENSION vector`).
3. Link `DATABASE_URL` as a ref on `kb-api`'s service vars.
4. Install `pg` dependency: `npm i pg` (first prod dep besides `express`).
5. Add `src/db.js` with a singleton `pg.Pool` and a health-check helper.
6. Add `GET /api/db-health` endpoint returning `{ok, version, extensions}`.

**Gate:** `curl /api/db-health` returns `{"ok":true,"version":"PostgreSQL 16.x","extensions":["vector"]}`.

### Phase 1 — Schema + empty migration (est. 30 min)

1. Create `migrations/001_initial.sql` with the schema above.
2. On server startup, run any unapplied migrations (track in `schema_migrations` table — simple timestamp-keyed log).
3. Add `POST /api/admin/migrate` to manually trigger — useful for CI / emergencies.

**Gate:** Deploy, confirm `SELECT * FROM entities LIMIT 1` returns 0 rows with no error.

### Phase 2 — One-off data migration (est. 1 hr + bulk load time)

Write `scripts/migrate-to-postgres.js`:

1. Stream-parse `kb_index.json` via `readJson()` (already handles >50 MB).
2. Copy entities: `INSERT INTO entities (id, type, slug, title, meta) VALUES ...` in 1000-row batches.
3. Copy relations: same, in 5000-row batches (or use `COPY FROM STDIN` for speed).
4. Stream-parse `kb_embeddings.json`. For each chunk entry:
   - Insert `(id, entity_id, kind, chunk_index, text, embedding)` in 500-row batches.
   - Parse embedding array, serialize as `[0.1,0.2,...]` for pgvector.
5. Print per-table counts + final timing.
6. Run `VACUUM ANALYZE` on all three tables.
7. Finally: `CREATE INDEX ... USING hnsw` (deferred until after bulk load — 10-100x faster to build once than incrementally).

Run via `railway run node scripts/migrate-to-postgres.js` so it uses the prod `DATABASE_URL` and has access to `/app/vault/*.json`.

**Gate:**
- `SELECT count(*) FROM entities` = 1540 (202 + 1321 + 17)
- `SELECT count(*) FROM relations` = 913,738
- `SELECT count(*) FROM embeddings` ≈ 707K (summary + chunks + deep)
- Pick 5 random entities and spot-check that their `meta` JSONB matches the JSON file.

### Phase 3 — Dual-read (est. 3-4 hr)

Refactor read paths to hit Postgres but fall back to JSON if `DATABASE_URL` is unset:

- `indexer.js#loadIndex` — becomes `loadIndex()` with a `{ source: 'pg' | 'json' }` option, default 'pg'.
- `embeddings.js#semanticSearch` — becomes pgvector KNN: `SELECT entity_id, 1 - (embedding <=> $1) AS score FROM embeddings WHERE kind = $2 ORDER BY embedding <=> $1 LIMIT $3`.
- `server.js`'s `/api/status`, `/api/graph`, `/api/search`, `/api/context/:id` — PG reads.
- `rag.js#chat` unchanged (uses semanticSearch which is now PG-backed).

Keep JSON write paths intact. Nothing writes to PG yet.

**Gate:**
- `/api/status` matches JSON counts.
- Run 20 sample queries through `/api/search`, compare top-5 results to pre-migration output. pgvector HNSW is approximate — expect ≥80% top-5 overlap, not exact match.
- `/api/chat` returns sensible answers on 3 test questions.

### Phase 4 — Dual-write (est. 2-3 hr)

Writes go to both PG and JSON. If one fails, fail the whole request:

- `ingestPaper`, `ingestRepo`, `ingestDocsSite` — after JSON upsert, also PG upsert entity.
- `rebuildLinks` — after computing new relations, `BEGIN; DELETE FROM relations WHERE from_id = $1; INSERT ...; COMMIT;` instead of rewriting `kb_index.json`. Entity metadata and notes still land on disk.
- `buildEmbeddingIndex` / `buildContentIndex` — embed → insert into PG → also append to JSON for now.
- `/api/delete-entity` — PG `DELETE FROM entities WHERE id = $1` (cascades to relations + embeddings), then remove JSON entries, then remove vault dir.

**Gate:**
- Ingest one fresh arxiv paper end-to-end. No OOM. Present in both PG and JSON with matching ID/slug.
- Verify `rebuildLinks` no longer loads the full relations array into memory (RSS check during ingest).

### Phase 5 — Flip to PG-only (est. 1 hr)

Remove JSON write paths:
- Delete `saveIndex` + JSON writes in `indexer.js`, `commands.js`, `embeddings.js`.
- Remove `/api/patch-index`, `/api/recover-index`, `/api/import-index` (obsolete — SQL replaces them).
- `/api/delete-entity` stops touching JSON.
- Keep reading `kb_index.json` as cold-start fallback? **No.** Either we trust PG or we don't.

Keep the source files in `/app/vault/` (PDFs, packed repos, pages, notes) — those aren't the problem.

**Gate:**
- Full ingest → embed → search cycle on a new paper, PG-only.
- `rm /app/vault/kb_index.json /app/vault/kb_embeddings.json` in a preview env, confirm everything still works. (Don't do this in prod until a week of stable operation.)

### Phase 6 — Cleanup (future, not this PR train)

- Drop the JSON files from `/app/vault` (after confirming stable operation for 1-2 weeks).
- Backfill `papers.year` and `papers.authors` as proper columns once we start filtering on them.
- Consider: half-precision embeddings (`vector(1536)` → `halfvec(1536)`) to halve storage cost. pgvector 0.7+ supports it.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| pgvector HNSW returns different top-K than cosine-over-JSON | Accept it; HNSW is standard. Validate overlap ≥80% during Phase 3 gate. Can raise `ef_search` per query if recall matters more than latency. |
| Migration script takes hours / OOMs itself | Batch sizes (1000 entities, 5000 relations, 500 embeddings). Streaming JSON read. Build HNSW index AFTER bulk load, not during. |
| Postgres cost on Railway | Start small (Hobby plan). Watch storage — 6-8GB embeddings + 100MB everything else. Alert at 80%. |
| Connection pool exhaustion during ingest | Default pool size 10. Ingestion is sequential per worker, so fine. Batch operations use explicit client checkout. |
| Dropping JSON files prematurely breaks prod | Keep them read-only for 1-2 weeks after Phase 5. |
| pg driver pulls in unexpected deps | `pg` has exactly 6 deps, all small, all pure JS. Review `npm list pg` before commit. |
| We need to roll back | Phase 3 (dual-read) can be toggled via env var. Phase 4+ is harder — if we flip and find problems, we restore from JSON backup + replay ingests. **Tag `pre-pg-migration` on the commit before Phase 4.** |

---

## What I need from you before starting Phase 0

1. **Plan size.** Go ahead with "A → B → C" merged into the 6-phase plan above? Or split (A now, B+C later)?
2. **Railway plan.** OK to pay for a Postgres hobby plan ($5/mo) on the knowledge-base project? Storage will grow to 6-8GB so we'll need at least the hobby tier.
3. **Checkpoints.** Do you want me to stop for review between each phase, or run through to Phase 3 (read-only, reversible) before checking in?
4. **Cutover target.** Any deadline? If not, I'd target Phase 0-3 in one session (reversible), then pause before Phase 4 (dual-write) so you can sanity-check search quality.
