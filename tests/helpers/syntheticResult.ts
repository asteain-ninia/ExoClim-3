// 採点層テスト用の合成 PipelineResult(パイプライン非実行)。
// 観測ラスターを土台に決定的な摂動を加える — 完全一致でも全滅でもない
// 中間の成績になるため、採点の比較が退化しない。

import { createGrid } from '../../src/domain/grid';
import type { PipelineResult } from '../../src/sim/types';
import { getKoppenObs } from '../../scripts/scoring';

export function syntheticResult(): PipelineResult {
  const grid = createGrid(1);
  const obs = getKoppenObs();
  const land = new Uint8Array(grid.cellCount);
  const classId = new Uint8Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    const o = obs.classRaster[i] ?? 0;
    if (o === 0) continue;
    land[i] = 1;
    classId[i] = i % 7 === 0 ? ((o + 2) % 30) + 1 : o;
  }
  const monthlyTemperatureC: Float32Array[] = [];
  const monthlyPrecipMm: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    const t = new Float32Array(grid.cellCount);
    const p = new Float32Array(grid.cellCount);
    const itczLat = 8 * Math.sin((2 * Math.PI * (m - 3)) / 12);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5);
      const seasonal = 8 * Math.sin((2 * Math.PI * (m - 3)) / 12) * (lat >= 0 ? 1 : -1);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        t[i] = 28 * Math.cos((lat * Math.PI) / 180) - 8 + seasonal;
        p[i] = 30 + 180 * Math.exp(-(((lat - itczLat) / 12) ** 2)) + 10 * Math.sin((col * Math.PI) / 45);
      }
    }
    monthlyTemperatureC.push(t);
    monthlyPrecipMm.push(p);
  }
  const annualMeanC = new Float32Array(grid.cellCount);
  const annualPrecipMm = new Float32Array(grid.cellCount);
  for (let i = 0; i < grid.cellCount; i++) {
    let ts = 0;
    let ps = 0;
    for (let m = 0; m < 12; m++) {
      ts += monthlyTemperatureC[m]?.[i] ?? 0;
      ps += monthlyPrecipMm[m]?.[i] ?? 0;
    }
    annualMeanC[i] = ts / 12;
    annualPrecipMm[i] = ps;
  }
  const monthlyCenterLatDegByCol: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    const c = new Float32Array(grid.widthCells);
    for (let col = 0; col < grid.widthCells; col++) {
      c[col] = 8 * Math.sin((2 * Math.PI * (m - 3)) / 12) + 2 * Math.sin((col * Math.PI) / 90);
    }
    monthlyCenterLatDegByCol.push(c);
  }
  return {
    context: { grid, terrain: { landMask: land } },
    koppen: { classId },
    temperature: { monthlyTemperatureC, annualMeanC },
    precipitation: { monthlyPrecipMm, annualPrecipMm },
    itcz: { monthlyCenterLatDegByCol, halfWidthDeg: 10 },
  } as unknown as PipelineResult;
}
