// P1-2 + 変更レビュー FB P2-3: 探索半径は球面上の角距離(円形マスク)。
// - 赤道と 60° 緯度で同じ角距離判定(60° では同じ半径がより多くの経度列に届く)
// - 対角方向でも半径内外が正しい(旧: 正方窓の対角は半径超過を拾っていた)
// - 2° 格子の 3° 半径が 4° 地点を拾わない(旧: round(1.5)=2 セル窓が拾った)
// - 0.5°/1°/2° で境界判定が一致

import { describe, expect, it } from 'vitest';
import { createGrid } from '../../../src/domain/grid';
import type { SimContext } from '../../../src/sim/types';
import {
  COLD_COAST_SEARCH_RADIUS_DEG,
  WARM_OCEAN_SEARCH_RADIUS_DEG,
  forEachCellWithinAngularRadius,
  nearestOceanAnomaly,
  nearestOceanTempC,
} from '../../../src/sim/step06_precipitation';

function makeCtx(
  resolutionDeg: number,
  centerLatDeg: number,
  oceanOffsets: Array<{ dLatDeg?: number; dLonDeg?: number }>,
): {
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
  const row = Math.round((90 - centerLatDeg) / resolutionDeg - 0.5);
  const col = Math.floor(grid.widthCells / 2);
  for (const off of oceanOffsets) {
    const r = row - Math.round((off.dLatDeg ?? 0) / resolutionDeg);
    const c = col + Math.round((off.dLonDeg ?? 0) / resolutionDeg);
    const oi = r * grid.widthCells + c;
    land[oi] = 0;
    tField[oi] = 20;
    sstAnomalyC[oi] = -2;
  }
  const ctx = { grid, terrain: { landMask: land } } as unknown as SimContext;
  return { ctx, row, col, tField, sstAnomalyC };
}

describe('探索半径の球面角距離化(P2-3)', () => {
  it('定数は仕様どおり(暖海 6° / 寒流 3°)', () => {
    expect(WARM_OCEAN_SEARCH_RADIUS_DEG).toBe(6);
    expect(COLD_COAST_SEARCH_RADIUS_DEG).toBe(3);
  });

  it('赤道: 経度 +6° は全解像度で拾い、+8° は拾わない', () => {
    for (const res of [0.5, 1, 2]) {
      const near = makeCtx(res, res / 2, [{ dLonDeg: 6 }]);
      expect(nearestOceanTempC(near.ctx, near.tField, near.row, near.col)).toBe(20);
      const far = makeCtx(res, res / 2, [{ dLonDeg: 8 }]);
      expect(nearestOceanTempC(far.ctx, far.tField, far.row, far.col)).toBeNull();
    }
  });

  it('60° 緯度: 経度 10 列(見かけ 10° = 角距離 ~5°)を拾う — 旧正方窓は見失う', () => {
    const { ctx, row, col, tField } = makeCtx(1, 60.5, [{ dLonDeg: 10 }]);
    expect(nearestOceanTempC(ctx, tField, row, col)).toBe(20);
  });

  it('対角: 赤道の (4°, 5°) は距離 ~6.4° で半径 6° の外 — 旧正方窓は誤って拾う', () => {
    const { ctx, row, col, tField } = makeCtx(1, 0.5, [{ dLatDeg: 4, dLonDeg: 5 }]);
    expect(nearestOceanTempC(ctx, tField, row, col)).toBeNull();
    // 同じ対角でも (3°, 4°) = 5° は半径内
    const inCase = makeCtx(1, 0.5, [{ dLatDeg: 3, dLonDeg: 4 }]);
    expect(nearestOceanTempC(inCase.ctx, inCase.tField, inCase.row, inCase.col)).toBe(20);
  });

  it('寒流 3°: 2° 格子で 4° 地点を拾わない(旧 round(1.5)=2 セル窓の是正)', () => {
    for (const res of [0.5, 1, 2]) {
      const near = makeCtx(res, 30 + res / 2, [{ dLonDeg: 2 }]);
      expect(
        nearestOceanAnomaly(near.ctx, { sstAnomalyC: near.sstAnomalyC } as never, near.row, near.col),
      ).toBe(-2);
      const far = makeCtx(res, 30 + res / 2, [{ dLonDeg: 4 }]);
      expect(
        nearestOceanAnomaly(far.ctx, { sstAnomalyC: far.sstAnomalyC } as never, far.row, far.col),
      ).toBe(0);
    }
  });

  it('列挙の内部整合: 全候補が半径内で、重複がない', () => {
    const grid = createGrid(1);
    const seen = new Set<number>();
    const row = 29; // 60.5°N
    const col = 180;
    forEachCellWithinAngularRadius(grid, row, col, 6, (i) => {
      expect(seen.has(i)).toBe(false);
      seen.add(i);
      const r = Math.floor(i / grid.widthCells);
      const c = i % grid.widthCells;
      const lat0 = 90 - (row + 0.5);
      const lat1 = 90 - (r + 0.5);
      const dPhi = lat1 - lat0;
      let dCol = Math.abs(c - col);
      dCol = Math.min(dCol, grid.widthCells - dCol);
      const cosMid = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
      const d = Math.hypot(dPhi, dCol * cosMid);
      expect(d).toBeLessThanOrEqual(6 + 1e-6);
    });
    expect(seen.size).toBeGreaterThan(80); // 円形マスクとして十分な候補数
  });
});
