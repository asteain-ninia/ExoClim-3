// P0-3(FB 2026-07-31): 採点定義の一元化。
// 最適化器の目的関数(optimize_lib.evaluateResult)と標準検証(validate.ts)が
// 使う共有採点(scoring.ts)が、同一の PipelineResult に対して同じ値を返すことを
// 合成結果で担保する。パイプラインは実行しない(採点層だけの検査)。

import { describe, expect, it } from 'vitest';
import { createGrid } from '../../../src/domain/grid';
import type { PipelineResult } from '../../../src/sim/types';
import { evaluateResult } from '../../../scripts/optimize_lib';
import {
  fieldScore,
  getKoppenObs,
  itczLineRmse,
  koppenScore,
  scoreRegionGates,
  REGION_GATES,
} from '../../../scripts/scoring';

// 観測ラスターを土台に、決定的な摂動を加えた合成結果を作る。
// (完全一致でも全滅でもない中間の成績になるため、比較が退化しない)
function syntheticResult(): PipelineResult {
  const grid = createGrid(1);
  const obs = getKoppenObs();
  const land = new Uint8Array(grid.cellCount);
  const classId = new Uint8Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    const o = obs.classRaster[i] ?? 0;
    if (o === 0) continue;
    land[i] = 1;
    classId[i] = i % 7 === 0 ? ((o + 2) % 30) + 1 : o;
  }
  const monthlyTemperatureC: Float32Array[] = [];
  const monthlyPrecipMm: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    const t = new Float32Array(grid.cellCount);
    const p = new Float32Array(grid.cellCount);
    const itczLat = 8 * Math.sin((2 * Math.PI * (m - 3)) / 12);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5);
      const seasonal = 8 * Math.sin((2 * Math.PI * (m - 3)) / 12) * (lat >= 0 ? 1 : -1);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        t[i] = 28 * Math.cos((lat * Math.PI) / 180) - 8 + seasonal;
        p[i] = 30 + 180 * Math.exp(-(((lat - itczLat) / 12) ** 2)) + 10 * Math.sin((col * Math.PI) / 45);
      }
    }
    monthlyTemperatureC.push(t);
    monthlyPrecipMm.push(p);
  }
  const annualMeanC = new Float32Array(grid.cellCount);
  const annualPrecipMm = new Float32Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    let ts = 0;
    let ps = 0;
    for (let m = 0; m < 12; m++) {
      ts += monthlyTemperatureC[m]?.[i] ?? 0;
      ps += monthlyPrecipMm[m]?.[i] ?? 0;
    }
    annualMeanC[i] = ts / 12;
    annualPrecipMm[i] = ps;
  }
  const monthlyCenterLatDegByCol: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    const c = new Float32Array(grid.widthCells);
    for (let col = 0; col < grid.widthCells; col++) {
      c[col] = 8 * Math.sin((2 * Math.PI * (m - 3)) / 12) + 2 * Math.sin((col * Math.PI) / 90);
    }
    monthlyCenterLatDegByCol.push(c);
  }
  return {
    context: { grid, terrain: { landMask: land } },
    koppen: { classId },
    temperature: { monthlyTemperatureC, annualMeanC },
    precipitation: { monthlyPrecipMm, annualPrecipMm },
    itcz: { monthlyCenterLatDegByCol, halfWidthDeg: 10 },
  } as unknown as PipelineResult;
}

describe('採点の一元化(P0-3)', () => {
  const result = syntheticResult();

  it('目的関数の全成分が共有採点と厳密一致する', () => {
    const s = evaluateResult(result);
    const k = koppenScore(result);
    const gates = scoreRegionGates(result);
    const f = fieldScore(result);
    const i = itczLineRmse(result);
    expect(s.majorPct).toBe(k.majorPct);
    expect(s.detailPct).toBe(k.detailPct);
    expect(s.gates).toBe(gates.filter((g) => g.pass).length);
    expect(s.tempRmse).toBe(f.tempRmseC);
    expect(s.precipRmse).toBe(f.precipRmseMm);
    expect(s.landMeanMm).toBe(f.landMeanModelMm);
    expect(s.itczRmse).toBe(i);
    const fitness =
      k.majorPct +
      1.1 * s.gates +
      0.25 * k.detailPct -
      0.35 * f.tempRmseC -
      0.004 * f.precipRmseMm -
      (0.02 * Math.abs(f.landMeanModelMm - f.landMeanObsMm)) / 10 -
      0.3 * i;
    expect(s.fitness).toBeCloseTo(fitness, 12);
  });

  it('合成結果の成績が退化していない(比較が意味を持つ)', () => {
    const k = koppenScore(result);
    expect(k.wTotal).toBeGreaterThan(0);
    expect(k.detailPct).toBeGreaterThan(50);
    expect(k.detailPct).toBeLessThan(100);
    expect(k.majorPct).toBeGreaterThanOrEqual(k.detailPct);
    const gates = scoreRegionGates(result);
    expect(gates.length).toBe(REGION_GATES.length);
    const passed = gates.filter((g) => g.pass).length;
    expect(passed).toBeGreaterThan(5);
    const f = fieldScore(result);
    for (const v of [f.tempRmseC, f.tempJanRmseC, f.tempJulRmseC, f.precipRmseMm]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(Math.abs(f.logCorrelation)).toBeLessThanOrEqual(1);
    expect(itczLineRmse(result)).toBeGreaterThan(0);
  });

  it('地域ゲートの定義が単一(REGION_GATES は 17 地域)', () => {
    expect(REGION_GATES.length).toBe(17);
    const ids = new Set(REGION_GATES.map((g) => g.id));
    expect(ids.size).toBe(17);
  });
});
