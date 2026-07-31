// 地域降水診断(地域降水 FB 2026-07-31 R0)。docs/FB_2026-07-31_地域降水.md §4
// 地球の地域座標はこの検証層にのみ置く(src/sim へは一切入れない — 地理中立)。
// 定義は最適化・標準検証の双方からこのモジュールを参照する(複製禁止)。
//
// 扱いの明記(受入条件):
// - 降水は 2° 平年値と比較。モデルは各 2° セルに対応する f×f ブロックの
//   陸セル平均。観測欠損(-9999)月を含む 2° セルは除外。
// - 集計は面積重み(cos 緯度)。セル中心が地域枠 [min, max] 内のセルを対象。
// - 最乾月・最多雨月は「地域平均の月別系列」の最小・最大(セル別ではない)。
// - 気候区分は 1° 観測ラスターとの共通陸セル(モデル陸 ∩ 観測有効)で
//   面積重み付きシェアを比較。
// - この診断は報告専用であり、最適化の目的関数には入れない(凍結維持)。

import type { PipelineResult } from '../src/sim/types';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';
import { areaWeightOfRow, latDegOfRow } from '../src/domain/grid';
import { getClimObs, getKoppenObs, type ClimateFixture, type KoppenFixture } from './scoring';

export interface DiagRegion {
  id: string;
  label: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

// 地域枠は FB「1. 現状の測定結果」の定義どおり
export const DIAG_REGIONS: DiagRegion[] = [
  { id: 'amazon', label: 'アマゾン', latMin: -10, latMax: 5, lonMin: -75, lonMax: -50 },
  { id: 'la_plata', label: 'ラプラタ・アルゼンチン北東部', latMin: -35, latMax: -25, lonMin: -65, lonMax: -55 },
  { id: 'pampa', label: 'パンパ', latMin: -38, latMax: -30, lonMin: -65, lonMax: -55 },
  { id: 'east_china', label: '中国東部', latMin: 25, latMax: 35, lonMin: 105, lonMax: 122 },
  { id: 'south_china', label: '中国南部', latMin: 20, latMax: 27, lonMin: 105, lonMax: 120 },
  { id: 'patagonia_east', label: 'パタゴニア東部', latMin: -50, latMax: -40, lonMin: -72, lonMax: -65 },
];

export interface RegionPrecipDiag {
  id: string;
  label: string;
  /** 地域平均の年降水(mm/年、面積重み) */
  modelAnnualMm: number;
  obsAnnualMm: number;
  ratio: number;
  /** 地域平均月別系列の最乾月・最多雨月(mm/月) */
  modelDriestMm: number;
  obsDriestMm: number;
  modelWettestMm: number;
  obsWettestMm: number;
  /** 地域平均の月別系列(診断用) */
  modelMonthlyMm: number[];
  obsMonthlyMm: number[];
  /** 集計に使った 2° セル数 */
  cells: number;
}

export function regionPrecipDiag(
  result: PipelineResult,
  clim: ClimateFixture = getClimObs(),
): RegionPrecipDiag[] {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const out: RegionPrecipDiag[] = [];
  for (const reg of DIAG_REGIONS) {
    const modelSum = new Array<number>(12).fill(0);
    const obsSum = new Array<number>(12).fill(0);
    let wsum = 0;
    let cells = 0;
    for (let cr = 0; cr < clim.heightCells; cr++) {
      const lat = 89 - cr * 2;
      if (lat < reg.latMin || lat > reg.latMax) continue;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let cc = 0; cc < clim.widthCells; cc++) {
        const lon = -179 + cc * 2;
        if (lon < reg.lonMin || lon > reg.lonMax) continue;
        const ci = cr * clim.widthCells + cc;
        // 観測 12 か月がすべて有効なセルのみ
        let obsOk = true;
        for (let m = 0; m < 12; m++) {
          if ((clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999) < 0) {
            obsOk = false;
            break;
          }
        }
        if (!obsOk) continue;
        // モデル: 対応ブロックの陸セル平均
        const blockMean = new Array<number>(12).fill(0);
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
              blockMean[m] = (blockMean[m] ?? 0) + (result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
            }
          }
        }
        if (n === 0) continue;
        cells++;
        wsum += w;
        for (let m = 0; m < 12; m++) {
          modelSum[m] = (modelSum[m] ?? 0) + (w * (blockMean[m] ?? 0)) / n;
          obsSum[m] = (obsSum[m] ?? 0) + w * (clim.monthlyPrecipitationMm[m]?.[ci] ?? 0);
        }
      }
    }
    const modelMonthlyMm = modelSum.map((v) => v / Math.max(1e-9, wsum));
    const obsMonthlyMm = obsSum.map((v) => v / Math.max(1e-9, wsum));
    const modelAnnualMm = modelMonthlyMm.reduce((a, b) => a + b, 0);
    const obsAnnualMm = obsMonthlyMm.reduce((a, b) => a + b, 0);
    out.push({
      id: reg.id,
      label: reg.label,
      modelAnnualMm: Math.round(modelAnnualMm),
      obsAnnualMm: Math.round(obsAnnualMm),
      ratio: Math.round((modelAnnualMm / Math.max(1e-9, obsAnnualMm)) * 100) / 100,
      modelDriestMm: Math.round(Math.min(...modelMonthlyMm)),
      obsDriestMm: Math.round(Math.min(...obsMonthlyMm)),
      modelWettestMm: Math.round(Math.max(...modelMonthlyMm)),
      obsWettestMm: Math.round(Math.max(...obsMonthlyMm)),
      modelMonthlyMm: modelMonthlyMm.map((v) => Math.round(v * 10) / 10),
      obsMonthlyMm: obsMonthlyMm.map((v) => Math.round(v * 10) / 10),
      cells,
    });
  }
  return out;
}

