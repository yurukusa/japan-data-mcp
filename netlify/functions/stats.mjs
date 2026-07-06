// 公開の利用統計 /stats。段階0の需要計測(仕様7節)の透明性の面。
// 出すのは匿名の集計だけ(生IP・生UAは最初から保存していない=telemetry.js参照)。
// 機械顧客(エージェント)と人間の両方が「このサーバーは実際に使われているか」を
// 確かめられる。自分の段階0判定(30日でユニーク利用者N・リピート率)も同じ数字を読む。
import { getStore } from '@netlify/blobs';
import { aggregateStats } from '../../src/telemetry.js';

export default async () => {
  const stats = await aggregateStats({ getStore }, 30);
  return new Response(JSON.stringify({
    server: 'japan-data-mcp',
    measuring_since: '2026-07-06',
    ...stats,
  }, null, 2), {
    status: stats && stats.error ? 503 : 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};

export const config = { path: '/stats' };
