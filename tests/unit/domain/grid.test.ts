import { describe, expect, it } from 'vitest';
import {
  areaWeightedMean,
  cellWidthKm,
  colOfLonDeg,
  createGrid,
  latDegOfRow,
  lonDegOfCol,
  rowOfLatDeg,
  wrapCol,
} from '@/domain/grid';

describe('grid', () => {
  const g = createGrid(1);

  it('1° 格子は 360×180', () => {
    expect(g.widthCells).toBe(360);
    expect(g.heightCells).toBe(180);
    expect(g.cellCount).toBe(64800);
  });

  it('row 0 は北端セル中心 89.5°、最終行は -89.5°', () => {
    expect(latDegOfRow(g, 0)).toBeCloseTo(89.5);
    expect(latDegOfRow(g, 179)).toBeCloseTo(-89.5);
  });

  it('col 0 は西端セル中心 -179.5°', () => {
    expect(lonDegOfCol(g, 0)).toBeCloseTo(-179.5);
    expect(lonDegOfCol(g, 359)).toBeCloseTo(179.5);
  });

  it('緯度経度 → row/col の逆引きが一致する', () => {
    expect(rowOfLatDeg(g, 89.5)).toBe(0);
    expect(rowOfLatDeg(g, -89.5)).toBe(179);
    expect(colOfLonDeg(g, -179.5)).toBe(0);
    expect(colOfLonDeg(g, 179.5)).toBe(359);
    expect(colOfLonDeg(g, 180.5)).toBe(0); // 循環
  });

  it('wrapCol は負・過大な col を循環させる', () => {
    expect(wrapCol(g, -1)).toBe(359);
    expect(wrapCol(g, 360)).toBe(0);
  });

  it('面積重み付き平均: 定数場は定数', () => {
    const field = new Float64Array(g.cellCount).fill(7);
    expect(areaWeightedMean(g, field)).toBeCloseTo(7);
  });

  it('セル物理幅は赤道で約 111km、高緯度で縮む', () => {
    const equatorRow = rowOfLatDeg(g, 0.5);
    expect(cellWidthKm(g, equatorRow, 6371)).toBeGreaterThan(110);
    expect(cellWidthKm(g, equatorRow, 6371)).toBeLessThan(112);
    expect(cellWidthKm(g, 0, 6371)).toBeLessThan(2);
  });
});
