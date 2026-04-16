// Sitemap → per-page ingest. Uses gpt-5.4-nano (already a dependency) to
// turn raw HTML into clean markdown — no Firecrawl, no Puppeteer, no extra
// npm deps. One entity per URL, reusing the paper-pipeline plumbing so
// embeddings + search + rebuildLinks all work unchanged.

import fs from "node:fs/promises";
import path from "node:path";

import { vaultRoot } from "./config.js";
import { ensureDir, slugify, stableId } from "./fs-utils.js";
import { llmSummarize } from "./llm-summarize.js";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.KB_LLM_MODEL ?? "gpt-5.4-nano";
const HTML_CAP = 150_000; // ~40K tokens upper bound per page
const MIN_CONTENT = 200;  // chars — anything shorter is almost certainly boilerplate

// ---------------------------------------------------------------------------
// Sitemap parsing — handles both url-sitemaps and sitemap-indexes.
// ---------------------------------------------------------------------------
export async function parseSitemap(sitemapUrl, depth = 0) {
  if (depth > 3) return []; // guard against cycles
  const res = await fetch(sitemapUrl, {
    redirect: "follow",
    headers: { "User-Agent": "kb-sitemap-ingester/0.1" },
  });
  if (!res.ok) throw new Error(`sitemap fetch ${res.status}`);
  const xml = await res.text();

  // Sitemap index? Recurse into each child.
  if (/<sitemapindex\b/i.test(xml)) {
    const subs = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map((m) =>
      m[1].trim(),
    );
    const all = new Set();
    for (const sub of subs) {
      try {
        const children = await parseSitemap(sub, depth + 1);
        children.forEach((u) => all.add(u));
      } catch (err) {
        process.stderr.write(`[sitemap] sub-sitemap ${sub} failed: ${err.message}\n`);
      }
    }
    return [...all];
  }

  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return [...new Set(urls)];
}

// ---------------------------------------------------------------------------
// HTML fetch + LLM-driven content extraction.
// ---------------------------------------------------------------------------
async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (kb-sitemap-ingester/0.1) AppleWebKit/537.36 (KHTML, like Gecko)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return await res.text();
}

function stripHtmlBoilerplate(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .slice(0, HTML_CAP);
}

async function htmlToMarkdown(html, url, retries = 5) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const cleaned = stripHtmlBoilerplate(html);
  const body = {
    model: MODEL,
    instructions:
      "Extract the main article or content from this HTML as clean Markdown. " +
      "Discard navigation, ads, footer, boilerplate, comments, share buttons, " +
      "and cookie banners. Preserve headings (# ##), paragraphs, lists, code " +
      "blocks, and tables. Do NOT wrap in triple backticks. Start directly " +
      "with the first heading or sentence. If the page is empty, a 404, or " +
      "login-gated, output exactly: NO_CONTENT",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `URL: ${url}\n\nHTML:\n${cleaned}` }],
      },
    ],
  };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    // 429 rate limit → exponential backoff (2s, 4s, 8s, 16s, 30s cap)
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(2 ** attempt * 2000, 30000);
      process.stderr.write(
        `[sitemap] 429 on ${url} (attempt ${attempt + 1}/${retries + 1}), waiting ${wait / 1000}s\n`,
      );
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
    }
    const json = await res.json();
    if (typeof json.output_text === "string" && json.output_text.length) {
      return json.output_text;
    }
    const chunks = [];
    for (const item of json.output ?? []) {
      for (const piece of item.content ?? []) {
        if (typeof piece.text === "string") chunks.push(piece.text);
      }
    }
    return chunks.join("\n");
  }
  throw new Error(`OpenAI 429 exhausted retries for ${url}`);
}

// ---------------------------------------------------------------------------
// Per-URL → paper-shaped entity record. The `type` stays "paper" so the
// embedding + search pipeline picks it up with zero changes; `kind: "article"`
// in meta lets callers distinguish source.
// ---------------------------------------------------------------------------
function articleSlug(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, "");
  const body = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean).join("-");
  return slugify(body ? `${host}-${body}` : host).slice(0, 80) || slugify(host);
}

function inferTitle(markdown, url) {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 200);
  const line = markdown.split("\n").find((l) => l.trim().length > 10);
  if (line) return line.trim().replace(/^[#*\-\s]+/, "").slice(0, 200);
  return new URL(url).pathname || url;
}

function trim(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

export async function fetchAndExtractArticle(url) {
  const html = await fetchHtml(url);
  const markdown = await htmlToMarkdown(html, url);
  const body = markdown.trim();
  if (body === "NO_CONTENT") throw new Error("no content");
  if (body.length < MIN_CONTENT) throw new Error(`content too short (${body.length} chars)`);

  const slug = articleSlug(url);
  const articleDir = path.join(vaultRoot, "articles", slug);
  const rawDir = path.join(articleDir, "raw");
  await ensureDir(rawDir);
  await fs.writeFile(path.join(rawDir, `${slug}.md`), `${body}\n`, "utf8");

  const title = inferTitle(body, url);
  const now = new Date().toISOString();
  const id = stableId("article", slug);

  // LLM summarization — produces much better quality than a naive first-N-chars
  // slice. Falls back to the crude excerpt if it 429s out or parses badly.
  const llm = await llmSummarize(body).catch(() => null);
  const fallbackSummary = trim(body.replace(/^#[^\n]+\n+/, ""), 1200);

  const record = {
    id,
    slug,
    type: "paper",
    title,
    sourceUrl: url,
    sourcePath: "",
    createdAt: now,
    updatedAt: now,
    notePath: path.join(articleDir, "note.md"),
    summary: trim(llm?.summary || fallbackSummary, 1200),
    markdownExcerpt: trim(body, 2500),
    // Paper-shape fields — empty defaults ensure renderPaperNote and
    // scoreRelation never crash on missing iterables.
    authors: [],
    year: "",
    methodologySummary: trim(llm?.methodology ?? "", 800),
    constraintsSummary: trim(llm?.constraints ?? "", 800),
    assets: [],
    citations: [],
    tags: ["article", ...(llm?.topics ?? [])],
    kind: "article",
    topics: llm?.topics ?? [],
  };

  const note = [
    "---",
    `id: "${id}"`,
    `type: "paper"`,
    `kind: "article"`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source_url: "${url}"`,
    `tags:`,
    `  - "article"`,
    "---",
    "",
    `# ${title}`,
    "",
    `Source: [${url}](${url})`,
    "",
    record.markdownExcerpt,
    "",
  ].join("\n");
  await fs.writeFile(record.notePath, note, "utf8");

  return record;
}
