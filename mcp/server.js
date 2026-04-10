#!/usr/bin/env node

/**
 * MCP stdio server for the Knowledge Base API.
 * Proxies tool calls to the Railway-hosted (or local) KB API.
 *
 * Usage: node mcp/server.js
 * Env:   KB_API_URL (default: https://kb-api-production-d23f.up.railway.app)
 */

import { createInterface } from "node:readline";

const API = process.env.KB_API_URL ?? "https://kb-api-production-d23f.up.railway.app";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "kb_status",
    description: "Get knowledge base status — paper, repo, and relation counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kb_search",
    description: "Semantic search across papers and repos. Returns scored results with text excerpts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        topK: { type: "number", description: "Number of results (default 10)" },
        scope: { type: "array", items: { type: "string" }, description: "Repo IDs to include content chunks from" },
        deep: { type: "boolean", description: "Search all repo content chunks (slower)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_chat",
    description: "RAG chat — ask a question grounded in the knowledge base. Returns an answer with source citations.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to answer" },
        topK: { type: "number", description: "Number of context chunks (default 8)" },
        scope: { type: "array", items: { type: "string" }, description: "Repo IDs to scope retrieval to" },
        deep: { type: "boolean", description: "Include all repo content chunks" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_search_arxiv",
    description: "Search arXiv for papers by topic. Returns candidates that can be ingested with kb_fetch_paper_candidates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "arXiv search query" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_search_github",
    description: "Search GitHub for repos by topic. Returns candidates that can be ingested with kb_fetch_repo_candidates.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "GitHub search query" },
        limit: { type: "number", description: "Max results (default 20)" },
        sort: { type: "string", enum: ["stars", "updated"], description: "Sort order (default stars)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_discover_arxiv",
    description: "Discover new arXiv papers by mining citations from already-ingested papers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kb_fetch_paper_candidates",
    description: "Download and ingest top N paper candidates from the last search/discover. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "number", description: "Number of candidates to fetch (default 10)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kb_fetch_repo_candidates",
    description: "Clone and ingest top N repo candidates from the last GitHub search. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "number", description: "Number of candidates to fetch (default 10)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kb_ingest_repo",
    description: "Ingest a single GitHub repo. Accepts full URL or org/repo shorthand. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "GitHub URL or org/repo shorthand" },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_ingest_repos",
    description: "Ingest multiple GitHub repos in batch. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        sources: { type: "array", items: { type: "string" }, description: "Array of GitHub URLs or org/repo shorthands" },
      },
      required: ["sources"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_embed",
    description: "Build/refresh the summary embedding index for all papers and repos. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Re-embed everything even if unchanged" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kb_embed_content",
    description: "Build per-repo deep content embeddings from packed source code. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        repos: { type: "array", items: { type: "string" }, description: "Repo IDs to embed (omit for all)" },
        all: { type: "boolean", description: "Embed all repos" },
        force: { type: "boolean", description: "Re-embed even if unchanged" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kb_job_status",
    description: "Check the status and progress of an async job.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID to check" },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_jobs",
    description: "List all jobs (running and completed).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kb_graph",
    description: "Get the full relation graph — all papers, repos, and their relations.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kb_lit_review",
    description: "Generate a literature review for a paper or repo based on linked papers. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Paper or repo ID/slug" },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_gap_analysis",
    description: "Generate a gap analysis comparing a repo against linked research papers. Returns a job ID.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Repo ID/slug" },
      },
      required: ["repoId"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers — map tool calls to API requests
// ---------------------------------------------------------------------------
async function handleTool(name, args) {
  switch (name) {
    case "kb_status":
      return get("/api/status");
    case "kb_search":
      return post("/api/search", args);
    case "kb_chat":
      return post("/api/chat", args);
    case "kb_search_arxiv":
      return post("/api/search-arxiv", args);
    case "kb_search_github":
      return post("/api/search-github", args);
    case "kb_discover_arxiv":
      return post("/api/discover-arxiv", {});
    case "kb_fetch_paper_candidates":
      return post("/api/fetch-candidates", args);
    case "kb_fetch_repo_candidates":
      return post("/api/fetch-repo-candidates", args);
    case "kb_ingest_repo":
      return post("/api/ingest-repo", args);
    case "kb_ingest_repos":
      return post("/api/ingest-repos", args);
    case "kb_embed":
      return post("/api/embed", args);
    case "kb_embed_content":
      return post("/api/embed-content", args);
    case "kb_job_status":
      return get(`/api/jobs/${args.jobId}`);
    case "kb_jobs":
      return get("/api/jobs");
    case "kb_graph":
      return get("/api/graph");
    case "kb_lit_review":
      return post("/api/lit-review", args);
    case "kb_gap_analysis":
      return post("/api/gap-analysis", args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function get(path) {
  const res = await fetch(`${API}${path}`);
  return await res.json();
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC stdio transport
// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "knowledge-base", version: "0.1.0" },
        },
      });
    } else if (method === "notifications/initialized") {
      // no response needed
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      const result = await handleTool(name, args ?? {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Error: ${err.message ?? err}` }],
        isError: true,
      },
    });
  }
});

process.stderr.write("KB MCP server started\n");
