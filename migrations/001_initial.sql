-- Initial schema for the knowledge base.
-- Entities (papers, repos, docs) + relations + embeddings.
-- Run by the server on startup via runMigrations() in src/db.js.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,                -- 'paper' | 'repo' | 'docs'
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(type);
CREATE INDEX IF NOT EXISTS entities_slug_idx ON entities(slug);

CREATE TABLE IF NOT EXISTS relations (
  from_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id          TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL,             -- 'paper-repo' | 'related' | ...
  score          REAL,
  evidence       JSONB,
  note_path      TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, relation_type)
);

CREATE INDEX IF NOT EXISTS relations_from_idx ON relations(from_id);
CREATE INDEX IF NOT EXISTS relations_to_idx   ON relations(to_id);
CREATE INDEX IF NOT EXISTS relations_type_idx ON relations(relation_type);

CREATE TABLE IF NOT EXISTS embeddings (
  id           TEXT PRIMARY KEY,             -- "entityId" (summary) or "entityId:chunkN"
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                -- 'summary' | 'chunk' | 'deep'
  chunk_index  INTEGER,
  text         TEXT,
  embedding    vector(1536) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embeddings_entity_idx ON embeddings(entity_id);
CREATE INDEX IF NOT EXISTS embeddings_kind_idx   ON embeddings(kind);

-- NOTE: the HNSW index on `embeddings.embedding` is NOT created here —
-- building it before bulk load is 10-100× slower. It's created by the
-- one-off migration script after data import (or can be created by hand
-- via /api/admin/build-vector-index once data is in place).
