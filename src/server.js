import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import crypto from "node:crypto";

// Minimal .env loader
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

import {
  discoverArxivCandidates,
  fetchArxivCandidates,
  ingestPaper,
  ingestPapersBatch,
  ingestRepo,
  ingestReposBatch,
  queryContext,
  rebuildLinks,
  searchArxiv,
  searchGithubRepos,
  fetchRepoCandidates,
  ingestDocsSite,
  ingestSitemap,
} from "./commands.js";
import { buildContentIndex, buildEmbeddingIndex, embedQuery, semanticSearch } from "./embeddings.js";
import { loadIndex } from "./indexer.js";
import { chat, gapAnalysis, literatureReview } from "./rag.js";
import { generateTopicBrief } from "./briefings.js";
import { importVault } from "./export.js";
import { readJson, writeJson } from "./fs-utils.js";
import { dbHealth, runMigrations, hasDatabase } from "./db.js";
import {
  useDbReads,
  statusCounts,
  loadIndexPG,
  findEntityPG,
  linkedEntitiesPG,
  listEntityEmbeddingsPG,
  semanticSearchPG,
  deleteEntityPG,
} from "./db-queries.js";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ---------------------------------------------------------------------------
// Bearer-token gate for expensive / write endpoints
// ---------------------------------------------------------------------------
// When KB_API_TOKEN is set, requests to PROTECTED_PREFIXES must include a
// matching Authorization: Bearer <token> header. When unset, the gate is
// disabled (dev default). /api/search is protected because every call costs
// an OpenAI embedding round-trip — even though the route is "read-only".
const KB_API_TOKEN = process.env.KB_API_TOKEN || "";
const PROTECTED_PREFIXES = [
  "/api/search",
  "/api/chat",
  "/api/topic-brief",
  "/api/gap-analysis",
  "/api/lit-review",
  "/api/embed",
  "/api/ingest",
  "/api/patch-index",
  "/api/recover-index",
  "/api/import-index",
  "/api/rebuild-links",
  "/api/admin",
];
app.use((req, res, next) => {
  if (!KB_API_TOKEN) return next();
  if (!PROTECTED_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== KB_API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ---------------------------------------------------------------------------
// Background job tracker
// ---------------------------------------------------------------------------
const jobs = new Map();

function createJob(name, fn) {
  const id = crypto.randomUUID();
  const job = { id, name, status: "running", startedAt: new Date().toISOString(), result: null, error: null };
  jobs.set(id, job);
  fn()
    .then((result) => {
      job.status = "completed";
      job.result = result;
    })
    .catch((err) => {
      job.status = "failed";
      job.error = err.message ?? String(err);
    });
  return job;
}

// ---------------------------------------------------------------------------
// Database health — returns Postgres version + installed extensions, or a
// reason if DATABASE_URL isn't configured yet.
// ---------------------------------------------------------------------------
app.get("/api/db-health", async (_req, res) => {
  const result = await dbHealth();
  res.status(result.ok ? 200 : 503).json(result);
});

// Entity lookup — read-only, unprotected. Returns the PG entity for a given
// id or slug. 404 if not found.
app.get("/api/entity/:id", async (req, res) => {
  try {
    if (!(await useDbReads())) return res.status(503).json({ error: "postgres not ready" });
    const entity = await findEntityPG(req.params.id);
    if (!entity) return res.status(404).json({ found: false, id: req.params.id });
    res.json({ found: true, entity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic: look up a single entity by id/slug from Postgres.
app.get("/api/admin/entity/:id", async (req, res) => {
  try {
    const entity = await findEntityPG(req.params.id);
    if (!entity) return res.status(404).json({ found: false, id: req.params.id });
    res.json({ found: true, entity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read the LLM-generated note for a single entity. Returns the markdown
// text plus minimal metadata. Used by golden-showcase's /knowledge/[id]
// page to render a curated view of an entity. Token-gated.
app.get("/api/admin/entity/:id/note", async (req, res) => {
  try {
    const entity = await findEntityPG(req.params.id);
    if (!entity) return res.status(404).json({ error: "entity not found" });
    if (!entity.notePath) return res.status(404).json({ error: "no note for entity" });
    let markdown;
    try {
      markdown = await fs.promises.readFile(entity.notePath, "utf8");
    } catch (err) {
      return res.status(404).json({ error: `note file unreadable: ${err.code || err.message}` });
    }
    res.json({
      id: entity.id,
      title: entity.title,
      type: entity.type,
      slug: entity.slug,
      sourceUrl: entity.sourceUrl || null,
      arxivId: entity.arxivId || null,
      year: entity.year || null,
      authors: entity.authors || null,
      markdown,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dump all entity-level summary embeddings in one shot. Consumer: the
// golden-showcase knowledge-map generator script. Not paginated — corpus is
// ~1.5K entities so payload is ~6 MB gzipped. Token-gated via PROTECTED_PREFIXES.
app.get("/api/admin/entity-embeddings", async (_req, res) => {
  try {
    if (!(await useDbReads())) return res.status(503).json({ error: "postgres not ready" });
    const entities = await listEntityEmbeddingsPG();
    res.json({ count: entities.length, entities });
  } catch (err) {
    console.error("entity-embeddings failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Re-run llmSummarize over existing entities and UPDATE their meta with
// better summary/methodology/constraints/topics. Skips rows that already
// have a populated topics array unless force=true.
//   body: { force?, limit?, concurrency? }
app.post("/api/admin/resummarize", async (req, res) => {
  const { force = false, limit = null, concurrency = 2 } = req.body ?? {};
  const { backfillSummaries } = await import("./backfill.js");
  const job = createJob("resummarize", async () => {
    return await backfillSummaries({
      force,
      limit,
      concurrency,
      onProgress: (s) => {
        job.progress = s;
        if ((s.index || 0) % 25 === 0) {
          console.log(`[resummarize] ${JSON.stringify(s)}`);
        }
      },
    });
  });
  res.json({ jobId: job.id, status: job.status });
});

// Manually trigger migrations. Useful for CI or emergencies. Protected by
// the same token gate as other admin routes (prefix /api/admin).
app.post("/api/admin/migrate", async (_req, res) => {
  try {
    const result = await runMigrations();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-off data migration from kb_index.json + kb_embeddings.json into
// Postgres. Creates a background job (same mechanism as ingestion) so
// progress can be polled with /api/jobs/:id.
app.post("/api/admin/migrate-data", async (req, res) => {
  const { dryRun = false } = req.body ?? {};
  const { runDataMigration } = await import("./migration-runner.js");
  const job = createJob(`migrate-data${dryRun ? "-dryrun" : ""}`, async () => {
    const stats = await runDataMigration({
      dryRun,
      onProgress: (snapshot) => {
        job.progress = snapshot;
        // Mirror to stdout so log tail shows progress even if the in-memory
        // job state is lost to a restart.
        console.log(`[migrate] ${JSON.stringify(snapshot).slice(0, 400)}`);
      },
    });
    return stats;
  });
  res.json({ jobId: job.id, status: job.status });
});

// ---------------------------------------------------------------------------
// Ping — absolutely cheap liveness endpoint. Used by Railway healthchecks so
// heavy in-process work (migrations, index rebuilds) doesn't cause restarts.
// ---------------------------------------------------------------------------
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
app.get("/api/status", async (_req, res) => {
  try {
    // Prefer Postgres counts once the migration has populated the tables —
    // they're a single O(1) query and don't touch the 100MB+ kb_index.json.
    if (await useDbReads()) {
      const counts = await statusCounts();
      res.json({ ok: true, source: "postgres", ...counts });
      return;
    }
    const index = await loadIndex();
    res.json({
      ok: true,
      source: "json",
      papers: index.papers.length,
      repos: index.repos.length,
      docs: (index.docs ?? []).length,
      relations: index.relations.length,
    });
  } catch (err) {
    // Degraded mode — return 200 so healthcheck doesn't kill the container.
    // This lets us hit /api/recover-index to fix a corrupted kb_index.json.
    res.json({
      ok: false,
      degraded: true,
      error: err.message,
      hint: "Call POST /api/recover-index to rebuild kb_index.json from the filesystem.",
    });
  }
});

app.get("/api/graph", async (_req, res) => {
  try {
    const index = (await useDbReads()) ? await loadIndexPG() : await loadIndex();
    res.json({
      papers: index.papers.map((p) => ({ id: p.id, title: p.title, slug: p.slug, type: "paper" })),
      repos: index.repos.map((r) => ({ id: r.id, title: r.title, slug: r.slug, type: "repo", languages: r.languages })),
      relations: index.relations,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
app.get("/api/jobs", (_req, res) => {
  const list = [...jobs.values()].map(({ id, name, status, startedAt }) => ({ id, name, status, startedAt }));
  res.json(list);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ---------------------------------------------------------------------------
// Search & Chat (synchronous — fast)
// ---------------------------------------------------------------------------
app.post("/api/search", async (req, res) => {
  try {
    const { query, topK = 10, scope = null, deep = false, types = null } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });
    let hits;
    if (await useDbReads()) {
      // pgvector KNN path — embed once, one SQL round-trip.
      const vector = await embedQuery(query);
      hits = await semanticSearchPG(vector, { topK, scope, deep, types });
    } else {
      hits = await semanticSearch(query, { topK, scope, deep });
    }
    res.json(
      hits.map((h) => ({
        score: h.score,
        entityId: h.entry.entityId,
        entityTitle: h.entry.entityTitle,
        type: h.entry.type,
        kind: h.entry.kind,
        text: (h.entry.text ?? "").slice(0, 500),
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { question, topK = 8, scope = null, deep = false } = req.body;
    if (!question) return res.status(400).json({ error: "Missing question" });
    const result = await chat(question, { topK, scope, deep });
    res.json({
      answer: result.answer,
      sources: result.hits.map((h) => ({
        score: h.score,
        entityTitle: h.entry.entityTitle,
        type: h.entry.type,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Discovery (synchronous — arXiv API is fast)
// ---------------------------------------------------------------------------
app.post("/api/discover-arxiv", async (_req, res) => {
  try {
    const result = await discoverArxivCandidates();
    res.json({ count: result.candidates.length, candidates: result.candidates.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/search-arxiv", async (req, res) => {
  try {
    const { query, limit = 20 } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });
    const result = await searchArxiv(query, { limit });
    res.json({ count: result.candidates.length, candidates: result.candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/search-github", async (req, res) => {
  try {
    const { query, limit = 20, sort = "stars" } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });
    const result = await searchGithubRepos(query, { limit, sort });
    res.json({ count: result.candidates.length, candidates: result.candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/fetch-repo-candidates", (req, res) => {
  const { top = 10 } = req.body;
  const job = createJob(`fetch-repo-candidates --top ${top}`, async () => {
    const result = await fetchRepoCandidates(top, {
      onProgress: (info) => {
        job.progress = info.record
          ? { index: info.index, total: info.total, repoId: info.record.id, elapsedSec: info.elapsedSec }
          : { index: info.index, total: info.total, error: info.error };
      },
    });
    return { ingested: result.ingested.length };
  });
  res.json({ jobId: job.id, status: job.status });
});

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
app.get("/api/context/:id", async (req, res) => {
  try {
    const result = await queryContext(req.params.id);
    res.type("text/plain").send(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Heavy operations — return job ID immediately
// ---------------------------------------------------------------------------
app.post("/api/fetch-candidates", (req, res) => {
  const { top = 10 } = req.body;
  const job = createJob(`fetch-candidates --top ${top}`, async () => {
    const result = await fetchArxivCandidates(top, {
      onProgress: (info) => {
        job.progress = info.record
          ? { index: info.index, total: info.total, paperId: info.record.id, elapsedSec: info.elapsedSec }
          : { index: info.index, total: info.total, error: info.error };
      },
    });
    return { downloaded: result.downloaded.length, ingested: result.ingested.length };
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/ingest-paper", (req, res) => {
  const { path: pdfPath } = req.body;
  if (!pdfPath) return res.status(400).json({ error: "Missing path" });
  const job = createJob(`ingest-paper ${pdfPath}`, async () => {
    const record = await ingestPaper(pdfPath);
    return { id: record.id, title: record.title };
  });
  res.json({ jobId: job.id, status: job.status });
});

// Batch arxiv ingest. Accepts { arxivIds: [...] }. Downloads all PDFs in
// parallel, then runs ingestPapersBatch (single rebuildLinks at the end).
app.post("/api/ingest-arxiv-batch", async (req, res) => {
  try {
    const { arxivIds = [] } = req.body ?? {};
    const ids = arxivIds
      .map((s) => String(s).trim())
      .filter((s) => /^\d{4}\.\d{4,5}$/.test(s));
    if (!ids.length) return res.status(400).json({ error: "arxivIds must be non-empty list of IDs" });

    const { projectRoot } = await import("./config.js");
    const { ensureDir, fileExists } = await import("./fs-utils.js");
    const fsp = await import("node:fs/promises");
    const inboxDir = path.join(projectRoot, "inbox");
    await ensureDir(inboxDir);

    // Cap download concurrency — arxiv rate-limits aggressive parallel fetches.
    const DOWNLOAD_CONCURRENCY = 6;
    async function downloadOne(id) {
      const pdfPath = path.join(inboxDir, `${id}.pdf`);
      if (await fileExists(pdfPath)) return { id, pdfPath, skipped: "cached" };
      try {
        const r = await fetch(`https://arxiv.org/pdf/${id}.pdf`, {
          headers: { "User-Agent": "kb-discover/0.1" },
        });
        if (!r.ok) return { id, error: `http ${r.status}` };
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.slice(0, 5).toString() !== "%PDF-") return { id, error: "not a PDF" };
        await fsp.writeFile(pdfPath, buf);
        return { id, pdfPath, downloaded: true };
      } catch (err) {
        return { id, error: err.message };
      }
    }
    const downloads = [];
    let dlCursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, ids.length) }, async () => {
        while (true) {
          const i = dlCursor++;
          if (i >= ids.length) return;
          downloads[i] = await downloadOne(ids[i]);
        }
      }),
    );

    const paths = downloads.filter((d) => d.pdfPath).map((d) => d.pdfPath);
    const errors = downloads.filter((d) => d.error);
    if (!paths.length) return res.status(502).json({ error: "no PDFs downloaded", downloads });

    const job = createJob(`ingest-arxiv-batch (${paths.length})`, async () => {
      const results = await ingestPapersBatch(paths, {
        onProgress: (info) => {
          job.progress = info.record
            ? { index: info.index, total: info.total, paperId: info.record.id }
            : { index: info.index, total: info.total, error: info.error };
        },
      });
      return { ingested: results.length, downloads, downloadErrors: errors };
    });
    res.json({ jobId: job.id, status: job.status, downloaded: paths.length, errors: errors.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download an arxiv PDF and ingest it. Accepts { arxivId } or { url }.
// Normalizes common arxiv URL shapes (abs/, pdf/, with or without .pdf).
app.post("/api/ingest-arxiv", async (req, res) => {
  try {
    const { arxivId, url } = req.body ?? {};
    const id = (arxivId ?? url?.match(/\d{4}\.\d{4,5}/)?.[0] ?? "").trim();
    if (!id) return res.status(400).json({ error: "Missing arxivId or URL containing one" });

    const { projectRoot } = await import("./config.js");
    const { ensureDir, fileExists } = await import("./fs-utils.js");
    const fsp = await import("node:fs/promises");
    const inboxDir = path.join(projectRoot, "inbox");
    await ensureDir(inboxDir);
    const pdfPath = path.join(inboxDir, `${id}.pdf`);

    if (!(await fileExists(pdfPath))) {
      const pdfUrl = `https://arxiv.org/pdf/${id}.pdf`;
      const r = await fetch(pdfUrl, { headers: { "User-Agent": "kb-discover/0.1" } });
      if (!r.ok) return res.status(502).json({ error: `arxiv fetch ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.slice(0, 5).toString() !== "%PDF-") {
        return res.status(502).json({ error: "arxiv response not a PDF" });
      }
      await fsp.writeFile(pdfPath, buf);
    }

    const job = createJob(`ingest-arxiv ${id}`, async () => {
      const record = await ingestPaper(pdfPath);
      return { id: record.id, title: record.title, arxivId: id };
    });
    res.json({ jobId: job.id, status: job.status, arxivId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ingest-papers", (req, res) => {
  const { paths = [] } = req.body;
  if (!paths.length) return res.status(400).json({ error: "Missing paths" });
  const job = createJob(`ingest-papers (${paths.length})`, async () => {
    const results = await ingestPapersBatch(paths, {
      onProgress: (info) => {
        job.progress = info.record
          ? { index: info.index, total: info.total, paperId: info.record.id, elapsedSec: info.elapsedSec, etaSec: info.etaSec }
          : { index: info.index, total: info.total, error: info.error };
      },
    });
    return { ingested: results.length };
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/ingest-repo", (req, res) => {
  const { path: repoPath, source } = req.body;
  const input = source ?? repoPath;
  if (!input) return res.status(400).json({ error: "Missing source (path or GitHub URL or org/repo)" });
  const job = createJob(`ingest-repo ${input}`, async () => {
    const record = await ingestRepo(input);
    return { id: record.id, title: record.title };
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/ingest-repos", (req, res) => {
  const { sources = [] } = req.body;
  if (!sources.length) return res.status(400).json({ error: "Missing sources array" });
  const job = createJob(`ingest-repos (${sources.length})`, async () => {
    const results = await ingestReposBatch(sources, {
      onProgress: (info) => {
        job.progress = info.record
          ? { index: info.index, total: info.total, repoId: info.record.id, elapsedSec: info.elapsedSec, etaSec: info.etaSec }
          : { index: info.index, total: info.total, error: info.error };
      },
    });
    return { ingested: results.length };
  });
  res.json({ jobId: job.id, status: job.status });
});

// Per-page sitemap ingest. No Firecrawl — uses the already-configured
// gpt-5.4-nano to convert HTML → Markdown. One entity per URL.
//   body: { sitemapUrl, urlFilter?, maxPages?=200, concurrency?=4 }
app.post("/api/ingest-sitemap", (req, res) => {
  const { sitemapUrl, urlFilter, maxPages = 200, concurrency = 4 } = req.body ?? {};
  if (!sitemapUrl) return res.status(400).json({ error: "Missing sitemapUrl" });
  const job = createJob(`ingest-sitemap ${sitemapUrl}`, async () => {
    return await ingestSitemap(sitemapUrl, {
      urlFilter,
      maxPages,
      concurrency,
      onProgress: (info) => {
        job.progress = info;
      },
    });
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/ingest-docs", (req, res) => {
  const { url, maxPages = 100, includePaths, excludePaths, title } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });
  const job = createJob(`ingest-docs ${url}`, async () => {
    const record = await ingestDocsSite(url, { maxPages, includePaths, excludePaths, title });
    return {
      id: record.id,
      title: record.title,
      pageCount: record.pageCount,
      totalBytes: record.totalBytes,
    };
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/rebuild-links", (_req, res) => {
  const job = createJob("rebuild-links", async () => {
    const index = await rebuildLinks();
    return { relations: index.relations.length };
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/embed", (req, res) => {
  const { force = false } = req.body;
  const job = createJob("embed", async () => buildEmbeddingIndex({ force }));
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/embed-content", (req, res) => {
  const { repos = null, all = false, force = false } = req.body;
  if (!repos && !all) return res.status(400).json({ error: "Specify repos array or all: true" });
  const job = createJob("embed-content", async () => buildContentIndex({ repoIds: repos, force }));
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/topic-brief", (req, res) => {
  const { topic, topK, types, synthesize, scope, outPath } = req.body;
  if (!topic) return res.status(400).json({ error: "Missing topic" });
  const job = createJob(`topic-brief ${topic}`, async () => {
    const result = await generateTopicBrief(topic, { topK, types, synthesize, scope, outPath });
    return result;
  });
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/lit-review", (req, res) => {
  const { entityId } = req.body;
  if (!entityId) return res.status(400).json({ error: "Missing entityId" });
  const job = createJob(`lit-review ${entityId}`, async () => literatureReview(entityId));
  res.json({ jobId: job.id, status: job.status });
});

app.post("/api/gap-analysis", (req, res) => {
  const { repoId } = req.body;
  if (!repoId) return res.status(400).json({ error: "Missing repoId" });
  const job = createJob(`gap-analysis ${repoId}`, async () => gapAnalysis(repoId));
  res.json({ jobId: job.id, status: job.status });
});

// ---------------------------------------------------------------------------
// Patch index — upsert papers/repos/docs and embeddings without wiping others
// ---------------------------------------------------------------------------
app.post("/api/patch-index", async (req, res) => {
  try {
    const { papers = [], repos = [], docs = [], embeddings = null } = req.body;

    const { vaultRoot } = await import("./config.js");
    const fsp = await import("node:fs/promises");
    const indexFile = path.join(vaultRoot, "kb_index.json");
    const embFile = path.join(vaultRoot, "kb_embeddings.json");

    // Load existing index (tolerate missing/corrupted)
    let current;
    try {
      current = JSON.parse(await fsp.readFile(indexFile, "utf8"));
    } catch {
      current = { papers: [], repos: [], docs: [], relations: [] };
    }
    current.papers = current.papers ?? [];
    current.repos = current.repos ?? [];
    current.docs = current.docs ?? [];
    current.relations = current.relations ?? [];

    const upsert = (arr, incoming) => {
      const byId = new Map(arr.map((e) => [e.id, e]));
      for (const e of incoming) byId.set(e.id, e);
      return [...byId.values()];
    };

    current.papers = upsert(current.papers, papers);
    current.repos = upsert(current.repos, repos);
    current.docs = upsert(current.docs, docs);
    current.generatedAt = new Date().toISOString();
    await fsp.writeFile(indexFile, JSON.stringify(current, null, 2), "utf8");

    let embeddingsResult = null;
    if (embeddings && Array.isArray(embeddings.entries)) {
      let existing;
      try {
        existing = JSON.parse(await fsp.readFile(embFile, "utf8"));
      } catch {
        existing = { entries: [] };
      }
      const byId = new Map((existing.entries ?? []).map((e) => [e.id, e]));
      for (const e of embeddings.entries) byId.set(e.id, e);
      const merged = {
        model: embeddings.model ?? existing.model ?? "text-embedding-3-small",
        generatedAt: new Date().toISOString(),
        entries: [...byId.values()],
      };
      await fsp.writeFile(embFile, JSON.stringify(merged, null, 2), "utf8");
      embeddingsResult = merged.entries.length;
    }

    res.json({
      ok: true,
      papers: current.papers.length,
      repos: current.repos.length,
      docs: current.docs.length,
      embeddings: embeddingsResult,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Delete entity — remove a paper/repo/docs entry and its dependent state.
// Body: { id: string, removeFiles?: boolean }
// Removes: index entry, relations involving it, embedding entries
//   (summary + content chunks), optional vault directory.
// ---------------------------------------------------------------------------
app.post("/api/delete-entity", async (req, res) => {
  try {
    const { id, removeFiles = true } = req.body ?? {};
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "Missing id" });
    }

    const { vaultRoot } = await import("./config.js");
    const fsp = await import("node:fs/promises");
    const indexFile = path.join(vaultRoot, "kb_index.json");
    const embFile = path.join(vaultRoot, "kb_embeddings.json");

    // --- Index (stream-parse via readJson — file may exceed Node's
    //     max string length) ---
    const current = await readJson(indexFile, null);
    if (!current) return res.status(404).json({ error: "Index not found" });
    current.papers = current.papers ?? [];
    current.repos = current.repos ?? [];
    current.docs = current.docs ?? [];
    current.relations = current.relations ?? [];

    const before = {
      papers: current.papers.length,
      repos: current.repos.length,
      docs: current.docs.length,
      relations: current.relations.length,
    };

    let slug = "";
    let type = "";
    let notePath = "";
    for (const kind of ["papers", "repos", "docs"]) {
      const arr = current[kind];
      const hit = arr.find((e) => e.id === id);
      if (hit) {
        slug = hit.slug ?? "";
        type = hit.type ?? kind.slice(0, -1);
        notePath = hit.notePath ?? "";
        current[kind] = arr.filter((e) => e.id !== id);
        break;
      }
    }
    if (!slug) return res.status(404).json({ error: `Entity ${id} not found` });

    current.relations = current.relations.filter(
      (r) => r.fromId !== id && r.toId !== id,
    );
    current.generatedAt = new Date().toISOString();
    await writeJson(indexFile, current);

    // --- Postgres mirror: delete entity, cascaded relations, and embeddings ---
    let pgDeleted = false;
    if (hasDatabase()) {
      try {
        pgDeleted = await deleteEntityPG(id);
      } catch (err) {
        process.stderr.write(`[warn] deleteEntityPG ${id}: ${err.message}\n`);
      }
    }

    // --- Embeddings (summary + per-entity content chunks) ---
    let embRemoved = 0;
    const emb = await readJson(embFile, null);
    if (emb && Array.isArray(emb.entries)) {
      // Match by exact id (summary) or by id prefix with ":" (chunked entries
      // are conventionally keyed "entityId:chunkN"). Also match entityId field
      // if present.
      const kept = emb.entries.filter((e) => {
        if (e.id === id) return false;
        if (typeof e.id === "string" && e.id.startsWith(`${id}:`)) return false;
        if (e.entityId === id) return false;
        return true;
      });
      embRemoved = emb.entries.length - kept.length;
      await writeJson(embFile, {
        model: emb.model ?? "text-embedding-3-small",
        generatedAt: new Date().toISOString(),
        entries: kept,
      });
    }

    // --- Vault directory ---
    let removedDir = "";
    if (removeFiles && slug) {
      const subdir =
        type === "paper" ? "papers" : type === "repo" ? "repos" : type === "docs" ? "docs" : "";
      if (subdir) {
        const dir = path.join(vaultRoot, subdir, slug);
        try {
          await fsp.rm(dir, { recursive: true, force: true });
          removedDir = dir;
        } catch {}
      }
    }

    res.json({
      ok: true,
      id,
      slug,
      type,
      notePath,
      embeddingsRemoved: embRemoved,
      removedDir,
      pgDeleted,
      before,
      after: {
        papers: current.papers?.length ?? 0,
        repos: current.repos?.length ?? 0,
        docs: current.docs?.length ?? 0,
        relations: current.relations?.length ?? 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Recover index from filesystem — rebuild kb_index.json from entity meta files
// ---------------------------------------------------------------------------
app.post("/api/recover-index", async (_req, res) => {
  try {
    const fsp = await import("node:fs/promises");
    const { vaultRoot } = await import("./config.js");
    const papersDir = path.join(vaultRoot, "papers");
    const reposDir = path.join(vaultRoot, "repos");
    const docsDir = path.join(vaultRoot, "docs");

    const papers = [];
    const repos = [];
    const docs = [];

    for (const slug of await fsp.readdir(papersDir).catch(() => [])) {
      const notePath = path.join(papersDir, slug, "note.md");
      try {
        const note = await fsp.readFile(notePath, "utf8");
        const fmMatch = note.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fm = {};
        for (const line of fmMatch[1].split("\n")) {
          const m = line.match(/^(\w+):\s*"?(.*?)"?$/);
          if (m) fm[m[1]] = m[2];
        }
        if (!fm.id) continue;
        papers.push({
          id: fm.id, slug, type: "paper",
          title: fm.title || slug,
          createdAt: fm.created_at || new Date().toISOString(),
          updatedAt: fm.updated_at || new Date().toISOString(),
          sourcePath: fm.source_path || "", sourceUrl: fm.source_url || "",
          notePath, tags: ["research"],
          year: fm.year || "", summary: "",
          methodologySummary: fm.methodology_summary || "",
          constraintsSummary: fm.constraints || "",
          authors: [], citations: [], assets: [],
          markdownExcerpt: "", markdownHash: "", extractedJsonPath: "",
        });
      } catch {}
    }

    for (const slug of await fsp.readdir(reposDir).catch(() => [])) {
      const metaPath = path.join(reposDir, slug, "packed-context.meta.json");
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
        repos.push({
          id: meta.id, slug, type: "repo",
          title: meta.title, repoName: meta.title,
          createdAt: meta.generatedAt || new Date().toISOString(),
          updatedAt: meta.generatedAt || new Date().toISOString(),
          sourcePath: meta.sourcePath || "", sourceUrl: "",
          origin: (meta.sourcePath || "").includes("sources/repos") ? "git" : "local",
          notePath: path.join(reposDir, slug, "note.md"),
          packedContextPath: meta.packedContextPath,
          packedContextMetaPath: metaPath,
          tags: ["codebase"],
          languages: meta.languages || [],
          entrypoints: meta.entrypoints || [],
          keyModules: meta.keyModules || [],
          summary: `Packed ${(meta.includedFiles || []).length} files.`,
        });
      } catch {}
    }

    for (const slug of await fsp.readdir(docsDir).catch(() => [])) {
      const metaPath = path.join(docsDir, slug, "meta.json");
      try {
        const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
        docs.push({
          id: meta.id, slug, type: "docs",
          title: meta.title, sourceUrl: meta.sourceUrl,
          createdAt: meta.crawledAt || new Date().toISOString(),
          updatedAt: meta.crawledAt || new Date().toISOString(),
          pageCount: meta.pageCount, totalBytes: meta.totalBytes,
          notePath: path.join(docsDir, slug, "note.md"),
          metaPath, pagesDir: path.join(docsDir, slug, "pages"),
          tags: ["documentation"],
        });
      } catch {}
    }

    const newIndex = {
      generatedAt: new Date().toISOString(),
      papers, repos, docs, relations: [],
    };
    await fsp.writeFile(
      path.join(vaultRoot, "kb_index.json"),
      JSON.stringify(newIndex, null, 2),
      "utf8",
    );

    res.json({
      ok: true,
      papers: papers.length,
      repos: repos.length,
      docs: docs.length,
      note: "Relations cleared — run /api/rebuild-links to regenerate them.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ---------------------------------------------------------------------------
// Import index + embeddings (lightweight seed — ~55 MB)
// ---------------------------------------------------------------------------
app.post("/api/import-index", express.json({ limit: "200mb" }), async (req, res) => {
  try {
    const { index: indexData, embeddings } = req.body;
    if (!indexData) return res.status(400).json({ error: "Missing index field" });

    const { ensureDir } = await import("./fs-utils.js");
    const { vaultRoot } = await import("./config.js");
    const fsp = await import("node:fs/promises");

    await ensureDir(vaultRoot);
    await fsp.writeFile(
      path.join(vaultRoot, "kb_index.json"),
      JSON.stringify(indexData, null, 2),
      "utf8",
    );

    if (embeddings) {
      await fsp.writeFile(
        path.join(vaultRoot, "kb_embeddings.json"),
        JSON.stringify(embeddings, null, 2),
        "utf8",
      );
    }

    res.json({
      ok: true,
      papers: indexData.papers?.length ?? 0,
      repos: indexData.repos?.length ?? 0,
      relations: indexData.relations?.length ?? 0,
      embeddingsImported: !!embeddings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, async () => {
  console.log(`kb server listening on :${PORT}`);
  if (hasDatabase()) {
    try {
      const result = await runMigrations();
      if (result.applied?.length) {
        console.log(`[db] applied migrations: ${result.applied.join(", ")}`);
      } else {
        console.log(`[db] schema up to date (${result.alreadyApplied?.length ?? 0} applied)`);
      }
    } catch (err) {
      console.error("[db] migration failed:", err.message);
    }
  }
});
// force restart 1776199006
