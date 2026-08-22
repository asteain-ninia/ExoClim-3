// P1-1(FB 2026-07-31): 空間ホールドアウト分割。
// 受入条件: 区画重複なし・和が全球、--holdout-fold で目的関数から除外、
// 区画バランスの報告、訓練/保留/全球の分離。

import { describe, expect, it } from 'vitest';
import {
  HOLDOUT_FOLDS,
  foldOfLatLon,
  gateFoldAssignments,
  keepExcludingFold,
  keepOnlyFold,
} from '../../../scripts/holdout';
import {
  fieldScore,
  intermediateFieldScore,
  getClimObs,
  getKoppenObs,
  koppenScore,
  scoreRegionGates,
  REGION_GATES,
  type ClimateFixture,
  type KoppenFixture,
} from '../../../scripts/scoring';
import { OBJECTIVE_V7, evaluateResult } from '../../../scripts/optimize_lib';
import { syntheticResult } from '../../helpers/syntheticResult';

describe('空間ホールドアウト分割(P1-1)', () => {
  it('全点がちょうど 1 区画に属し、除外/限定フィルタは相補', () => {
    for (let lat = -89.5; lat <= 89.5; lat += 7) {
      for (let lon = -179.5; lon <= 179.5; lon += 11) {
        const f = foldOfLatLon(lat, lon);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThan(HOLDOUT_FOLDS);
        expect(foldOfLatLon(lat, lon)).toBe(f); // 決定的
        for (let g = 0; g < HOLDOUT_FOLDS; g++) {
          expect(keepOnlyFold(g)(lat, lon)).toBe(f === g);
          expect(keepExcludingFold(g)!(lat, lon)).toBe(f !== g);
        }
      }
    }
  });

  it('区画の和 = 全球(採点重みの分割が完全)', () => {
    const result = syntheticResult();
    const global = koppenScore(result);
    let wSum = 0;
    let wDetailSum = 0;
    for (let f = 0; f < HOLDOUT_FOLDS; f++) {
      const part = koppenScore(result, undefined, keepOnlyFold(f));
      wSum += part.wTotal;
      wDetailSum += (part.detailPct / 100) * part.wTotal;
    }
    expect(wSum).toBeCloseTo(global.wTotal, 6);
    expect((wDetailSum / wSum) * 100).toBeCloseTo(global.detailPct, 6);
  });

  it('区画バランス: 観測陸面積が極端に偏らない(各 10〜35%)', () => {
    const obs = getKoppenObs();
    const W = obs.widthCells;
    const landW = new Array<number>(HOLDOUT_FOLDS).fill(0);
    let total = 0;
    for (let row = 0; row < obs.heightCells; row++) {
      const lat = 90 - (row + 0.5);
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < W; col++) {
        if ((obs.classRaster[row * W + col] ?? 0) === 0) continue;
        const f = foldOfLatLon(lat, -180 + (col + 0.5));
        landW[f] = (landW[f] ?? 0) + w;
        total += w;
      }
    }
    for (let f = 0; f < HOLDOUT_FOLDS; f++) {
      const share = ((landW[f] ?? 0) / total) * 100;
      expect(share).toBeGreaterThan(10);
      expect(share).toBeLessThan(35);
    }
  });

  it('地域ゲートは全 17 件が事前登録され、区画は決定的', () => {
    const folds = gateFoldAssignments();
    expect(Object.keys(folds).length).toBe(REGION_GATES.length);
    for (const g of REGION_GATES) {
      const f = folds[g.id];
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(HOLDOUT_FOLDS);
    }
    expect(gateFoldAssignments()).toEqual(folds);
  });

  it('--holdout-fold 相当: 目的関数から区画セルとゲートが除外される', () => {
    const result = syntheticResult();
    const global = evaluateResult(result);
    const folds = gateFoldAssignments();
    for (let f = 0; f < HOLDOUT_FOLDS; f++) {
      const held = evaluateResult(result, f);
      // 区画のゲートは数えない
      const expectedMaxGates = REGION_GATES.filter((g) => folds[g.id] !== f).length;
      expect(held.gates).toBeLessThanOrEqual(expectedMaxGates);
      // 目的関数が実際に変わる(セル除外が効いている)
      expect(held.fitness).not.toBe(global.fitness);
    }
    // 未指定は従来どおり(同一値)
    expect(evaluateResult(result)).toEqual(global);
  });

  it('保留較正の目的関数に ITCZ 項が無く、ゲート項は訓練対象数で正規化(P1-2/P1-3)', () => {
    const result = syntheticResult();
    const folds = gateFoldAssignments();
    for (let f = 0; f < HOLDOUT_FOLDS; f++) {
      const s = evaluateResult(result, f);
      const training = scoreRegionGates(result).filter((g) => folds[g.id] !== f);
      const keep = keepExcludingFold(f);
      const k = koppenScore(result, undefined, keep);
      const fld = fieldScore(result, undefined, keep);
      const gateTerm = (17 * s.gates) / training.length;
      // v2(旧定義。併記のために計算し続けている)
      const expectedV2 =
        k.majorPct +
        1.1 * gateTerm +
        0.25 * k.detailPct -
        0.35 * fld.tempRmseC -
        0.004 * fld.precipRmseMm -
        (0.02 * Math.abs(fld.landMeanModelMm - fld.landMeanObsMm)) / 10;
      expect(s.fitnessV2).toBeCloseTo(expectedV2, 10); // ITCZ 項なしで厳密に再構成できる
      // v3(探索が最大化する量)。季節指標を含み、観測のばらつきで無次元化する
      const W = OBJECTIVE_V7;
      const expectedV3 =
        k.majorPct +
        1.1 * gateTerm +
        0.25 * k.detailPct -
        W.wTempMean * (fld.tempRmseC / fld.obsSdTempC) -
        W.wTempRange * (fld.tempRangeRmseC / fld.obsSdTempRangeC) -
        W.wTempPhase * (fld.tempPhaseRmseDays / W.phaseScaleDays) -
        W.wPrecipAnnual * (fld.precipRmseMm / fld.obsSdPrecipMm) -
        W.wPrecipDriest * (fld.precipDriestRmseMm / fld.obsSdPrecipDriestMm) -
        W.wPrecipWettest * (fld.precipWettestRmseMm / fld.obsSdPrecipWettestMm) -
        W.wLandMean *
          (Math.abs(fld.landMeanModelMm - fld.landMeanObsMm) / Math.max(1e-9, fld.landMeanObsMm));
      expect(s.fitnessV3).toBeCloseTo(expectedV3, 10); // ITCZ 項なしで厳密に再構成できる

      // v4(2026-08-16 以降、探索が最大化する量)。保留較正でも
      // **連続版のゲート項が訓練対象数で正規化される**ことを確かめる
      // (絶対数のままだと fold ごとに項の最大値が揃わない — P1-3 と同じ理由)
      const gateShareTerm =
        (17 * training.reduce((acc, g) => acc + g.share, 0)) / training.length;
      const expectedV4 =
        expectedV3 - 1.1 * gateTerm + 1.1 * gateShareTerm - W.wPrecipQuantile * fld.precipQuantileLogErr;
      expect(s.fitnessV4).toBeCloseTo(expectedV4, 10);
      const expectedV6 =
        expectedV4 - W.wPrecipPhase * (fld.precipPhaseBandMeanDays / W.phaseScaleDays);
      const im = intermediateFieldScore(result);
      const expectedV7 =
        expectedV6 -
        W.wSstAnom * (im.sstAnomRmseC / Math.max(1e-9, im.obsSdSstAnomC)) -
        W.wSstAnom * (im.sstSignErrC / Math.max(1e-9, im.obsSdSstAnomC)) -
        W.wLandWind * (im.landWindRmseMs / Math.max(1e-9, im.obsSdLandWindMs));
      expect(s.fitness).toBeCloseTo(expectedV7, 10);
      expect(s.gateShare).toBeCloseTo(gateShareTerm, 10);
      expect(s.itczRmse).toBeGreaterThan(0); // 参考値としての報告は継続
    }
  });

  it('漏洩反証: 保留区画の観測セルを改変しても訓練側の採点が変わらない(P1-2/P1-3)', () => {
    const result = syntheticResult();
    const f = 2;
    const keep = keepExcludingFold(f)!;
    // ケッペン観測: 保留区画のセルだけ別クラスへ書き換え
    const ko = getKoppenObs();
    const koMut: KoppenFixture = { ...ko, classRaster: [...ko.classRaster] };
    for (let row = 0; row < 180; row++) {
      const lat = 90 - (row + 0.5);
      for (let col = 0; col < 360; col++) {
        const i = row * 360 + col;
        if ((koMut.classRaster[i] ?? 0) === 0) continue;
        if (foldOfLatLon(lat, -180 + (col + 0.5)) === f) {
          koMut.classRaster[i] = (((koMut.classRaster[i] ?? 1) + 4) % 30) + 1;
        }
      }
    }
    const a = koppenScore(result, ko, keep);
    const b = koppenScore(result, koMut, keep);
    expect(b.majorPct).toBe(a.majorPct);
    expect(b.detailPct).toBe(a.detailPct);
    // 気候観測: 保留区画の 2° セルの降水・気温を大きく改変
    const clim = getClimObs();
    const climMut: ClimateFixture = {
      ...clim,
      monthlyPrecipitationMm: clim.monthlyPrecipitationMm.map((m) => [...m]),
      monthlyTemperatureDeciC: clim.monthlyTemperatureDeciC.map((m) => [...m]),
    };
    for (let cr = 0; cr < clim.heightCells; cr++) {
      const lat = 89 - cr * 2;
      for (let cc = 0; cc < clim.widthCells; cc++) {
        if (foldOfLatLon(lat, -179 + cc * 2) !== f) continue;
        const ci = cr * clim.widthCells + cc;
        for (let m = 0; m < 12; m++) {
          const p = climMut.monthlyPrecipitationMm[m]!;
          const t = climMut.monthlyTemperatureDeciC[m]!;
          if ((p[ci] ?? -9999) >= 0) p[ci] = (p[ci] ?? 0) + 500;
          if ((t[ci] ?? -9999) !== -9999) t[ci] = (t[ci] ?? 0) + 100;
        }
      }
    }
    const fa = fieldScore(result, clim, keep);
    const fb = fieldScore(result, climMut, keep);
    expect(fb.tempRmseC).toBe(fa.tempRmseC);
    expect(fb.precipRmseMm).toBe(fa.precipRmseMm);
    expect(fb.landMeanObsMm).toBe(fa.landMeanObsMm);
  });

  it('漏洩反証: 保留所属ゲート領域のモデル改変が訓練ゲート数を変えない(P1-3)', () => {
    const result = syntheticResult();
    const folds = gateFoldAssignments();
    const f = folds['australia_interior_arid']!; // fold 3 に完全所属
    const before = scoreRegionGates(result).filter((g) => folds[g.id] !== f);
    // 豪州枠内のモデル分類を全て別クラスへ
    const grid = result.context.grid;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5) * grid.resolutionDeg;
      if (lat < -30 || lat > -20) continue;
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < 120 || lon > 145) continue;
        const i = row * grid.widthCells + col;
        if (result.koppen.classId[i]) result.koppen.classId[i] = 1;
      }
    }
    const after = scoreRegionGates(result).filter((g) => folds[g.id] !== f);
    expect(after.map((g) => g.pass)).toEqual(before.map((g) => g.pass));
  });
});
