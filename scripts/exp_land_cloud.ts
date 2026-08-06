// 実験: 陸の対流・前線雲を入れると冷帯の夏は下がるか。
//
// 対応 spec: docs/事前登録_陸の対流雲_2026-08-07.md
//
// 判定(結果を見る前に固定済み):
//   主判定 … 観測 D 帯の最暖月ずれが 40〜50°N と 50〜60°N の**両方**で +3.0°C 以下
//   副判定 … 第 3 文字の一致 45% 以上 / 乾燥ゲート 3 件維持 / 熱帯ゲート 2 件維持
//            / 数値的健全性(残差 < 1e-3、ドリフト < 0.05)
//   棄却   … landCloudBoost を 0.15 / 0.3 / 0.5 の 3 段階試して届かなければ棄却
//
// 実行: npx tsx scripts/exp_land_cloud.ts [boost,boost,...]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { evaluateResult } from './optimize_lib';
import { scoreRegionGates } from './scoring';
import { borealMetrics } from './boreal_metrics';
import { openAccel } from './accel_cli';

const BOOSTS = (process.argv[2] ?? '0,0.15,0.3,0.5').split(',').map(Number);
const DRY = ['sahara_arid', 'arabia_arid', 'australia_interior_arid'];
const TROPICAL = ['amazon_tropical', 'congo_tropical'];

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const accel = await openAccel();
  const rows: Array<{
    boost: number;
    d40: number;
    d50: number;
    d60: number;
    letter: number;
    dry: number;
    trop: number;
    fit: number;
    major: number;
    detail: number;
    range: number;
    gates: number;
    residual: number;
    drift: number;
  }> = [];
  try {
    for (const boost of BOOSTS) {
      K.landCloudBoost = boost;
      EBM_SOLVER_STATS.maxResidualC = 0;
      EBM_SOLVER_STATS.meanYearDriftC = 0;
      const r = await runPipeline(EARTH_PARAMS, accel.opts);
      const s = evaluateResult(r);
      const b = borealMetrics(r);
      const g = scoreRegionGates(r);
      const row = {
        boost,
        d40: b.dTmaxByBand[40] ?? NaN,
        d50: b.dTmaxByBand[50] ?? NaN,
        d60: b.dTmaxByBand[60] ?? NaN,
        letter: b.letterHitPct,
        dry: g.filter((x) => DRY.includes(x.id) && x.pass).length,
        trop: g.filter((x) => TROPICAL.includes(x.id) && x.pass).length,
        fit: s.fitness,
        major: s.majorPct,
        detail: s.detailPct,
        range: s.tempRangeRmse,
        gates: s.gates,
        residual: EBM_SOLVER_STATS.maxResidualC,
        drift: EBM_SOLVER_STATS.meanYearDriftC,
      };
      rows.push(row);
      console.log(
        `boost=${String(boost).padStart(5)}  40N=${(row.d40 >= 0 ? '+' : '') + row.d40.toFixed(2)}  ` +
          `50N=${(row.d50 >= 0 ? '+' : '') + row.d50.toFixed(2)}  60N=${(row.d60 >= 0 ? '+' : '') + row.d60.toFixed(2)}  ` +
          `文字=${row.letter.toFixed(1)}%  乾燥=${row.dry}/3  熱帯=${row.trop}/2  ` +
          `v3=${row.fit.toFixed(3)}  大分類=${row.major.toFixed(2)}  詳細=${row.detail.toFixed(2)}  ` +
          `年較差=${row.range.toFixed(2)}  残差=${row.residual.toExponential(1)}`,
      );
    }
  } finally {
    accel.close();
  }

  console.log('\n===== 事前登録の判定 =====');
  const base = rows.find((r) => r.boost === 0);
  console.log('boost   主判定(40N/50N ≤ +3.0)  文字 ≥45%   乾燥 3/3  熱帯 2/2  健全性  v3 の変化');
  for (const r of rows) {
    const main = r.d40 <= 3 && r.d50 <= 3;
    const sound = r.residual < 1e-3 && r.drift < 0.05;
    const dv = base ? r.fit - base.fit : 0;
    console.log(
      `${String(r.boost).padStart(5)}   ${main ? '○' : '×'} (${r.d40.toFixed(2)} / ${r.d50.toFixed(2)})` +
        `       ${r.letter >= 45 ? '○' : '×'} (${r.letter.toFixed(1)})   ${r.dry === 3 ? '○' : '×'}     ` +
        `${r.trop === 2 ? '○' : '×'}     ${sound ? '○' : '×'}   ${dv >= 0 ? '+' : ''}${dv.toFixed(3)}`,
    );
  }
  const win = rows.find((r) => r.boost > 0 && r.d40 <= 3 && r.d50 <= 3 && r.dry === 3 && r.trop === 2);
  console.log(
    win
      ? `\n主判定と副判定を満たす最小の boost: ${win.boost}`
      : '\n主判定を満たす boost は無い → 事前登録の棄却条件に該当',
  );
}

void main();
