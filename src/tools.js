// 3つのツールの実体。段階0の中身（仕様2節）。
// 法令ツールは鍵不要で完全動作。法人番号とe-Statは利用者登録（appId）が要り、
// 未設定なら「何を登録すればよいか」を英語で返す（人間ゲートを貼るだけにする）。

import { normalizeLaw, ATTRIBUTION } from './normalize.js';

const EGOV_BASE = 'https://laws.e-gov.go.jp/api/2';
const HOJIN_BASE = 'https://api.houjin-bangou.nta.go.jp/4';
const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';

// 上流APIへのfetchを短いタイムアウトで包む。Workersの実行時間の上限内に収め、
// 上流が遅い時にエージェント側を無限に待たせない。
async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
}

// ツール1: 日本の法令の検索（英語のメタデータで返す）。鍵不要。
// keyword は日本語でも英語でも受けるが、上流は日本語の全文検索なので、
// 英語のキーワードは同定率が下がる旨を description に明記して誤解を防ぐ。
export async function searchJapaneseLaw({ keyword, limit = 5 }) {
  if (!keyword || typeof keyword !== 'string') {
    return { error: 'invalid_argument', message: 'keyword (string) is required.' };
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
  const url = `${EGOV_BASE}/keyword?keyword=${encodeURIComponent(keyword)}&limit=${lim}`;
  const res = await fetchJson(url);
  if (!res.ok) {
    return { error: 'upstream_error', status: res.status, message: 'e-Gov Law Search API returned an error.' };
  }
  let data;
  try { data = JSON.parse(res.text); } catch { return { error: 'parse_error', message: 'Unexpected response from e-Gov API.' }; }
  const items = (data.items || []).map((it) => {
    const law = normalizeLaw(it);
    // マッチした本文（日本語）を短く同梱。全文は revision_id で別途取得する導線を示す。
    const sentence = it.sentence || it.sentence_text || null;
    return { ...law, matched_text_ja: sentence };
  });
  return {
    query: keyword,
    total_count: data.total_count ?? items.length,
    returned: items.length,
    results: items,
    attribution: ATTRIBUTION.law,
  };
}

// ツール2: 法人の検索（法人番号Web-API）。appId（登録）が要る＝人間ゲート。
export async function searchCorporation({ name, corporate_number }, env) {
  const appId = env && env.HOJIN_APP_ID;
  if (!appId) {
    return {
      error: 'not_configured',
      message: 'Corporate Number Web-API requires a free application ID (appId) from the National Tax Agency of Japan. Register at https://www.houjin-bangou.nta.go.jp/webapi/ and set HOJIN_APP_ID. This is a one-time human step.',
      human_gate: true,
    };
  }
  if (!name && !corporate_number) {
    return { error: 'invalid_argument', message: 'Provide either name (partial company name) or corporate_number (13 digits).' };
  }
  let url;
  if (corporate_number) {
    url = `${HOJIN_BASE}/num?id=${encodeURIComponent(appId)}&number=${encodeURIComponent(corporate_number)}&type=12&history=0`;
  } else {
    url = `${HOJIN_BASE}/name?id=${encodeURIComponent(appId)}&name=${encodeURIComponent(name)}&type=12&mode=2&history=0`;
  }
  const res = await fetchJson(url);
  if (!res.ok) {
    return { error: 'upstream_error', status: res.status, message: 'Corporate Number Web-API returned an error.' };
  }
  // 応答はCSV（type=12）なので、英語キーの配列へ最小限に整形する。
  const rows = parseHojinCsv(res.text);
  return {
    query: corporate_number ? { corporate_number } : { name },
    returned: rows.length,
    results: rows,
    attribution: ATTRIBUTION.corporation,
  };
}

// 法人番号Web-APIのCSV（type=12）の主要列を英語キーへ。列順は仕様の固定順。
function parseHojinCsv(csv) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    if (c.length < 10) continue;
    out.push({
      corporate_number: c[1] || null,
      name_ja: c[6] || null,
      prefecture_ja: c[9] || null,
      city_ja: c[10] || null,
      street_ja: c[11] || null,
      registered_date: c[4] || null,
      process_type: c[2] || null,
    });
  }
  return out;
}

function splitCsvLine(line) {
  const res = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { res.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  res.push(cur);
  return res;
}

// ツール3: 統計表の検索（e-Stat API）。appId（登録）が要る＝人間ゲート。
export async function searchStatistics({ keyword, limit = 5 }, env) {
  const appId = env && env.ESTAT_APP_ID;
  if (!appId) {
    return {
      error: 'not_configured',
      message: 'e-Stat API requires a free application ID (appId) from the Statistics Bureau of Japan. Register at https://www.e-stat.go.jp/api/ and set ESTAT_APP_ID. This is a one-time human step.',
      human_gate: true,
    };
  }
  if (!keyword) return { error: 'invalid_argument', message: 'keyword (string) is required.' };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
  const url = `${ESTAT_BASE}/getStatsList?appId=${encodeURIComponent(appId)}&searchWord=${encodeURIComponent(keyword)}&limit=${lim}`;
  const res = await fetchJson(url);
  if (!res.ok) return { error: 'upstream_error', status: res.status, message: 'e-Stat API returned an error.' };
  let data;
  try { data = JSON.parse(res.text); } catch { return { error: 'parse_error', message: 'Unexpected response from e-Stat API.' }; }
  const list = data?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF || [];
  const arr = Array.isArray(list) ? list : [list];
  const results = arr.filter(Boolean).map((t) => ({
    stats_data_id: t['@id'] || null,
    title_ja: (t.TITLE && (t.TITLE.$ || t.TITLE)) || t.STATISTICS_NAME || null,
    government_org_ja: t.GOV_ORG && (t.GOV_ORG.$ || t.GOV_ORG),
    survey_date: t.SURVEY_DATE || null,
    updated: t.UPDATED_DATE || null,
    open_date: t.OPEN_DATE || null,
  }));
  return {
    query: keyword,
    returned: results.length,
    results,
    attribution: ATTRIBUTION.statistics,
  };
}

// MCPの tools/list が返すツールの定義（英語のスキーマ）。
export const TOOL_DEFS = [
  {
    name: 'search_japanese_law',
    description: 'Search Japanese laws and regulations by keyword and return English-normalized metadata (law id, type, era, promulgation date, category) plus the matched Japanese text. No API key required. Japanese keywords match best; the underlying source is full-text Japanese.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search term. Japanese matches the source text directly; English is best-effort.' },
        limit: { type: 'integer', description: 'Max results (1-20).', default: 5 },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'search_corporation',
    description: 'Look up a Japanese corporation by partial name or 13-digit corporate number, returning English-keyed records (corporate number, name, address). Requires a free National Tax Agency application ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Partial company name (Japanese).' },
        corporate_number: { type: 'string', description: '13-digit corporate number.' },
      },
    },
  },
  {
    name: 'search_statistics',
    description: 'Search Japanese official statistics tables (e-Stat) by keyword and return English-keyed table metadata (id, title, organization, dates). Requires a free e-Stat application ID.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search term for statistics tables.' },
        limit: { type: 'integer', description: 'Max results (1-20).', default: 5 },
      },
      required: ['keyword'],
    },
  },
];

export async function callTool(name, args, env) {
  switch (name) {
    case 'search_japanese_law': return searchJapaneseLaw(args || {});
    case 'search_corporation': return searchCorporation(args || {}, env || {});
    case 'search_statistics': return searchStatistics(args || {}, env || {});
    default: return { error: 'unknown_tool', message: `No tool named ${name}.` };
  }
}
