// Step 7: ケッペン=ガイガー気候区分。docs/spec/07_気候帯.md
// 月別気温(°C)・降水(mm)から標準閾値(Peel et al. 2007 / Beck et al. 2023)で
// 判定する。**地理・緯度帯を決め打ちした強制ルールは持たない**(教訓 §1)。
// 夏半年は「北半球 = 月 3〜8(冬至起点の月定義で 4〜9 月相当)」の Peel 準拠。

import { latDegOfRow } from '@/domain/grid';
import { classIdOf } from '@/domain/koppen';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import type { KoppenResult, PrecipitationResult, SimContext, TemperatureResult } from './types';

export function computeKoppen(
  ctx: SimContext,
  temperature: TemperatureResult,
  precipitation: PrecipitationResult,
): KoppenResult {
  const { grid, terrain } = ctx;
  const classId = new Uint8Array(grid.cellCount);
  const tMonths = temperature.monthlyTemperatureC;
  const pMonths = precipitation.monthlyPrecipMm;

  for (let row = 0; row < grid.heightCells; row++) {
    const isNorth = latDegOfRow(grid, row) >= 0;
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!terrain.landMask[i]) continue;
      const t: number[] = [];
      const p: number[] = [];
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        t.push(tMonths[m]?.[i] ?? 0);
        p.push(Math.max(0, pMonths[m]?.[i] ?? 0));
      }
      classId[i] = classifyKoppenCell(t, p, isNorth);
    }
  }
  return { classId };
}

/**
 * 1 セルの判定。t/p は 12 か月(月 0 = 冬至開始月)。
 * isNorth の夏半年 = 月 3〜8、冬半年 = 月 9〜2(南半球は逆)。
 */
export function classifyKoppenCell(t: number[], p: number[], isNorth: boolean): number {
  const mat = mean(t);
  const map = sum(p);
  const tHot = Math.max(...t);
  const tCold = Math.min(...t);

  const summerMonths = isNorth ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const winterMonths = isNorth ? [9, 10, 11, 0, 1, 2] : [3, 4, 5, 6, 7, 8];
  const pSummer = summerMonths.reduce((s, m) => s + (p[m] ?? 0), 0);
  const pWinter = winterMonths.reduce((s, m) => s + (p[m] ?? 0), 0);

  // ---- B 乾燥(Beck 実装と同じく最初に判定) ----
  let pThreshBase = 2 * mat + 14;
  if (map > 0) {
    if (pSummer >= 0.7 * map) pThreshBase = 2 * mat + 28;
    else if (pWinter >= 0.7 * map) pThreshBase = 2 * mat;
  }
  const pThresh = Math.max(0, pThreshBase) * 10; // mm/年
  if (pThresh > 0 && map < pThresh) {
    const w = map < pThresh / 2 ? 'BW' : 'BS';
    const hk = mat >= 18 ? 'h' : 'k';
    return classIdOf(w + hk);
  }

  // ---- E 寒帯 ----
  if (tHot < 10) {
    return classIdOf(tHot > 0 ? 'ET' : 'EF');
  }

  // ---- A 熱帯 ----
  if (tCold >= 18) {
    const pDry = Math.min(...p);
    if (pDry >= 60) return classIdOf('Af');
    if (pDry >= 100 - map / 25) return classIdOf('Am');
    return classIdOf('Aw');
  }

  // ---- C / D(第 2 文字 s/w/f、第 3 文字 a/b/c/d) ----
  const group = tCold > 0 ? 'C' : 'D';
  const pSummerDriest = Math.min(...summerMonths.map((m) => p[m] ?? 0));
  const pSummerWettest = Math.max(...summerMonths.map((m) => p[m] ?? 0));
  const pWinterDriest = Math.min(...winterMonths.map((m) => p[m] ?? 0));
  const pWinterWettest = Math.max(...winterMonths.map((m) => p[m] ?? 0));
  const sCond = pSummerDriest < 40 && pSummerDriest < pWinterWettest / 3;
  const wCond = pWinterDriest < pSummerWettest / 10;
  let second: string;
  if (sCond && wCond) {
    second = pSummer > pWinter ? 'w' : 's';
  } else if (sCond) {
    second = 's';
  } else if (wCond) {
    second = 'w';
  } else {
    second = 'f';
  }
  const monthsAbove10 = t.filter((x) => x >= 10).length;
  let third: string;
  if (tHot >= 22) third = 'a';
  else if (monthsAbove10 >= 4) third = 'b';
  else if (group === 'D' && tCold < -38) third = 'd';
  else third = 'c';
  const symbol = group + second + third;
  const id = classIdOf(symbol);
  // Cs の 'd' は体系に存在しない等、未定義組合せは 'c' に落とす
  return id > 0 ? id : classIdOf(group + second + 'c');
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
