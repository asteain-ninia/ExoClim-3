// P1-2(FB 2026-07-31): 固定セル半径 → 角距離基準。
// 旧実装(±6/±3 セル)は 0.5°/2° で探索距離が 4 倍変わった。
// 本テストは「同じ角距離の地形を 0.5°/1°/2° で評価して同じ判定になる」ことを
// 直接検査する(旧実装ではオーシャン +6° は 0.5° で見つからず、+8° は 2° で
// 見つかってしまい、いずれも FAIL する)。

import { describe, expect, it } from 'vitest';
import { createGrid } from '../../../src/domain/grid';
import type { SimContext } from '../../../src/sim/types';
import {
  COLD_COAST_SEARCH_RADIUS_DEG,
  WARM_OCEAN_SEARCH_RADIUS_DEG,
  nearestOceanAnomaly,
  nearestOceanTempC,
  searchRadiusCells,
} from '../../../src/sim/step06_precipitation';

function makeCtx(resolutionDeg: number, oceanOffsetsDeg: number[]): {
  ctx: SimContext;
  row: number;
  col: number;
  tField: Float32Array;
  sstAnomalyC: Float32Array;
} {
  const grid = createGrid(resolutionDeg);
  const land = new Uint8Array(grid.cellCount).fill(1);
  const tField = new Float32Array(grid.cellCount);
  const sstAnomalyC = new Float32Array(grid.cellCount);
  const row = Math.floor(grid.heightCells / 2); // 赤道直近の行
  const col = Math.floor(grid.widthCells / 2);
  for (const offDeg of oceanOffsetsDeg) {
    const oc = col + Math.round(offDeg / resolutionDeg);
    const oi = row * grid.widthCells + oc;
    land[oi] = 0;
    tField[oi] = 20;
    sstAnomalyC[oi] = -2;
  }
  const ctx = { grid, terrain: { landMask: land } } as unknown as SimContext;
  return { ctx, row, col, tField, sstAnomalyC };
}

describe('探索半径の角距離基準化(P1-2)', () => {
  it('角半径 → セル数の換算(1° は旧実装と同一の 6/3 セル)', () => {
    expect(searchRadiusCells(1, WARM_OCEAN_SEARCH_RADIUS_DEG)).toBe(6);
    expect(searchRadiusCells(0.5, WARM_OCEAN_SEARCH_RADIUS_DEG)).toBe(12);
    expect(searchRadiusCells(2, WARM_OCEAN_SEARCH_RADIUS_DEG)).toBe(3);
    expect(searchRadiusCells(1, COLD_COAST_SEARCH_RADIUS_DEG)).toBe(3);
    expect(searchRadiusCells(0.5, COLD_COAST_SEARCH_RADIUS_DEG)).toBe(6);
    expect(searchRadiusCells(2, COLD_COAST_SEARCH_RADIUS_DEG)).toBe(2);
  });

  it('暖海探索: +6° の海は全解像度で見つかり、+8° は全解像度で見つからない', () => {
    for (const res of [0.5, 1, 2]) {
      const near = makeCtx(res, [6]);
      expect(nearestOceanTempC(near.ctx, near.tField, near.row, near.col)).toBe(20);
      const far = makeCtx(res, [8]);
      expect(nearestOceanTempC(far.ctx, far.tField, far.row, far.col)).toBeNull();
    }
  });

  it('寒流沿岸探索: +2° の寒水は全解像度で拾い、+6° は拾わない', () => {
    for (const res of [0.5, 1, 2]) {
      const near = makeCtx(res, [2]);
      expect(
        nearestOceanAnomaly(near.ctx, { sstAnomalyC: near.sstAnomalyC } as never, near.row, near.col),
      ).toBe(-2);
      const far = makeCtx(res, [6]);
      expect(
        nearestOceanAnomaly(far.ctx, { sstAnomalyC: far.sstAnomalyC } as never, far.row, far.col),
      ).toBe(0);
    }
  });
});
