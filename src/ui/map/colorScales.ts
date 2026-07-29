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

/** 海流: SST 偏差の発散配色(暖流 = 赤系、寒流 = 青系)。陸は薄い中立色 */
export function currentColor(sstAnomalyC: number, isLand: boolean): Rgb {
  if (isLand) return [52, 62, 74];
  const x = Math.max(-3.5, Math.min(3.5, sstAnomalyC)) / 3.5;
  if (x >= 0) {
    return [
      Math.round(40 + 205 * x),
      Math.round(60 + 30 * (1 - x)),
      Math.round(90 - 40 * x),
    ];
  }
  return [Math.round(30 + 10 * (1 + x)), Math.round(70 + 60 * -x), Math.round(120 + 110 * -x)];
}

/** 気圧偏差: 低圧 = 暖色、高圧 = 寒色(天気図の L/R 直感に合わせる) */
export function pressureColor(anomalyHpa: number, isLand: boolean): Rgb {
  const x = Math.max(-8, Math.min(8, anomalyHpa)) / 8;
  const base = isLand ? 30 : 0;
  if (x >= 0) {
    // 高圧: 青
    return [
      Math.round(90 + base - 40 * x),
      Math.round(120 + base + 20 * x),
      Math.round(150 + 100 * x),
    ];
  }
  // 低圧: 橙赤
  return [
    Math.round(90 + base + 150 * -x),
    Math.round(120 + base - 30 * -x),
    Math.round(150 - 110 * -x),
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
