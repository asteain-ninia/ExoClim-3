// P0-1(FB 2026-07-31): 手続き地形の解像度不変性。
// 表示解像度は「同じ連続ノイズ場の標本密度」だけを変え、惑星を変えてはならない。

import { describe, expect, it } from 'vitest';
import { createGrid, areaWeightOfRow } from '@/domain/grid';
import { resolveTerrain } from '@/domain/terrain';
import type { TerrainSource } from '@/domain/planetParams';

const proc = (seed: number): TerrainSource => ({
  kind: 'procedural',
  seed,
  landFraction: 0.3,
  reliefScale: 1,
});

function landAreaFrac(res: number, seed: number): number {
  const grid = createGrid(res);
  const t = resolveTerrain(grid, proc(seed));
  let land = 0;
  let total = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      total += w;
      if (t.landMask[row * grid.widthCells + col]) land += w;
    }
  }
  return land / total;
}

/** 細かい解像度の landMask を粗い格子へ集約(陸率 ≥ 0.5 で陸) */
function aggregateLand(fineRes: number, coarseRes: number, seed: number): Uint8Array {
  const fine = createGrid(fineRes);
  const coarse = createGrid(coarseRes);
  const t = resolveTerrain(fine, proc(seed));
  const f = Math.round(coarseRes / fineRes);
  const out = new Uint8Array(coarse.cellCount);
  for (let row = 0; row < coarse.heightCells; row++) {
    for (let col = 0; col < coarse.widthCells; col++) {
      let land = 0;
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const i = (row * f + dr) * fine.widthCells + (col * f + dc);
          n++;
          if (t.landMask[i]) land++;
        }
      }
      out[row * coarse.widthCells + col] = land * 2 >= n ? 1 : 0;
    }
  }
  return out;
}

function jaccard(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] === 1;
    const y = b[i] === 1;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union > 0 ? inter / union : 1;
}

describe('手続き地形の解像度不変性(P0-1)', () => {
  it('同一種子・同一解像度は配列まで完全一致(決定性)', () => {
    const grid = createGrid(1);
    const a = resolveTerrain(grid, proc(42));
    const b = resolveTerrain(grid, proc(42));
    expect(Array.from(a.landMask)).toEqual(Array.from(b.landMask));
    expect(Array.from(a.elevationMeters)).toEqual(Array.from(b.elevationMeters));
  });

  it('種子が違えば別の惑星になる', () => {
    const grid = createGrid(2);
    const a = resolveTerrain(grid, proc(42));
    const b = resolveTerrain(grid, proc(43));
    const same = jaccard(Uint8Array.from(a.landMask), Uint8Array.from(b.landMask));
    expect(same).toBeLessThan(0.8);
  });

  it('陸面積率が指定値 ±1pt(複数種子 × 0.5°/1°/2°)', () => {
    for (const seed of [42, 7, 1234]) {
      for (const res of [0.5, 1, 2]) {
        const frac = landAreaFrac(res, seed);
        expect(Math.abs(frac - 0.3)).toBeLessThan(0.01);
      }
    }
  });

  it('1° と 0.5° を同じ格子へ集約した陸域 Jaccard ≥ 0.95(複数種子)', () => {
    for (const seed of [42, 7]) {
      const coarse1 = aggregateLand(1, 2, seed);
      const coarseHalf = aggregateLand(0.5, 2, seed);
      expect(jaccard(coarse1, coarseHalf)).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('1° と 2° も同じ大陸形状(2° 格子で Jaccard ≥ 0.9)', () => {
    const from1 = aggregateLand(1, 2, 42);
    const grid2 = createGrid(2);
    const at2 = Uint8Array.from(resolveTerrain(grid2, proc(42)).landMask);
    expect(jaccard(from1, at2)).toBeGreaterThanOrEqual(0.9);
  });

  it('経度の継ぎ目(±180°)でノイズが連続(端列の標高差が場の標準偏差より小さい)', () => {
    const grid = createGrid(1);
    const t = resolveTerrain(grid, proc(42));
    let seamDiff = 0;
    let n = 0;
    let mean = 0;
    for (let i = 0; i < grid.cellCount; i++) mean += t.elevationMeters[i] ?? 0;
    mean /= grid.cellCount;
    let varSum = 0;
    for (let i = 0; i < grid.cellCount; i++) {
      varSum += ((t.elevationMeters[i] ?? 0) - mean) ** 2;
    }
    const std = Math.sqrt(varSum / grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const west = t.elevationMeters[row * grid.widthCells] ?? 0;
      const east = t.elevationMeters[row * grid.widthCells + grid.widthCells - 1] ?? 0;
      seamDiff += Math.abs(west - east);
      n++;
    }
    expect(seamDiff / n).toBeLessThan(std);
  });
});
