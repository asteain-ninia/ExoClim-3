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
import { getKoppenObs, koppenScore, REGION_GATES } from '../../../scripts/scoring';
import { evaluateResult } from '../../../scripts/optimize_lib';
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
});
