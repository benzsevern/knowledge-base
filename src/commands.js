import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { indexPath, projectRoot, repoCloneRoot, vaultRoot } from "./config.js";
import { ensureDir, fileExists, sha1File, slugify, stableId, tokenize } from "./fs-utils.js";
import { hasDatabase } from "./db.js";
import { insertRelationBatchPG, loadEntitiesOnlyPG, upsertEntityPG, useDbReads } from "./db-queries.js";
import { db } from "./db.js";
import { findEntity, loadIndex, saveIndex, upsertEntity } from "./indexer.js";
import { renderPaperNote, renderRelationNote, renderRepoNote, renderRepoRepoRelationNote } from "./markdown.js";
import { extractPaper } from "./marker-adapter.js";
import { packRepository } from "./repo-packer.js";
import { ingestDocs as _ingestDocs } from "./docs-ingester.js";
import { parseSitemap, fetchAndExtractArticle } from "./sitemap-ingester.js";
import { llmSummarize } from "./llm-summarize.js";

function now() {
  return new Date().toISOString();
}

async function ensureVaultLayout() {
  await ensureDir(vaultRoot);
  await ensureDir(path.join(vaultRoot, "papers"));
  await ensureDir(path.join(vaultRoot, "repos"));
  await ensureDir(path.join(vaultRoot, "links"));
  await ensureDir(path.join(repoCloneRoot));
}

async function writeRepoMetadata(repoDir, repoRecord, packResult) {
  const metadataPath = path.join(repoDir, "packed-context.meta.json");
  const payload = {
    id: repoRecord.id,
    title: repoRecord.title,
    sourcePath: repoRecord.sourcePath,
    packedContextPath: repoRecord.packedContextPath,
    generatedAt: now(),
    languages: packResult.languages,
    entrypoints: packResult.entrypoints,
    keyModules: packResult.keyModules,
    ignorePatterns: packResult.ignorePatterns,
    includedFiles: packResult.includedFiles,
  };

  await fs.writeFile(metadataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return metadataPath;
}

function trimExcerpt(text, maxLength = 2000) {
  const clean = String(text ?? "").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean;
}

function sentenceAround(text, matcher) {
  const source = String(text ?? "");
  const match = matcher.exec(source);
  if (!match) {
    return null;
  }

  const index = match.index;
  const start = Math.max(source.lastIndexOf(".", index - 1) + 1, 0);
  const endIndex = source.indexOf(".", index + match[0].length);
  const end = endIndex === -1 ? source.length : endIndex + 1;
  return source.slice(start, end).trim();
}

function extractSection(markdown, headingMatchers) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  let capture = false;
  const buffer = [];

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      capture = headingMatchers.some((matcher) => matcher.test(line));
      if (capture) {
        continue;
      }
      if (buffer.length) {
        break;
      }
    }

    if (capture) {
      buffer.push(line);
    }
  }

  return trimExcerpt(buffer.join("\n").trim(), 800);
}

// Strip only a literal .pdf extension — path.extname() misreads dots in
// arxiv IDs like "2508.08322" as extensions.
function stripPdfExtension(filename) {
  return filename.replace(/\.pdf$/i, "");
}

// Detect arxiv ID from URL or filename. Handles new-style (2508.08322)
// and old-style (cs.CL/0401001) identifiers, with optional version suffix.
function detectArxivId(...inputs) {
  const newStyle = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
  const oldStyle = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/;
  for (const input of inputs) {
    if (!input) continue;
    const m = input.match(newStyle) || input.match(oldStyle);
    if (m) return m[1];
  }
  return "";
}

// Fetch authoritative paper metadata from arXiv's Atom API. Zero-dep,
// regex-based parse of the entry fields we care about.
// https://info.arxiv.org/help/api/user-manual.html
async function fetchArxivMetadata(arxivId) {
  if (!arxivId) return null;
  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "kb-ingester/0.1" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entry) return null;
    const body = entry[1];
    const unescape = (s) =>
      String(s)
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
    const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = body.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = body.match(/<published>([^<]+)<\/published>/);
    const authorMatches = [
      ...body.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g),
    ];
    return {
      title: titleMatch ? unescape(titleMatch[1]) : "",
      abstract: summaryMatch ? unescape(summaryMatch[1]) : "",
      year: publishedMatch ? publishedMatch[1].slice(0, 4) : "",
      authors: authorMatches.map((m) => unescape(m[1])).filter(Boolean),
    };
  } catch {
    return null;
  }
}

