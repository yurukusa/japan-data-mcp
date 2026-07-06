// 段階0の需要計測(仕様7節)。成功指標=ユニーク利用者数・呼び出し数・リピート率を
// 実測できるようにする。掲載から30日の判定窓が「需要なし」と「測れていないだけ」を
// 区別できない偽陰性(matched_text_ja常時nullバグと同型)を防ぐのが目的。
//
// プライバシーの設計(削れない制約):
// - IPは保存しない。ソルト付きSHA-256の先頭16桁のみ(同一クライアントの同定にだけ使う)
// - User-Agentは保存しない。先頭の製品名トークン(例: claude-code, python-httpx)のみ
// - MCPのinitializeが運ぶ clientInfo.name はプロトコル上の自己申告の製品名なので記録してよい
//
// 記録の設計: Netlify Blobs はappendを持たず、単一キーへの読み書きは並行で競合する。
// そこで1リクエスト=1キーとし、集計に必要な全属性をキー自体に埋め込む。
// 集計は list() だけで済み、本文のgetが不要になる(段階0の流量では十分速い)。
// キーの形: ev/<UTC日付>/<epoch_ms>.<乱数4>.<method>.<tool>.<ip_hash16>.<client>

// 記録の失敗が本応答(/mcp)を壊してはならない。全経路 try/catch の fail-open。
export async function recordEvents(events, { getStore }) {
  try {
    const store = await openStore(getStore);
    if (!store) return false;
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    await Promise.all(
      events.map((ev, i) => {
        const key = [
          'ev/' + day + '/' + (now + i),
          rand4(),
          sanitize(ev.method, 24) || 'unknown',
          sanitize(ev.tool, 40) || '-',
          ev.ipHash || 'noip',
          sanitize(ev.client, 24) || '-',
        ].join('.');
        // 値は最小の冗長バックアップ(キーが正)。将来キー形式を変えても再集計できる。
        return store.set(key, JSON.stringify({ t: now, ...ev }));
      })
    );
    return true;
  } catch {
    return false;
  }
}

// 30日窓の集計。/stats(公開・匿名の集計のみ)と段階0の判定の両方が使う。
export async function aggregateStats({ getStore }, days = 30) {
  const store = await openStore(getStore);
  if (!store) return { error: 'telemetry_unavailable', message: 'Blob store is not reachable in this context.' };
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const byMethod = {};
  const byTool = {};
  const byDay = {};
  const clientDays = new Map(); // ip_hash -> Set(day)
  const clientNames = {};
  let total = 0;
  let cursor;
  do {
    const page = await store.list({ prefix: 'ev/', paginate: false, cursor });
    for (const b of page.blobs || []) {
      // ev/<day>/<ts>.<rand>.<method>.<tool>.<iphash>.<client>
      const m = b.key.match(/^ev\/(\d{4}-\d{2}-\d{2})\/(\d+)\.[^.]+\.([^.]*)\.([^.]*)\.([^.]*)\.(.*)$/);
      if (!m) continue;
      const [, day, ts, method, tool, ipHash, client] = m;
      if (Number(ts) < cutoff) continue;
      total++;
      byDay[day] = (byDay[day] || 0) + 1;
      byMethod[method] = (byMethod[method] || 0) + 1;
      if (tool && tool !== '-') byTool[tool] = (byTool[tool] || 0) + 1;
      if (ipHash && ipHash !== 'noip') {
        if (!clientDays.has(ipHash)) clientDays.set(ipHash, new Set());
        clientDays.get(ipHash).add(day);
      }
      if (client && client !== '-') clientNames[client] = (clientNames[client] || 0) + 1;
    }
    cursor = page.cursor;
  } while (cursor);
  const unique = clientDays.size;
  const repeat = [...clientDays.values()].filter((s) => s.size >= 2).length;
  return {
    window_days: days,
    total_events: total,
    unique_clients: unique,
    repeat_clients: repeat, // 2日以上またいで来たクライアント=リピートの実測
    by_method: byMethod,
    by_tool: byTool,
    by_client_name: clientNames,
    by_day: byDay,
    privacy: 'No raw IPs or user agents are stored; clients are counted via salted hashes only.',
  };
}

// Blobsのstoreを開く。Netlifyの本番ランタイムでは自動の接続情報で動く。
// 動かない環境(ローカル試験・別ホスト)では null を返し、呼び出し側がfail-openする。
async function openStore(getStore) {
  if (!getStore) return null;
  try {
    return getStore('telemetry');
  } catch {
    return null;
  }
}

// IPのソルト付きハッシュ。ソルトは環境変数が正、未設定でも固定文字列で動く
// (匿名化の目的には足りる。逆引き耐性を上げたい時だけ env を設定する)。
// Web Crypto(globalThis.crypto)が無いランタイム(Node 18のLambda等・ドラフト実測で
// unique_clients=0に落ちた実バグ)では node:crypto へフォールバックする。
export async function hashIp(ip, salt) {
  if (!ip) return 'noip';
  const input = (salt || 'japan-data-mcp-telemetry-v1') + '|' + ip;
  try {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  } catch {
    return 'noip';
  }
}

// User-Agentから製品名トークンだけを取り出す(生UAは保存しない)。
export function clientFromUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const first = ua.trim().split(/[\s(]/)[0]; // 例: "claude-code/1.2" -> "claude-code/1.2"
  return first.split('/')[0] || null;
}

// リクエスト本文(JSON-RPC・単一/バッチ)から記録するイベント属性を抜き出す。
// initialize の clientInfo.name は自己申告の製品名(MCP仕様)なので client として優先する。
export function eventsFromBody(body, { ipHash, uaClient }) {
  const msgs = Array.isArray(body) ? body : [body];
  const events = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || !m.method) continue;
    if (String(m.method).startsWith('notifications/')) continue; // 通知は需要の信号でない
    const ev = { method: m.method, ipHash, client: uaClient };
    if (m.method === 'initialize') {
      const ci = m.params && m.params.clientInfo;
      if (ci && ci.name) ev.client = String(ci.name);
    }
    if (m.method === 'tools/call') {
      ev.tool = m.params && m.params.name;
    }
    events.push(ev);
  }
  return events;
}

function sanitize(s, max) {
  if (!s || typeof s !== 'string') return null;
  return s.replace(/[^a-zA-Z0-9._\/-]/g, '_').replace(/\./g, '_').replace(/\//g, '-').slice(0, max);
}

function rand4() {
  return Math.random().toString(36).slice(2, 6);
}
