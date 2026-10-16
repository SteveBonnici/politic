# politic-ask Worker

Relays the "Ask Claude (live)" button on https://stevebonnici.github.io/politic/ to the Claude API so the API key never reaches the browser.

- Model: `claude-opus-5-5` with the `web_search_20260209` server tool (max 5 searches per answer, NZ location hint).
- Guard rails: origin allow-list (`ALLOWED_ORIGINS` in `wrangler.jsonc`), 6 questions per minute per IP (ratelimit binding `RL`), 300-character questions, 4k output tokens.
- Sends: the question, electorate name, high-weight issue labels, top-match party. Never the money figures. Stores nothing.

## First deploy

```
cd worker
npx wrangler login                                  # browser OAuth to the Cloudflare account that owns *.steve-b8b.workers.dev
echo sk-ant-api03-... | npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
curl https://politic-ask.steve-b8b.workers.dev/health
```

If the Worker lands on a different subdomain, update `ASK_URL` in `../index.html`.

## Rough cost

One answer is one Opus 5.5 call with up to five web searches: typically a few cents, up to ~15c with heavy searching. The per-IP limit caps a single visitor at 6 a minute. Watch spend at console.anthropic.com.