async function derivePaperMetadata(markdown, pdfPath, fallbackTitle = "") {
  const titleMatch = String(markdown).match(/^#\s+(.+)$/m);
  const filenameStem = stripPdfExtension(path.basename(pdfPath));
  const title = titleMatch?.[1]?.trim() || fallbackTitle || filenameStem;
  const yearMatch = title.match(/\b(19|20)\d{2}\b/) || filenameStem.match(/\b(19|20)\d{2}\b/);

  // Regex-based fallback summary (used if LLM summarization returns null).
  const regexSummary = trimExcerpt(
    String(markdown)
      .replace(/^---[\s\S]*?---/, "")
      .split(/\n{2,}/)
      .find((section) => section.trim() && !section.trim().startsWith("#")) ?? "",
    1200,
  );
  // Section-based fallback for explicit `# Methodology` / `# Constraints`.
  // Dropped the old sentenceAround fallback — it matched any sentence with
  // the keyword, leaking random body text into these fields.
  const regexMethodology =
    extractSection(markdown, [/^#{1,6}\s+(method|methodology|approach)/i]) || "";
  const regexConstraints =
    extractSection(markdown, [/^#{1,6}\s+(constraint|limitations|assumptions)/i]) || "";

  // LLM pass produces better structured summaries when the text permits.
  const llm = await llmSummarize(markdown).catch(() => null);

  const summary = trimExcerpt(llm?.summary || regexSummary, 1200);
  const methodologySummary = trimExcerpt(llm?.methodology || regexMethodology, 800);
  const constraintsSummary = trimExcerpt(llm?.constraints || regexConstraints, 800);

  const authors =
    String(markdown)
      .split(/\r?\n/)
      .slice(1, 8)
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .slice(0, 3);
  const citations = Array.from(
    new Set(
      [...String(markdown).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]).slice(0, 10),
    ),
  );

  return {
    title,
    year: yearMatch?.[0] ?? "",
    summary,
    methodologySummary,
    constraintsSummary,
    authors,
    citations,
    topics: llm?.topics ?? [],
  };
}

// Light version: writes paper/repo entity notes only. Used by the PG path in
// rebuildLinks to avoid 913K individual link-file writes (too slow on Railway).
async function regenerateEntityNotes(index) {
  const paperToRepos = new Map();
  const repoToPapers = new Map();
  const repoToRepos = new Map();

  for (const relation of index.relations) {
    if (relation.relationType === "related") {
      repoToRepos.set(relation.fromId, [...(repoToRepos.get(relation.fromId) ?? []), relation.toId]);
      repoToRepos.set(relation.toId, [...(repoToRepos.get(relation.toId) ?? []), relation.fromId]);
    } else {
      paperToRepos.set(relation.fromId, [...(paperToRepos.get(relation.fromId) ?? []), relation.toId]);
      repoToPapers.set(relation.toId, [...(repoToPapers.get(relation.toId) ?? []), relation.fromId]);
    }
  }

  for (const paper of index.papers) {
    const linkedRepos = (paperToRepos.get(paper.id) ?? [])
      .map((id) => index.repos.find((r) => r.id === id))
      .filter(Boolean);
    paper.updatedAt = now();
    await fs.writeFile(paper.notePath, `${renderPaperNote(paper, linkedRepos)}\n`, "utf8");
  }

  for (const repo of index.repos) {
    const linkedPapers = (repoToPapers.get(repo.id) ?? [])
      .map((id) => index.papers.find((p) => p.id === id))
      .filter(Boolean);
    const linkedRepos = (repoToRepos.get(repo.id) ?? [])
      .map((id) => index.repos.find((r) => r.id === id))
      .filter(Boolean);
    repo.updatedAt = now();
    await fs.writeFile(repo.notePath, `${renderRepoNote(repo, linkedPapers, linkedRepos)}\n`, "utf8");
  }
}

async function regenerateNotes(index) {
  const paperToRepos = new Map();
  const repoToPapers = new Map();
  const repoToRepos = new Map();

  for (const relation of index.relations) {
    if (relation.relationType === "related") {
      repoToRepos.set(relation.fromId, [...(repoToRepos.get(relation.fromId) ?? []), relation.toId]);
      repoToRepos.set(relation.toId, [...(repoToRepos.get(relation.toId) ?? []), relation.fromId]);
    } else {
      paperToRepos.set(relation.fromId, [...(paperToRepos.get(relation.fromId) ?? []), relation.toId]);
      repoToPapers.set(relation.toId, [...(repoToPapers.get(relation.toId) ?? []), relation.fromId]);
    }
  }

  for (const paper of index.papers) {
    const linkedRepos = (paperToRepos.get(paper.id) ?? [])
      .map((id) => index.repos.find((repo) => repo.id === id))
      .filter(Boolean);
    paper.updatedAt = now();
    await fs.writeFile(paper.notePath, `${renderPaperNote(paper, linkedRepos)}\n`, "utf8");
  }

  for (const repo of index.repos) {
    const linkedPapers = (repoToPapers.get(repo.id) ?? [])
      .map((id) => index.papers.find((paper) => paper.id === id))
      .filter(Boolean);
    const linkedRepos = (repoToRepos.get(repo.id) ?? [])
      .map((id) => index.repos.find((other) => other.id === id))
      .filter(Boolean);
    repo.updatedAt = now();
    await fs.writeFile(repo.notePath, `${renderRepoNote(repo, linkedPapers, linkedRepos)}\n`, "utf8");
  }

  await ensureDir(path.join(vaultRoot, "links"));
  const activeRelationPaths = new Set();
  for (const relation of index.relations) {
    if (relation.relationType === "related") {
      const a = index.repos.find((item) => item.id === relation.fromId);
      const b = index.repos.find((item) => item.id === relation.toId);
      if (!a || !b) {
        continue;
      }
      activeRelationPaths.add(relation.notePath);
      relation.updatedAt = now();
      await fs.writeFile(relation.notePath, `${renderRepoRepoRelationNote(relation, a, b)}\n`, "utf8");
      continue;
    }

    const paper = index.papers.find((item) => item.id === relation.fromId);
    const repo = index.repos.find((item) => item.id === relation.toId);
    if (!paper || !repo) {
      continue;
    }

    activeRelationPaths.add(relation.notePath);
    relation.updatedAt = now();
    await fs.writeFile(relation.notePath, `${renderRelationNote(relation, paper, repo)}\n`, "utf8");
  }

  const existingRelationFiles = await fs.readdir(path.join(vaultRoot, "links")).catch(() => []);
  for (const fileName of existingRelationFiles) {
    const fullPath = path.join(vaultRoot, "links", fileName);
    if (!activeRelationPaths.has(fullPath)) {
      await fs.rm(fullPath, { force: true });
    }
  }
}

async function downloadToTempFile(url) {
  const res = await fetch(url, { headers: { "User-Agent": "kb-ingester/0.1" } });
  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 5).toString() !== "%PDF-") {
    throw new Error(`Not a PDF: ${url}`);
  }
  // Derive filename from URL. Ensure .pdf extension so downstream
  // path.extname() calls don't misinterpret dots in arxiv IDs.
  const urlObj = new URL(url);
  let basename = path.basename(urlObj.pathname) || `paper-${Date.now()}.pdf`;
  if (!/\.pdf$/i.test(basename)) basename += ".pdf";
  const tmpDir = path.join(projectRoot, "inbox", "url-cache");
  await ensureDir(tmpDir);
  const tmpPath = path.join(tmpDir, basename);
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

function isHttpUrl(input) {
  return /^https?:\/\//i.test(input);
}

export async function ingestPaper(pdfInputPath, options = {}) {
  await ensureVaultLayout();

  // Support URLs: download first, then ingest the local copy.
  let resolvedInput = pdfInputPath;
  let originalUrl = "";
  if (isHttpUrl(pdfInputPath)) {
    originalUrl = pdfInputPath;
    resolvedInput = await downloadToTempFile(pdfInputPath);
  }

  const pdfPath = path.resolve(resolvedInput);
  if (!(await fileExists(pdfPath))) {
    throw new Error(`Paper not found: ${pdfPath}`);
  }

  const filenameStem = stripPdfExtension(path.basename(pdfPath));
  const arxivId = detectArxivId(originalUrl, filenameStem);
  const slug = arxivId ? slugify(`arxiv-${arxivId}`) : slugify(filenameStem);
  const paperDir = path.join(vaultRoot, "papers", slug);
  // Kick off arxiv metadata fetch in parallel with Marker extraction — Marker
  // dominates wall time, so this is effectively free.
  const arxivMetaPromise = arxivId ? fetchArxivMetadata(arxivId) : Promise.resolve(null);
  const sourceDir = path.join(paperDir, "source");
  const rawDir = path.join(paperDir, "raw");
  const assetsDir = path.join(paperDir, "assets");
  await ensureDir(sourceDir);
  await ensureDir(rawDir);
  await ensureDir(assetsDir);

  const copiedPdfPath = path.join(sourceDir, path.basename(pdfPath));
  await fs.copyFile(pdfPath, copiedPdfPath);

  const extraction = await extractPaper(pdfPath, rawDir);
  let extractedMarkdown = "";
  let extractedJsonPath = "";
  const assetPaths = [];

  if (extraction?.markdownPath) {
    extractedMarkdown = await fs.readFile(extraction.markdownPath, "utf8");
    extractedJsonPath = extraction.jsonPath ?? "";

    for (const rawAssetPath of extraction.assetPaths) {
      const targetAssetPath = path.join(assetsDir, path.basename(rawAssetPath));
      await fs.copyFile(rawAssetPath, targetAssetPath);
      assetPaths.push(targetAssetPath);
    }
  }

  if (!extractedMarkdown) {
    const fallbackHeading = arxivId ? `arXiv:${arxivId}` : filenameStem;
    extractedMarkdown = `# ${fallbackHeading}\n\nSummary pending extraction.\n\n## Constraints\nManual review required.\n`;
  }

  const arxivMeta = await arxivMetaPromise;
  const fallbackTitle = arxivMeta?.title || (arxivId ? `arXiv:${arxivId}` : filenameStem);
  const metadata = await derivePaperMetadata(extractedMarkdown, pdfPath, fallbackTitle);
  // arXiv's API is the authoritative source for title/authors/year when
  // we have an arxiv ID — prefer it over Marker's extraction, which is
  // heuristic and frequently picks up running headers or figure captions.
  if (arxivMeta) {
    if (arxivMeta.title) metadata.title = arxivMeta.title;
    if (arxivMeta.authors.length) metadata.authors = arxivMeta.authors;
    if (arxivMeta.year) metadata.year = arxivMeta.year;
    if (arxivMeta.abstract) metadata.summary = trimExcerpt(arxivMeta.abstract, 1200);
  }
  const notePath = path.join(paperDir, "note.md");
  const record = {
    id: stableId("paper", slug),
    slug,
    type: "paper",
    title: metadata.title,
    createdAt: now(),
    updatedAt: now(),
    sourcePath: copiedPdfPath,
    sourceUrl: originalUrl,
    arxivId: arxivId || undefined,
    notePath,
    tags: ["research"],
    authors: metadata.authors,
    year: metadata.year,
    methodologySummary: metadata.methodologySummary,
    constraintsSummary: metadata.constraintsSummary,
    summary: metadata.summary,
    citations: metadata.citations,
    assets: assetPaths,
    markdownExcerpt: trimExcerpt(extractedMarkdown, 2500),
    markdownHash: await sha1File(copiedPdfPath),
    extractedJsonPath,
  };

  let index = options.index ?? ((await useDbReads()) ? await loadEntitiesOnlyPG() : await loadIndex());
  const previous = index.papers.find((paper) => paper.id === record.id);
  if (previous) {
    record.createdAt = previous.createdAt;
  }

  index.papers = upsertEntity(index.papers, record);
  if (hasDatabase()) {
    await upsertEntityPG(record, "paper").catch((err) => {
      process.stderr.write(`[warn] upsertEntityPG paper ${record.id}: ${err.message}\n`);
      throw err; // surface the real error so the job reports it
    });
  }
  if (options.skipRebuild) {
    return { record, index };
  }
  index = await rebuildLinks(index);

  return record;
}

export async function ingestPapersBatch(pdfInputPaths, { onProgress } = {}) {
  await ensureVaultLayout();
  // When PG is the relation store, load only entities — avoids the OOM from
  // materialising 913K relations into the Node heap.
  let index = (await useDbReads()) ? await loadEntitiesOnlyPG() : await loadIndex();
  const results = [];
  const total = pdfInputPaths.length;
  const startedAt = Date.now();
  let completed = 0;

  const paperConcurrency = Number(process.env.KB_PAPER_CONCURRENCY ?? 5);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(paperConcurrency, total) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= total) return;

      const pdfPath = pdfInputPaths[idx];
      const paperStart = Date.now();
      try {
        const { record, index: nextIndex } = await ingestPaper(pdfPath, { index, skipRebuild: true });
        index = nextIndex;
        results.push(record);
        completed += 1;

        if (typeof onProgress === "function") {
          const elapsedSec = (Date.now() - paperStart) / 1000;
          const totalSec = (Date.now() - startedAt) / 1000;
          const avgPerPaper = totalSec / completed;
          const remaining = total - completed;
          const etaSec = Math.round(avgPerPaper * remaining);
          onProgress({ record, index: completed, total, elapsedSec, etaSec });
        }
      } catch (err) {
        completed += 1;
        if (typeof onProgress === "function") {
          onProgress({ error: err.message ?? String(err), input: pdfPath, index: completed, total });
        }
      }
    }
  });
  await Promise.all(workers);

  await rebuildLinks(index);
  return results;
}

