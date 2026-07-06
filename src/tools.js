// 3つのツールの実体。段階0の中身（仕様2節）。
// 法令ツールは鍵不要で完全動作。法人番号とe-Statは利用者登録（appId）が要り、
// 未設定なら「何を登録すればよいか」を英語で返す（人間ゲートを貼るだけにする）。

import { normalizeLaw, ATTRIBUTION } from './normalize.js';

const EGOV_BASE = 'https://laws.e-gov.go.jp/api/2';
const HOJIN_BASE = 'https://api.houjin-bangou.nta.go.jp/4';
const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';

// e-Gov v2 の /keyword は items[].sentences[] に、キーワードが一致した本文を
// {position, text} の配列で返す（一致語は text 内で <span> に囲まれる）。
// 上流は関連度順でなく法令番号順で返すため、先頭に主題外の法令が来ることがある。
// エージェントが「なぜこの法令が一致したか」を判断できるよう、最も情報量の多い
// 本文（本則 > 目次の本則側 > 目次 > 先頭）を1つ選び、タグを除いた素の日本語で同梱する。
const SENTENCE_PRIORITY = { mainprovision: 3, mainprovisiontoc: 2, toc: 1 };
function bestMatchedSentence(sentences) {
  if (!Array.isArray(sentences) || sentences.length === 0) return null;
  let best = null;
  let bestScore = -1;
  for (const s of sentences) {
    const score = SENTENCE_PRIORITY[s.position] ?? 0;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  const raw = best && best.text;
  if (!raw) return null;
  // <span> などのタグを除いて素のテキストにする（一致語は文中にそのまま残る）。
  return raw.replace(/<[^>]+>/g, '').trim() || null;
}

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
// keyword は日本語でも英語でも受けるが、上流は日本語の検索なので、
// 英語のキーワードは同定率が下がる旨を description に明記して誤解を防ぐ。
//
// 2系統マージの理由（967cf6f時点で未解決だった並び順の残課題の根治）:
// 全文検索(/keyword)だけでは「個人情報保護」の先頭に会計検査院法が来る。
// 上流が法令番号順で返すうえ、limit が法令数でなく一致文の数を数える仕様
// (実測: limit=20 で6法令)のため、本命の法令が返却ページに入らないことすらある。
// 題名検索(/laws?law_title=)は助詞のゆらぎ（「個人情報保護」→「個人情報の保護に
// 関する法律」）にも一致する（実測）ので、題名一致を第一系統、全文一致を第二系統
// として並行で引き、法形式（法律>政令>省令・規則）とクエリ被覆率で並べ直す。
export async function searchJapaneseLaw({ keyword, limit = 5 }) {
  if (!keyword || typeof keyword !== 'string') {
    return { error: 'invalid_argument', message: 'keyword (string) is required.' };
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
  const [titleRes, kwRes] = await Promise.all([
    fetchJson(`${EGOV_BASE}/laws?law_title=${encodeURIComponent(keyword)}&limit=${lim}`),
    // 上流のlimitは一致文の数を数えるため、法令lim件ぶんに足りるよう多めに要求する。
    fetchJson(`${EGOV_BASE}/keyword?keyword=${encodeURIComponent(keyword)}&limit=${Math.min(lim * 10, 50)}`),
  ]);
  if (!titleRes.ok && !kwRes.ok) {
    return { error: 'upstream_error', status: kwRes.status, message: 'e-Gov Law Search API returned an error.' };
  }

  const byId = new Map(); // law_id -> エントリ（題名一致を優先しつつ一致本文は合流させる）
  let titleTotal = 0;
  let fullTextTotal = 0;

  if (titleRes.ok) {
    try {
      const data = JSON.parse(titleRes.text);
      titleTotal = data.total_count ?? 0;
      for (const it of data.laws || []) {
        const law = normalizeLaw(it);
        if (law.law_id) byId.set(law.law_id, { ...law, match: 'title', matched_text_ja: null });
      }
    } catch { /* 題名系統の破損は全文系統だけで続行 */ }
  }
  if (kwRes.ok) {
    try {
      const data = JSON.parse(kwRes.text);
      fullTextTotal = data.total_count ?? 0;
      for (const it of data.items || []) {
        const law = normalizeLaw(it);
        const matched = bestMatchedSentence(it.sentences);
        const prev = law.law_id && byId.get(law.law_id);
        if (prev) {
          prev.match = 'title+full_text';
          prev.matched_text_ja = matched;
        } else if (law.law_id) {
          byId.set(law.law_id, { ...law, match: 'full_text', matched_text_ja: matched });
        }
      }
    } catch { /* 同上 */ }
  }

  const merged = [...byId.values()];
  const scored = merged.map((it, i) => ({ it, i, s: relevanceScore(it, keyword) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i)); // 同点は上流の順（安定）
  return {
    query: keyword,
    title_match_count: titleTotal,
    full_text_match_count: fullTextTotal,
    returned: Math.min(scored.length, lim),
    order: 'reranked: title matches first, weighted by law type (Act highest) and query coverage',
    results: scored.slice(0, lim).map((x) => x.it),
    attribution: ATTRIBUTION.law,
  };
}

// 法形式の重み。キーワードだけの検索意図では、規則・省令より法律本体が本命である
// ことが多い（実例: 「個人情報保護」の題名一致には会計検査院の審査会「規則」も
// 含まれるが、利用者の本命はほぼ常に個人情報の保護に関する「法律」）。
const LAW_TYPE_WEIGHT = { Constitution: 3.5, Act: 3, CabinetOrder: 2, MinisterialOrdinance: 1, Rule: 1, ImperialOrdinance: 1 };

function relevanceScore(law, keyword) {
  const kw = keyword.trim();
  let s = 0;
  if (law.match === 'title' || law.match === 'title+full_text') s += 8; // 題名一致は常に全文一致より上
  const typeKey = Object.keys(LAW_TYPE_WEIGHT).find((k) => (law.law_type || '').startsWith(k));
  if (typeKey) s += LAW_TYPE_WEIGHT[typeKey];
  if (law.title_ja) {
    // 日本の法令名は「個人情報の保護に関する法律」のように定型の助詞句を挟むため、
    // 素の部分文字列では「個人情報保護」が本命の法律に一致しない。助詞句を除いた
    // 正規化題名で包含を判定し、さらに文字bigramの被覆率で語順のずれに耐える。
    const nt = normalizedTitle(law.title_ja);
    if (nt.includes(kw)) s += 1.5;
    s += titleCoverage(nt, kw) * 2;
    // 題名が短い法令ほど一般法(本命)である傾向(設置法・審査会規則などの付随法令は
    // 題名が長い)。同じ一致条件の中の順序づけにだけ効く弱い重み。
    s += Math.max(0, 40 - law.title_ja.length) / 20;
  }
  if (law.matched_text_ja && law.matched_text_ja.includes(kw)) s += 0.5;
  return s;
}

function normalizedTitle(t) {
  return t.replace(/の|に関する|に係る/g, '');
}

function titleCoverage(title, kw) {
  if (kw.length < 2) return title.includes(kw) ? 1 : 0;
  let hit = 0;
  let n = 0;
  for (let i = 0; i < kw.length - 1; i++) {
    const bg = kw.slice(i, i + 2);
    if (/\s/.test(bg)) continue;
    n++;
    if (title.includes(bg)) hit++;
  }
  return n ? hit / n : 0;
}

// ツール1b: 法令の本文の取得。鍵不要。search_japanese_law の law_id / revision_id を
// 受けて、原文（日本語）を返す。エージェントは検索→本文引用の2段で、鍵なしで完結する
// 実用の作業の流れを持てる（段階0の看板ツールを「探せる」から「使える」へ）。
export async function getLawText({ law_id, article, max_chars = 4000 }) {
  const id = (law_id || '').trim();
  if (!id) {
    return { error: 'invalid_argument', message: 'law_id (string) is required — pass law_id or revision_id from search_japanese_law.' };
  }
  const mc = Math.min(Math.max(parseInt(max_chars, 10) || 4000, 200), 20000);
  const url = `${EGOV_BASE}/law_data/${encodeURIComponent(id)}?law_full_text_format=json`;
  const res = await fetchJson(url);
  if (!res.ok) {
    return { error: 'upstream_error', status: res.status, message: 'e-Gov Law Data API returned an error. Check that law_id or revision_id is exactly as returned by search_japanese_law.' };
  }
  let data;
  try { data = JSON.parse(res.text); } catch { return { error: 'parse_error', message: 'Unexpected response from e-Gov API.' }; }
  const meta = normalizeLaw(data);
  const tree = data.law_full_text;
  if (!tree) return { error: 'no_text', message: 'The law data did not include full text.' };

  if (article) {
    const wanted = String(article).trim();
    const node = findArticle(tree, wanted);
    if (!node) {
      const nums = collectArticleNums(tree);
      return {
        error: 'article_not_found',
        message: `Article "${wanted}" not found. Use Arabic numerals as e-Gov numbers them (e.g. "9", or "32_2" for Article 32-2).`,
        available_articles: nums.slice(0, 80),
        total_articles: nums.length,
      };
    }
    const text = flattenLawText(node);
    return {
      ...meta,
      article: wanted,
      text_ja: text.slice(0, mc),
      total_chars: text.length,
      truncated: text.length > mc,
      attribution: ATTRIBUTION.law,
    };
  }

  const text = flattenLawText(tree);
  return {
    ...meta,
    article: null,
    text_ja: text.slice(0, mc),
    total_chars: text.length,
    truncated: text.length > mc,
    note: text.length > mc ? 'Pass article (e.g. "9") to extract one article, or raise max_chars (up to 20000).' : undefined,
    attribution: ATTRIBUTION.law,
  };
}

// 法令XMLの木（JSON形）から素の日本語本文を組み立てる。ブロック級のタグの後で
// 改行を入れ、エージェントがそのまま引用できる読みやすさを保つ。
const BLOCK_TAGS = new Set([
  'LawTitle', 'EnactStatement', 'Preamble', 'ChapterTitle', 'SectionTitle', 'SubsectionTitle',
  'ArticleCaption', 'ArticleTitle', 'Paragraph', 'Item', 'SupplProvisionLabel',
]);
function flattenLawText(node) {
  const out = [];
  (function walk(n) {
    if (typeof n === 'string') { out.push(n); return; }
    if (!n || typeof n !== 'object') return;
    for (const c of n.children || []) walk(c);
    if (BLOCK_TAGS.has(n.tag)) out.push('\n');
  })(node);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Article ノードは章・節・附則の下に自由に入れ子になるため、木全体を探す。
function findArticle(node, num) {
  if (!node || typeof node !== 'object') return null;
  if (node.tag === 'Article' && node.attr && String(node.attr.Num) === num) return node;
  for (const c of node.children || []) {
    if (typeof c === 'object') {
      const hit = findArticle(c, num);
      if (hit) return hit;
    }
  }
  return null;
}

function collectArticleNums(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.tag === 'Article' && node.attr && node.attr.Num) acc.push(String(node.attr.Num));
  for (const c of node.children || []) {
    if (typeof c === 'object') collectArticleNums(c, acc);
  }
  return acc;
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
    name: 'get_law_text',
    description: 'Fetch the original Japanese text of a law by its law_id or revision_id (as returned by search_japanese_law). Optionally extract a single article. Returns the authentic Japanese legal text with English-normalized metadata and the required source attribution. No API key required. Typical flow: search_japanese_law -> get_law_text.',
    inputSchema: {
      type: 'object',
      properties: {
        law_id: { type: 'string', description: 'law_id (e.g. "321CONSTITUTION") or revision_id from search_japanese_law results.' },
        article: { type: 'string', description: 'Optional article number in Arabic numerals as e-Gov numbers them, e.g. "9", or "32_2" for Article 32-2. Omit to get the whole law (truncated to max_chars).' },
        max_chars: { type: 'integer', description: 'Max characters of Japanese text to return (200-20000).', default: 4000 },
      },
      required: ['law_id'],
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
    case 'get_law_text': return getLawText(args || {});
    case 'search_corporation': return searchCorporation(args || {}, env || {});
    case 'search_statistics': return searchStatistics(args || {}, env || {});
    default: return { error: 'unknown_tool', message: `No tool named ${name}.` };
  }
}
