import fs from "node:fs/promises";
import path from "node:path";

import { vaultRoot } from "./config.js";
import { ensureDir, slugify, stableId } from "./fs-utils.js";

const FIRECRAWL_URL = "https://api.firecrawl.dev/v1";

function now() {
  return new Date().toISOString();
}

function inferDocsSlug(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  const firstPath = u.pathname.split("/").filter(Boolean)[0] ?? "";
  return slugify(firstPath ? `${host}-${firstPath}` : host);
}

function inferDocsTitle(url, firstPage) {
  if (firstPage?.metadata?.title) return firstPage.metadata.title;
  const u = new URL(url);
  return u.hostname.replace(/^www\./, "");
}

async function firecrawlRequest(path, body) {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error(
      "FIRECRAWL_API_KEY not set. Get one at https://firecrawl.dev and set it as an env var.",
    );
  }
  const res = await fetch(`${FIRECRAWL_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firecrawl ${path} ${res.status}: ${errText.slice(0, 400)}`);
  }
  return await res.json();
}

async function firecrawlGet(path) {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error("FIRECRAWL_API_KEY not set.");
  }
  const res = await fetch(`${FIRECRAWL_URL}${path}`, {
    headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firecrawl ${path} ${res.status}: ${errText.slice(0, 400)}`);
  }
  return await res.json();
}

/**
 * Start a crawl job, poll until complete, return all scraped pages.
 */
async function crawlSite(url, { maxPages = 100, includePaths, excludePaths } = {}) {
  const body = {
    url,
    limit: maxPages,
    scrapeOptions: {
      formats: ["markdown"],
      onlyMainContent: true,
    },
  };
  if (includePaths) body.includePaths = includePaths;
  if (excludePaths) body.excludePaths = excludePaths;

  const start = await firecrawlRequest("/crawl", body);
  const jobId = start.id ?? start.jobId;
  if (!jobId) {
    throw new Error(`Firecrawl returned no job id: ${JSON.stringify(start).slice(0, 300)}`);
  }

  // Poll until done
  const pollInterval = 5000;
  const maxWaitMs = 10 * 60 * 1000; // 10 minutes
  const startedAt = Date.now();
  let pages = [];

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval));
    const status = await firecrawlGet(`/crawl/${jobId}`);

    if (status.data) {
      pages = status.data;
    }

    if (status.status === "completed") {
      return pages;
    }
    if (status.status === "failed") {
      throw new Error(`Firecrawl crawl failed: ${status.error ?? "unknown"}`);
    }
  }

  throw new Error(`Firecrawl crawl timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Ingest a documentation site: crawl → save pages → build note.md + meta.json.
 */
export async function ingestDocs(url, { maxPages = 100, includePaths, excludePaths, title } = {}) {
  const slug = inferDocsSlug(url);
  const docsDir = path.join(vaultRoot, "docs", slug);
  const pagesDir = path.join(docsDir, "pages");
  await ensureDir(pagesDir);

  const pages = await crawlSite(url, { maxPages, includePaths, excludePaths });

  if (!pages.length) {
    throw new Error(`No pages scraped from ${url}`);
  }

  const pageRecords = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const markdown = page.markdown ?? "";
    const metadata = page.metadata ?? {};
    const pageUrl = metadata.sourceURL ?? metadata.url ?? url;
    const pageTitle = metadata.title ?? `Page ${i + 1}`;

    const pageSlug = slugify(pageTitle).slice(0, 80) || `page-${i + 1}`;
    const filename = `${String(i + 1).padStart(4, "0")}-${pageSlug}.md`;
    const pagePath = path.join(pagesDir, filename);

    const fileContent = `---\ntitle: "${pageTitle.replace(/"/g, '\\"')}"\nurl: "${pageUrl}"\n---\n\n${markdown}`;
    await fs.writeFile(pagePath, fileContent, "utf8");

    pageRecords.push({
      index: i + 1,
      title: pageTitle,
      url: pageUrl,
      path: pagePath,
      bytes: Buffer.byteLength(markdown, "utf8"),
    });
  }

  const record = {
    id: stableId("docs", slug),
    slug,
    type: "docs",
    title: title ?? inferDocsTitle(url, pages[0]),
    sourceUrl: url,
    createdAt: now(),
    updatedAt: now(),
    pageCount: pageRecords.length,
    totalBytes: pageRecords.reduce((s, p) => s + p.bytes, 0),
    notePath: path.join(docsDir, "note.md"),
    metaPath: path.join(docsDir, "meta.json"),
    pagesDir,
    tags: ["documentation"],
  };

  const meta = {
    id: record.id,
    slug,
    title: record.title,
    sourceUrl: url,
    crawledAt: now(),
    pageCount: pageRecords.length,
    totalBytes: record.totalBytes,
    pages: pageRecords,
  };
  await fs.writeFile(record.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  const note = [
    `---`,
    `id: "${record.id}"`,
    `type: "docs"`,
    `title: "${record.title.replace(/"/g, '\\"')}"`,
    `source_url: "${url}"`,
    `crawled_at: "${record.createdAt}"`,
    `pages: ${pageRecords.length}`,
    `tags:`,
    `  - "documentation"`,
    `---`,
    ``,
    `# ${record.title}`,
    ``,
    `Source: [${url}](${url})`,
    ``,
    `**${pageRecords.length} pages** crawled (${(record.totalBytes / 1024).toFixed(0)} KB total)`,
    ``,
    `## Pages`,
    ``,
    ...pageRecords.slice(0, 50).map((p) => `- [${p.title}](pages/${path.basename(p.path)})`),
    pageRecords.length > 50 ? `\n... and ${pageRecords.length - 50} more pages.` : "",
    ``,
  ].join("\n");
  await fs.writeFile(record.notePath, note, "utf8");

  return record;
}