function normalizeRepoInput(input) {
  // Accept "org/repo" shorthand → full GitHub URL
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input)) {
    return `https://github.com/${input}.git`;
  }
  return input;
}

function isGitUrl(input) {
  return /^https?:\/\/|^git@/i.test(input);
}

function inferRepoName(input) {
  return slugify(path.basename(input).replace(/\.git$/i, ""));
}

function cloneRepository(repoUrl, destination) {
  const result = spawnSync("git", ["clone", "--depth", "1", repoUrl, destination], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Unable to clone ${repoUrl}`);
  }
}

function summarizeRepo(packResult) {
  const fileCount = packResult.includedFiles.length;
  const languageSummary = packResult.languages.length ? packResult.languages.join(", ") : "unknown languages";
  return `Packed ${fileCount} files across ${languageSummary}.`;
}

export async function ingestRepo(repoInput, options = {}) {
  await ensureVaultLayout();

  const normalizedInput = normalizeRepoInput(repoInput);
  let sourcePath = normalizedInput;
  let sourceUrl = "";
  let origin = "local";

  if (isGitUrl(normalizedInput)) {
    const repoName = inferRepoName(normalizedInput);
    sourcePath = path.join(repoCloneRoot, repoName);
    sourceUrl = normalizedInput;
    origin = "git";

    if (!(await fileExists(sourcePath))) {
      cloneRepository(normalizedInput, sourcePath);
    }
  }

  const resolvedRepoPath = path.resolve(sourcePath);
  if (!(await fileExists(resolvedRepoPath))) {
    throw new Error(`Repository not found: ${resolvedRepoPath}`);
  }

  const slug = inferRepoName(resolvedRepoPath);
  const repoDir = path.join(vaultRoot, "repos", slug);
  await ensureDir(repoDir);

  const packedContextPath = path.join(repoDir, "packed-context.md");
  const packResult = await packRepository(resolvedRepoPath, packedContextPath);
  const notePath = path.join(repoDir, "note.md");
  const summary = summarizeRepo(packResult);

  const record = {
    id: stableId("repo", slug),
    slug,
    type: "repo",
    title: path.basename(resolvedRepoPath),
    repoName: path.basename(resolvedRepoPath),
    createdAt: now(),
    updatedAt: now(),
    sourcePath: resolvedRepoPath,
    sourceUrl,
    origin,
    notePath,
    packedContextPath,
    tags: ["codebase"],
    languages: packResult.languages,
    entrypoints: packResult.entrypoints,
    keyModules: packResult.keyModules,
    summary,
    // Caller-provided metadata (e.g. {submittedBy, auditId, source:"user-audit"})
    // lands as top-level fields; upsertEntityPG spreads non-standard keys into
    // entities.meta JSONB automatically.
    ...(options.meta || {}),
  };
  record.packedContextMetaPath = await writeRepoMetadata(repoDir, record, packResult);

  let index = options.index ?? ((await useDbReads()) ? await loadEntitiesOnlyPG() : await loadIndex());
  const previous = index.repos.find((repo) => repo.id === record.id);
  if (previous) {
    record.createdAt = previous.createdAt;
  }

  index.repos = upsertEntity(index.repos, record);
  if (hasDatabase()) {
    await upsertEntityPG(record, "repo").catch((err) =>
      process.stderr.write(`[warn] upsertEntityPG repo ${record.id}: ${err.message}\n`),
    );
  }
  if (options.skipRebuild) {
    return { record, index };
  }
  index = await rebuildLinks(index);

  return record;
}

function scoreRelation(paper, repo) {
  const haystack = [paper.title, paper.summary, paper.methodologySummary, paper.constraintsSummary, paper.markdownExcerpt]
    .join(" ")
    .toLowerCase();
  const repoTokens = tokenize(`${repo.title} ${repo.repoName} ${repo.keyModules.join(" ")} ${repo.entrypoints.join(" ")}`);

  let score = 0;
  const evidence = [];

  for (const token of repoTokens) {
    if (!token || token.length < 3) {
      continue;
    }
    if (haystack.includes(token)) {
      score += token === repo.slug || token === repo.repoName.toLowerCase() ? 4 : 2;
      evidence.push(`Matched token "${token}" in paper text.`);
    }
  }

  const yearMatch = paper.year && haystack.includes(String(paper.year));
  if (yearMatch) {
    score += 1;
  }

  return { score, evidence: Array.from(new Set(evidence)).slice(0, 8) };
}

function scoreRepoRelation(a, b) {
  const tokensA = new Set(
    tokenize(
      `${a.title} ${a.repoName} ${(a.keyModules ?? []).join(" ")} ${(a.entrypoints ?? []).join(" ")}`,
    ).filter((token) => token && token.length >= 3),
  );
  const tokensB = new Set(
    tokenize(
      `${b.title} ${b.repoName} ${(b.keyModules ?? []).join(" ")} ${(b.entrypoints ?? []).join(" ")}`,
    ).filter((token) => token && token.length >= 3),
  );

  let score = 0;
  const evidence = [];

  for (const token of tokensA) {
    if (tokensB.has(token)) {
      score += 2;
      evidence.push(`Shared token "${token}".`);
    }
  }

  const langsA = new Set(a.languages ?? []);
  const langsB = new Set(b.languages ?? []);
  const sharedLangs = [...langsA].filter((lang) => langsB.has(lang));
  if (sharedLangs.length) {
    score += sharedLangs.length;
    evidence.push(`Shared languages: ${sharedLangs.join(", ")}.`);
  }

  return { score, evidence: Array.from(new Set(evidence)).slice(0, 8) };
}

export async function rebuildLinks(existingIndex = null) {
  await ensureVaultLayout();

  // When PG holds relations, load only entities to avoid materialising the
  // 913K-relation JSON into the Node heap — that's what caused the OOM.
  const usePg = await useDbReads();

  let papers, repos, docs;
  if (existingIndex) {
    ({ papers, repos } = existingIndex);
    docs = existingIndex.docs ?? [];
  } else if (usePg) {
    const pg = await loadEntitiesOnlyPG();
    ({ papers, repos, docs } = pg);
  } else {
    const idx = await loadIndex();
    ({ papers, repos } = idx);
    docs = idx.docs ?? [];
  }

  if (usePg) {
    // PG streaming path — never accumulate 913K relation objects in memory.
    // Score, flush to PG in 500-row batches, then discard. Keeps only lightweight
    // Maps of linked entity IDs for note generation.
    const BATCH = 500;
    let buffer = [];
    // Lightweight Maps for note rendering (just IDs, not full relation objects).
    const paperToRepos = new Map();
    const repoToPapers = new Map();
    const repoToRepos = new Map();

    const flushBuffer = async () => {
      if (!buffer.length) return;
      await insertRelationBatchPG(buffer);
      buffer = [];
      await new Promise((r) => setImmediate(r)); // keep event loop alive
    };

    // TRUNCATE is O(1) — critical for 913K existing rows.
    await db().query("TRUNCATE TABLE relations");

    let iterCount = 0;
    const maybeYield = () => (++iterCount % 1000 === 0 ? new Promise((r) => setImmediate(r)) : undefined);

    for (const paper of papers) {
      for (const repo of repos) {
        await maybeYield();
        const rel = scoreRelation(paper, repo);
        if (rel.score < 2) continue;
        buffer.push({
          fromId: paper.id, toId: repo.id, relationType: "informs",
          score: rel.score,
          evidence: rel.evidence.length ? rel.evidence : ["Token overlap between paper summary and repository metadata."],
          notePath: path.join(vaultRoot, "links", `${paper.id}__${repo.id}.md`),
        });
        if (!paperToRepos.has(paper.id)) paperToRepos.set(paper.id, []);
        paperToRepos.get(paper.id).push(repo.id);
        if (!repoToPapers.has(repo.id)) repoToPapers.set(repo.id, []);
        repoToPapers.get(repo.id).push(paper.id);
        if (buffer.length >= BATCH) await flushBuffer();
      }
    }

    for (let i = 0; i < repos.length; i += 1) {
      for (let j = i + 1; j < repos.length; j += 1) {
        await maybeYield();
        const a = repos[i];
        const b = repos[j];
        const rel = scoreRepoRelation(a, b);
        if (rel.score < 3) continue;
        buffer.push({
          fromId: a.id, toId: b.id, relationType: "related",
          score: rel.score,
          evidence: rel.evidence,
          notePath: path.join(vaultRoot, "links", `${a.id}__${b.id}.md`),
        });
        if (!repoToRepos.has(a.id)) repoToRepos.set(a.id, []);
        repoToRepos.get(a.id).push(b.id);
        if (!repoToRepos.has(b.id)) repoToRepos.set(b.id, []);
        repoToRepos.get(b.id).push(a.id);
        if (buffer.length >= BATCH) await flushBuffer();
      }
    }
    await flushBuffer();

    // Write entity notes using the lightweight ID Maps.
    for (const paper of papers) {
      const linkedRepos = (paperToRepos.get(paper.id) ?? [])
        .map((id) => repos.find((r) => r.id === id)).filter(Boolean);
      paper.updatedAt = now();
      await fs.writeFile(paper.notePath, `${renderPaperNote(paper, linkedRepos)}\n`, "utf8");
    }
    for (const repo of repos) {
      const linkedPapers = (repoToPapers.get(repo.id) ?? [])
        .map((id) => papers.find((p) => p.id === id)).filter(Boolean);
      const linkedRepos = (repoToRepos.get(repo.id) ?? [])
        .map((id) => repos.find((r) => r.id === id)).filter(Boolean);
      repo.updatedAt = now();
      await fs.writeFile(repo.notePath, `${renderRepoNote(repo, linkedPapers, linkedRepos)}\n`, "utf8");
    }

    // Save JSON with entities only (relations live in PG).
    return saveIndex({ papers, repos, docs, relations: [] });
  }

  // JSON-only path (no PG) — accumulate and save as before.
  const relations = [];
  for (const paper of papers) {
    for (const repo of repos) {
      const rel = scoreRelation(paper, repo);
      if (rel.score < 2) continue;
      const id = `${paper.id}__${repo.id}`;
      relations.push({
        id, fromId: paper.id, toId: repo.id, relationType: "informs",
        score: rel.score,
        confidence: rel.score >= 6 ? "high" : rel.score >= 4 ? "medium" : "low",
        evidence: rel.evidence.length ? rel.evidence : ["Token overlap between paper summary and repository metadata."],
        createdAt: now(), updatedAt: now(),
        notePath: path.join(vaultRoot, "links", `${id}.md`),
      });
    }
  }
  for (let i = 0; i < repos.length; i += 1) {
    for (let j = i + 1; j < repos.length; j += 1) {
      const a = repos[i];
      const b = repos[j];
      const rel = scoreRepoRelation(a, b);
      if (rel.score < 3) continue;
      const id = `${a.id}__${b.id}`;
      relations.push({
        id, fromId: a.id, toId: b.id, relationType: "related",
        score: rel.score,
        confidence: rel.score >= 8 ? "high" : rel.score >= 5 ? "medium" : "low",
        evidence: rel.evidence,
        createdAt: now(), updatedAt: now(),
        notePath: path.join(vaultRoot, "links", `${id}.md`),
      });
    }
  }
  const idx = existingIndex ?? (await loadIndex());
  idx.relations = relations;
  await regenerateNotes(idx);
  return saveIndex(idx);
}

// YY = 07-29 (arXiv's new scheme started April 2007), MM = 01-12
const ARXIV_ID_BODY = "(?:0[7-9]|[1-2]\\d)(?:0[1-9]|1[0-2])\\.\\d{4,5}";
const ARXIV_ID_RE = new RegExp(`\\b(${ARXIV_ID_BODY})(v\\d+)?\\b`, "g");
const ARXIV_CONTEXT_RE = new RegExp(`arxiv(?:\\.org)?[^\\n]{0,40}?(${ARXIV_ID_BODY})`, "gi");

function normalizeArxivId(raw) {
  return raw.replace(/v\d+$/i, "");
}

async function verifyArxivIds(ids) {
  // arXiv API: http://export.arxiv.org/api/query?id_list=a,b,c — Atom XML.
  // Batch up to 100 per request to keep it polite.
  const verified = new Map();
  const batchSize = 50;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const url = `http://export.arxiv.org/api/query?id_list=${batch.join(",")}&max_results=${batch.length}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "kb-discover/0.1" } });
      if (!res.ok) continue;
      const xml = await res.text();
      // Each <entry> contains <id>http://arxiv.org/abs/ID</id> and <title>...</title>
      const entries = xml.split(/<entry>/).slice(1);
      for (const entry of entries) {
        const idMatch = entry.match(/<id>[^<]*arxiv\.org\/abs\/([^<v]+)(?:v\d+)?<\/id>/i);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        if (idMatch) {
          verified.set(idMatch[1].trim(), {
            title: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "",
          });
        }
      }
    } catch {
      // Soft-fail this batch; the candidate simply won't be marked verified.
    }
  }
  return verified;
}