export interface RegionKoppenDiag {
  id: string;
  label: string;
  /** 面積重み付きシェア %(共通陸セル基準)。上位のみでなく差の大きい順 */
  classSharesModelPct: Array<{ cls: string; pct: number }>;
  classSharesObsPct: Array<{ cls: string; pct: number }>;
  /** 大分類 A〜E のシェア %(モデル / 観測) */
  majorSharesModelPct: number[];
  majorSharesObsPct: number[];
  /** Af+Am シェア %(熱帯雨林診断) */
  afAmModelPct: number;
  afAmObsPct: number;
}

export function regionKoppenDiag(
  result: PipelineResult,
  obs: KoppenFixture = getKoppenObs(),
): RegionKoppenDiag[] {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  const out: RegionKoppenDiag[] = [];
  for (const reg of DIAG_REGIONS) {
    const wModel = new Array<number>(31).fill(0);
    const wObs = new Array<number>(31).fill(0);
    let wTotal = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < reg.latMin || lat > reg.latMax) continue;
      const w = areaWeightOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < reg.lonMin || lon > reg.lonMax) continue;
        const i = row * grid.widthCells + col;
        const o = obs.classRaster[i] ?? 0;
        const m = model[i] ?? 0;
        if (!land[i] || o === 0 || m === 0) continue;
        wTotal += w;
        wModel[m] = (wModel[m] ?? 0) + w;
        wObs[o] = (wObs[o] ?? 0) + w;
      }
    }
    const pct = (x: number) => Math.round((x / Math.max(1e-9, wTotal)) * 1000) / 10;
    const shares = (arr: number[]) =>
      arr
        .map((w2, id) => ({ cls: KOPPEN_CLASSES[id] ?? '?', pct: pct(w2) }))
        .filter((e) => e.pct > 0.5)
        .sort((a, b) => b.pct - a.pct);
    const majors = (arr: number[]) => {
      const acc = new Array<number>(5).fill(0);
      arr.forEach((w2, id) => {
        const mj = majorClassOf(id);
        if (mj >= 0) acc[mj] = (acc[mj] ?? 0) + w2;
      });
      return acc.map(pct);
    };
    out.push({
      id: reg.id,
      label: reg.label,
      classSharesModelPct: shares(wModel),
      classSharesObsPct: shares(wObs),
      majorSharesModelPct: majors(wModel),
      majorSharesObsPct: majors(wObs),
      afAmModelPct: pct((wModel[1] ?? 0) + (wModel[2] ?? 0)),
      afAmObsPct: pct((wObs[1] ?? 0) + (wObs[2] ?? 0)),
    });
  }
  return out;
}
