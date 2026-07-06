// Netlify Functions v2 のアダプタ。
// サーバー本体(../../src/index.js)は Cloudflare Workers の形(export default { fetch(request, env) })で
// 書いてあり、これは Web 標準の Request/Response なので Netlify がそのまま受けられる。
// Cloudflare の env(secrets/vars)に相当するものを、Netlify では process.env から渡す。
// 段階0の法令ツールは鍵が要らないので、未設定でも動く(tools.js が案内を返す設計)。
import { getStore } from '@netlify/blobs';
import worker from '../../src/index.js';
import { recordEvents, eventsFromBody, hashIp, clientFromUserAgent } from '../../src/telemetry.js';

export default async (request, context) => {
  const env = {
    HOJIN_APP_ID: process.env.HOJIN_APP_ID,
    ESTAT_APP_ID: process.env.ESTAT_APP_ID,
  };

  // 需要計測(仕様7節)。POSTのJSON-RPCだけが需要の信号(GETは死活監視なので数えない)。
  // 本文はここで一度だけ読み、本体へは同じ内容の新しいRequestを渡す。
  // 記録の失敗は本応答を壊さない(telemetry.js側でfail-open)。
  if (request.method === 'POST') {
    const text = await request.text();
    const res = await worker.fetch(new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: text,
    }), env);
    try {
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (body) {
        const ip = (context && context.ip) || request.headers.get('x-nf-client-connection-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
        const ipHash = await hashIp(ip, process.env.TELEMETRY_SALT);
        const uaClient = clientFromUserAgent(request.headers.get('user-agent'));
        const events = eventsFromBody(body, { ipHash, uaClient });
        if (events.length) {
          const p = recordEvents(events, { getStore });
          // 応答を待たせず記録できるランタイムでは非同期に流す。無ければ待つ(数十ms)。
          if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
          else await p;
        }
      }
    } catch {
      // 計測は本機能でない。どんな失敗でも応答は既に確定している。
    }
    return res;
  }

  return worker.fetch(request, env);
};

// MCP の Streamable HTTP のエンドポイントを /mcp に出す。
export const config = { path: '/mcp' };
