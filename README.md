# Japan Data MCP

An [MCP](https://modelcontextprotocol.io/) server that gives AI agents cross-source access to **Japanese public data — law, corporations, and statistics — normalized to English metadata**, with source attribution on every response.

**Live endpoint:** `https://japan-data-mcp.netlify.app/mcp` (MCP over Streamable HTTP)

Most authoritative Japanese public-data APIs return Japanese-only fields, which is a barrier for non-Japanese agents and tools. This server queries the official government APIs and returns clean, English-labelled structured metadata, so an AI agent can use Japanese law/corporation/statistics data without reading Japanese.

## Tools

| Tool | Upstream source | API key | Status |
|---|---|---|---|
| `search_japanese_law` | e-Gov Law API | not required | Fully working (verified against the live API) |
| `search_corporation` | Corporate Number Web-API (National Tax Agency) | requires `appId` | Works with a key; without one, returns English registration guidance |
| `search_statistics` | e-Stat API (Statistics Bureau) | requires `appId` | Same as above |

Every response carries the required source attribution and disclaimer (Government Standard Terms of Use 2.0; the Corporate Number data's no-warranty note; e-Stat's mandatory credit line).

## Use it

Point any MCP client at the live endpoint. Example client config:

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

A plain `GET /mcp` returns server info and the tool list (useful for liveness checks). Tool calls use JSON-RPC 2.0 over `POST /mcp` (`initialize` → `tools/list` → `tools/call`).

Quick check (no key needed — the law tool works without one):

```sh
curl -s https://japan-data-mcp.netlify.app/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_japanese_law","arguments":{"keyword":"個人情報保護","limit":2}}}'
```

## Run locally

```sh
node test/local-test.mjs
```

`ALL PASS` means the MCP `initialize` / `tools/list` / `tools/call` respond and the law tool returns English metadata from the real e-Gov API.

## Deploy

The server is a Web-standard fetch handler (`export default { fetch(request, env) }`), so it runs on either platform:

- **Netlify** (current live deployment): a thin adapter in `netlify/functions/mcp.mjs` exposes it at `/mcp`. Deploy with `netlify deploy --prod`.
- **Cloudflare Workers**: `wrangler deploy` (see `wrangler.toml`).

The two API keys are injected as environment variables (`HOJIN_APP_ID`, `ESTAT_APP_ID`); the law tool needs no key, so the server is useful even without them. Get the keys from the [Corporate Number Web-API](https://www.houjin-bangou.nta.go.jp/webapi/) and [e-Stat API](https://www.e-stat.go.jp/api/).

## License

MIT
