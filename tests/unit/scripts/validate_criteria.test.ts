// P0-4(FB 2026-07-31)+ 変更レビュー FB P0-2/P0-3:
// 退行防止・途中目標・最終受入の三段階分離。判定は非有限値・不正構造に閉じる
// (旧実装では全指標 NaN が PASS した — 修正前に失敗する再現を含む)。

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_CRITERIA,
  REGRESSION_BASELINE,
  evaluateAcceptance,
  evaluateInterimTarget,
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

describe('退行防止ゲート', () => {
  it('採用モデルの実測値は PASS する', () => {
    const v = evaluateRegression(currentMetrics);
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('退行フィクスチャ: ゲート喪失・一致率低下・RMSE 悪化がそれぞれ FAIL', () => {
    expect(evaluateRegression({ ...currentMetrics, gates: 13 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, majorPct: 72.9 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, tempRmseC: 4.0 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, precipRmseMm: 850 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, itczRmseDeg: 9.0 }).pass).toBe(false);
    expect(evaluateRegression({ ...currentMetrics, landMeanModelMm: 794 * 1.11 }).pass).toBe(false);
  });

  it('全指標 NaN は FAIL(P0-2 — 旧実装は PASS していた)', () => {
    const nan = Object.fromEntries(
      Object.keys(currentMetrics).map((k) => [k, Number.NaN]),
    ) as unknown as RegressionMetrics;
    const v = evaluateRegression(nan);
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('非有限'))).toBe(true);
  });

  it('Infinity も FAIL し、指標名を報告する', () => {
    const v = evaluateRegression({ ...currentMetrics, tempRmseC: Infinity });
    expect(v.pass).toBe(false);
    expect(v.failures.some((f) => f.includes('気温年 RMSE') && f.includes('非有限'))).toBe(true);
  });

  it('基準の凍結日と余裕幅が実測値と整合している', () => {
    expect(REGRESSION_BASELINE.frozenAt).toBe('2026-07-31');
    expect(REGRESSION_BASELINE.majorPctMin).toBeLessThan(currentMetrics.majorPct);
    expect(REGRESSION_BASELINE.tempRmseMaxC).toBeGreaterThan(currentMetrics.tempRmseC);
  });
});

const base: AcceptanceMetrics = {
  majorAreaGapPt: [1.4, 0, -1.7, -1.4, 1.6],
  gatesPassed: 14,
  gatesTotal: 17,
  zonalTempAbsDiffsC: [0.5, 2.0, 4.9, 3.0],
};

describe('途中目標と最終受入の三段階分離(P0-3)', () => {
  it('境界固定: 途中目標 70% は 11/17(64.7%)FAIL・12/17(70.6%)PASS', () => {
    expect(evaluateInterimTarget({ ...base, gatesPassed: 11 }).pass).toBe(false);
    expect(evaluateInterimTarget({ ...base, gatesPassed: 12 }).pass).toBe(true);
    expect(evaluateInterimTarget({ ...base, gatesPassed: 14 }).pass).toBe(true);
    expect(evaluateInterimTarget({ ...base, gatesPassed: 16 }).pass).toBe(true);
    expect(evaluateInterimTarget({ ...base, gatesPassed: 17 }).pass).toBe(true);
  });

  it('境界固定: 最終受入は 17/17 のみ PASS(14/17 も 16/17 も FAIL)', () => {
    expect(evaluateAcceptance({ ...base, gatesPassed: 12 }).pass).toBe(false);
    expect(evaluateAcceptance({ ...base, gatesPassed: 14 }).pass).toBe(false);
    expect(evaluateAcceptance({ ...base, gatesPassed: 16 }).pass).toBe(false);
    expect(evaluateAcceptance({ ...base, gatesPassed: 17 }).pass).toBe(true);
  });

  it('最終受入: 帯状気温 ±5°C 超過・面積差 ±10pt 超過は 17/17 でも FAIL', () => {
    expect(
      evaluateAcceptance({ ...base, gatesPassed: 17, zonalTempAbsDiffsC: [0.5, 11.9] }).pass,
    ).toBe(false);
    expect(
      evaluateAcceptance({ ...base, gatesPassed: 17, majorAreaGapPt: [11, 0, 0, 0, 0] }).pass,
    ).toBe(false);
  });

  it('全指標 NaN は途中目標・最終受入とも FAIL(P0-2)', () => {
    const nan: AcceptanceMetrics = {
      majorAreaGapPt: [NaN, NaN, NaN, NaN, NaN],
      gatesPassed: NaN,
      gatesTotal: NaN,
      zonalTempAbsDiffsC: [NaN],
    };
    expect(evaluateInterimTarget(nan).pass).toBe(false);
    expect(evaluateAcceptance(nan).pass).toBe(false);
  });

  it('不正構造は FAIL: ゲート総数 0・合格数 > 総数・空配列', () => {
    expect(evaluateAcceptance({ ...base, gatesTotal: 0, gatesPassed: 0 }).pass).toBe(false);
    expect(evaluateInterimTarget({ ...base, gatesTotal: 0, gatesPassed: 0 }).pass).toBe(false);
    expect(evaluateAcceptance({ ...base, gatesPassed: 18 }).pass).toBe(false);
    expect(evaluateAcceptance({ ...base, majorAreaGapPt: [] }).pass).toBe(false);
    expect(evaluateAcceptance({ ...base, zonalTempAbsDiffsC: [] }).pass).toBe(false);
  });

  it('受入基準は凍結値(途中 70%・面積 ±10pt・帯状 ±5°C)', () => {
    expect(ACCEPTANCE_CRITERIA.interimRegionGatePassRateMin).toBe(0.7);
    expect(ACCEPTANCE_CRITERIA.majorAreaGapMaxPt).toBe(10);
    expect(ACCEPTANCE_CRITERIA.zonalTempAbsMaxC).toBe(5);
  });
});
