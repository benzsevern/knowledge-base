// LLM-generated structured summaries for paper and article records.
// Replaces the regex-based `sentenceAround()` fallbacks that matched any
// sentence containing "method"/"constraint"/etc. — producing random
// mid-body sentences in methodology/constraints fields.

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.KB_LLM_MODEL ?? "gpt-5.4-nano";
const INPUT_CAP = 50_000; // ~12K tokens — plenty for an abstract + intro + method section

const SYSTEM = `You analyze the markdown of an academic paper or technical article and return a strict JSON object with exactly these keys:

{
  "summary": "2-4 sentence abstract-quality description of what the work is and why it matters",
  "methodology": "1-3 sentence description of the technical approach, or empty string if not applicable",
  "constraints": "1-2 sentence description of stated limitations/assumptions/requirements, or empty string if none are stated",
  "topics": ["up to 6 short topic tags, lowercase hyphen-separated"]
}

Rules:
- Output ONLY the JSON object. No prose before or after. No code fence.
- If the text is a blog post or tutorial rather than a research paper, "methodology" and "constraints" may be empty strings.
- Do not invent or hallucinate content. Only extract what the text actually says.
- Keep each summary concise — aim for one paragraph max per field.
- Topics should capture the core subject (e.g. ["cardinality-estimation","learned-query-optimizer"]) not generic terms like "ai" or "research".`;

export async function llmSummarize(markdown, { retries = 4 } = {}) {
  if (!process.env.OPENAI_API_KEY) return null;
  const trimmed = String(markdown ?? "").slice(0, INPUT_CAP);
  if (trimmed.length < 200) return null;

  const body = {
    model: MODEL,
    instructions: SYSTEM,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: trimmed }],
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
        `[summarize] 429 (attempt ${attempt + 1}/${retries + 1}), waiting ${wait / 1000}s\n`,
      );
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      process.stderr.write(
        `[summarize] OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}\n`,
      );
      return null;
    }
    const json = await res.json();
    let text = "";
    if (typeof json.output_text === "string") {
      text = json.output_text;
    } else {
      for (const item of json.output ?? []) {
        for (const piece of item.content ?? []) {
          if (typeof piece.text === "string") text += piece.text;
        }
      }
    }
    return parseJsonLoose(text);
  }
  return null;
}

// The model sometimes wraps the JSON in a code fence or adds filler tokens.
// Pull out the first balanced {...} block and parse that.
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
    methodology: str(obj.methodology),
    constraints: str(obj.constraints),
    topics,
  };
}
