// R2(地域降水 FB §6): 供給場の循環 3 点月ブレンド。
// 受入条件のうち「1 月と 12 月の循環境界を含むテスト」をここで固定する。

import { describe, expect, it } from 'vitest';
import {
  SUPPLY_MONTH_BLEND_SIDE,
  blendSupplyMonths,
} from '../../../src/sim/step06_precipitation';

function months(values: number[]): Float32Array[] {
  return values.map((v) => Float32Array.from([v, v * 10]));
}

describe('供給月ブレンド(R2)', () => {
  const arr = months([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);

  it('中間月: 0.25/0.5/0.25 の重みで混ざる', () => {
    const out = blendSupplyMonths(arr, 5, 2, 0.25);
    expect(out[0]).toBeCloseTo(0.25 * 50 + 0.5 * 60 + 0.25 * 70, 5);
    expect(out[1]).toBeCloseTo(10 * (0.25 * 50 + 0.5 * 60 + 0.25 * 70), 4);
  });

  it('循環境界: 1 月(m=0)は 12 月と 2 月を、12 月(m=11)は 11 月と 1 月を隣接に取る', () => {
    const jan = blendSupplyMonths(arr, 0, 2, 0.25);
    expect(jan[0]).toBeCloseTo(0.25 * 120 + 0.5 * 10 + 0.25 * 20, 5);
    const dec = blendSupplyMonths(arr, 11, 2, 0.25);
    expect(dec[0]).toBeCloseTo(0.25 * 110 + 0.5 * 120 + 0.25 * 10, 5);
  });

  it('side=0 は恒等写像(旧挙動の再現手段)', () => {
    for (let m = 0; m < 12; m++) {
      const out = blendSupplyMonths(arr, m, 2, 0);
      expect(out[0]).toBe(arr[m]![0]);
      expect(out[1]).toBe(arr[m]![1]);
    }
  });

  it('断絶の谷が埋まる: 隣接月が湿潤な 0 供給月が 1/4 水準まで回復', () => {
    const gap = months([80, 80, 80, 80, 80, 80, 0, 80, 80, 80, 80, 80]);
    const out = blendSupplyMonths(gap, 6, 2, 0.25);
    expect(out[0]).toBeCloseTo(40, 5); // 0.25×80 + 0.5×0 + 0.25×80
    // 連続した乾季(3 か月以上 0)は中央月が 0 のまま(サバナ・地中海を消さない)
    const dry = months([80, 80, 80, 0, 0, 0, 80, 80, 80, 80, 80, 80]);
    const mid = blendSupplyMonths(dry, 4, 2, 0.25);
    expect(mid[0]).toBe(0);
  });

  it('採用値は 0.25(実験の事前凍結値)', () => {
    expect(SUPPLY_MONTH_BLEND_SIDE).toBe(0.25);
  });
});
