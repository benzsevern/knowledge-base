// Postgres connection pool + helpers. When DATABASE_URL is unset, db()
// returns null so callers can fall back to the legacy JSON path.
//
// Railway's private network uses IPv6 — the standard `pg` connection string
// handles that transparently as long as `?sslmode=require` or equivalent
// isn't overridden. Railway's Postgres image uses a self-signed cert, so we
// explicitly disable cert verification (the private network is the security
// boundary, not TLS).

import pgPkg from "pg";
const { Pool } = pgPkg;

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

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
