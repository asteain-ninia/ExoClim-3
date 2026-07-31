// P0-3(FB 2026-07-31): 採点定義の一元化。
// 最適化器の目的関数(optimize_lib.evaluateResult)と標準検証(validate.ts)が
// 使う共有採点(scoring.ts)が、同一の PipelineResult に対して同じ値を返すことを
// 合成結果で担保する。パイプラインは実行しない(採点層だけの検査)。

import { describe, expect, it } from 'vitest';
import { evaluateResult } from '../../../scripts/optimize_lib';
import {
  fieldScore,
  itczLineRmse,
  koppenScore,
  scoreRegionGates,
  REGION_GATES,
} from '../../../scripts/scoring';
import { syntheticResult } from '../../helpers/syntheticResult';

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
