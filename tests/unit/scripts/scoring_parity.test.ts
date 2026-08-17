// P0-3(FB 2026-07-31): 採点定義の一元化。
// 最適化器の目的関数(optimize_lib.evaluateResult)と標準検証(validate.ts)が
// 使う共有採点(scoring.ts)が、同一の PipelineResult に対して同じ値を返すことを
// 合成結果で担保する。パイプラインは実行しない(採点層だけの検査)。

import { describe, expect, it } from 'vitest';
import { OBJECTIVE_V5, evaluateResult } from '../../../scripts/optimize_lib';
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
    // 季節指標も共有採点と一致すること(2026-08-02 に目的関数へ入った量)
    expect(s.tempRangeRmse).toBe(f.tempRangeRmseC);
    expect(s.tempPhaseRmseDays).toBe(f.tempPhaseRmseDays);
    expect(s.precipDriestRmse).toBe(f.precipDriestRmseMm);
    expect(s.precipWettestRmse).toBe(f.precipWettestRmseMm);

    // v2(旧定義。比較のために計算し続けている)
    const fitnessV2 =
      k.majorPct +
      1.1 * s.gates +
      0.25 * k.detailPct -
      0.35 * f.tempRmseC -
      0.004 * f.precipRmseMm -
      (0.02 * Math.abs(f.landMeanModelMm - f.landMeanObsMm)) / 10 -
      0.3 * i;
    expect(s.fitnessV2).toBeCloseTo(fitnessV2, 12);

    // v3(2026-08-02〜08-16 に探索が最大化していた量。以後は併記のみ)
    const W = OBJECTIVE_V5;
    const fitnessV3 =
      k.majorPct +
      1.1 * s.gates +
      0.25 * k.detailPct -
      W.wTempMean * (f.tempRmseC / f.obsSdTempC) -
      W.wTempRange * (f.tempRangeRmseC / f.obsSdTempRangeC) -
      W.wTempPhase * (f.tempPhaseRmseDays / W.phaseScaleDays) -
      W.wPrecipAnnual * (f.precipRmseMm / f.obsSdPrecipMm) -
      W.wPrecipDriest * (f.precipDriestRmseMm / f.obsSdPrecipDriestMm) -
      W.wPrecipWettest * (f.precipWettestRmseMm / f.obsSdPrecipWettestMm) -
      W.wLandMean * (Math.abs(f.landMeanModelMm - f.landMeanObsMm) / f.landMeanObsMm) -
      W.wItcz * (i / W.itczScaleDeg);
    expect(s.fitnessV3).toBeCloseTo(fitnessV3, 12);

    // v4(2026-08-16 以降、探索が最大化する量)。v3 との差は 2 点だけ:
    //   ゲートが離散(合格件数)から連続(面積割合の和)へ
    //   年降水の分布形の項が加わった
    const gateShare = gates.reduce((acc, g) => acc + g.share, 0);
    const fitnessV4 =
      fitnessV3 - 1.1 * s.gates + 1.1 * gateShare - W.wPrecipQuantile * f.precipQuantileLogErr;
    expect(s.fitnessV4).toBeCloseTo(fitnessV4, 12);

    // v5(2026-08-17 以降、探索が最大化する量)。v4 との差は降水位相の 1 項だけ
    const fitnessV5 = fitnessV4 - W.wPrecipPhase * (f.precipPhaseRmseDays / W.phaseScaleDays);
    expect(s.fitness).toBeCloseTo(fitnessV5, 12);
    expect(s.precipPhaseRmseDays).toBe(f.precipPhaseRmseDays);
    expect(s.gateShare).toBeCloseTo(gateShare, 12);
    expect(s.precipQuantileLogErr).toBe(f.precipQuantileLogErr);
    // 連続部分(版をまたいで比べられる唯一の量)がゲート項を含まないこと
    expect(s.continuousV3).toBeCloseTo(fitnessV3 - 1.1 * s.gates, 12);
  });

  it('ゲートの被覆(連続版)は 0〜1 で、合否と整合する', () => {
    const gates = scoreRegionGates(result);
    for (const g of gates) {
      expect(g.share).toBeGreaterThanOrEqual(0);
      expect(g.share).toBeLessThanOrEqual(1);
    }
    // 大分類ゲートは「過半」で合格。被覆はセル数基準の合否と概ね一致するはずで、
    // **合格しているのに被覆が 0** なら連続化の配線を間違えている
    for (const g of gates) {
      if (g.pass) expect(g.share).toBeGreaterThan(0);
    }
  });

  it('降水の分位が単調で、分布形の誤差が有限である', () => {
    const f = fieldScore(result);
    expect(f.precipQuantiles.length).toBe(8);
    for (let i = 1; i < f.precipQuantiles.length; i++) {
      // 分位なので分位点・モデル値・観測値のいずれも単調非減少
      expect(f.precipQuantiles[i]![0]).toBeGreaterThan(f.precipQuantiles[i - 1]![0]);
      expect(f.precipQuantiles[i]![1]).toBeGreaterThanOrEqual(f.precipQuantiles[i - 1]![1]);
      expect(f.precipQuantiles[i]![2]).toBeGreaterThanOrEqual(f.precipQuantiles[i - 1]![2]);
    }
    expect(Number.isFinite(f.precipQuantileLogErr)).toBe(true);
    expect(f.precipQuantileLogErr).toBeGreaterThanOrEqual(0);
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
