// Postgres connection pool + helpers. When DATABASE_URL is unset, db()
// returns null so callers can fall back to the legacy JSON path.
//
// Railway's private network uses IPv6 — the standard `pg` connection string
// handles that transparently as long as `?sslmode=require` or equivalent
// isn't overridden. Railway's Postgres image uses a self-signed cert, so we
// explicitly disable cert verification (the private network is the security
// boundary, not TLS).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pgPkg from "pg";
const { Pool } = pgPkg;

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

let _pool = null;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Self-signed cert on Railway's Postgres — skip verification. Private
      // network is the real trust boundary.
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    _pool.on("error", (err) => {
      // Never let an idle-connection error crash the process — log and let
      // the next checkout reconnect.
      console.error("[db] pool error:", err.message);
    });
  }
  return _pool;
}

export async function dbHealth() {
  if (!hasDatabase()) {
    return { ok: false, reason: "DATABASE_URL not set" };
  }
  try {
    const pool = db();
    const client = await pool.connect();
    try {
      const version = await client.query("SELECT version()");
      const exts = await client.query(
        "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector')",
      );
      return {
        ok: true,
        version: version.rows[0].version.split(" ").slice(0, 2).join(" "),
        extensions: exts.rows.map((r) => ({ name: r.extname, version: r.extversion })),
      };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Migrations — simple file-based runner. Each .sql file in migrations/ is
// applied once, in filename order. Applied migrations are recorded in the
// schema_migrations table. Failures abort and are surfaced to the caller.
// ---------------------------------------------------------------------------
export async function runMigrations() {
  if (!hasDatabase()) {
    return { skipped: true, reason: "DATABASE_URL not set" };
  }
  const pool = db();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map(
        (r) => r.filename,
      ),
    );
    const files = (await fs.readdir(migrationsDir).catch(() => []))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const ran = [];
    for (const filename of files) {
      if (applied.has(filename)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, filename), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
        ran.push(filename);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${filename} failed: ${err.message}`);
      }
    }
    return { ok: true, applied: ran, alreadyApplied: [...applied] };
  } finally {
    client.release();
  }
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
