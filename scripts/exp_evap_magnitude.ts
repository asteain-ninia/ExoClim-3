// 実験: 蒸発冷却の**大きさ**を物理値へ近づけると冷帯の夏は下がるか。
//
// 対応 spec: docs/事前登録_蒸発帰還_2026-08-07.md の続き(置き場所ではなく大きさ)。
//
// なぜこれを試すか(2026-08-07):
//   陰的化(∂LE/∂T を対角へ)は主判定に届かなかった。理由は着想の側:
//   **k·(T − T_ref) は前パスの気温へ引き戻す項**であって、外側の反復が
//   収束すれば消える。冷やす項ではない。
//
//   一方、陽的な係数 `evapCoolingWm2PerMmDay = 4` は潜熱の物理値
//   λρ = 28.4 W/m²/(mm/日) の **1/7** しかない。較正がここへ落ちたのは
//   「陽的な項に大きな係数を入れると振動して成績が落ちる」からだった可能性がある。
//   陰的な項は**振動を抑える安定化装置**としてなら意味を持つので、
//   **大きさと陰的化を組み合わせる**のが筋の通った次の一手になる。
//
// 判定(結果を見る前に固定):
//   主判定 … 40〜50°N と 50〜60°N の最暖月ずれが**両方 +3.0°C 以下**
//   副判定 … 乾燥ゲート 3 件を維持、数値的健全性(残差 < 1e-3、ドリフト < 0.05)
//   棄却   … 下の格子(係数 3 段 × 陰的 2 段)で主判定に届かなければ、
//            「蒸発冷却では冷帯の夏は動かない」と結論して別の機構へ移る
//
// 実行: npx tsx scripts/exp_evap_magnitude.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { evaluateResult } from './optimize_lib';
import { scoreRegionGates } from './scoring';
import { borealMetrics } from './boreal_metrics';
import { openAccel } from './accel_cli';

const COEFS = [4, 12, 28.4];
const FRACS = [0, 1];
const DRY_GATES = ['sahara_arid', 'arabia_arid', 'australia_interior_arid'];

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const accel = await openAccel();
  console.log('係数  陰的  50-60N   40-50N   文字    乾燥  v3       大分類  詳細   年較差  残差');
  try {
    for (const coef of COEFS) {
      for (const frac of FRACS) {
        K.evapCoolingWm2PerMmDay = coef;
        K.evapFeedbackFrac = frac;
        EBM_SOLVER_STATS.maxResidualC = 0;
        EBM_SOLVER_STATS.meanYearDriftC = 0;
        const r = await runPipeline(EARTH_PARAMS, accel.opts);
        const s = evaluateResult(r);
        const b = borealMetrics(r);
        const dry = scoreRegionGates(r).filter((g) => DRY_GATES.includes(g.id) && g.pass).length;
        const d50 = b.dTmaxByBand[50] ?? NaN;
        const d40 = b.dTmaxByBand[40] ?? NaN;
        const ok = d40 <= 3 && d50 <= 3 && dry === 3;
        console.log(
          `${String(coef).padStart(5)} ${String(frac).padStart(5)}  ` +
            `${(d50 >= 0 ? '+' : '') + d50.toFixed(2)}   ${(d40 >= 0 ? '+' : '') + d40.toFixed(2)}   ` +
            `${b.letterHitPct.toFixed(1)}%   ${dry}/3   ${s.fitness.toFixed(3)}  ` +
            `${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ${s.tempRangeRmse.toFixed(2)}  ` +
            `${EBM_SOLVER_STATS.maxResidualC.toExponential(1)} ${ok ? ' ← 主判定○' : ''}`,
        );
      }
    }
  } finally {
    accel.close();
  }
}

void main();
