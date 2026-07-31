// P0-4(FB 2026-07-31): 退行防止ゲートと最終受入ゲートの分離。
// 「退行させたフィクスチャで FAIL する」ことを含めて判定関数を検査する。

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_CRITERIA,
  REGRESSION_BASELINE,
  evaluateAcceptance,
  evaluateRegression,
  type AcceptanceMetrics,
  type RegressionMetrics,
} from '../../../scripts/validate_criteria';

// 2026-07-31 の採用モデルの実測値(面積重み付き正本)
const currentMetrics: RegressionMetrics = {
  majorPct: 73.93,
  detailPct: 42.74,
  gates: 14,
  tempRmseC: 3.65,
  precipRmseMm: 773,
  itczRmseDeg: 8.33,
  landMeanModelMm: 825,
  landMeanObsMm: 794,
};

describe('退行防止ゲート(P0-4)', () => {
  it('採用モデルの実測値は PASS する', () => {
    const v = evaluateRegression(currentMetrics);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('退行フィクスチャ: ゲート喪失は 1 個でも FAIL', () => {
    const v = evaluateRegression({ ...currentMetrics, gates: 13 });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('地域ゲート'))).toBe(true);
  });

  it('退行フィクスチャ: 大分類一致率の低下で FAIL', () => {
    const v = evaluateRegression({ ...currentMetrics, majorPct: 72.9 });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('大分類'))).toBe(true);
  });

  it('退行フィクスチャ: 気温・降水・ITCZ の悪化でそれぞれ FAIL', () => {
    expect(evaluateRegression({ ...currentMetrics, tempRmseC: 4.0 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, precipRmseMm: 850 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, itczRmseDeg: 9.0 }).pass).toBe(false);
  });

  it('退行フィクスチャ: 陸平均降水比が ±10% を超えると FAIL', () => {
    const v = evaluateRegression({ ...currentMetrics, landMeanModelMm: 794 * 1.11 });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('陸平均降水比'))).toBe(true);
  });

  it('基準の凍結日と余裕幅が実測値と整合している(基準が実測より緩い)', () => {
    expect(REGRESSION_BASELINE.frozenAt).toBe('2026-07-31');
    expect(REGRESSION_BASELINE.majorPctMin).toBeLessThan(currentMetrics.majorPct);
    expect(REGRESSION_BASELINE.tempRmseMaxC).toBeGreaterThan(currentMetrics.tempRmseC);
    expect(REGRESSION_BASELINE.precipRmseMaxMm).toBeGreaterThan(currentMetrics.precipRmseMm);
  });
});

const goodAcceptance: AcceptanceMetrics = {
  majorAreaGapPt: [1.4, 0, -1.7, -1.4, 1.6],
  gatesPassed: 12,
  gatesTotal: 17,
  zonalTempAbsDiffsC: [0.5, 2.0, 4.9, 3.0],
};

describe('最終受入ゲート(P0-4)', () => {
  it('全条件を満たす合成値は達成', () => {
    const v = evaluateAcceptance(goodAcceptance);
    expect(v.pass).toBe(true);
  });

  it('帯状平均気温 ±5°C 超過で未達(現状の実態: 南半球高緯度)', () => {
    const v = evaluateAcceptance({ ...goodAcceptance, zonalTempAbsDiffsC: [0.5, 11.9] });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('帯状平均気温'))).toBe(true);
  });

  it('大分類面積差 ±10pt 超過で未達', () => {
    const v = evaluateAcceptance({ ...goodAcceptance, majorAreaGapPt: [11, 0, 0, 0, 0] });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('面積差'))).toBe(true);
  });

  it('地域ゲート合格率 70% 未満で未達(11/17 = 65%)', () => {
    const v = evaluateAcceptance({ ...goodAcceptance, gatesPassed: 11 });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('合格率'))).toBe(true);
  });

  it('受入基準は要件 §6-1 の凍結値', () => {
    expect(ACCEPTANCE_CRITERIA.majorAreaGapMaxPt).toBe(10);
    expect(ACCEPTANCE_CRITERIA.regionGatePassRateMin).toBe(0.7);
    expect(ACCEPTANCE_CRITERIA.zonalTempAbsMaxC).toBe(5);
  });
});
