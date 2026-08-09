// 実験: 保存型での雲底下の再蒸発(virga)を測り直す。
//
// 対応 spec: docs/計画_保存則の段階的置換_2026-08-09.md
//
// なぜ「測り直す」なのか:
//   virga は非保存のモデルで一度試して採らなかった(`exp_dry_air.ts`、
//   `subCloudEvapCoef: 0` のまま。探索空間にも入っていない)。
//   非保存の実装では、雲底下で蒸発した水を**虚無へ消していた** —
//   つまり「乾燥地の降水を減らすだけ」の機構で、減らした分の行き先が無かった。
//
//   保存型では消せない。蒸発した水は気柱に残り、風下へ運ばれて別の場所で降る。
//   **乾燥地を乾かしつつ、その水を湿潤地へ回す**という別の機構になる。
//   だから結論が変わりうる。
//
// 実装上の注意(隠しパラメータを作らないため):
//   失われる割合は降水量に依存する(弱い雨ほど多く失われる)ので、
//   凝結率を下げて解き直す外側反復になっている。**反復数と減衰が答えを
//   決めてはならない**ので、未収束の月数を必ず出す。
//
// 相対湿度は保存型では W/W_sat で直接得られる(供給の代用ではなく、
// 輸送が解いた水蒸気量そのもの)。W_sat は evaporation.ts の飽和可降水量。
//
// 判定(先に固定する):
//   1. 水が閉じたままか（virga は水を消さないので閉包は 0 のはず）
//   2. 外側反復が収束しているか
//   3. 陸平均降水が観測(794)へ寄るか
//   4. 詳細一致率と降水の季節位相
//
// 実行: npx tsx scripts/exp_conservative_virga.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { computeOceanEvaporation } from '../src/sim/evaporation';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const COEFS = [0, 0.5, 1.0, 2.0];

function means(
  r: PipelineResult,
  monthly: Float32Array[],
): { land: number; ocean: number; global: number } {
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  let wl = 0, el = 0, wo = 0, eo = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = 90 - (row + 0.5) * grid.resolutionDeg;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      let sum = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) sum += monthly[m]?.[i] ?? 0;
      if (land[i]) { wl += w; el += w * sum; } else { wo += w; eo += w * sum; }
    }
  }
  const lm = wl > 0 ? el / wl : 0;
  const om = wo > 0 ? eo / wo : 0;
  const f = wl / Math.max(1e-9, wl + wo);
  return { land: lm, ocean: om, global: f * lm + (1 - f) * om };
}

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  K.conservativeMoisture = 1;
  console.log('係数    閉包     輸送  virga  v3      大分類  詳細   位相   陸降水  海降水');
  for (const c of COEFS) {
    K.subCloudEvapCoef = c;
    const accel = await openAccel(true);
    let r: PipelineResult;
    try {
      r = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const P = means(r, r.precipitation.monthlyPrecipMm);
    const ev = computeOceanEvaporation(r.context, r.temperature, r.airflow);
    const et = r.precipitation.land?.monthlyEtMm ?? [];
    const grid = r.context.grid;
    const land = r.context.terrain.landMask;
    const src: Float32Array[] = [];
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const f = new Float32Array(grid.cellCount);
      for (let i = 0; i < grid.cellCount; i++)
        f[i] = land[i] ? (et[m]?.[i] ?? 0) : (ev.monthlyOceanEvapMm[m]?.[i] ?? 0);
      src.push(f);
    }
    const E = means(r, src);
    const closure = E.global > 0 ? ((P.global - E.global) / E.global) * 100 : NaN;
    const s = evaluateResult(r);
    const fs = fieldScore(r, getClimObs());
    console.log(
      `${c.toFixed(1).padStart(4)}  ${closure.toFixed(1).padStart(6)}%  ` +
        `${CONSERVATIVE_STATS.nonConverged === 0 ? ' ○ ' : ' × '}  ` +
        `${CONSERVATIVE_STATS.virgaNonConverged === 0 ? ' ○ ' : ' × '}  ` +
        `${s.fitness.toFixed(3)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
        `${fs.precipPhaseRmseDays.toFixed(1)}  ${Math.round(fs.landMeanModelMm).toString().padStart(5)}   ` +
        `${Math.round(P.ocean).toString().padStart(5)}`,
    );
  }
  console.log(
    '\n読み方: 係数 0 が保存型の基準線。**閉包が 0 のままであること**が前提で、' +
      '\n        陸降水が観測 794 へ寄り、詳細と位相が改善するなら採る。',
  );
}

void main();
