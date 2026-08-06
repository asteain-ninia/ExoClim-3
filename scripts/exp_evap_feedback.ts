// 実験: 蒸発帰還(∂LE/∂T を EBM の対角へ)の効きを、事前登録した条件で測る。
//
// 対応 spec: docs/事前登録_蒸発帰還_2026-08-07.md
//
// 判定(結果を見る前に固定済み):
//   主判定 … 観測 D 帯の最暖月ずれが 40〜50°N と 50〜60°N の**両方**で +3.0°C 以下
//            (現状 +4.77 / +5.38)
//   副判定 … D の第 3 文字の一致 45% 以上(現状 31.3%)
//            乾燥ゲート 3 件(sahara/arabia/australia)が PASS を維持
//            数値的健全性: EBM 残差 < 1e-3°C、年次ドリフト < 0.05°C
//   棄却   … frac を 0.5 / 1 / 2 の 3 段階試して主判定に届かなければ棄却
//
// 実行: npx tsx scripts/exp_evap_feedback.ts [frac,frac,...]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { evaluateResult } from './optimize_lib';
import { scoreRegionGates } from './scoring';
import { borealMetrics } from './boreal_metrics';
import { openAccel } from './accel_cli';

const FRACS = (process.argv[2] ?? '0,0.5,1,2').split(',').map(Number);
const DRY_GATES = ['sahara_arid', 'arabia_arid', 'australia_interior_arid'];

interface Row {
  frac: number;
  fitness: number;
  major: number;
  detail: number;
  gates: number;
  tempRmse: number;
  rangeRmse: number;
  letterHit: number;
  d40: number;
  d50: number;
  d60: number;
  dryPass: number;
  residual: number;
  drift: number;
}

async function main(): Promise<void> {
  const accel = await openAccel();
  const rows: Row[] = [];
  try {
    for (const frac of FRACS) {
      (MODEL_CONSTANTS as unknown as Record<string, number>).evapFeedbackFrac = frac;
      EBM_SOLVER_STATS.maxResidualC = 0;
      EBM_SOLVER_STATS.meanYearDriftC = 0;
      const result = await runPipeline(EARTH_PARAMS, accel.opts);
      const s = evaluateResult(result);
      const b = borealMetrics(result);
      const gates = scoreRegionGates(result);
      const dryPass = gates.filter((g) => DRY_GATES.includes(g.id) && g.pass).length;
      rows.push({
        frac,
        fitness: s.fitness,
        major: s.majorPct,
        detail: s.detailPct,
        gates: s.gates,
        tempRmse: s.tempRmse,
        rangeRmse: s.tempRangeRmse,
        letterHit: b.letterHitPct,
        d40: b.dTmaxByBand[40] ?? NaN,
        d50: b.dTmaxByBand[50] ?? NaN,
        d60: b.dTmaxByBand[60] ?? NaN,
        dryPass,
        residual: EBM_SOLVER_STATS.maxResidualC,
        drift: EBM_SOLVER_STATS.meanYearDriftC,
      });
      const r = rows[rows.length - 1]!;
      console.log(
        `frac=${String(frac).padStart(4)}  v3=${r.fitness.toFixed(3)}  大分類=${r.major.toFixed(2)}  ` +
          `詳細=${r.detail.toFixed(2)}  ゲート=${r.gates}  文字=${r.letterHit.toFixed(1)}%  ` +
          `40N=${r.d40 >= 0 ? '+' : ''}${r.d40.toFixed(2)}  50N=${r.d50 >= 0 ? '+' : ''}${r.d50.toFixed(2)}  ` +
          `乾燥=${r.dryPass}/3  残差=${r.residual.toExponential(2)}  ドリフト=${r.drift.toFixed(4)}`,
      );
    }
  } finally {
    accel.close();
  }

  console.log('\n===== 事前登録の判定 =====');
  const base = rows.find((r) => r.frac === 0);
  console.log(
    'frac   主判定(40N/50N ≤ +3.0)   文字 ≥45%   乾燥 3/3   健全性   v3 の変化',
  );
  for (const r of rows) {
    const main = r.d40 <= 3.0 && r.d50 <= 3.0;
    const letter = r.letterHit >= 45;
    const dry = r.dryPass === 3;
    const sound = r.residual < 1e-3 && r.drift < 0.05;
    const dv = base ? r.fitness - base.fitness : 0;
    console.log(
      `${String(r.frac).padStart(4)}   ${main ? '○' : '×'} (${r.d40.toFixed(2)} / ${r.d50.toFixed(2)})` +
        `        ${letter ? '○' : '×'} (${r.letterHit.toFixed(1)})   ${dry ? '○' : '×'}      ` +
        `${sound ? '○' : '×'}    ${dv >= 0 ? '+' : ''}${dv.toFixed(3)}`,
    );
  }
  const winner = rows.find((r) => r.frac > 0 && r.d40 <= 3.0 && r.d50 <= 3.0 && r.dryPass === 3);
  console.log(
    winner
      ? `\n主判定を満たす最小の frac: ${winner.frac}`
      : '\n主判定を満たす frac は無い → 事前登録の棄却条件に該当',
  );
}

void main();
