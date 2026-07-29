import { describe, expect, it } from 'vitest';
import { createGrid, latDegOfRow, rowOfLatDeg } from '@/domain/grid';
import {
  computeInsolation,
  dailyMeanInsolationWm2,
  meanAnomalyFromTrue,
  sampleOrbit,
  solveEccentricAnomaly,
  trueAnomalyFromEccentric,
} from '@/domain/insolation';
import { EARTH_PARAMS } from '@/domain/planetParams';

describe('ケプラー方程式', () => {
  it('離心率 0 では E = M', () => {
    expect(solveEccentricAnomaly(1.234, 0)).toBeCloseTo(1.234, 10);
  });

  it('真近点角 ↔ 離心近点角 ↔ 平均近点角の往復が一致する', () => {
    for (const e of [0.0167, 0.2, 0.6]) {
      for (const m of [0.3, 1.5, 3.0, 5.0]) {
        const E = solveEccentricAnomaly(m, e);
        const nu = trueAnomalyFromEccentric(E, e);
        const m2 = meanAnomalyFromTrue(nu, e);
        const diff = Math.atan2(Math.sin(m2 - m), Math.cos(m2 - m));
        expect(Math.abs(diff)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('日平均日射', () => {
  it('赤緯 0 のとき赤道で S0/π、極で 0', () => {
    expect(dailyMeanInsolationWm2(0, 0, 1361)).toBeCloseTo(1361 / Math.PI, 3);
    expect(Math.abs(dailyMeanInsolationWm2(90, 0, 1361))).toBeLessThan(1e-9);
  });

  it('極昼(緯度 89°、赤緯 23°)は正の日射、極夜は 0', () => {
    expect(dailyMeanInsolationWm2(89, 23, 1361)).toBeGreaterThan(400);
    expect(dailyMeanInsolationWm2(89, -23, 1361)).toBe(0);
  });

  it('極昼の日射が赤道を上回る(実地球の夏至と同じ構造)', () => {
    // この「極昼 > 赤道」は物理的に正しい。教訓 §5: これを線形に温度へ写すと
    // 破綻する(EBM が熱容量・放射で吸収する)。
    const pole = dailyMeanInsolationWm2(89, 23.44, 1361);
    const equator = dailyMeanInsolationWm2(0, 23.44, 1361);
    expect(pole).toBeGreaterThan(equator);
  });
});

describe('軌道サンプルと月定義', () => {
  it('月 0 の開始 = 冬至: 月 0 中央の赤緯は深い負、月 6 は深い正', () => {
    const g = createGrid(2);
    const field = computeInsolation(g, EARTH_PARAMS.orbital, 23.44);
    expect(field.monthlyDeclinationDeg[0]).toBeLessThan(-20);
    expect(field.monthlyDeclinationDeg[6]).toBeGreaterThan(20);
  });

  it('地球: 近日点(1 月)の距離係数 > 遠日点(7 月)', () => {
    const g = createGrid(2);
    const field = computeInsolation(g, EARTH_PARAMS.orbital, 23.44);
    expect(field.monthlyDistanceFactor[0]).toBeGreaterThan(field.monthlyDistanceFactor[6] ?? 0);
  });

  it('傾斜 0 では全月の赤緯が 0', () => {
    const sample = sampleOrbit(EARTH_PARAMS.orbital, 0, 2.0);
    expect(Math.abs(sample.declinationDeg)).toBeLessThan(1e-9);
  });

  it('年平均日射: 赤道 ≈ 417 W/m²、極 ≈ 175 W/m²(地球の実値)', () => {
    const g = createGrid(1);
    const field = computeInsolation(g, EARTH_PARAMS.orbital, 23.44);
    const eq = field.annualMeanByRow[rowOfLatDeg(g, 0.5)] ?? 0;
    const pole = field.annualMeanByRow[0] ?? 0;
    expect(eq).toBeGreaterThan(405);
    expect(eq).toBeLessThan(430);
    expect(pole).toBeGreaterThan(160);
    expect(pole).toBeLessThan(190);
  });

  it('全球年平均日射 ≈ S0/4 ≈ 340 W/m²', () => {
    const g = createGrid(1);
    const field = computeInsolation(g, EARTH_PARAMS.orbital, 23.44);
    let sum = 0;
    let wsum = 0;
    for (let row = 0; row < g.heightCells; row++) {
      const w = Math.cos((latDegOfRow(g, row) * Math.PI) / 180);
      sum += (field.annualMeanByRow[row] ?? 0) * w;
      wsum += w;
    }
    expect(sum / wsum).toBeGreaterThan(335);
    expect(sum / wsum).toBeLessThan(346);
  });

  it('高離心率 (e=0.5) でも NaN を出さない', () => {
    const g = createGrid(4);
    const orbital = { ...EARTH_PARAMS.orbital, eccentricity: 0.5 };
    const field = computeInsolation(g, orbital, 40);
    for (const arr of field.monthlyByRow) {
      for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
