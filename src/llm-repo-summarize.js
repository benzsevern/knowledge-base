// LLM summarization specifically for repositories. Different shape than
// papers/articles because repos aren't research artifacts: they need
// purpose, architecture, and usage instead of methodology/constraints.

import fs from "node:fs/promises";
import path from "node:path";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.KB_LLM_MODEL ?? "gpt-5.4-nano";
const INPUT_CAP = 60_000; // ~15K tokens — README + top of packed-context

const SYSTEM = `You analyze the source of a software repository and return a strict JSON object with exactly these keys:

{
  "summary": "2-3 sentence description of what the repository is and what it does",
  "purpose": "1-2 sentence description of the problem it solves or the design goal",
  "architecture": "1-3 sentence description of how the code is organized (e.g. monolith, modular, plugin-based, microservices, single-file CLI, etc.)",
  "usage": "1-2 sentence description of how a developer would adopt or use it",
  "topics": ["up to 6 short topic tags, lowercase hyphen-separated"]
}

Rules:
- Output ONLY the JSON object. No prose before or after. No code fence.
- Base answers on the README + source. Do not invent features not present in the text.
- Keep each field concise — one short paragraph max.
- Topics should be specific (e.g. ["rust-ui-framework","cross-platform-gui","signals-reactivity"]) not generic ("software","code","github").
- If the input looks empty or only has boilerplate, return {"summary":"","purpose":"","architecture":"","usage":"","topics":[]}.`;

// Assemble a focused input: README first, then a slice of the packed
// context. Heavily favors README because it's the canonical self-description.
export async function collectRepoText(repo) {
  const parts = [];

  // 1. README from the cloned source
  if (repo.sourcePath) {
    for (const name of ["README.md", "README.MD", "readme.md", "README"]) {
      const p = path.join(repo.sourcePath, name);
      try {
        const text = await fs.readFile(p, "utf8");
        if (text && text.length > 50) {
          parts.push(`# README\n\n${text.slice(0, 20_000)}`);
          break;
        }
      } catch {}
    }
  }

  // 2. Slice of packed-context for structure/code signal
  if (repo.packedContextPath) {
    try {
      const packed = await fs.readFile(repo.packedContextPath, "utf8");
      const slice = packed.slice(0, 40_000);
      parts.push(`# Packed context (first ~40KB)\n\n${slice}`);
    } catch {}
  }

  // 3. Metadata hints
  const meta = [
    repo.languages?.length ? `Languages: ${repo.languages.slice(0, 8).join(", ")}` : null,
    repo.keyModules?.length ? `Top-level: ${repo.keyModules.slice(0, 12).join(", ")}` : null,
    repo.entrypoints?.length
      ? `Entrypoint samples: ${repo.entrypoints.slice(0, 6).join(", ")}`
      : null,
  ].filter(Boolean);
  if (meta.length) parts.push(`# Repo metadata\n\n${meta.join("\n")}`);

  return parts.join("\n\n---\n\n").slice(0, INPUT_CAP);
}

export async function llmSummarizeRepo(repo, { retries = 4 } = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const text = await collectRepoText(repo);
  if (text.length < 200) return null;

  const body = {
    model: MODEL,
    instructions: SYSTEM,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `Repository: ${repo.title ?? repo.slug}\n\n${text}` }],
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
    if (res.status === 429 && attempt < retries) {
      const wait = Math.min(2 ** attempt * 2000, 30000);
      process.stderr.write(
        `[repo-summarize] 429 on ${repo.slug} (attempt ${attempt + 1}/${retries + 1}), waiting ${wait / 1000}s\n`,
      );
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      process.stderr.write(
        `[repo-summarize] OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}\n`,
      );
      return null;
    }
    const json = await res.json();
    let out = "";
    if (typeof json.output_text === "string") out = json.output_text;
    else {
      for (const item of json.output ?? []) {
        for (const piece of item.content ?? []) {
          if (typeof piece.text === "string") out += piece.text;
        }
      }
    }
    return parseJsonLoose(out);
  }
  return null;
}

function parseJsonLoose(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1));
          return normalize(obj);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalize(obj) {
  if (!obj || typeof obj !== "object") return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const topics = Array.isArray(obj.topics)
    ? obj.topics.filter((t) => typeof t === "string").slice(0, 6)
    : [];
  return {
    summary: str(obj.summary),
    purpose: str(obj.purpose),
    architecture: str(obj.architecture),
    usage: str(obj.usage),
    topics,
  };
}
