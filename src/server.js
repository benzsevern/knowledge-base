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
} from "./commands.js";
import { buildContentIndex, buildEmbeddingIndex, semanticSearch } from "./embeddings.js";
import { loadIndex } from "./indexer.js";
import { chat, gapAnalysis, literatureReview } from "./rag.js";
import { generateTopicBrief } from "./briefings.js";
import { importVault } from "./export.js";

const app = express();
app.use(express.json({ limit: "200mb" }));

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
// Status
// ---------------------------------------------------------------------------
app.get("/api/status", async (_req, res) => {
  try {
    const index = await loadIndex();
    res.json({
      papers: index.papers.length,
      repos: index.repos.length,
      docs: (index.docs ?? []).length,
      relations: index.relations.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/graph", async (_req, res) => {
  try {
    const index = await loadIndex();
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
    const { query, topK = 10, scope = null, deep = false } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });
    const hits = await semanticSearch(query, { topK, scope, deep });
    res.json(
      hits.map((h) => ({
        score: h.score,
        entityId: h.entry.entityId,
        entityTitle: h.entry.entityTitle,
        type: h.entry.type,
        kind: h.entry.kind,
        text: h.entry.text.slice(0, 500),
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
app.listen(PORT, () => {
  console.log(`kb server listening on :${PORT}`);
});
