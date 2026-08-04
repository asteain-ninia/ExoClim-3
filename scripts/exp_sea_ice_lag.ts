// 実験: 海氷の断熱が遅れて効いていることが、高緯度の季節の遅れの原因か。
//
// 対応 spec: docs/spec/05_気温.md。診断は docs/実験記録_高緯度の冬_2026-08-04.md。
//
// 測っている症状(50°N 以北の陸、モデル − 観測):
//   秋 9〜12月 +8.1 / +10.7 / +11.9 / +10.2 °C   ← 冷えるのが遅い
//   春 3〜4月  −3.8 / −3.2 °C                     ← 暖まるのも遅い
//   沿岸(海から 0〜3 セル)で冬 +11.34°C、内陸奥で冬 −10.14°C
//   北極(海氷)は暖かすぎ、南極(陸氷)は寒すぎる
//
// 仮説: iceW は**その時刻の気温だけ**の関数で氷厚の記憶が無いため、
//   海が「−1.9°C を下回ってから」しか断熱を始めない。混合層の熱容量を
//   持ったまま秋を過ごすので冷えるのが遅れる。
//
// 触る量(どちらもその惑星の物理量で、地球の座標は入らない):
//   seaFreezeC        … 結氷の閾値。早く凍れば早く断熱が始まる
//   iceRampWidthC     … 断熱の立ち上がりの鋭さ。狭いほど急に切り替わる
//   seaIceInsulationFactor … 断熱の強さ(既に 0.95 で上限近い)
//
// **事前に登録する判定**:
//   成立 … 秋(10〜11月)の +10〜+12°C が縮み、**同時に**春(3〜4月)の
//     −3〜−4°C も縮む。両方が同時に縮むことが条件 — 片方だけなら
//     位相ではなく水準を動かしただけである。
//     加えて大分類・詳細・ゲートを下げないこと。
//   不成立 … 秋は縮むが春が悪化する。その場合は氷厚の記憶が要るという結論に
//     なる(2026-07-30 の双安定を避ける形での再設計)。
//
// 実行: npx tsx scripts/exp_sea_ice_lag.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { getClimObs } from './scoring';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const PARAM_PATH = process.argv[2];
const MONTHS = 12;

/** 50°N 以北の陸の月別バイアス(面積重み、観測 2° へ集約) */
function northMonthlyBias(result: PipelineResult): number[] {
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const sum = new Array<number>(MONTHS).fill(0);
  let wsum = 0;
  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    if (lat < 50) continue;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const obs: number[] = [];
      let ok = true;
      for (let m = 0; m < MONTHS; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (t === -9999) {
          ok = false;
          break;
        }
        obs.push(t / 10);
      }
      if (!ok) continue;
      const model = new Array<number>(MONTHS).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < MONTHS; m++) {
            model[m] = (model[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < MONTHS; m++) sum[m] = (sum[m] ?? 0) + w * (model[m]! / n - obs[m]!);
      wsum += w;
    }
  }
  return sum.map((v) => v / Math.max(1e-9, wsum));
}

interface Case {
  label: string;
  seaFreezeC: number;
  iceRampWidthC: number;
}

const CASES: Case[] = [
  { label: '現行', seaFreezeC: -1.9, iceRampWidthC: 5 },
  { label: 'ランプ狭 2', seaFreezeC: -1.9, iceRampWidthC: 2 },
  { label: 'ランプ狭 1', seaFreezeC: -1.9, iceRampWidthC: 1 },
  { label: '結氷 +1.0', seaFreezeC: 1.0, iceRampWidthC: 5 },
  { label: '結氷 +1.0 ランプ 2', seaFreezeC: 1.0, iceRampWidthC: 2 },
  { label: '結氷 +3.0 ランプ 2', seaFreezeC: 3.0, iceRampWidthC: 2 },
];

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`出発点のパラメータ: ${PARAM_PATH}`);
  }
  const target = MODEL_CONSTANTS as unknown as Record<string, number>;

  console.log(
    '\n案                     v3    大分類   詳細  ゲート  秋(10-11月)  春(3-4月)  年較差  位相',
  );
  for (const c of CASES) {
    target.seaFreezeC = c.seaFreezeC;
    target.iceRampWidthC = c.iceRampWidthC;
    const accel = await openAccel();
    let result: PipelineResult;
    try {
      result = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const s = evaluateResult(result);
    const b = northMonthlyBias(result);
    const autumn = ((b[9] ?? 0) + (b[10] ?? 0)) / 2;
    const spring = ((b[2] ?? 0) + (b[3] ?? 0)) / 2;
    const f2 = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`.padStart(8);
    console.log(
      `${c.label.padEnd(20)} ${s.fitness.toFixed(2).padStart(6)} ` +
        `${s.majorPct.toFixed(2).padStart(6)} ${s.detailPct.toFixed(2).padStart(6)} ` +
        `${String(s.gates).padStart(4)}  ${f2(autumn)} °C ${f2(spring)} °C ` +
        `${s.tempRangeRmse.toFixed(2).padStart(6)} ${s.tempPhaseRmseDays.toFixed(1).padStart(6)}日`,
    );
  }
  console.log(
    '\n判定: 秋の +10〜+12°C と春の −3〜−4°C が**両方とも**縮めば位相が直っている。' +
      '\n      片方だけなら水準を動かしただけ。大分類・詳細・ゲートを下げないこと。',
  );
}

void main();
