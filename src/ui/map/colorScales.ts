// マップ配色。ケッペンは Beck 標準配色(domain/koppen.ts)、
// 気温は青-赤の発散、降水は対数の白-青-緑、地形は段彩。

import { KOPPEN_COLORS } from '@/domain/koppen';

export type Rgb = readonly [number, number, number];

export const OCEAN_COLOR: Rgb = [18, 32, 58];

export function koppenColor(classId: number, isLand: boolean): Rgb {
  if (!isLand || classId === 0) return OCEAN_COLOR;
  return KOPPEN_COLORS[classId] ?? [0, 0, 0];
}

export function temperatureColor(tempC: number): Rgb {
  const x = Math.max(-45, Math.min(45, tempC)) / 45;
  if (x >= 0) {
    return [255, Math.round(210 * (1 - x)), Math.round(255 * (1 - x))];
  }
  return [Math.round(255 * (1 + x)), Math.round(210 * (1 + x)), 255];
}

export function precipitationColor(mmPerYear: number, isLand: boolean): Rgb {
  if (!isLand) return OCEAN_COLOR;
  const x = Math.min(1, Math.log1p(mmPerYear) / Math.log1p(4000));
  return [
    Math.round(250 - 215 * x),
    Math.round(247 - 122 * x),
    Math.round(230 - 40 * x),
  ];
}

export function terrainColor(elevationM: number, isLand: boolean): Rgb {
  if (!isLand) {
    const d = Math.min(1, Math.max(0, -elevationM / 6000));
    return [Math.round(30 - 12 * d), Math.round(70 - 38 * d), Math.round(140 - 80 * d)];
  }
  const stops: Array<[number, Rgb]> = [
    [0, [96, 138, 88]],
    [500, [140, 162, 96]],
    [1000, [190, 178, 110]],
    [2000, [166, 132, 90]],
    [3500, [150, 140, 135]],
    [5500, [240, 240, 240]],
  ];
  let prev = stops[0] as [number, Rgb];
  for (const stop of stops) {
    if (elevationM <= stop[0]) {
      const [e0, c0] = prev;
      const [e1, c1] = stop;
      const t = e1 === e0 ? 0 : (elevationM - e0) / (e1 - e0);
      return [
        Math.round((c0[0] ?? 0) + ((c1[0] ?? 0) - (c0[0] ?? 0)) * t),
        Math.round((c0[1] ?? 0) + ((c1[1] ?? 0) - (c0[1] ?? 0)) * t),
        Math.round((c0[2] ?? 0) + ((c1[2] ?? 0) - (c0[2] ?? 0)) * t),
      ];
    }
    prev = stop;
  }
  return prev[1];
}
