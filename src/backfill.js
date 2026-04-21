// Backfill LLM-generated summaries over existing entities.
// Reads each entity's raw markdown from disk, re-runs llmSummarize, and
// UPDATE-s the meta JSONB in-place. Skips entities that already have a
// populated topics array (marker of the new LLM pipeline) unless force=true.

import fs from "node:fs/promises";
import path from "node:path";

import { db } from "./db.js";
import { stripNul } from "./fs-utils.js";
import { llmSummarize } from "./llm-summarize.js";
import { llmSummarizeRepo } from "./llm-repo-summarize.js";

async function readEntityMarkdown(meta) {
  const notePath = meta?.notePath;
  if (!notePath) return "";
  const dir = path.dirname(notePath);
  const rawDir = path.join(dir, "raw");
  try {
    const files = await fs.readdir(rawDir);
    const md = files.find((f) => f.endsWith(".md"));
    if (md) {
      const full = await fs.readFile(path.join(rawDir, md), "utf8");
      if (full) return full;
    }
  } catch {
    // fall through to markdownExcerpt
  }
  return String(meta.markdownExcerpt ?? "");
}

export async function backfillSummaries({
  force = false,
  limit = null,
  concurrency = 2,
  onProgress,
} = {}) {
  const pool = db();

  // Articles and academic_papers are the two sub-types we LLM-summarize.
  // We skip rows that already carry a populated `topics` array unless force=true.
  let sql = `
    SELECT id, type, slug, title, meta
      FROM entities
     WHERE type IN ('article','academic_paper')
  `;
  if (!force) {
    sql +=
      " AND (meta->>'topics' IS NULL OR meta->>'topics' = '' OR meta->>'topics' = '[]')";
  }
  sql += " ORDER BY id";
  if (limit) sql += ` LIMIT ${Number(limit)}`;

  const { rows } = await pool.query(sql);
  const total = rows.length;
  const stats = { total, updated: 0, failed: 0, skipped: 0 };

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= total) return;
      const row = rows[i];
      try {
        const markdown = await readEntityMarkdown(row.meta);
        if (!markdown || markdown.length < 200) {
          stats.skipped += 1;
          continue;
        }
        const llm = await llmSummarize(markdown).catch(() => null);
        if (!llm) {
          stats.failed += 1;
          continue;
        }
        const newMeta = {
          ...row.meta,
          summary: llm.summary || row.meta.summary || "",
          methodologySummary: llm.methodology ?? row.meta.methodologySummary ?? "",
          constraintsSummary: llm.constraints ?? row.meta.constraintsSummary ?? "",
          topics: llm.topics ?? [],
        };
        // Merge new topics into tags (dedup).
        if (Array.isArray(row.meta.tags) && Array.isArray(llm.topics)) {
          const t = new Set([...row.meta.tags, ...llm.topics]);
          newMeta.tags = [...t];
        }
        await pool.query(
          "UPDATE entities SET meta = $1::jsonb, updated_at = now() WHERE id = $2",
          [JSON.stringify(stripNul(newMeta)), row.id],
        );
        stats.updated += 1;
      } catch (err) {
        stats.failed += 1;
        process.stderr.write(`[backfill] ${row.id}: ${err.message}\n`);
      }
      if (onProgress && (stats.updated + stats.failed + stats.skipped) % 5 === 0) {
        onProgress({ ...stats, index: stats.updated + stats.failed + stats.skipped });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  return stats;
}

// ---------------------------------------------------------------------------
// Repo-variant backfill. Reads README + packed-context, calls
// llmSummarizeRepo, and stores { summary, purpose, architecture, usage,
// topics } in meta. Skips rows with populated topics unless force=true.
// ---------------------------------------------------------------------------
export async function backfillRepoSummaries({
  force = false,
  limit = null,
  concurrency = 2,
  onProgress,
} = {}) {
  const pool = db();

  let sql = `
    SELECT id, type, slug, title, meta
      FROM entities
     WHERE type = 'repo'
  `;
  if (!force) {
    sql +=
      " AND (meta->>'topics' IS NULL OR meta->>'topics' = '' OR meta->>'topics' = '[]')";
  }
  sql += " ORDER BY id";
  if (limit) sql += ` LIMIT ${Number(limit)}`;

  const { rows } = await pool.query(sql);
  const total = rows.length;
  const stats = { total, updated: 0, failed: 0, skipped: 0 };

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= total) return;
      const row = rows[i];
      try {
        // Pass the inflated record so llmSummarizeRepo can read disk paths.
        const repo = { ...row.meta, id: row.id, slug: row.slug, title: row.title };
        const llm = await llmSummarizeRepo(repo).catch(() => null);
        if (!llm) {
          stats.failed += 1;
          continue;
        }
        const newMeta = {
          ...row.meta,
          summary: llm.summary || row.meta.summary || "",
          purpose: llm.purpose ?? "",
          architecture: llm.architecture ?? "",
          usage: llm.usage ?? "",
          topics: llm.topics ?? [],
        };
        if (Array.isArray(row.meta.tags) && Array.isArray(llm.topics)) {
          const t = new Set([...row.meta.tags, ...llm.topics]);
          newMeta.tags = [...t];
        }
        await pool.query(
          "UPDATE entities SET meta = $1::jsonb, updated_at = now() WHERE id = $2",
          [JSON.stringify(stripNul(newMeta)), row.id],
        );
        stats.updated += 1;
      } catch (err) {
        stats.failed += 1;
        process.stderr.write(`[backfill-repo] ${row.id}: ${err.message}\n`);
      }
      if (onProgress && (stats.updated + stats.failed + stats.skipped) % 5 === 0) {
        onProgress({ ...stats, index: stats.updated + stats.failed + stats.skipped });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  return stats;
}
