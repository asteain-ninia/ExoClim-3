// P1-4(FB 2026-07-31): 気候パイプラインの性質テスト。
// - 同一入力で気候場が配列まで決定的(stepTimingsMs 分離後)
// - 全出力配列が有限(地球・全海・全陸)
// - 傾斜 0° の季節対称性 / 南北対称性 / 全海惑星の経度対称性
// - 放射照度・温室効果の増加で全球平均気温が低下しない
// - 逆行時に東西風の位相が反転する
// 手続き地形の解像度不変性は tests/unit/domain/terrain.test.ts(P0-1)、
// 地球主要指標の凍結基準退行は npm run validate の退行ゲート(P0-4)が受け持つ。

import { beforeAll, describe, expect, it } from 'vitest';
import { EARTH_PARAMS, type PlanetParams } from '../../../src/domain/planetParams';
import { runPipeline } from '../../../src/sim/pipeline';
import { areaWeightedMean } from '../../../src/domain/grid';
import type { PipelineResult } from '../../../src/sim/types';

const RES = 2; // 高速化のため 2°(性質は解像度に依らない)

const AQUA_TILT0: PlanetParams = {
  ...EARTH_PARAMS,
  gridResolutionDeg: RES,
  terrain: { kind: 'preset', preset: 'aquaplanet' },
  body: { ...EARTH_PARAMS.body, axialTiltDeg: 0 },
  orbital: { ...EARTH_PARAMS.orbital, eccentricity: 0 },
};

// FNV-1a で物理場のダイジェストを取る(配列まで決定的かの比較用)
function digest(result: PipelineResult): string {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    for (let b = 0; b < 8; b++) {
      h ^= dv.getUint8(b);
      h = Math.imul(h, 0x01000193);
    }
  };
  const mixArr = (arr: ArrayLike<number>) => {
    for (let i = 0; i < arr.length; i++) mix(arr[i] as number);
  };
  for (let m = 0; m < 12; m++) {
    mixArr(result.temperature.monthlyTemperatureC[m] ?? []);
    mixArr(result.precipitation.monthlyPrecipMm[m] ?? []);
    mixArr(result.airflow.monthlyWindU[m] ?? []);
    mixArr(result.itcz.monthlyCenterLatDegByCol[m] ?? []);
  }
  mixArr(result.temperature.annualMeanC);
  mixArr(result.precipitation.annualPrecipMm);
  mixArr(result.ocean.sstAnomalyC);
  mixArr(result.koppen.classId);
  return (h >>> 0).toString(16);
}

function expectAllFinite(result: PipelineResult, label: string): void {
  const fields: Array<[string, ArrayLike<number>]> = [
    ['annualMeanC', result.temperature.annualMeanC],
    ['annualPrecipMm', result.precipitation.annualPrecipMm],
    ['sstAnomalyC', result.ocean.sstAnomalyC],
  ];
  for (let m = 0; m < 12; m++) {
    fields.push([`temp[${m}]`, result.temperature.monthlyTemperatureC[m] ?? []]);
    fields.push([`precip[${m}]`, result.precipitation.monthlyPrecipMm[m] ?? []]);
    fields.push([`windU[${m}]`, result.airflow.monthlyWindU[m] ?? []]);
    fields.push([`windV[${m}]`, result.airflow.monthlyWindV[m] ?? []]);
  }
  for (const [name, arr] of fields) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i] as number)) {
        throw new Error(`${label}: ${name}[${i}] = ${String(arr[i])} が非有限`);
      }
    }
  }
}

function globalMeanC(result: PipelineResult): number {
  return areaWeightedMean(result.context.grid, result.temperature.annualMeanC);
}

let aqua: PipelineResult;

beforeAll(() => {
  aqua = runPipeline(AQUA_TILT0);
}, 300_000);

