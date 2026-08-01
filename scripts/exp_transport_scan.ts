// 収束させた EBM で、熱輸送の定数を振って採点の応答を見る。
//
// 問い(2026-08-01):
//   線形解を収束させると大分類が 74.32 → 71.92 へ落ちた。仮説は
//   「未収束の Gauss-Seidel は陰的作用素を途中までしか適用しないので熱輸送が
//     弱く効き、拡散・移流係数はそれを打ち消す向きに(過大に)較正されていた」。
//   この仮説が正しければ、**輸送係数を下げれば成績は戻る**はず。
//   戻らなければ、失われた 2.4pt は係数では取り返せない別の何かである。
//
// これは較正そのものではなく、較正の探索範囲が足りているかを確かめる下見。
//
// 実行: npx tsx scripts/exp_transport_scan.ts [パラメータ名] [値, 値, ...]
//   引数なしなら主要 4 定数を既定の刻みで走査する。

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { EBM_SOLVER, EBM_GPU_ITERATIONS } from '../src/sim/step05_temperature';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
// **収束させた EBM で走査する**(これが本題)
EBM_SOLVER.order = 'red-black';
EBM_SOLVER.sweeps = EBM_GPU_ITERATIONS;

const DEFAULT_SCANS: [string, number[]][] = [
  ['diffusionWm2PerK', [0.35, 0.42, 0.4884, 0.5484, 0.62]],
  ['zonalAdvectionCouplingWm2PerK', [20, 26, 30, 35.2, 45]],
  ['hadleyDiffusionBoost', [0.35, 0.5, 0.6, 0.72784469, 0.95]],
  ['zonalDiffusionFactor', [0.06, 0.09, 0.12, 0.16, 0.22]],
];

const argName = process.argv[2];
const argValues = process.argv.slice(3).map(Number).filter(Number.isFinite);
const scans: [string, number[]][] =
  argName && argValues.length > 0 ? [[argName, argValues]] : DEFAULT_SCANS;

const accel = await openAccel();

const evalOnce = async (): Promise<string> => {
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const s = evaluateResult(r);
  return (
    `大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} / ゲート ${String(s.gates).padStart(2)} / ` +
    `気温RMSE ${s.tempRmse.toFixed(3)} / 降水RMSE ${Math.round(s.precipRmse)} / ` +
    `陸平均 ${Math.round(s.landMeanMm)}mm / fit ${s.fitness.toFixed(2)}`
  );
};

console.log('基準(現行の定数、収束させた EBM):');
console.log(`  ${await evalOnce()}\n`);

for (const [name, values] of scans) {
  const base = K[name];
  if (base === undefined) {
    console.log(`定数 ${name} が見つからない`);
    continue;
  }
  console.log(`=== ${name}(現行 ${base}) ===`);
  for (const v of values) {
    K[name] = v;
    const line = await evalOnce();
    console.log(`  ${String(v).padStart(10)}  ${line}${v === base ? '  ← 現行' : ''}`);
  }
  K[name] = base;
  console.log('');
}
accel.close();
console.log(
  '仮説どおりなら、輸送を弱める向き(拡散・移流を下げる)で大分類が戻るはず。\n' +
    '戻り幅が小さいなら、探索範囲を広げるか、失点が輸送以外にあることになる。',
);
