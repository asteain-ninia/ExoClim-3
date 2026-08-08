// 較正後の確認: 他の定数を釣り合わせた後でも、目的関数は陸の雲を 0 へ戻したがるか。
//
// 対応 spec: docs/較正計画_v15_2026-08-07.md 「較正後に必ずやる確認」
//
// なぜ要るか:
//   `landCloudBoost` は探索空間へ入れていない。v3 が強さに対して単調に下がるので、
//   入れると座標降下が**補償の見つかる前に 0 へ戻す**からである
//   (教訓 §9「座標降下は谷を渡れない」)。
//
//   ただしこれは「目的関数が雲を欲しがっていない」可能性を隠す造りでもある。
//   **較正が収束した点で強さだけを振り直し**、そこでも 0 が最良なら、
//   他の定数で補償してもなお v3 は雲を要らないと言っていることになる。
//   その事実ごと記録して採否を考え直す。押し戻さないなら谷を渡れていた。
//
// 実行: npx tsx scripts/exp_boost_recheck.ts <較正後のパラメータJSON> [boost,...]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { evaluateResult } from './optimize_lib';
import { scoreRegionGates } from './scoring';
import { borealMetrics } from './boreal_metrics';
import { openAccel } from './accel_cli';

const PARAM_PATH = process.argv[2];
const BOOSTS = (process.argv[3] ?? '0,0.1,0.2,0.3,0.4').split(',').map(Number);
const DRY = ['sahara_arid', 'arabia_arid', 'australia_interior_arid'];
const TROPICAL = ['amazon_tropical', 'congo_tropical'];

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    let n = 0;
    for (const [k, v] of Object.entries(patch)) {
      if (k in K) {
        K[k] = v;
        n++;
      }
    }
    console.log(`較正後の定数を適用: ${PARAM_PATH}(${n} 件)`);
  } else {
    console.log('引数が無いので現在の constants.ts のまま回す');
  }

  const accel = await openAccel();
  console.log('\nboost   v3       大分類  詳細   ゲート  40-50N  50-60N  文字   乾燥 熱帯  残差');
  const rows: Array<{ b: number; fit: number }> = [];
  try {
    for (const b of BOOSTS) {
      K.landCloudBoost = b;
      EBM_SOLVER_STATS.maxResidualC = 0;
      const r = await runPipeline(EARTH_PARAMS, accel.opts);
      const s = evaluateResult(r);
      const bm = borealMetrics(r);
      const g = scoreRegionGates(r);
      rows.push({ b, fit: s.fitness });
      console.log(
        `${String(b).padStart(5)}   ${s.fitness.toFixed(3)}  ${s.majorPct.toFixed(2)}  ` +
          `${s.detailPct.toFixed(2)}  ${String(s.gates).padStart(4)}   ` +
          `${((bm.dTmaxByBand[40] ?? NaN) >= 0 ? '+' : '') + (bm.dTmaxByBand[40] ?? NaN).toFixed(2)}   ` +
          `${((bm.dTmaxByBand[50] ?? NaN) >= 0 ? '+' : '') + (bm.dTmaxByBand[50] ?? NaN).toFixed(2)}   ` +
          `${bm.letterHitPct.toFixed(1)}%  ` +
          `${g.filter((x) => DRY.includes(x.id) && x.pass).length}/3  ` +
          `${g.filter((x) => TROPICAL.includes(x.id) && x.pass).length}/2  ` +
          `${EBM_SOLVER_STATS.maxResidualC.toExponential(1)}`,
      );
    }
  } finally {
    accel.close();
  }

  const best = rows.reduce((a, b) => (b.fit > a.fit ? b : a));
  console.log(`\n目的関数が最良とする boost: ${best.b}(v3=${best.fit.toFixed(3)})`);
  console.log(
    best.b === 0
      ? '→ 他の定数を釣り合わせた後でも 0 が最良。**目的関数は陸の雲を要らないと言っている。**\n' +
          '   採否を考え直すこと(v3 が拾えていない指標 — 季節・第 3 文字 — と突き合わせる)。'
      : '→ 0 より大きい boost が最良。谷は渡れていた。較正が雲を受け入れている。',
  );
}

void main();