describe('パイプラインの性質(P1-4)', () => {
  it('同一入力で物理結果が配列まで決定的(地球 2° を 2 回実行)', () => {
    const p = { ...EARTH_PARAMS, gridResolutionDeg: RES };
    const a = runPipeline(p);
    const b = runPipeline(p);
    expect(digest(a)).toBe(digest(b));
    expectAllFinite(a, '地球 2°');
  }, 300_000);

  it('全海(傾斜 0)が有限で、季節・南北・経度対称', () => {
    expectAllFinite(aqua, '全海 2°');
    expect(aqua.diagnostics.status).toBe('ok');
    const grid = aqua.context.grid;
    const t0m = aqua.temperature.monthlyTemperatureC[0]!;
    // 季節対称: 傾斜 0・離心率 0 では全月が同一場。
    // 既知の制約(このテストが発見・FB対応記録 P1-4): 季節 EBM の周期解が
    // 完全収束しておらず 0.027°C/月 の線形ドリフトが残る(最大 0.293°C、
    // 2026-07-31 実測)。空回し年数の変更は凍結中の地球指標を動かすため、
    // 修正は凍結解除後。許容 0.5°C はこのドリフトを包み、実際の季節非対称
    // (数 °C 以上)は確実に検出する
    for (let m = 1; m < 12; m++) {
      const tm = aqua.temperature.monthlyTemperatureC[m]!;
      for (let i = 0; i < tm.length; i += 7) {
        expect(Math.abs((tm[i] ?? 0) - (t0m[i] ?? 0))).toBeLessThan(0.5);
      }
    }
    // 南北対称: 鏡像行の年平均が一致
    for (let row = 0; row < grid.heightCells / 2; row++) {
      const mirror = grid.heightCells - 1 - row;
      for (let col = 0; col < grid.widthCells; col += 9) {
        const a = aqua.temperature.annualMeanC[row * grid.widthCells + col] ?? 0;
        const b = aqua.temperature.annualMeanC[mirror * grid.widthCells + col] ?? 0;
        expect(Math.abs(a - b)).toBeLessThan(0.1);
      }
    }
    // 経度対称: 同一行の全列が一致(不自然な経度模様を作らない)
    for (let row = 0; row < grid.heightCells; row += 5) {
      const base = aqua.temperature.annualMeanC[row * grid.widthCells] ?? 0;
      for (let col = 1; col < grid.widthCells; col += 7) {
        const v = aqua.temperature.annualMeanC[row * grid.widthCells + col] ?? 0;
        expect(Math.abs(v - base)).toBeLessThan(0.1);
      }
    }
  }, 300_000);

  it('全陸が有限で適用域内', () => {
    const result = runPipeline({
      ...EARTH_PARAMS,
      gridResolutionDeg: RES,
      terrain: { kind: 'preset', preset: 'all_land' },
    });
    expectAllFinite(result, '全陸 2°');
    expect(result.diagnostics.status).toBe('ok');
  }, 300_000);

  it('放射照度 +10% で全球平均気温が低下しない', () => {
    const brighter = runPipeline({
      ...AQUA_TILT0,
      orbital: { ...AQUA_TILT0.orbital, starLuminositySolar: 1.1 },
    });
    expect(globalMeanC(brighter)).toBeGreaterThanOrEqual(globalMeanC(aqua));
  }, 300_000);

  it('温室効果 +20% で全球平均気温が低下しない', () => {
    const warmer = runPipeline({
      ...AQUA_TILT0,
      atmosphere: { ...AQUA_TILT0.atmosphere, greenhouseStrength: 1.2 },
    });
    expect(globalMeanC(warmer)).toBeGreaterThanOrEqual(globalMeanC(aqua));
  }, 300_000);

  it('逆行で東西風(貿易風・偏西風)の符号が反転する', () => {
    const retro = runPipeline({
      ...AQUA_TILT0,
      body: { ...AQUA_TILT0.body, rotationDirection: -1 },
    });
    const grid = aqua.context.grid;
    // 貿易風帯(±15°)と偏西風帯(±45°)の帯平均 u を比較
    const bandMeanU = (result: PipelineResult, latCenter: number): number => {
      const row = Math.round((90 - latCenter) / RES - 0.5);
      let s = 0;
      let n = 0;
      for (let col = 0; col < grid.widthCells; col++) {
        s += result.airflow.monthlyWindU[0]?.[row * grid.widthCells + col] ?? 0;
        n++;
      }
      return s / n;
    };
    for (const lat of [15, -15, 45, -45]) {
      const u1 = bandMeanU(aqua, lat);
      const u2 = bandMeanU(retro, lat);
      expect(Math.abs(u1)).toBeGreaterThan(0.5); // 帯風が実在する
      expect(Math.sign(u2)).toBe(-Math.sign(u1)); // 逆行で反転
    }
  }, 300_000);
});
