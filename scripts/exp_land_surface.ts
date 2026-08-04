// 実験: 陸面の水を気温へ繋ぐ 2 経路の効果を実測する。
//
// 対応 spec: docs/spec/01-05_気温.md(EBM)。
//
// 何を測るか:
//   (A) 蒸発冷却 evapCoolingWm2PerMmDay … 実蒸発散の陸平均偏差 × 係数を潜熱として注入
//   (B) 熱容量    landDryCapacityFrac    … 陸の実効熱容量のうち水に依らない割合
//   frac = 1 かつ 係数 = 0 が従来(全球一定の熱容量・潜熱の帰還なし)。
//
// なぜこの 2 つを別々に測るか(2026-08-03 の診断 scripts/diag_range_vs_wetness.ts):
//   最暖月のズレが湿り具合で**符号を変える**
//     砂漠(<100mm)            −5.11°C … 夏が寒すぎる → 熱容量が過大
//     中緯度半乾燥(250〜800mm) +5.00°C … 夏が暑すぎる → 潜熱の逃げ道が無い
//   熱容量は夏冬を対称に効かせるので、片方だけでは両端を直せない。
//   合算して測ると「どちらが効いたか」が分からなくなるため、単独 → 併用の順で測る。
//
// **事前に登録する判定**(結果を見る前に固定する):
//   (A) 成立 … 中緯度半乾燥の最暖月バイアス +5.00°C が縮み、年較差 RMSE が下がる。
//       **かつ降水 RMSE が悪化しない**。悪化するなら 2026-07-30 と同じ
//       「誤差の正帰還」が実 ET でもなお支配的ということで、物理量の
//       取り違えは原因ではなかったことになる(その場合は素直に棄却する)。
//   (B) 成立 … 砂漠の最暖月バイアス −5.11°C が縮み、年較差 RMSE が下がる。
//   併用 成立 … 目的関数 v3 が単独のどちらよりも高い。
//   いずれも **大分類・詳細・ゲートを下げない**ことを条件に加える
//   (年較差だけ良くして気候区分を壊すのでは意味がない)。
//
// 実行: npx tsx scripts/exp_land_surface.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { getClimObs } from './scoring';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const PARAM_PATH = process.argv[2];

/** 診断と同じ層別: 最暖月・最寒月のバイアスを湿り具合の層ごとに出す */
function seasonalBias(result: PipelineResult): {
  desertWarm: number;
  semiAridWarm: number;
  highLatCold: number;
} {
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  let dw = 0,
    dwW = 0,
    sw = 0,
    swW = 0,
    hc = 0,
    hcW = 0;

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const tMon = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            tMon[m] = (tMon[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) tMon[m] = (tMon[m] ?? 0) / n;

      const tObs: number[] = [];
      let pObs = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (t === -9999 || p === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
        pObs += p;
      }
      if (!ok) continue;
      let mWarm = 0;
      let mCold = 0;
      for (let m = 1; m < 12; m++) {
        if (tObs[m]! > tObs[mWarm]!) mWarm = m;
        if (tObs[m]! < tObs[mCold]!) mCold = m;
      }
      const warmBias = tMon[mWarm]! - tObs[mWarm]!;
      const coldBias = tMon[mCold]! - tObs[mCold]!;
      if (pObs < 100) {
        dw += w * warmBias;
        dwW += w;
      }
      if (lat >= 30 && lat < 60 && pObs >= 250 && pObs < 800) {
        sw += w * warmBias;
        swW += w;
      }
      if (lat >= 50) {
        hc += w * coldBias;
        hcW += w;
      }
    }
  }
  return {
    desertWarm: dwW > 0 ? dw / dwW : 0,
    semiAridWarm: swW > 0 ? sw / swW : 0,
    highLatCold: hcW > 0 ? hc / hcW : 0,
  };
}

interface Case {
  label: string;
  evap: number;
  dryFrac: number;
}

const CASES: Case[] = [
  { label: '従来(両方 無効)', evap: 0, dryFrac: 1.0 },
  // (A) 蒸発冷却のみ。物理値 28.4 の 1/7〜2/3 を振る
  { label: 'A 蒸発 4', evap: 4, dryFrac: 1.0 },
  { label: 'A 蒸発 8', evap: 8, dryFrac: 1.0 },
  { label: 'A 蒸発 14', evap: 14, dryFrac: 1.0 },
  { label: 'A 蒸発 20', evap: 20, dryFrac: 1.0 },
  // (B) 熱容量のみ
  { label: 'B 乾燥割合 0.7', evap: 0, dryFrac: 0.7 },
  { label: 'B 乾燥割合 0.5', evap: 0, dryFrac: 0.5 },
  { label: 'B 乾燥割合 0.3', evap: 0, dryFrac: 0.3 },
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
    '\n案                    v3      v2    大分類   詳細  ゲート  気温    年較差  降水   ' +
      '砂漠夏  半乾夏  高緯冬   秒',
  );
  const rows: Array<Record<string, number | string>> = [];
  for (const c of CASES) {
    target.evapCoolingWm2PerMmDay = c.evap;
    target.landDryCapacityFrac = c.dryFrac;
    const t0 = Date.now();
    const accel = await openAccel();
    let result: PipelineResult;
    try {
      result = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const s = evaluateResult(result);
    const b = seasonalBias(result);
    const sec = (Date.now() - t0) / 1000;
    const f = (v: number, d = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
    console.log(
      `${c.label.padEnd(20)} ${s.fitness.toFixed(2).padStart(6)} ${s.fitnessV2.toFixed(2).padStart(6)} ` +
        `${s.majorPct.toFixed(2).padStart(6)} ${s.detailPct.toFixed(2).padStart(6)} ` +
        `${String(s.gates).padStart(4)}  ${s.tempRmse.toFixed(2).padStart(5)} ` +
        `${s.tempRangeRmse.toFixed(2).padStart(6)} ${String(Math.round(s.precipRmse)).padStart(5)}  ` +
        `${f(b.desertWarm).padStart(6)} ${f(b.semiAridWarm).padStart(6)} ${f(b.highLatCold).padStart(6)} ` +
        `${sec.toFixed(0).padStart(5)}`,
    );
    rows.push({
      label: c.label,
      evap: c.evap,
      dryFrac: c.dryFrac,
      fitness: s.fitness,
      fitnessV2: s.fitnessV2,
      majorPct: s.majorPct,
      detailPct: s.detailPct,
      gates: s.gates,
      tempRmse: s.tempRmse,
      tempRangeRmse: s.tempRangeRmse,
      precipRmse: s.precipRmse,
      precipDriestRmse: s.precipDriestRmse,
      tempPhaseRmseDays: s.tempPhaseRmseDays,
      desertWarm: b.desertWarm,
      semiAridWarm: b.semiAridWarm,
      highLatCold: b.highLatCold,
      sec,
    });
    fs.mkdirSync('out/exp', { recursive: true });
    fs.writeFileSync('out/exp/land_surface.json', JSON.stringify(rows, null, 1));
  }
}

void main();
