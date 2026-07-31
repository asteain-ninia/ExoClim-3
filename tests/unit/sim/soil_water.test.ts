// R3(地域降水 FB §7): 土壌水分の季節記憶。
// 受入条件のうち計算層で担保するもの: 周期定常解が初期値に依らない/
// 空回し年数を増やしても変わらない/水収支が閉じる/退化条件で有限・決定的。

import { describe, expect, it } from 'vitest';
import {
  potentialEtMmPerMonth,
  solveSoilWater,
  type SoilWaterResult,
} from '../../../src/sim/step06_precipitation';

const N = 4; // セル 0-2 = 陸、3 = 海
const isLand = (i: number) => i < 3;

/** セル 0 = 明瞭な雨季乾季、1 = 常湿、2 = 極端乾燥 */
function forcing(): { precip: Float32Array[]; temp: Float32Array[] } {
  const precip: Float32Array[] = [];
  const temp: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    const wet = m >= 10 || m <= 3; // 11-4 月が雨季
    precip.push(Float32Array.from([wet ? 260 : 15, 180, 0, 999]));
    temp.push(Float32Array.from([26, 26, 30, 20]));
  }
  return { precip, temp };
}

function annual(res: SoilWaterResult, key: 'actualEtMm' | 'runoffMm', cell: number): number {
  let s = 0;
  for (let m = 0; m < 12; m++) s += res[key][m]?.[cell] ?? 0;
  return s;
}

describe('土壌水分の季節記憶(R3)', () => {
  const { precip, temp } = forcing();

  it('可能蒸発散: 0°C 以下は 0、20°C で基準値、高温ほど大きい', () => {
    expect(potentialEtMmPerMonth(-5)).toBe(0);
    expect(potentialEtMmPerMonth(0)).toBe(0);
    expect(potentialEtMmPerMonth(20)).toBeCloseTo(90, 6); // soilPetScaleMmPerMonth
    expect(potentialEtMmPerMonth(30)).toBeGreaterThan(potentialEtMmPerMonth(20));
  });

  it('周期定常解が初期貯水に依らない(0% / 50% / 100% 充填で一致)', () => {
    const a = solveSoilWater(N, isLand, precip, temp, 300, 40, 0);
    const b = solveSoilWater(N, isLand, precip, temp, 300, 40, 0.5);
    const c = solveSoilWater(N, isLand, precip, temp, 300, 40, 1);
    for (let m = 0; m < 12; m++) {
      for (let i = 0; i < 3; i++) {
        expect(b.storageMm[m]?.[i]).toBeCloseTo(a.storageMm[m]?.[i] ?? 0, 4);
        expect(c.storageMm[m]?.[i]).toBeCloseTo(a.storageMm[m]?.[i] ?? 0, 4);
        expect(b.actualEtMm[m]?.[i]).toBeCloseTo(a.actualEtMm[m]?.[i] ?? 0, 4);
      }
    }
  });

  it('空回し年数を増やしても結果が変わらない(30 年で収束済み)', () => {
    const y30 = solveSoilWater(N, isLand, precip, temp, 300, 30);
    const y60 = solveSoilWater(N, isLand, precip, temp, 300, 60);
    for (let m = 0; m < 12; m++) {
      for (let i = 0; i < 3; i++) {
        expect(y60.actualEtMm[m]?.[i]).toBeCloseTo(y30.actualEtMm[m]?.[i] ?? 0, 3);
      }
    }
  });

  it('水収支が閉じる: 年降水 = 年蒸発散 + 年流出(貯水変化 0)', () => {
    const r = solveSoilWater(N, isLand, precip, temp, 300, 40);
    for (let i = 0; i < 3; i++) {
      let p = 0;
      for (let m = 0; m < 12; m++) p += precip[m]?.[i] ?? 0;
      const et = annual(r, 'actualEtMm', i);
      const ro = annual(r, 'runoffMm', i);
      // 周期定常なので 12 月末 = 前年 12 月末(貯水変化ゼロ)
      expect(p).toBeCloseTo(et + ro, 2);
      expect(et).toBeGreaterThanOrEqual(0);
      expect(ro).toBeGreaterThanOrEqual(0);
    }
  });

  it('季節記憶がある: 乾季の蒸発散が当月降水を上回る(持ち越しの実証)', () => {
    const r = solveSoilWater(N, isLand, precip, temp, 300, 40);
    // セル 0 の乾季(5-9 月)は降水 15mm/月。記憶がなければ ET ≤ 15
    let carryMonths = 0;
    for (let m = 4; m <= 9; m++) {
      if ((r.actualEtMm[m]?.[0] ?? 0) > (precip[m]?.[0] ?? 0) + 1) carryMonths++;
    }
    expect(carryMonths).toBeGreaterThan(0);
    // 容量が大きいほど乾季の蒸発散が持続する
    const small = solveSoilWater(N, isLand, precip, temp, 50, 40);
    expect(r.actualEtMm[7]?.[0] ?? 0).toBeGreaterThan(small.actualEtMm[7]?.[0] ?? 0);
  });

  it('退化条件: 容量 0 は全ゼロ、極端乾燥セルは 0 に収束、海セルは不介入', () => {
    const off = solveSoilWater(N, isLand, precip, temp, 0, 30);
    for (let m = 0; m < 12; m++) {
      expect(off.actualEtMm[m]?.[0]).toBe(0);
      expect(off.storageMm[m]?.[0]).toBe(0);
    }
    const r = solveSoilWater(N, isLand, precip, temp, 300, 40);
    for (let m = 0; m < 12; m++) {
      expect(r.actualEtMm[m]?.[2]).toBeCloseTo(0, 6); // 降水 0 のセル
      expect(r.storageMm[m]?.[3]).toBe(0); // 海セルは触らない
      for (let i = 0; i < N; i++) {
        expect(Number.isFinite(r.storageMm[m]?.[i] ?? 0)).toBe(true);
        expect(r.storageMm[m]?.[i] ?? 0).toBeGreaterThanOrEqual(0);
        expect(r.storageMm[m]?.[i] ?? 0).toBeLessThanOrEqual(300);
      }
    }
  });

  it('決定的: 同じ入力で同じ結果', () => {
    const a = solveSoilWater(N, isLand, precip, temp, 300, 30);
    const b = solveSoilWater(N, isLand, precip, temp, 300, 30);
    for (let m = 0; m < 12; m++) {
      expect([...(b.actualEtMm[m] ?? [])]).toEqual([...(a.actualEtMm[m] ?? [])]);
    }
  });
});
