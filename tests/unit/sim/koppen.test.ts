import { describe, expect, it } from 'vitest';
import { classifyKoppenCell } from '@/sim/step07_koppen';
import { KOPPEN_CLASSES } from '@/domain/koppen';

// 月 0 = 冬至開始月(北半球では 1 月相当)。実在都市の平年値の概数で判定を確認する。
function sym(id: number): string {
  return KOPPEN_CLASSES[id] ?? '?';
}

describe('ケッペン判定(教科書ケース)', () => {
  it('シンガポール型 → Af', () => {
    const t = Array(12).fill(27);
    const p = Array(12).fill(200);
    expect(sym(classifyKoppenCell(t, p, true))).toBe('Af');
  });

  it('カイロ型(高温砂漠) → BWh', () => {
    const t = [14, 15, 18, 22, 26, 28, 28, 28, 26, 24, 19, 15];
    const p = [5, 4, 4, 1, 1, 0, 0, 0, 0, 1, 3, 5];
    expect(sym(classifyKoppenCell(t, p, true))).toBe('BWh');
  });

  it('ローマ型(地中海性) → Csa', () => {
    const t = [8, 9, 11, 14, 18, 22, 25, 25, 22, 17, 12, 9];
    const p = [80, 70, 65, 60, 40, 25, 15, 25, 65, 95, 110, 90];
    expect(sym(classifyKoppenCell(t, p, true))).toBe('Csa');
  });

  it('東京型(温暖湿潤) → Cfa', () => {
    const t = [5, 6, 9, 14, 19, 22, 26, 27, 24, 18, 13, 8];
    const p = [50, 55, 115, 130, 140, 170, 155, 170, 210, 200, 90, 50];
    expect(sym(classifyKoppenCell(t, p, true))).toBe('Cfa');
  });

  it('モスクワ型(冷帯湿潤) → Dfb', () => {
    const t = [-8, -7, -2, 6, 13, 17, 19, 17, 11, 5, -2, -6];
    const p = [40, 35, 35, 40, 50, 70, 85, 75, 60, 60, 50, 45];
    expect(sym(classifyKoppenCell(t, p, true))).toBe('Dfb');
  });

  it('イルクーツク型(冬乾寒冷) → Dw 系', () => {
    const t = [-18, -15, -7, 2, 10, 16, 18, 15, 8, 0, -10, -16];
    const p = [12, 8, 10, 18, 30, 75, 110, 90, 50, 20, 18, 15];
    expect(sym(classifyKoppenCell(t, p, true)).startsWith('Dw')).toBe(true);
  });

  it('ツンドラ型 → ET、氷床型 → EF', () => {
    const tundraT = [-25, -26, -22, -14, -4, 2, 5, 4, 0, -8, -17, -23];
    const p = Array(12).fill(15);
    expect(sym(classifyKoppenCell(tundraT, p, true))).toBe('ET');
    const iceT = tundraT.map((x) => x - 20);
    expect(sym(classifyKoppenCell(iceT, p, true))).toBe('EF');
  });

  it('南半球では夏半年が反転する(シドニー型 → C 群)', () => {
    // 月 0 = 南半球の夏
    const t = [23, 23, 21, 18, 15, 12, 11, 12, 15, 18, 20, 22];
    const p = [100, 110, 120, 110, 100, 120, 80, 70, 60, 70, 80, 90];
    const cls = sym(classifyKoppenCell(t, p, false));
    expect(cls.startsWith('C')).toBe(true);
  });

  it('ステップ型(半乾燥) → BSk', () => {
    const t = [-4, -2, 4, 12, 18, 23, 26, 25, 19, 11, 3, -3];
    const p = [10, 12, 20, 30, 45, 40, 30, 25, 25, 25, 15, 10];
    expect(sym(classifyKoppenCell(t, p, true))).toBe('BSk');
  });

  it('乾燥判定は夏雨集中で閾値が上がる(70% 夏雨 + 少雨 → B)', () => {
    const t = [10, 12, 16, 20, 24, 28, 30, 29, 25, 20, 14, 11];
    const pSummerHeavy = [5, 5, 10, 30, 60, 90, 100, 80, 40, 10, 5, 5]; // 440mm、夏 400
    const cls = sym(classifyKoppenCell(t, pSummerHeavy, true));
    expect(cls.startsWith('B')).toBe(true);
  });
});
