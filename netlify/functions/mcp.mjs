// Netlify Functions v2 のアダプタ。
// サーバー本体(../../src/index.js)は Cloudflare Workers の形(export default { fetch(request, env) })で
// 書いてあり、これは Web 標準の Request/Response なので Netlify がそのまま受けられる。
// Cloudflare の env(secrets/vars)に相当するものを、Netlify では process.env から渡す。
// 段階0の法令ツールは鍵が要らないので、未設定でも動く(tools.js が案内を返す設計)。
import worker from '../../src/index.js';

export default async (request) => {
  const env = {
    HOJIN_APP_ID: process.env.HOJIN_APP_ID,
    ESTAT_APP_ID: process.env.ESTAT_APP_ID,
  };
  return worker.fetch(request, env);
};

// MCP の Streamable HTTP のエンドポイントを /mcp に出す。
export const config = { path: '/mcp' };
