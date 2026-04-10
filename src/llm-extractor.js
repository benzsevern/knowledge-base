import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { projectRoot } from "./config.js";
import { ensureDir, fileExists } from "./fs-utils.js";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.KB_LLM_MODEL ?? "gpt-5.4-nano";

const SYSTEM_PROMPT =
  "You transcribe a single page of a scientific PDF to clean Markdown. " +
  "Preserve headings (use #, ##, ###), paragraphs, lists, equations (use $...$ or $$...$$), " +
  "tables (GitHub-flavored), and figure captions. Do NOT add commentary, do NOT wrap in ```markdown, " +
  "do NOT add a page header. If a page has no meaningful text, output an empty string.";

async function discoverPython() {
  const candidates = [
    path.join(projectRoot, ".venv-marker", "Scripts", "python.exe"),
    path.join(projectRoot, ".venv-marker", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return process.env.KB_MARKER_PYTHON ?? "python";
}

async function rasterize(pdfPath, outDir) {
  const python = await discoverPython();
  const shim = path.join(projectRoot, "scripts", "rasterize_pdf.py");
  const result = spawnSync(python, [shim, pdfPath, outDir, "--dpi", "120"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`rasterize_pdf failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function transcribePage(imagePath, pageNum) {
  const bytes = await fs.readFile(imagePath);
  const b64 = bytes.toString("base64");
  const body = {
    model: MODEL,
    instructions: SYSTEM_PROMPT,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `Transcribe page ${pageNum} to Markdown.` },
          { type: "input_image", image_url: `data:image/png;base64,${b64}` },
        ],
      },
    ],
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 500)}`);
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

export async function extractPaperViaLLM(pdfPath, outputDir) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  await ensureDir(outputDir);
  const pagesDir = path.join(outputDir, "pages");
  await ensureDir(pagesDir);

  const imagePaths = await rasterize(pdfPath, pagesDir);
  if (!imagePaths.length) {
    return null;
  }

  const concurrency = Number(process.env.KB_LLM_CONCURRENCY ?? 5);
  const pageMarkdowns = new Array(imagePaths.length).fill("");
  const failures = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, imagePaths.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= imagePaths.length) return;
      try {
        const md = await transcribePage(imagePaths[idx], idx + 1);
        pageMarkdowns[idx] = md.trim();
      } catch (err) {
        failures.push({ page: idx + 1, error: err.message ?? String(err) });
        pageMarkdowns[idx] = `<!-- page ${idx + 1} extraction failed: ${err.message ?? err} -->`;
      }
    }
  });
  await Promise.all(workers);

  if (failures.length) {
    process.stderr.write(
      `LLM extractor: ${failures.length}/${imagePaths.length} page(s) failed for ${path.basename(pdfPath)}\n`,
    );
  }
  if (failures.length === imagePaths.length) {
    return null; // Total failure — let caller decide.
  }

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const markdownPath = path.join(outputDir, `${basename}.md`);
  const jsonPath = path.join(outputDir, `${basename}.json`);

  const combined = pageMarkdowns.filter(Boolean).join("\n\n---\n\n");
  await fs.writeFile(markdownPath, `${combined}\n`, "utf8");
  await fs.writeFile(
    jsonPath,
    `${JSON.stringify({ source: pdfPath, model: MODEL, pages: pageMarkdowns }, null, 2)}\n`,
    "utf8",
  );

  return {
    markdownPath,
    jsonPath,
    assetPaths: imagePaths,
  };
}
