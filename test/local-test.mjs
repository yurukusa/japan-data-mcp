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
check('3 tools listed', names.length === 3, names.join(', '));
check('has search_japanese_law', names.includes('search_japanese_law'));

console.log('== tools/call: search_japanese_law (live e-Gov API, no key) ==');
const law = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_japanese_law', arguments: { keyword: '個人情報', limit: 3 } } });
let lawObj = null;
try { lawObj = JSON.parse(law?.result?.content?.[0]?.text || '{}'); } catch {}
check('law tool not isError', law?.result?.isError === false);
check('law returned results', Array.isArray(lawObj?.results) && lawObj.results.length > 0, `${lawObj?.results?.length} results`);
const first = lawObj?.results?.[0];
check('English-keyed metadata (law_id/law_type/era)', !!(first?.law_id && first?.law_type && ('era' in (first || {}))), first ? `${first.law_type} / ${first.era}` : '');
check('attribution present', typeof lawObj?.attribution === 'string' && lawObj.attribution.includes('e-Gov'));

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
