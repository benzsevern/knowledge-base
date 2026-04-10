import fs from "node:fs/promises";
import path from "node:path";

import { vaultRoot } from "./config.js";
import { ensureDir } from "./fs-utils.js";
import { loadIndex } from "./indexer.js";
import { semanticSearch } from "./embeddings.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const CHAT_MODEL = process.env.KB_CHAT_MODEL ?? process.env.KB_LLM_MODEL ?? "gpt-5.4-nano";

async function callResponses({ instructions, userText }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set.");
  }
  const res = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI responses ${res.status}: ${errText.slice(0, 500)}`);
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

function formatChunkBlock(hit) {
  const meta = `[${hit.entry.type} • ${hit.entry.entityTitle} • score ${hit.score.toFixed(3)}]`;
  return `${meta}\n${hit.entry.text}`;
}

async function readPaperMarkdown(paper) {
  const paperDir = path.dirname(paper.notePath);
  const rawDir = path.join(paperDir, "raw");
  const files = await fs.readdir(rawDir).catch(() => []);
  const md = files.find((name) => name.endsWith(".md"));
  if (!md) return paper.markdownExcerpt ?? "";
  return await fs.readFile(path.join(rawDir, md), "utf8").catch(() => paper.markdownExcerpt ?? "");
}

async function reportPath(slug, kind) {
  const dir = path.join(vaultRoot, "reports");
  await ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${slug}.${kind}.${stamp}.md`);
}

export async function chat(question, { topK = 8, scope = null, deep = false } = {}) {
  const hits = await semanticSearch(question, { topK, scope, deep });
  const context = hits.map(formatChunkBlock).join("\n\n---\n\n");

  const instructions =
    "You answer questions using ONLY the supplied knowledge base excerpts. " +
    "When you cite, reference the entity title in brackets. " +
    "If the answer is not present in the excerpts, say so plainly.";

  const userText = `# Question\n${question}\n\n# Knowledge base excerpts\n${context}`;
  const answer = await callResponses({ instructions, userText });
  return { answer, hits };
}

export async function literatureReview(entityId, { outPath } = {}) {
  const index = await loadIndex();
  const entity =
    index.papers.find((p) => p.id === entityId || p.slug === entityId) ??
    index.repos.find((r) => r.id === entityId || r.slug === entityId);
  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  // Collect linked papers via the relation graph.
  let linkedPapers;
  if (entity.type === "paper") {
    // For a paper, gather other papers linked through any shared repo.
    const sharedRepoIds = index.relations
      .filter((r) => r.fromId === entity.id)
      .map((r) => r.toId);
    const peerIds = new Set(
      index.relations
        .filter((r) => r.relationType !== "related" && sharedRepoIds.includes(r.toId) && r.fromId !== entity.id)
        .map((r) => r.fromId),
    );
    linkedPapers = [entity, ...index.papers.filter((p) => peerIds.has(p.id))];
  } else {
    const paperIds = new Set(
      index.relations
        .filter((r) => r.relationType !== "related" && r.toId === entity.id)
        .map((r) => r.fromId),
    );
    linkedPapers = index.papers.filter((p) => paperIds.has(p.id));
  }

  if (!linkedPapers.length) {
    throw new Error(`No linked papers found for ${entity.id}.`);
  }

  const paperBlocks = [];
  for (const paper of linkedPapers) {
    const md = await readPaperMarkdown(paper);
    paperBlocks.push(`## ${paper.title}\n\n${md.slice(0, 6000)}`);
  }

  const instructions =
    "You are a research analyst writing a literature review. " +
    "Synthesize the supplied papers into a coherent narrative grouped by theme. " +
    "Use Markdown with H2 sections for themes and inline citations like [Paper Title]. " +
    "Be concise and concrete; avoid filler.";

  const userText = `# Subject\n${entity.title}\n\n# Papers\n\n${paperBlocks.join("\n\n---\n\n")}`;
  const review = await callResponses({ instructions, userText });

  const finalPath = outPath ?? (await reportPath(entity.slug ?? entity.id, "lit-review"));
  await fs.writeFile(finalPath, `# Literature review: ${entity.title}\n\n${review}\n`, "utf8");
  return { outPath: finalPath, paperCount: linkedPapers.length };
}

export async function gapAnalysis(repoId, { outPath } = {}) {
  const index = await loadIndex();
  const repo = index.repos.find((r) => r.id === repoId || r.slug === repoId);
  if (!repo) {
    throw new Error(`Repo not found: ${repoId}`);
  }

  const paperIds = new Set(
    index.relations
      .filter((r) => r.relationType !== "related" && r.toId === repo.id)
      .map((r) => r.fromId),
  );
  const linkedPapers = index.papers.filter((p) => paperIds.has(p.id));
  if (!linkedPapers.length) {
    throw new Error(`No linked papers for ${repo.id}. Run \`kb rebuild-links\` first.`);
  }

  const paperBlocks = [];
  for (const paper of linkedPapers) {
    const md = await readPaperMarkdown(paper);
    paperBlocks.push(`## ${paper.title}\n\n${md.slice(0, 5000)}`);
  }

  const repoBlock = [
    `Title: ${repo.title}`,
    `Summary: ${repo.summary}`,
    `Languages: ${(repo.languages ?? []).join(", ")}`,
    `Key modules: ${(repo.keyModules ?? []).join(", ")}`,
    `Entrypoints: ${(repo.entrypoints ?? []).join(", ")}`,
  ].join("\n");

  const instructions =
    "You perform a gap analysis between a codebase and a corpus of related research papers. " +
    "Identify techniques, algorithms, or design patterns described in the papers that are NOT evident in the codebase summary. " +
    "Output Markdown with three H2 sections: 'Already covered', 'Gaps', 'Recommended next steps'. " +
    "For each gap, name the source paper, describe the technique briefly, and suggest where it could plug into the codebase.";

  const userText = `# Codebase\n${repoBlock}\n\n# Related papers\n\n${paperBlocks.join("\n\n---\n\n")}`;
  const report = await callResponses({ instructions, userText });

  const finalPath = outPath ?? (await reportPath(repo.slug ?? repo.id, "gap-analysis"));
  await fs.writeFile(finalPath, `# Gap analysis: ${repo.title}\n\n${report}\n`, "utf8");
  return { outPath: finalPath, paperCount: linkedPapers.length };
}
