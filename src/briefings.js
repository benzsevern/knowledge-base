import fs from "node:fs/promises";
import path from "node:path";

import { vaultRoot } from "./config.js";
import { ensureDir, slugify } from "./fs-utils.js";
import { loadIndex } from "./indexer.js";
import { semanticSearch } from "./embeddings.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const CHAT_MODEL = process.env.KB_CHAT_MODEL ?? process.env.KB_LLM_MODEL ?? "gpt-5.4-nano";

function now() {
  return new Date().toISOString();
}

function stampedFilename(slug) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${slug}.${stamp}.md`;
}

/**
 * Group hits by entity and collapse adjacent chunks from the same entity.
 */
function groupByEntity(hits) {
  const byEntity = new Map();
  for (const hit of hits) {
    const key = hit.entry.entityId;
    if (!byEntity.has(key)) {
      byEntity.set(key, {
        entityId: hit.entry.entityId,
        entityTitle: hit.entry.entityTitle,
        type: hit.entry.type,
        chunks: [],
        topScore: 0,
      });
    }
    const group = byEntity.get(key);
    group.chunks.push({
      score: hit.score,
      kind: hit.entry.kind,
      text: hit.entry.text,
      chunkIndex: hit.entry.chunkIndex ?? 0,
      sourceFile: hit.entry.sourceFile,
    });
    if (hit.score > group.topScore) group.topScore = hit.score;
  }

  // Sort chunks within each entity by chunkIndex (or score if no index)
  for (const group of byEntity.values()) {
    group.chunks.sort((a, b) => {
      if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
      return b.score - a.score;
    });
  }

  return [...byEntity.values()].sort((a, b) => b.topScore - a.topScore);
}

function truncate(text, max = 1200) {
  const clean = text.replace(/^---[\s\S]*?---/m, "").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + "...";
}

function renderEntitySection(group, indexLookup) {
  const entity = indexLookup.get(group.entityId);
  const lines = [];
  const title = group.entityTitle;
  lines.push(`### ${title}`);

  if (entity) {
    if (entity.sourceUrl) lines.push(`**Source:** [${entity.sourceUrl}](${entity.sourceUrl})`);
    if (entity.notePath) lines.push(`**Entity:** \`${group.entityId}\``);
    if (entity.year) lines.push(`**Year:** ${entity.year}`);
    if (entity.languages?.length) lines.push(`**Languages:** ${entity.languages.join(", ")}`);
    if (entity.pageCount) lines.push(`**Pages:** ${entity.pageCount}`);
  }
  lines.push(`**Top score:** ${group.topScore.toFixed(3)} · **Chunks:** ${group.chunks.length}`);
  lines.push("");

  for (const chunk of group.chunks) {
    const label = chunk.sourceFile ? ` _(${chunk.sourceFile})_` : "";
    lines.push(`> **${chunk.score.toFixed(3)}**${label}`);
    const excerpt = truncate(chunk.text);
    for (const line of excerpt.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function renderBrief(topic, hits, { scopeLabel } = {}) {
  const index = await loadIndex();
  const allEntities = [
    ...index.papers,
    ...index.repos,
    ...(index.docs ?? []),
  ];
  const indexLookup = new Map(allEntities.map((e) => [e.id, e]));

  const groups = groupByEntity(hits);

  const byType = {
    paper: groups.filter((g) => g.type === "article" || g.type === "academic_paper"),
    repo: groups.filter((g) => g.type === "repo"),
    docs: groups.filter((g) => g.type === "docs"),
  };

  const lines = [];
  lines.push(`# Topic Brief: ${topic}`);
  lines.push("");
  lines.push(`_Generated: ${now()}_  `);
  if (scopeLabel) lines.push(`_Scope: ${scopeLabel}_  `);
  lines.push(
    `_${hits.length} chunks across ${groups.length} entities (${byType.paper.length} papers, ${byType.repo.length} repos, ${byType.docs.length} doc sites)_`,
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  if (byType.paper.length) {
    lines.push(`## Research Papers (${byType.paper.length})`);
    lines.push("");
    for (const group of byType.paper) {
      lines.push(renderEntitySection(group, indexLookup));
    }
    lines.push("---");
    lines.push("");
  }

  if (byType.repo.length) {
    lines.push(`## Code Repositories (${byType.repo.length})`);
    lines.push("");
    for (const group of byType.repo) {
      lines.push(renderEntitySection(group, indexLookup));
    }
    lines.push("---");
    lines.push("");
  }

  if (byType.docs.length) {
    lines.push(`## Documentation (${byType.docs.length})`);
    lines.push("");
    for (const group of byType.docs) {
      lines.push(renderEntitySection(group, indexLookup));
    }
    lines.push("---");
    lines.push("");
  }

  lines.push("## Suggested Deep Dives");
  lines.push("");
  const top = groups.slice(0, 10);
  for (const g of top) {
    lines.push(`- **${g.entityTitle}** (${g.type}) — score ${g.topScore.toFixed(3)} · \`${g.entityId}\``);
  }

  return {
    markdown: lines.join("\n"),
    stats: {
      chunks: hits.length,
      entities: groups.length,
      papers: byType.paper.length,
      repos: byType.repo.length,
      docs: byType.docs.length,
    },
  };
}

async function synthesizeNarrative(topic, rawBrief) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set; cannot synthesize.");
  }

  const instructions =
    "You are a research analyst writing a cohesive briefing document based on the supplied excerpts. " +
    "Use ONLY the supplied material; do not invent facts. " +
    "Structure the output as: " +
    "1. Executive Summary (3-5 sentences on the state of the topic across the library) " +
    "2. Key Findings by Theme (extract 3-6 themes, each with 2-4 bullet points citing source entities in [brackets]) " +
    "3. Cross-Source Connections (paper ↔ repo ↔ doc links) " +
    "4. Open Questions / Gaps (what the library doesn't cover) " +
    "5. Recommended Next Actions (concrete next steps based on the findings). " +
    "Keep bracketed citations like [PaperTitle] or [RepoName] so the reader can trace claims. " +
    "Use Markdown with H2 for sections.";

  const body = {
    model: CHAT_MODEL,
    instructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `# Topic\n${topic}\n\n# Raw brief (do not reproduce, synthesize)\n\n${rawBrief.slice(0, 120000)}`,
          },
        ],
      },
    ],
  };

  const res = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI responses ${res.status}: ${err.slice(0, 400)}`);
  }
  const json = await res.json();
  if (typeof json.output_text === "string" && json.output_text.length) return json.output_text;
  const chunks = [];
  for (const item of json.output ?? []) {
    for (const piece of item.content ?? []) {
      if (typeof piece.text === "string") chunks.push(piece.text);
    }
  }
  return chunks.join("\n");
}

export async function generateTopicBrief(topic, options = {}) {
  const {
    topK = 40,
    types = null,
    synthesize = false,
    outPath,
    scope = null,
    deep = true,
  } = options;

  const hits = await semanticSearch(topic, { topK, types, scope, deep });

  if (!hits.length) {
    throw new Error(`No results for topic: ${topic}`);
  }

  const { markdown: rawBrief, stats } = await renderBrief(topic, hits, {
    scopeLabel: scope ? scope.join(", ") : null,
  });

  let finalContent = rawBrief;
  if (synthesize) {
    const narrative = await synthesizeNarrative(topic, rawBrief);
    finalContent = [
      `# Topic Brief: ${topic}`,
      "",
      `_Generated: ${now()}_`,
      "",
      "## Synthesized Narrative",
      "",
      narrative,
      "",
      "---",
      "",
      "## Raw Retrieval (source excerpts)",
      "",
      rawBrief.split("\n").slice(4).join("\n"),
    ].join("\n");
  }

  const briefingsDir = path.join(vaultRoot, "briefings");
  await ensureDir(briefingsDir);
  const finalPath = outPath ?? path.join(briefingsDir, stampedFilename(slugify(topic).slice(0, 60)));
  await fs.writeFile(finalPath, finalContent, "utf8");

  return {
    outPath: finalPath,
    stats,
    synthesized: synthesize,
    bytes: Buffer.byteLength(finalContent, "utf8"),
  };
}