export async function discoverArxivCandidates() {
  const index = await loadIndex();
  const ingested = new Set(
    index.papers
      .map((paper) => paper.slug?.match(/\d{4}-\d{4,5}/)?.[0]?.replace("-", "."))
      .filter(Boolean),
  );

  const candidates = new Map();

  for (const paper of index.papers) {
    const paperDir = path.dirname(paper.notePath);
    const rawDir = path.join(paperDir, "raw");
    const rawFiles = await fs.readdir(rawDir).catch(() => []);
    const markdownFile = rawFiles.find((name) => name.endsWith(".md"));
    if (!markdownFile) continue;

    const content = await fs.readFile(path.join(rawDir, markdownFile), "utf8").catch(() => "");
    if (!content) continue;

    const hits = new Set();
    // Prefer context matches (arXiv:xxxx.xxxxx)
    for (const match of content.matchAll(ARXIV_CONTEXT_RE)) {
      hits.add(normalizeArxivId(match[1]));
    }
    // Then bare IDs as a broader net
    for (const match of content.matchAll(ARXIV_ID_RE)) {
      hits.add(normalizeArxivId(match[1]));
    }

    for (const id of hits) {
      if (ingested.has(id)) continue;
      // Skip self-references.
      if (paper.slug?.replace("-", ".") === id) continue;
      const existing = candidates.get(id) ?? { arxivId: id, sources: [], count: 0 };
      if (!existing.sources.includes(paper.id)) {
        existing.sources.push(paper.id);
      }
      existing.count += 1;
      candidates.set(id, existing);
    }
  }

  const rawSorted = [...candidates.values()].sort((a, b) => b.sources.length - a.sources.length || a.arxivId.localeCompare(b.arxivId));

  const verified = await verifyArxivIds(rawSorted.map((c) => c.arxivId));
  const sorted = rawSorted
    .filter((c) => verified.has(c.arxivId))
    .map((c) => ({ ...c, title: verified.get(c.arxivId)?.title ?? "" }));

  const discoveryDir = path.join(vaultRoot, "discovery");
  await ensureDir(discoveryDir);
  const outPath = path.join(discoveryDir, "arxiv-candidates.json");
  await fs.writeFile(
    outPath,
    `${JSON.stringify({ generatedAt: now(), count: sorted.length, candidates: sorted }, null, 2)}\n`,
    "utf8",
  );

  return { outPath, candidates: sorted };
}

