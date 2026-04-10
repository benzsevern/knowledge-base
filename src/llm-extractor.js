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
    path.join(projectRoot, ".venv-pdf", "bin", "python"),
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

// ---------------------------------------------------------------------------
// Step 1: Text extraction via pymupdf (free, instant)
// ---------------------------------------------------------------------------
async function extractText(pdfPath, outDir) {
  const python = await discoverPython();
  const shim = path.join(projectRoot, "scripts", "extract_text.py");
  const result = spawnSync(python, [shim, pdfPath, outDir], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Rasterize only uncertain pages for LLM vision
// ---------------------------------------------------------------------------
async function rasterizePages(pdfPath, pageNumbers, outDir) {
  const python = await discoverPython();
  const shim = path.join(projectRoot, "scripts", "rasterize_pdf.py");
  // rasterize_pdf.py rasterizes all pages; we'll pick the ones we need
  const result = spawnSync(python, [shim, pdfPath, outDir, "--dpi", "120"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`rasterize_pdf failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
  const allPaths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Return only the requested page indices (0-based)
  const needed = new Set(pageNumbers.map((n) => n - 1));
  return allPaths.filter((_, i) => needed.has(i));
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

// ---------------------------------------------------------------------------
// Hybrid extraction: pymupdf text first, LLM vision only for uncertain pages
// ---------------------------------------------------------------------------
export async function extractPaperViaLLM(pdfPath, outputDir) {
  await ensureDir(outputDir);
  const textDir = path.join(outputDir, "text");
  await ensureDir(textDir);

  // Step 1: free text extraction
  const textResult = await extractText(pdfPath, textDir);
  const totalPages = textResult?.total_pages ?? 0;

  if (totalPages === 0) {
    // Fallback to full LLM if pymupdf fails
    return await fullLLMExtraction(pdfPath, outputDir);
  }

  const pageMarkdowns = [];
  const uncertainPages = [];

  for (const page of textResult.pages) {
    if (page.confident) {
      const text = await fs.readFile(page.path, "utf8").catch(() => "");
      pageMarkdowns.push({ page: page.page, text: text.trim() });
    } else {
      uncertainPages.push(page.page);
      pageMarkdowns.push({ page: page.page, text: null }); // placeholder
    }
  }

  const confidentCount = totalPages - uncertainPages.length;

  // Step 2: LLM vision only for uncertain pages
  if (uncertainPages.length > 0 && process.env.OPENAI_API_KEY) {
    const pagesDir = path.join(outputDir, "pages");
    await ensureDir(pagesDir);

    try {
      const imagePaths = await rasterizePages(pdfPath, uncertainPages, pagesDir);
      const concurrency = Number(process.env.KB_LLM_CONCURRENCY ?? 15);
      let cursor = 0;
      const imageMap = new Map(uncertainPages.map((pageNum, i) => [pageNum, imagePaths[i]]));

      const workers = Array.from(
        { length: Math.min(concurrency, uncertainPages.length) },
        async () => {
          while (true) {
            const idx = cursor;
            cursor += 1;
            if (idx >= uncertainPages.length) return;
            const pageNum = uncertainPages[idx];
            const imagePath = imageMap.get(pageNum);
            if (!imagePath) continue;
            try {
              const md = await transcribePage(imagePath, pageNum);
              const slot = pageMarkdowns.find((p) => p.page === pageNum);
              if (slot) slot.text = md.trim();
            } catch (err) {
              const slot = pageMarkdowns.find((p) => p.page === pageNum);
              if (slot) slot.text = `<!-- page ${pageNum} LLM extraction failed: ${err.message ?? err} -->`;
            }
          }
        },
      );
      await Promise.all(workers);
    } catch (err) {
      process.stderr.write(`LLM fallback failed for uncertain pages: ${err.message ?? err}\n`);
    }
  }

  // Fill any remaining nulls (uncertain pages where LLM was unavailable)
  for (const entry of pageMarkdowns) {
    if (entry.text === null) {
      entry.text = "";
    }
  }

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const markdownPath = path.join(outputDir, `${basename}.md`);
  const jsonPath = path.join(outputDir, `${basename}.json`);

  const combined = pageMarkdowns.map((p) => p.text).filter(Boolean).join("\n\n---\n\n");
  await fs.writeFile(markdownPath, `${combined}\n`, "utf8");
  await fs.writeFile(
    jsonPath,
    `${JSON.stringify({
      source: pdfPath,
      model: MODEL,
      totalPages,
      confidentPages: confidentCount,
      llmPages: uncertainPages.length,
      pages: pageMarkdowns.map((p) => p.text),
    }, null, 2)}\n`,
    "utf8",
  );

  process.stderr.write(
    `Hybrid extraction: ${confidentCount}/${totalPages} pages via text, ${uncertainPages.length} via LLM [${path.basename(pdfPath)}]\n`,
  );

  return {
    markdownPath,
    jsonPath,
    assetPaths: [],
  };
}

// Full LLM extraction fallback (original approach)
async function fullLLMExtraction(pdfPath, outputDir) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const pagesDir = path.join(outputDir, "pages");
  await ensureDir(pagesDir);

  const python = await discoverPython();
  const shim = path.join(projectRoot, "scripts", "rasterize_pdf.py");
  const result = spawnSync(python, [shim, pdfPath, pagesDir, "--dpi", "120"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    return null;
  }
  const imagePaths = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!imagePaths.length) return null;

  const concurrency = Number(process.env.KB_LLM_CONCURRENCY ?? 15);
  const pageMarkdowns = new Array(imagePaths.length).fill("");
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, imagePaths.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= imagePaths.length) return;
      try {
        const md = await transcribePage(imagePaths[idx], idx + 1);
        pageMarkdowns[idx] = md.trim();
      } catch {
        pageMarkdowns[idx] = "";
      }
    }
  });
  await Promise.all(workers);

  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const markdownPath = path.join(outputDir, `${basename}.md`);
  const jsonPath = path.join(outputDir, `${basename}.json`);

  const combined = pageMarkdowns.filter(Boolean).join("\n\n---\n\n");
  await fs.writeFile(markdownPath, `${combined}\n`, "utf8");
  await fs.writeFile(
    jsonPath,
    `${JSON.stringify({ source: pdfPath, model: MODEL, totalPages: imagePaths.length, confidentPages: 0, llmPages: imagePaths.length, pages: pageMarkdowns }, null, 2)}\n`,
    "utf8",
  );

  return { markdownPath, jsonPath, assetPaths: imagePaths };
}
