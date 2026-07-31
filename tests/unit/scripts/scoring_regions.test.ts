// R0(地域降水 FB 2026-07-31): 地域診断の定義と集計の健全性。
// FB「1. 現状の測定結果」±2% の再現は実パイプラインで確認し
// docs/FB対応記録.md に記録する(ここでは採点層のみ検査)。

import { describe, expect, it } from 'vitest';
import { DIAG_REGIONS, regionKoppenDiag, regionPrecipDiag } from '../../../scripts/scoring_regions';
import { syntheticResult } from '../../helpers/syntheticResult';

describe('地域降水診断(R0)', () => {
  const result = syntheticResult();

  it('地域定義は FB の 6 地域・重複なし・枠が正立', () => {
    expect(DIAG_REGIONS.length).toBe(6);
    expect(new Set(DIAG_REGIONS.map((r) => r.id)).size).toBe(6);
    for (const r of DIAG_REGIONS) {
      expect(r.latMin).toBeLessThan(r.latMax);
      expect(r.lonMin).toBeLessThan(r.lonMax);
    }
  });

  it('降水診断: 全地域で有限・比が再構成可能・最乾 ≤ 最多雨', () => {
    const diags = regionPrecipDiag(result);
    expect(diags.length).toBe(6);
    for (const d of diags) {
      expect(d.cells).toBeGreaterThan(0);
      for (const v of [d.modelAnnualMm, d.obsAnnualMm, d.modelDriestMm, d.obsDriestMm]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(d.ratio).toBeCloseTo(d.modelAnnualMm / d.obsAnnualMm, 1);
      expect(d.modelDriestMm).toBeLessThanOrEqual(d.modelWettestMm);
      expect(d.obsDriestMm).toBeLessThanOrEqual(d.obsWettestMm);
      // 年量 = 月別系列の合計(丸め誤差内)
      const sum = d.modelMonthlyMm.reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - d.modelAnnualMm)).toBeLessThanOrEqual(1);
      expect(d.modelMonthlyMm.length).toBe(12);
    }
  });

  it('気候区分診断: シェア合計 ≈ 100%・Af+Am は A シェア以下', () => {
    const diags = regionKoppenDiag(result);
    expect(diags.length).toBe(6);
    for (const d of diags) {
      const sumModel = d.majorSharesModelPct.reduce((a, b) => a + b, 0);
      const sumObs = d.majorSharesObsPct.reduce((a, b) => a + b, 0);
      expect(Math.abs(sumModel - 100)).toBeLessThan(1.5);
      expect(Math.abs(sumObs - 100)).toBeLessThan(1.5);
      expect(d.afAmModelPct).toBeLessThanOrEqual((d.majorSharesModelPct[0] ?? 0) + 0.2);
      expect(d.afAmObsPct).toBeLessThanOrEqual((d.majorSharesObsPct[0] ?? 0) + 0.2);
    }
  });

  it('決定性: 同じ入力で同じ診断', () => {
    expect(regionPrecipDiag(result)).toEqual(regionPrecipDiag(result));
  });
});