// ---------------------------------------------------------------------------
// ingestSitemap — per-page ingest. Parses sitemap.xml, filters URLs, runs
// HTML→Markdown via gpt-5.4-nano (no Firecrawl), writes one paper-shaped
// entity per page, does a single rebuildLinks at the end.
// ---------------------------------------------------------------------------
export async function ingestSitemap(sitemapUrl, options = {}) {
  const { urlFilter = null, maxPages = 200, concurrency = 4, onProgress } = options;
  await ensureVaultLayout();
  await ensureDir(path.join(vaultRoot, "articles"));

  let urls = await parseSitemap(sitemapUrl);
  if (urlFilter) {
    const re = new RegExp(urlFilter);
    urls = urls.filter((u) => re.test(u));
  }
  urls = urls.slice(0, maxPages);
  const total = urls.length;
  if (!total) return { total: 0, ingested: 0, failed: 0, results: [] };

  let index = (await useDbReads()) ? await loadEntitiesOnlyPG() : await loadIndex();
  const results = [];
  let cursor = 0;
  let done = 0;
  const startedAt = Date.now();

  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= total) return;
      const url = urls[i];
      try {
        const record = await fetchAndExtractArticle(url);
        const previous = index.papers.find((p) => p.id === record.id);
        if (previous) record.createdAt = previous.createdAt;
        index.papers = upsertEntity(index.papers, record);
        if (hasDatabase()) {
          await upsertEntityPG(record, "paper").catch((err) => {
            process.stderr.write(`[warn] upsertEntityPG article ${record.id}: ${err.message}\n`);
          });
        }
        results.push({ url, id: record.id, title: record.title });
      } catch (err) {
        results.push({ url, error: err.message });
      }
      done += 1;
      if (onProgress) {
        const elapsed = (Date.now() - startedAt) / 1000;
        onProgress({ index: done, total, url, elapsedSec: elapsed });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker()),
  );

  if (!options.skipRebuild) {
    await rebuildLinks(index);
  }

  const ingested = results.filter((r) => !r.error).length;
  return { total, ingested, failed: total - ingested, results };
}

