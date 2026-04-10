import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { projectRoot, markerRoot } from "./config.js";
import { ensureDir, fileExists } from "./fs-utils.js";
import { extractPaperViaLLM } from "./llm-extractor.js";

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: options.env ?? process.env,
  });
}

function discoverOutputs(outputDir) {
  return fs.readdir(outputDir, { withFileTypes: true }).then((entries) => {
    const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(outputDir, entry.name));
    return {
      markdownPath: files.find((file) => file.endsWith(".md")) ?? null,
      jsonPath: files.find((file) => file.endsWith(".json")) ?? null,
      assetPaths: files.filter((file) => /\.(png|jpg|jpeg|webp)$/i.test(file)),
    };
  });
}

async function extractViaMarkerCli(pdfPath, outputDir) {
  const markdownRun = runCommand("marker_single", [pdfPath, "--output_dir", outputDir, "--output_format", "markdown"]);
  if (markdownRun.status !== 0) {
    return null;
  }

  runCommand("marker_single", [pdfPath, "--output_dir", outputDir, "--output_format", "json"]);
  return discoverOutputs(outputDir);
}

async function extractViaVendorPython(pdfPath, outputDir) {
  const pythonPath = process.env.KB_MARKER_PYTHON ?? (await discoverMarkerPython()) ?? "python";
  const env = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${markerRoot}${path.delimiter}${process.env.PYTHONPATH}` : markerRoot,
  };
  const shim = path.join(projectRoot, "scripts", "marker_run.py");
  const runner = (fmt) =>
    runCommand(
      pythonPath,
      [shim, pdfPath, "--output_dir", outputDir, "--output_format", fmt],
      { env },
    );

  const markdownRun = runner("markdown");
  if (markdownRun.status !== 0) {
    if (markdownRun.stderr) {
      process.stderr.write(markdownRun.stderr);
    }
    return null;
  }

  runner("json");

  // Marker writes to <outputDir>/<basename>/ — flatten or locate.
  const nested = path.join(outputDir, path.basename(pdfPath, path.extname(pdfPath)));
  const target = (await fileExists(nested)) ? nested : outputDir;
  return discoverOutputs(target);
}

async function discoverMarkerPython() {
  const candidates = [
    path.join(projectRoot, ".venv-marker", "Scripts", "python.exe"),
    path.join(projectRoot, ".venv-marker", "bin", "python"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function extractPaper(pdfPath, outputDir) {
  await ensureDir(outputDir);

  if (process.env.OPENAI_API_KEY) {
    try {
      const llmResult = await extractPaperViaLLM(pdfPath, outputDir);
      if (llmResult?.markdownPath) {
        return llmResult;
      }
    } catch (err) {
      process.stderr.write(`LLM extractor failed, falling back: ${err.message ?? err}\n`);
    }
  }

  // Marker fallback is disabled by default — it's slow, requires a large pagefile
  // on Windows, and we have a working LLM extractor. Set KB_ENABLE_MARKER=1 to opt in.
  if (process.env.KB_ENABLE_MARKER === "1") {
    if (await fileExists(path.join(markerRoot, "pyproject.toml"))) {
      const vendorResult = await extractViaVendorPython(pdfPath, outputDir);
      if (vendorResult?.markdownPath) {
        return vendorResult;
      }
    }

    const cliResult = await extractViaMarkerCli(pdfPath, outputDir);
    if (cliResult?.markdownPath) {
      return cliResult;
    }
  }

  const sidecarPath = pdfPath.replace(/\.[^.]+$/, ".md");
  if (await fileExists(sidecarPath)) {
    const markdownPath = path.join(outputDir, `${path.basename(pdfPath, path.extname(pdfPath))}.md`);
    await fs.copyFile(sidecarPath, markdownPath);
    return {
      markdownPath,
      jsonPath: null,
      assetPaths: [],
    };
  }

  return null;
}
