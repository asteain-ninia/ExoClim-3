// 診断: 風向の季節反転(Ramage 型)は、湿らせたい地域と乾かしたい地域を判別するか。
//
// 対応 spec: なし(R5 の設計判断)。
// 前提: docs/実験記録_温帯の因子分解_2026-08-08.md、外部レビュー(Codex 2026-08-09)
//
// なぜこれを測るか:
//   R4(水蒸気フラックス収束)は「供給場 q が水蒸気量ではなく到達可能性」で棄却された。
//   季節比 q(夏)/q(年) も実測で判別できなかった(東アジア 1.97 に対し豪州 1.75・
//   サハラ 1.67 で重なり、シベリアが 2.2〜2.4 と最も高い)。
//
//   **どちらも q を使ったから壊れている。** ならば q を一切使わない量で測る。
//   古典的なモンスーン指数(Ramage 1971)は風だけで定義される:
//     1 月と 7 月の卓越風向が 120° 以上変わり、かつ両月とも風速が十分ある。
//   これに「夏の風上が海であること」を足せば、
//   **海から陸へ吹く季節風**という定義になる。q の型の問題に免疫がある。
//
// 測る量(地域ゲートの枠ごと、陸セルの面積重み平均):
//   反転角      … 冬の平均風ベクトルと夏の平均風ベクトルのなす角(度)
//   夏の海率    … 夏の風上 500km を辿ったときに海だったセルの割合
//   冬の海率    … 同(冬)
//   海率の反転  … 夏の海率 − 冬の海率(**これがモンスーンの本体**)
//   夏の風速    … 反転しても弱ければモンスーンではない
//
// 実行: npx tsx scripts/diag_wind_reversal.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow, lonDegOfCol, cellWidthKm, cellHeightKm, wrapCol } from '../src/domain/grid';
import { REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const TRACE_KM = 500;
const STEP_KM = 50;

const WANT: Record<string, string> = {
  east_asia_humid: '湿らせたい',
  india_tropical: '湿らせたい',
  tibet_cold_highland: '湿らせたい',
  us_southeast_humid: '維持(湿)',
  amazon_tropical: '維持(湿)',
  congo_tropical: '維持(湿)',
  west_europe_temperate: '維持(湿)',
  sahara_arid: '乾燥維持',
  arabia_arid: '乾燥維持',
  australia_interior_arid: '乾燥維持',
  patagonia_rainshadow: '乾かしたい',
  mediterranean_cs_present: '夏乾燥',
  california_cs_present: '夏乾燥',
};

/** 風上へ TRACE_KM 辿り、海だったセルの割合を返す(0〜1)。風が弱ければ NaN */
function upwindOceanFrac(
  result: PipelineResult,
  m: number,
  row: number,
  col: number,
): number {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const u = result.airflow.monthlyWindU[m];
  const v = result.airflow.monthlyWindV[m];
  const i0 = row * grid.widthCells + col;
  const uu = u?.[i0] ?? 0;
  const vv = v?.[i0] ?? 0;
  const spd = Math.hypot(uu, vv);
  if (spd < 0.5) return Number.NaN;
  const dxKm = Math.max(20, cellWidthKm(grid, row, result.context.params.body.radiusKm));
  const dyKm = cellHeightKm(grid, result.context.params.body.radiusKm);
  let x = col + 0.5;
  let y = row + 0.5;
  let ocean = 0;
  let n = 0;
  const steps = Math.round(TRACE_KM / STEP_KM);
  for (let s = 0; s < steps; s++) {
    // **風上** = 風向の逆へ進む
    x -= ((uu / spd) * STEP_KM) / dxKm;
    y += ((vv / spd) * STEP_KM) / dyKm; // v は北向き正、row は南向き増
    const r = Math.round(y - 0.5);
    if (r < 0 || r >= grid.heightCells) break;
    const c = wrapCol(grid, Math.round(x - 0.5));
    n++;
    if (!land[r * grid.widthCells + c]) ocean++;
  }
  return n > 0 ? ocean / n : Number.NaN;
}

async function main(): Promise<void> {
  const accel = await openAccel();
  let result: PipelineResult;
  try {
    result = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;

  console.log('風だけで作るモンスーン指数(陸セルの面積重み平均)\n');
  console.log(
    '地域                     狙い        反転角  夏の海率  冬の海率  海率の反転  夏の風速',
  );

  for (const g of REGION_GATES) {
    const latC = (g.latMin + g.latMax) / 2;
    const summer = latC >= 0 ? [5, 6, 7] : [11, 0, 1];
    const winter = latC >= 0 ? [11, 0, 1] : [5, 6, 7];
    let w = 0;
    let angSum = 0;
    let sOcean = 0;
    let sOceanW = 0;
    let wOcean = 0;
    let wOceanW = 0;
    let sSpd = 0;

    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < g.latMin || lat > g.latMax) continue;
      const cw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = lonDegOfCol(grid, col);
        if (lon < g.lonMin || lon > g.lonMax) continue;
        const i = row * grid.widthCells + col;
        if (!land[i]) continue;

        // 季節平均の風ベクトル
        const mean = (ms: number[]): [number, number] => {
          let a = 0;
          let b = 0;
          for (const m of ms) {
            a += result.airflow.monthlyWindU[m]?.[i] ?? 0;
            b += result.airflow.monthlyWindV[m]?.[i] ?? 0;
          }
          return [a / ms.length, b / ms.length];
        };
        const [su, sv] = mean(summer);
        const [wu, wv] = mean(winter);
        const sMag = Math.hypot(su, sv);
        const wMag = Math.hypot(wu, wv);
        if (sMag < 0.2 || wMag < 0.2) continue;
        const cosA = (su * wu + sv * wv) / (sMag * wMag);
        const ang = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;

        w += cw;
        angSum += cw * ang;
        sSpd += cw * sMag;
        for (const m of summer) {
          const f = upwindOceanFrac(result, m, row, col);
          if (Number.isFinite(f)) {
            sOcean += cw * f;
            sOceanW += cw;
          }
        }
        for (const m of winter) {
          const f = upwindOceanFrac(result, m, row, col);
          if (Number.isFinite(f)) {
            wOcean += cw * f;
            wOceanW += cw;
          }
        }
      }
    }
    if (w <= 0) continue;
    const so = sOceanW > 0 ? sOcean / sOceanW : NaN;
    const wo = wOceanW > 0 ? wOcean / wOceanW : NaN;
    console.log(
      `${g.id.padEnd(24)} ${(WANT[g.id] ?? '—').padEnd(10)} ` +
        `${(angSum / w).toFixed(0).padStart(5)}°  ${so.toFixed(3).padStart(7)}  ${wo.toFixed(3).padStart(7)}  ` +
        `${((so - wo) >= 0 ? '+' : '') + (so - wo).toFixed(3).padStart(8)}  ${(sSpd / w).toFixed(2).padStart(7)} m/s`,
    );
  }

  console.log(
    '\n読み方:\n' +
      '  **海率の反転(夏の海率 − 冬の海率)がモンスーンの本体。**\n' +
      '  湿らせたい地域で大きく、乾燥維持したい地域で小さければ判別できる。\n' +
      '  反転角が大きくても、夏の風上が陸なら水は来ない(アラビアの Shamal 型)。\n' +
      '  この量は q を一切使わないので、R4 を殺した「到達可能性」型の問題に免疫がある。',
  );
}

void main();