export async function ingestDocsSite(url, options = {}) {
  await ensureVaultLayout();
  const docsDir = path.join(vaultRoot, "docs");
  await ensureDir(docsDir);

  const record = await _ingestDocs(url, options);

  let index = options.index ?? ((await useDbReads()) ? await loadEntitiesOnlyPG() : await loadIndex());
  const previous = (index.docs ?? []).find((d) => d.id === record.id);
  if (previous) {
    record.createdAt = previous.createdAt;
  }

  index.docs = upsertEntity(index.docs ?? [], record);
  if (hasDatabase()) {
    await upsertEntityPG(record, "docs").catch((err) =>
      process.stderr.write(`[warn] upsertEntityPG docs ${record.id}: ${err.message}\n`),
    );
  }
  if (options.skipRebuild) {
    return { record, index };
  }
  index = await rebuildLinks(index);
  return record;
}

export async function ingestReposBatch(repoInputs, { onProgress } = {}) {
  await ensureVaultLayout();
  // Same OOM-safe load as ingestPapersBatch.
  let index = (await useDbReads()) ? await loadEntitiesOnlyPG() : await loadIndex();
  const total = repoInputs.length;
  const startedAt = Date.now();
  const results = [];

  for (let i = 0; i < repoInputs.length; i += 1) {
    const repoInput = repoInputs[i];
    const stepStart = Date.now();
    try {
      const { record, index: nextIndex } = await ingestRepo(repoInput, { index, skipRebuild: true });
      index = nextIndex;
      results.push(record);

      if (typeof onProgress === "function") {
        const elapsedSec = (Date.now() - stepStart) / 1000;
        const totalSec = (Date.now() - startedAt) / 1000;
        const avgPer = totalSec / (i + 1);
        const remaining = total - (i + 1);
        const etaSec = Math.round(avgPer * remaining);
        onProgress({ record, index: i + 1, total, elapsedSec, etaSec });
      }
    } catch (err) {
      if (typeof onProgress === "function") {
        onProgress({
          error: err.message ?? String(err),
          input: repoInput,
          index: i + 1,
          total,
        });
      }
    }
  }

  await rebuildLinks(index);
  return results;
}

