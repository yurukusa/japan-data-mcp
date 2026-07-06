// 段階0のローカル試験。wrangler無しで、Worker本体を直接呼んで検証する
// （node 20 は fetch/Request/Response をグローバルに持つ）。
// 合否: initialize と tools/list が正しく応答し、法令ツール（鍵不要）が
// 実際の e-Gov API から英語のメタデータ付きの結果を返すこと。
// 法人番号/e-Stat は appId 未設定なら human_gate のエラーを返すこと。

import worker from '../src/index.js';

let failures = 0;
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function rpc(msg, env = {}) {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  });
  const res = await worker.fetch(req, env);
  if (res.status === 202) return null;
  return res.json();
}

console.log('== initialize ==');
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
check('protocolVersion returned', init?.result?.protocolVersion);
check('serverInfo.name', init?.result?.serverInfo?.name === 'japan-data-mcp');

console.log('== tools/list ==');
const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const names = (list?.result?.tools || []).map((t) => t.name);
check('4 tools listed', names.length === 4, names.join(', '));
check('has search_japanese_law', names.includes('search_japanese_law'));
check('has get_law_text', names.includes('get_law_text'));

console.log('== tools/call: search_japanese_law (live e-Gov API, no key) ==');
const law = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_japanese_law', arguments: { keyword: '個人情報', limit: 20 } } });
let lawObj = null;
try { lawObj = JSON.parse(law?.result?.content?.[0]?.text || '{}'); } catch {}
check('law tool not isError', law?.result?.isError === false);
check('law returned results', Array.isArray(lawObj?.results) && lawObj.results.length > 0, `${lawObj?.results?.length} results`);
const first = lawObj?.results?.[0];
check('English-keyed metadata (law_id/law_type/era)', !!(first?.law_id && first?.law_type && ('era' in (first || {}))), first ? `${first.law_type} / ${first.era}` : '');
check('attribution present', typeof lawObj?.attribution === 'string' && lawObj.attribution.includes('e-Gov'));

// 回帰ガード: 全文一致の結果は上流の sentences[] から一致本文を必ず持つはず。
// これが null に戻ると「なぜ一致したか」が消え、ツールが無関係な結果に見える（過去の実バグ 967cf6f）。
// 「善意」は題名一致0・全文一致303件(実測)なので、全文一致だけの経路を確実に踏む。
console.log('== full_text-only query carries matched_text_ja ==');
const ft = await rpc({ jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'search_japanese_law', arguments: { keyword: '善意', limit: 5 } } });
let ftObj = null; try { ftObj = JSON.parse(ft?.result?.content?.[0]?.text || '{}'); } catch {}
const ftResults = (ftObj?.results || []).filter((r) => (r.match || '').includes('full_text'));
check('full_text matches carry matched_text_ja (why it matched)', ftResults.length > 0 && ftResults.every((r) => typeof r.matched_text_ja === 'string' && r.matched_text_ja.length > 0), `${ftResults.length} full_text matches`);

// 回帰ガード: 上流が法令番号順で返す仕様への再ランク。「個人情報保護」で
// 先頭が主題外の法令(過去の実例: 会計検査院法)や規則類に戻ると FAIL。
// 期待は本命=個人情報の保護に関する法律(法形式Act・題名一致)。
console.log('== rerank: top result is the canonical Act ==');
const rr = await rpc({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'search_japanese_law', arguments: { keyword: '個人情報保護', limit: 5 } } });
let rrObj = null; try { rrObj = JSON.parse(rr?.result?.content?.[0]?.text || '{}'); } catch {}
const rrTop = rrObj?.results?.[0];
check('top result title contains query intent', !!(rrTop?.title_ja && rrTop.title_ja.includes('個人情報')), rrTop?.title_ja || '');
check('top result is an Act (not a Rule)', !!(rrTop?.law_type && rrTop.law_type.startsWith('Act')), rrTop?.law_type || '');
check('top result is a title match', !!(rrTop?.match && rrTop.match.includes('title')), rrTop?.match || '');

console.log('== tools/call: get_law_text (live e-Gov API, no key) ==');
const full = await rpc({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'get_law_text', arguments: { law_id: '321CONSTITUTION', max_chars: 500 } } });
let fullObj = null; try { fullObj = JSON.parse(full?.result?.content?.[0]?.text || '{}'); } catch {}
check('full text returned + truncated flag', !!(fullObj?.text_ja && fullObj.total_chars > 500 && fullObj.truncated === true), `${fullObj?.total_chars} chars`);
check('full text is real Japanese law text', typeof fullObj?.text_ja === 'string' && fullObj.text_ja.includes('日本国憲法'));

const art = await rpc({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'get_law_text', arguments: { law_id: '321CONSTITUTION', article: '9' } } });
let artObj = null; try { artObj = JSON.parse(art?.result?.content?.[0]?.text || '{}'); } catch {}
check('article 9 extracted', !!(artObj?.article === '9' && artObj.text_ja && artObj.text_ja.includes('戦争')), (artObj?.text_ja || '').slice(0, 40));
check('article attribution present', typeof artObj?.attribution === 'string' && artObj.attribution.includes('e-Gov'));

const noart = await rpc({ jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'get_law_text', arguments: { law_id: '321CONSTITUTION', article: '9999' } } });
let noartObj = null; try { noartObj = JSON.parse(noart?.result?.content?.[0]?.text || '{}'); } catch {}
check('missing article -> article_not_found with available list', noartObj?.error === 'article_not_found' && Array.isArray(noartObj?.available_articles) && noartObj.available_articles.length > 0, `${noartObj?.total_articles} articles`);

console.log('== tools/call: search_corporation (no appId -> human gate) ==');
const corp = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_corporation', arguments: { name: 'トヨタ' } } });
let corpObj = null; try { corpObj = JSON.parse(corp?.result?.content?.[0]?.text || '{}'); } catch {}
check('corporation reports human_gate when unconfigured', corpObj?.human_gate === true);

console.log('== tools/call: search_statistics (no appId -> human gate) ==');
const stat = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search_statistics', arguments: { keyword: 'population' } } });
let statObj = null; try { statObj = JSON.parse(stat?.result?.content?.[0]?.text || '{}'); } catch {}
check('statistics reports human_gate when unconfigured', statObj?.human_gate === true);

console.log('== unknown method ==');
const unk = await rpc({ jsonrpc: '2.0', id: 6, method: 'no/such' });
check('unknown method -> JSON-RPC error -32601', unk?.error?.code === -32601);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
