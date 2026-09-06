// 水蒸気の 2 層化(段 L-0、docs/計画_水蒸気の2層化_2026-09-06.md)の受入条件:
//   1. 交換率 0・境界層の飽和割合 1 なら、単層の解と**ビット一致**する(自由対流圏は空)。
//   2. 交換ありでも、全球で 源 = 境界層の凝結 + 自由対流圏の凝結 が閉じる
//      (8/4 の鉛直輸出が「返し先が無い」で漏らした水を、もう一方の層が受ける)。
//   3. パイプライン既定(moistureLayerSplit = 0)は 2 層の配線を通らず結果が変わらない
//      (フラグ 1・交換 0・飽和割合 1 のときも降水がビット一致する)。
import { describe, expect, it } from 'vitest';
import { createGrid, latDegOfRow } from '../../../src/domain/grid';
import { EARTH_PARAMS } from '../../../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../../../src/sim/constants';
import {
  solveMoistureTransport,
  solveTwoLayerTransport,
} from '../../../src/sim/moisture_transport';
import { runPipeline } from '../../../src/sim/pipeline';

const R_KM = 6371;

function synthetic(grid: ReturnType<typeof createGrid>) {
  const n = grid.cellCount;
  const src = new Float32Array(n);
  const rate = new Float32Array(n);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const sUp = new Float32Array(n);
  const sDn = new Float32Array(n);
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const c = Math.max(0, Math.cos((lat * Math.PI) / 180));
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      src[i] = 120 * c;
      rate[i] = 6 + 3 * Math.cos((col * Math.PI) / 45);
      u[i] = 6 * (1 + 0.3 * Math.sin((row * Math.PI) / 9));
      v[i] = 2 * Math.cos((col * Math.PI) / 30);
      // 収束域(sUp)と発散域(sDn)を経度で交互に
      const phase = Math.sin((col * Math.PI) / 15);
      sUp[i] = 0.8 * Math.max(0, phase);
      sDn[i] = 0.8 * Math.max(0, -phase);
    }
  }
  return { src, rate, u, v, sUp, sDn };
}

function areaSum(grid: ReturnType<typeof createGrid>, a: ArrayLike<number>): number {
  let s = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = Math.max(0, Math.cos((latDegOfRow(grid, row) * Math.PI) / 180));
    for (let col = 0; col < grid.widthCells; col++) s += w * (a[row * grid.widthCells + col] ?? 0);
  }
  return s;
}

describe('水蒸気の 2 層化(段 L-0)', () => {
  it('交換率 0 なら単層の解とビット一致し、自由対流圏は空', () => {
    const grid = createGrid(4);
    const { src, rate, u, v } = synthetic(grid);
    const zero = new Float32Array(grid.cellCount);
    const single = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
      tolerance: 1e-7,
      maxIterations: 3000,
      diffusivityM2PerS: 1e6,
    });
    const two = solveTwoLayerTransport(
      grid,
      R_KM,
      { u, v },
      { u, v },
      src,
      { condensationRatePerMonth: rate },
      { condensationRatePerMonth: rate },
      zero,
      zero,
      { tolerance: 1e-7, maxIterations: 3000, diffusivityM2PerS: 1e6 },
    );
    expect(two.converged).toBe(true);
    expect(two.passes).toBe(1);
    expect(two.waterFreeMm.every((x) => x === 0)).toBe(true);
    for (let i = 0; i < grid.cellCount; i++) {
      expect(two.condensationMm[i]).toBe(single.condensationMm[i]);
      expect(two.waterBoundaryMm[i]).toBe(single.waterMm[i]);
    }
  });

  it('交換ありでも 源 = 境界層の凝結 + 自由対流圏の凝結 が全球で閉じる(≤ 1e-4)', () => {
    const grid = createGrid(4);
    const { src, rate, u, v, sUp, sDn } = synthetic(grid);
    // 自由対流圏は境界層より速く西へ流れる(気柱輸送風の代わり)
    const uf = new Float32Array(u.length);
    for (let i = 0; i < u.length; i++) uf[i] = (u[i] ?? 0) * 1.8;
    const rateF = new Float32Array(rate.length);
    for (let i = 0; i < rate.length; i++) rateF[i] = (rate[i] ?? 0) * 0.3;
    const two = solveTwoLayerTransport(
      grid,
      R_KM,
      { u, v },
      { u: uf, v },
      src,
      { condensationRatePerMonth: rate },
      { condensationRatePerMonth: rateF },
      sUp,
      sDn,
      { maxIterations: 4000, diffusivityM2PerS: 1e6, layerTolerance: 1e-6, maxPasses: 60 },
    );
    expect(two.converged).toBe(true);
    expect(two.nonConvergedSolves).toBe(0);
    const s = areaSum(grid, src);
    const p = areaSum(grid, two.condensationMm);
    expect(Math.abs(s - p) / s).toBeLessThanOrEqual(1e-4);
    // 交換が実際に起きている(自由対流圏に水がある)
    expect(areaSum(grid, two.waterFreeMm)).toBeGreaterThan(0);
    // 負の水は作らない
    expect(two.waterMm.every((x) => x >= 0)).toBe(true);
  });

  it(
    'パイプライン: フラグ 1・交換 0・境界層の飽和割合 1 は既定(単層)と降水がビット一致する(地球 2°)',
    async () => {
      const P2 = { ...EARTH_PARAMS, gridResolutionDeg: 2 };
      const K = MODEL_CONSTANTS as unknown as Record<string, number>;
      const saved = {
        moistureLayerSplit: K['moistureLayerSplit'] ?? 0,
        layerExchangeUpPerConv: K['layerExchangeUpPerConv'] ?? 0,
        layerExchangeDownPerDiv: K['layerExchangeDownPerDiv'] ?? 0,
        layerBackgroundMixPerMonth: K['layerBackgroundMixPerMonth'] ?? 0,
        boundaryLayerSatFrac: K['boundaryLayerSatFrac'] ?? 0.6,
      };
      try {
        expect(saved.moistureLayerSplit).toBe(0);
        const base = await runPipeline(P2);
        K['moistureLayerSplit'] = 1;
        K['layerExchangeUpPerConv'] = 0;
        K['layerExchangeDownPerDiv'] = 0;
        K['layerBackgroundMixPerMonth'] = 0;
        K['boundaryLayerSatFrac'] = 1;
        const split = await runPipeline(P2);
        for (let m = 0; m < 12; m++) {
          const a = base.precipitation.monthlyPrecipMm[m]!;
          const b = split.precipitation.monthlyPrecipMm[m]!;
          expect(b.length).toBe(a.length);
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) throw new Error(`月 ${m} セル ${i}: 単層 ${a[i]} 2 層 ${b[i]}`);
          }
        }
      } finally {
        Object.assign(K, saved);
      }
    },
    600_000,
  );
});