export async function fetchArxivCandidates(limit = 10, { onProgress } = {}) {
  const discoveryPath = path.join(vaultRoot, "discovery", "arxiv-candidates.json");
  if (!(await fileExists(discoveryPath))) {
    throw new Error("No candidates file. Run `kb discover-arxiv` first.");
  }

  const payload = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
  const top = (payload.candidates ?? []).slice(0, limit);
  if (!top.length) {
    return { downloaded: [], ingested: [] };
  }

  const inboxDir = path.join(projectRoot, "inbox");
  await ensureDir(inboxDir);

  const downloaded = [];
  for (const candidate of top) {
    const pdfPath = path.join(inboxDir, `${candidate.arxivId}.pdf`);
    if (await fileExists(pdfPath)) {
      downloaded.push(pdfPath);
      continue;
    }
    const url = `https://arxiv.org/pdf/${candidate.arxivId}.pdf`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "kb-discover/0.1" } });
      if (!res.ok) {
        process.stderr.write(`Skipping ${candidate.arxivId}: HTTP ${res.status}\n`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.slice(0, 5).toString() !== "%PDF-") {
        process.stderr.write(`Skipping ${candidate.arxivId}: not a PDF\n`);
        continue;
      }
      await fs.writeFile(pdfPath, buf);
      downloaded.push(pdfPath);
    } catch (err) {
      process.stderr.write(`Skipping ${candidate.arxivId}: ${err.message ?? err}\n`);
    }
  }

  if (!downloaded.length) {
    return { downloaded: [], ingested: [] };
  }

  const ingested = await ingestPapersBatch(downloaded, { onProgress });
  return { downloaded, ingested };
}

