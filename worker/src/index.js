// politic-ask: a tiny proxy so the public 2026 Party Match page can ask Claude
// live questions with web search, without exposing the API key.
//
// POST /ask  { question, electorate?, priorities?: string[], topMatch? }
//   -> { answer: string, sources: [{url,title}], model }
//
// Guard rails: origin allow-list, per-IP rate limit (ratelimit binding),
// question length cap, max 5 web searches and 4k output tokens per answer.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_QUESTION = 300;

const SYSTEM = `You help a New Zealand voter research the general election on Saturday 7 November 2026.
The parties that matter are National, Labour, the Green Party, ACT, NZ First, The Opportunities Party (TOP) and Te Pāti Māori.

When asked about an issue, find what each party has actually announced for 2026 (policy pages, fiscal plans, reputable NZ news) and answer in plain English:
- Lead with one sentence on where the parties split.
- Then one bullet per party that has a published position, with the concrete commitment: figures, dates, named programmes.
- Say plainly which parties have no published 2026 position on it. Do not invent positions.
- Keep it under about 250 words. No preamble, no closing summary.
- Do not tell the voter who to vote for. You can note which bloc (National-led or Labour-led) a position sits in.
Use web search for current facts; prefer party websites and NZ outlets (RNZ, 1News, Stuff, NZ Herald, Newsroom, interest.co.nz, The Spinoff, policy.nz).`;

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: {
      "access-control-allow-origin": ok ? origin : "null",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      vary: "origin",
    },
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    const { ok, headers } = cors(origin, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname === "/health") return json({ ok: true, model: MODEL }, 200, headers);
    if (request.method !== "POST" || url.pathname !== "/ask") return json({ error: "Not found" }, 404, headers);
    if (!ok) return json({ error: "Origin not allowed" }, 403, headers);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Server is not configured" }, 503, headers);

    // Per-IP rate limit (Cloudflare ratelimit binding; see wrangler.jsonc).
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (env.RL) {
      const { success } = await env.RL.limit({ key: ip });
      if (!success) return json({ error: "Too many questions in a minute. Wait a moment and try again." }, 429, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request" }, 400, headers);
    }
    const question = String(body?.question || "").trim().slice(0, MAX_QUESTION);
    if (question.length < 3) return json({ error: "Ask a longer question" }, 400, headers);

    const ctx = [];
    if (body.electorate) ctx.push(`Voter's electorate: ${String(body.electorate).slice(0, 60)}.`);
    if (Array.isArray(body.priorities) && body.priorities.length)
      ctx.push(`Issues they weight highest: ${body.priorities.slice(0, 7).map((s) => String(s).slice(0, 40)).join(", ")}.`);
    if (body.topMatch) ctx.push(`Their closest party match on the tool so far: ${String(body.topMatch).slice(0, 40)}.`);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 90_000 });

    const messages = [
      {
        role: "user",
        content: `${ctx.length ? ctx.join(" ") + "\n\n" : ""}Issue to research: ${question}`,
      },
    ];

    const params = {
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
          max_uses: 5,
          user_location: { type: "approximate", country: "NZ", timezone: "Pacific/Auckland" },
        },
      ],
      messages,
    };

    try {
      let msg = await client.beta.messages.create(params);
      // A long search turn can pause; resume up to twice.
      for (let i = 0; i < 2 && msg.stop_reason === "pause_turn"; i++) {
        messages.push({ role: "assistant", content: msg.content });
        msg = await client.beta.messages.create({ ...params, messages });
      }
      if (msg.stop_reason === "refusal") {
        return json({ error: "Claude declined to answer that one." }, 200, headers);
      }

      const parts = [];
      const sources = new Map();
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text);
          for (const c of block.citations || []) {
            if (c.type === "web_search_result_location" && c.url && !sources.has(c.url))
              sources.set(c.url, { url: c.url, title: c.title || c.url });
          }
        }
      }
      return json(
        {
          answer: parts.join("").trim(),
          sources: [...sources.values()].slice(0, 8),
          model: msg.model,
          usage: { in: msg.usage?.input_tokens, out: msg.usage?.output_tokens },
        },
        200,
        headers,
      );
    } catch (err) {
      const status = err?.status === 429 ? 429 : err?.status >= 500 ? 502 : 500;
      return json({ error: err?.status === 429 ? "The API is busy. Try again in a minute." : "Could not get an answer right now." }, status, headers);
    }
  },
};
