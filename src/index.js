// Japan Data MCP — 段階0のサーバー本体。
// プロトコルは MCP の Streamable HTTP（現行標準・仕様3節）。SSEは非推奨化済みのため
// 単純な JSON-RPC の要求/応答（POSTでJSONを受けJSONを返す）だけを実装する。
// Cloudflare Workers の形（export default { fetch }）のまま、node からも呼べる。

import { TOOL_DEFS, callTool } from './tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'japan-data-mcp', version: '0.1.0' };

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// 1本のJSON-RPCメッセージを処理する。通知（idなし）は結果を返さない。
async function handleMessage(msg, env) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'Cross-source access to Japanese law, corporations, and statistics, normalized to English metadata. Every response carries the required source attribution.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // 通知には応答しない
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOL_DEFS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!name) return rpcError(id, -32602, 'Missing tool name.');
      const out = await callTool(name, args, env);
      // MCPの規約: ツールの結果は content の配列。構造化データはJSON文字列で載せ、
      // 上流のエラーは isError で明示する（エージェントが再試行の判断に使える）。
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: !!(out && out.error),
      });
    }
    default:
      if (id === undefined || id === null) return null; // 未知の通知は黙って捨てる
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 稼働確認用の軽いGET（レジストリの死活監視・仕様の稼働維持に使う）。
    if (request.method === 'GET') {
      return json({ server: SERVER_INFO, protocol: PROTOCOL_VERSION, tools: TOOL_DEFS.map((t) => t.name) });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, 'Parse error'), 400);
    }

    // バッチ（配列）と単一の両方を受ける。通知だけのバッチは202を返す。
    if (Array.isArray(body)) {
      const results = [];
      for (const m of body) {
        const r = await handleMessage(m, env);
        if (r) results.push(r);
      }
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const res = await handleMessage(body, env);
    return res ? json(res) : new Response(null, { status: 202 });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