export async function searchArxiv(query, { limit = 20 } = {}) {
  const index = await loadIndex();
  const ingested = new Set(
    index.papers
      .map((paper) => paper.slug?.match(/\d{4}-\d{4,5}/)?.[0]?.replace("-", "."))
      .filter(Boolean),
  );

  const encoded = encodeURIComponent(query);
  const url = `http://export.arxiv.org/api/query?search_query=all:${encoded}&sortBy=relevance&sortOrder=descending&max_results=${limit * 2}`;
  const res = await fetch(url, { headers: { "User-Agent": "kb-discover/0.1" } });
  if (!res.ok) {
    throw new Error(`arXiv API ${res.status}: ${await res.text().then((t) => t.slice(0, 300))}`);
  }

  const xml = await res.text();
  const entries = xml.split(/<entry>/).slice(1);
  const candidates = [];

  for (const entry of entries) {
    const idMatch = entry.match(/<id>[^<]*arxiv\.org\/abs\/([^<v]+)(?:v\d+)?<\/id>/i);
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    if (!idMatch) continue;

    const arxivId = idMatch[1].trim();
    if (ingested.has(arxivId)) continue;

    candidates.push({
      arxivId,
      title: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "",
      abstract: summaryMatch ? summaryMatch[1].replace(/\s+/g, " ").trim().slice(0, 300) : "",
      sources: ["arxiv-search"],
      count: 1,
    });

    if (candidates.length >= limit) break;
  }

  const discoveryDir = path.join(vaultRoot, "discovery");
  await ensureDir(discoveryDir);
  const outPath = path.join(discoveryDir, "arxiv-candidates.json");
  await fs.writeFile(
    outPath,
    `${JSON.stringify({ generatedAt: now(), query, count: candidates.length, candidates }, null, 2)}\n`,
    "utf8",
  );

  return { outPath, candidates };
}

export async function searchGithubRepos(query, { limit = 20, sort = "stars" } = {}) {
  const index = await loadIndex();
  const ingested = new Set(index.repos.map((r) => r.slug));

  const encoded = encodeURIComponent(query);
  const url = `https://api.github.com/search/repositories?q=${encoded}&sort=${sort}&order=desc&per_page=${limit * 2}`;
  const headers = { "User-Agent": "kb-discover/0.1", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text().then((t) => t.slice(0, 300))}`);
  }

  const json = await res.json();
  const candidates = [];
  for (const item of json.items ?? []) {
    const slug = slugify(item.name);
    if (ingested.has(slug)) continue;

    candidates.push({
      fullName: item.full_name,
      name: item.name,
      description: item.description ?? "",
      stars: item.stargazers_count,
      language: item.language,
      url: item.html_url,
      cloneUrl: item.clone_url,
      updatedAt: item.updated_at,
      sources: ["github-search"],
    });

    if (candidates.length >= limit) break;
  }

  const discoveryDir = path.join(vaultRoot, "discovery");
  await ensureDir(discoveryDir);
  const outPath = path.join(discoveryDir, "github-candidates.json");
  await fs.writeFile(
    outPath,
    `${JSON.stringify({ generatedAt: now(), query, count: candidates.length, candidates }, null, 2)}\n`,
    "utf8",
  );

  return { outPath, candidates };
}

export async function fetchRepoCandidates(limit = 10, { onProgress } = {}) {
  const discoveryPath = path.join(vaultRoot, "discovery", "github-candidates.json");
  if (!(await fileExists(discoveryPath))) {
    throw new Error("No candidates file. Run `kb search-github` first.");
  }

  const payload = JSON.parse(await fs.readFile(discoveryPath, "utf8"));
  const top = (payload.candidates ?? []).slice(0, limit);
  if (!top.length) {
    return { ingested: [] };
  }

  const sources = top.map((c) => c.cloneUrl);
  const results = await ingestReposBatch(sources, { onProgress });
  return { ingested: results };
}

export async function queryContext(identifier) {
  const index = await loadIndex();
  if (!(await fileExists(indexPath))) {
    throw new Error("Index not found. Run an ingest command first.");
  }

  const entity = findEntity(index, identifier);
  if (!entity) {
    throw new Error(`Entity not found: ${identifier}`);
  }

  const relatedRelations =
    entity.type === "paper"
      ? index.relations.filter((relation) => relation.fromId === entity.id)
      : index.relations.filter(
          (relation) => relation.toId === entity.id || relation.fromId === entity.id,
        );
  const linkedEntities = relatedRelations
    .map((relation) => {
      if (entity.type === "paper") {
        return index.repos.find((repo) => repo.id === relation.toId);
      }
      if (relation.relationType === "related") {
        const otherId = relation.fromId === entity.id ? relation.toId : relation.fromId;
        return index.repos.find((repo) => repo.id === otherId);
      }
      return index.papers.find((paper) => paper.id === relation.fromId);
    })
    .filter(Boolean);

  const lines = [
    `id: ${entity.id}`,
    `type: ${entity.type}`,
    `title: ${entity.title}`,
    `note: ${entity.notePath}`,
    `source: ${entity.sourcePath}`,
    "",
    "linked_entities:",
  ];

  for (const linked of linkedEntities) {
    lines.push(`- ${linked.id} | ${linked.title} | ${linked.notePath}`);
  }

  if (entity.type === "repo") {
    lines.push("", `packed_context: ${entity.packedContextPath}`);
    lines.push(`packed_context_meta: ${entity.packedContextMetaPath}`);
  }

  return lines.join("\n");
}
