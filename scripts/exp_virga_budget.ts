// 実験: **virga の外側反復の上限は答えを決めているか。**
//
// 事前登録: docs/事前登録_乾いた端_2026-08-15.md（段 22）
// 前段: scripts/diag_virga_ratio.ts の残差列
//
// 何が起きているか:
//   `subCloudEvapCoef = 1` で外側反復が 216 か月ぶん未収束になり、段 22 の
//   掃引の行が丸ごと適用範囲外になった。残差列を見ると**発散でも停滞でもなく
//   「緩慢」**で、隣接比が 0.51 から 0.91 へ悪化しながら確かに縮んでいる。
//   許容 5e-3 まで届くには 50 回前後が要る（既定は 6 回）。
//
// なぜ「上限を上げて測り直す」で終わらせないか:
//   許容差 5e-3 は **maxChange の最大値ノルム**で、全セルのうち最悪の 1 つが
//   決める。降水がほぼ 0 のセルでは失う割合が上限 0.8 に貼り付く境目にあり、
//   そこだけが延々と揺れている可能性が高い。**そのセルは答えに効かない。**
//
//   EBM で確立した作法は「上限が**答えを決めない**ところまで上げる」であって
//   「残差を許容まで落とす」ではない(docs/実験記録_EBM数値の点検_2026-08-02.md)。
//   したがって測るべきは残差ではなく、**上限を変えたときに答えが動くか**である。
//
//   見る答えは v3 ではなく**乾いた端の分位**にする。段 22 が動かしたい量が
//   そこであり、そこが動かなくなった時点で上限は答えを決めていない。
//
// 実行: npx tsx scripts/exp_virga_budget.ts [係数] [上限,上限,...]
//   例: npx tsx scripts/exp_virga_budget.ts 1 6,12,24,48

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { VIRGA_OVERRIDE } from '../src/sim/step06_precipitation';
import { formatLevel, measureLevel, resolveTargets } from './sweep_lib';
import { openAccel } from './accel_cli';

const COEF = Number(process.argv[2] ?? 1);
const LIMITS = (process.argv[3] ?? '6,12,24,48').split(',').map(Number);

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const base = K['subCloudEvapCoef'] ?? 0;
  const targets = resolveTargets();
  console.log(`subCloudEvapCoef = ${COEF} を固定し、virga の外側反復の上限を振る。`);
  console.log('**見るのは成績ではなく、乾いた端の分位が上限とともに動くか。**\n');
  const accel = await openAccel(true);
  try {
    for (const limit of LIMITS) {
      VIRGA_OVERRIDE.maxIterations = limit;
      const p = await measureLevel('subCloudEvapCoef', COEF, targets, accel.opts);
      console.log(`── 上限 ${limit} 回`);
      console.log(formatLevel(p));
      console.log('');
    }
  } finally {
    VIRGA_OVERRIDE.maxIterations = 0;
    K['subCloudEvapCoef'] = base;
    accel.close();
  }
  console.log(
    '判定: 乾いた端の 1% / 5% 分位が上限を上げても動かなくなれば、\n' +
      '  **上限は答えを決めていない**ので、その値を既定にしてよい\n' +
      '  (未収束の件数が残っていても、動いていないのは効かないセルである)。\n' +
      '  動き続けるなら上限が答えを決めており、収束させるまで結論を書けない。',
  );
}

void main();
