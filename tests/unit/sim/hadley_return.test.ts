// 段 L-4a(docs/計画_2層化の段L-4_自由対流圏の風場_2026-09-10.md): 自由対流圏のハドレー戻り流の帯の型。
//   1. 振幅 0 なら与えた風をそのまま返す(既定でビット一致)。
//   2. 帯の中は極向き(北半球で正・南半球で負)、赤道と帯の端で 0、端の半分で最大 = 振幅。
//   3. 帯の外は与えた風のまま(押し返しを残す)。
import { describe, expect, it } from 'vitest';
import { createGrid, latDegOfRow } from '../../../src/domain/grid';
import { hadleyReturnMeridionalWind } from '../../../src/sim/step06_precipitation';

describe('段 L-4a: ハドレー戻り流の帯の型', () => {
  const grid = createGrid(2);
  const vCol = new Float32Array(grid.cellCount);
  for (let i = 0; i < vCol.length; i++) vCol[i] = -3 + (i % 7);

  it('振幅 0 なら同じ配列を返す', () => {
    expect(hadleyReturnMeridionalWind(grid, 30, 30, 0, vCol)).toBe(vCol);
  });

  it('帯の中は極向きで、赤道と端で 0、端の半分で振幅', () => {
    const out = hadleyReturnMeridionalWind(grid, 30, 30, 2, vCol);
    const at = (lat: number) => {
      let best = 0;
      let bestD = 1e9;
      for (let row = 0; row < grid.heightCells; row++) {
        const d = Math.abs(latDegOfRow(grid, row) - lat);
        if (d < bestD) {
          bestD = d;
          best = row;
        }
      }
      return out[best * grid.widthCells + 5]!;
    };
    // 2° 格子の赤道に最も近い行は ±1°: 2·sin(π/30) = 0.21
    expect(Math.abs(at(0))).toBeLessThan(0.25);
    expect(at(15)).toBeCloseTo(2, 1);
    expect(at(-15)).toBeCloseTo(-2, 1);
    expect(at(8)).toBeGreaterThan(0);
    expect(at(-8)).toBeLessThan(0);
    expect(Math.abs(at(29))).toBeLessThan(0.3);
  });

  it('帯の外は与えた風のまま', () => {
    const out = hadleyReturnMeridionalWind(grid, 30, 30, 2, vCol);
    for (let row = 0; row < grid.heightCells; row++) {
      if (Math.abs(latDegOfRow(grid, row)) < 30) continue;
      for (let col = 0; col < grid.widthCells; col += 17) {
        const i = row * grid.widthCells + col;
        expect(out[i]).toBe(vCol[i]);
      }
    }
  });
});
