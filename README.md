# Japan Data MCP

An [MCP](https://modelcontextprotocol.io/) server that gives AI agents cross-source access to **Japanese public data — law, corporations, and statistics — normalized to English metadata**, with source attribution on every response.

**Live endpoint:** `https://japan-data-mcp.netlify.app/mcp` (MCP over Streamable HTTP) — hosted and free, no install, no API key for the law tools.

Most authoritative Japanese public-data APIs return Japanese-only fields, which is a barrier for non-Japanese agents and tools. This server queries the official government APIs and returns clean, English-labelled structured metadata, so an AI agent can identify and quote Japanese law/corporation/statistics data without reading Japanese. What makes it different:

- **English-normalized metadata** (law type, era, dates, categories) on every record — the original legal text stays authentic Japanese, never an unofficial translation.
- **Mandatory source attribution** on every response (Government of Japan Standard Terms of Use v2.0, National Tax Agency no-warranty note, e-Stat credit line) — safe to cite downstream.
- **Hosted live endpoint** — agents connect over HTTP; nothing to run locally.
- **Relevance-ranked law search** — combines e-Gov title search and full-text search, so a query like `個人情報保護` returns the canonical Act first (the raw e-Gov API returns matches in law-number order, oldest first).

## Connect

Claude Code:

```sh
claude mcp add --transport http japan-data https://japan-data-mcp.netlify.app/mcp
```

Claude Desktop / Cursor / any MCP client (Streamable HTTP):

```json
{
  "mcpServers": {
    "japan-data": {
      "type": "streamable-http",
      "url": "https://japan-data-mcp.netlify.app/mcp"
    }
  }
}
```

## Tools

| Tool | Upstream source | API key | Status |
|---|---|---|---|
| `search_japanese_law` | e-Gov Law API (title + full-text, relevance-ranked) | not required | Fully working (verified against the live API) |
| `get_law_text` | e-Gov Law Data API | not required | Fully working — whole law or a single article |
| `search_corporation` | Corporate Number Web-API (National Tax Agency) | requires `appId` | Works with a key; without one, returns English registration guidance |
| `search_statistics` | e-Stat API (Statistics Bureau) | requires `appId` | Same as above |

Typical agent flow — both steps need no key: `search_japanese_law` to identify the law, then `get_law_text` to quote its exact text.

## Real examples (captured from the live endpoint)

**1. Find the canonical law.** `search_japanese_law` with `{"keyword": "個人情報保護", "limit": 2}` — note the top result is the Personal Information Protection Act itself, not the oldest law that merely mentions the phrase:

```json
{
  "query": "個人情報保護",
  "title_match_count": 17,
  "full_text_match_count": 694,
  "order": "reranked: title matches first, weighted by law type (Act highest) and query coverage",
  "results": [
    {
      "law_id": "415AC0000000057",
      "law_number_ja": "平成十五年法律第五十七号",
      "law_type": "Act (法律)",
      "era": "Heisei",
      "year": 15,
      "promulgation_date": "2003-05-30",
      "title_ja": "個人情報の保護に関する法律",
      "title_reading_kana": "こじんじょうほうのほごにかんするほうりつ",
      "revision_id": "415AC0000000057_20260624_508AC0000000046",
      "match": "title"
    }
  ],
  "attribution": "Source: e-Gov Law Search API (Digital Agency, Japan). Government of Japan Standard Terms of Use v2.0. Original text is Japanese; English fields are normalized metadata, not an official translation."
}
```

**2. Quote its exact text.** `get_law_text` with `{"law_id": "415AC0000000057", "article": "1"}`:

```json
{
  "law_id": "415AC0000000057",
  "title_ja": "個人情報の保護に関する法律",
  "article": "1",
  "text_ja": "（目的）\n第一条\nこの法律は、デジタル社会の進展に伴い個人情報の利用が著しく拡大していることに鑑み、個人情報の適正な取扱いに関し、基本理念及び政府による基本方針の作成その他の個人情報の保護に関する施策の基本となる事項を定め、（…）個人の権利利益を保護することを目的とする。",
  "total_chars": 329,
  "truncated": false,
  "attribution": "Source: e-Gov Law Search API (Digital Agency, Japan). Government of Japan Standard Terms of Use v2.0. Original text is Japanese; English fields are normalized metadata, not an official translation."
}
```

(The second example is abbreviated at `（…）` for this README; the live response carries the full article text.)

Quick check from a shell:

```sh
curl -s https://japan-data-mcp.netlify.app/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_law_text","arguments":{"law_id":"321CONSTITUTION","article":"9"}}}'
```

A plain `GET /mcp` returns server info and the tool list (useful for liveness checks). Tool calls use JSON-RPC 2.0 over `POST /mcp` (`initialize` → `tools/list` → `tools/call`).

## Usage transparency

Anonymous aggregate usage is public at [`/stats`](https://japan-data-mcp.netlify.app/stats). No raw IPs or user agents are stored — clients are counted via salted hashes only.

## Run locally

```sh
node test/local-test.mjs
```

`ALL PASS` means the MCP `initialize` / `tools/list` / `tools/call` respond, the law search returns the canonical Act first, and `get_law_text` extracts real article text from the live e-Gov API.

## Deploy

The server is a Web-standard fetch handler (`export default { fetch(request, env) }`), so it runs on either platform:

- **Netlify** (current live deployment): a thin adapter in `netlify/functions/mcp.mjs` exposes it at `/mcp` and records anonymous usage via Netlify Blobs. Deploy with `netlify deploy --prod`.
- **Cloudflare Workers**: `wrangler deploy` (see `wrangler.toml`; telemetry is Netlify-only).

The two API keys are injected as environment variables (`HOJIN_APP_ID`, `ESTAT_APP_ID`); the law tools need no key, so the server is useful even without them. Get the keys from the [Corporate Number Web-API](https://www.houjin-bangou.nta.go.jp/webapi/) and [e-Stat API](https://www.e-stat.go.jp/api/).

## License

MIT
