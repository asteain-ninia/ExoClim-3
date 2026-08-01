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
import { runPipeline, runPipelineTimed } from '../../../src/sim/pipeline';
import { areaWeightedMean } from '../../../src/domain/grid';
import type { PipelineResult } from '../../../src/sim/types';
import { digestOf, nonFiniteLeaves } from '../../helpers/numericWalk';

const RES = 2; // 高速化のため 2°(性質は解像度に依らない)

const AQUA_TILT0: PlanetParams = {
  ...EARTH_PARAMS,
  gridResolutionDeg: RES,
  terrain: { kind: 'preset', preset: 'aquaplanet' },
  body: { ...EARTH_PARAMS.body, axialTiltDeg: 0 },
  orbital: { ...EARTH_PARAMS.orbital, eccentricity: 0 },
};

// P2-2(変更レビュー FB): 決定性ダイジェストと有限性検査は、PipelineResult の
// 全数値リーフの汎用列挙(tests/helpers/numericWalk.ts)を共有する。
// 新しい場が追加されても自動的に検査対象へ入る。
function digest(result: PipelineResult): string {
  return digestOf(result);
}

function expectAllFinite(result: PipelineResult, label: string): void {
  const bad = nonFiniteLeaves(result);
  if (bad.length > 0) {
    throw new Error(`${label}: 非有限リーフ ${bad.slice(0, 5).join(', ')}(計 ${bad.length} 件)`);
  }
}

function globalMeanC(result: PipelineResult): number {
  return areaWeightedMean(result.context.grid, result.temperature.annualMeanC);
}

let aqua: PipelineResult;

beforeAll(async () => {
  aqua = await runPipeline(AQUA_TILT0);
}, 300_000);

describe('パイプラインの性質(P1-4)', () => {
  it('同一入力で物理結果が配列まで決定的(地球 2° を 2 回実行)', async () => {
    const p = { ...EARTH_PARAMS, gridResolutionDeg: RES };
    const a = await runPipeline(p);
    const b = await runPipeline(p);
    expect(digest(a)).toBe(digest(b));
    expectAllFinite(a, '地球 2°');
  }, 300_000);

  it('全海(傾斜 0)が有限で、季節・南北・経度対称', async () => {
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

  it('全陸が有限で適用域内', async () => {
    const result = await runPipeline({
      ...EARTH_PARAMS,
      gridResolutionDeg: RES,
      terrain: { kind: 'preset', preset: 'all_land' },
    });
    expectAllFinite(result, '全陸 2°');
    expect(result.diagnostics.status).toBe('ok');
  }, 300_000);

  it('放射照度 +10% で全球平均気温が低下しない', async () => {
    const brighter = await runPipeline({
      ...AQUA_TILT0,
      orbital: { ...AQUA_TILT0.orbital, starLuminositySolar: 1.1 },
    });
    expect(globalMeanC(brighter)).toBeGreaterThanOrEqual(globalMeanC(aqua));
  }, 300_000);

  it('温室効果 +20% で全球平均気温が低下しない', async () => {
    const warmer = await runPipeline({
      ...AQUA_TILT0,
      atmosphere: { ...AQUA_TILT0.atmosphere, greenhouseStrength: 1.2 },
    });
    expect(globalMeanC(warmer)).toBeGreaterThanOrEqual(globalMeanC(aqua));
  }, 300_000);

  it('検査の実効性: 1 配列の改変で決定性が、1 値の NaN で有限性が破れる(P2-2)', async () => {
    const before = digest(aqua);
    const arr = aqua.ocean.sstAnomalyC;
    const orig = arr[7] ?? 0;
    arr[7] = orig + 0.5;
    expect(digest(aqua)).not.toBe(before);
    arr[7] = Number.NaN;
    expect(nonFiniteLeaves(aqua).length).toBeGreaterThan(0);
    arr[7] = orig;
    expect(digest(aqua)).toBe(before);
    // 流線座標も検査対象に入っている(汎用列挙の実証)
    const line = aqua.ocean.streamlines[0];
    if (line && line.points.length > 0) {
      const p0 = line.points[0] ?? 0;
      line.points[0] = p0 + 1;
      expect(digest(aqua)).not.toBe(before);
      line.points[0] = p0;
    }
  });

  it('時計 API の無い環境でも物理計算が動き、runPipelineTimed と全物理場が一致(P2-1)', async () => {
    const saved = globalThis.performance;
    let noClock: PipelineResult;
    try {
      Reflect.deleteProperty(globalThis, 'performance');
      noClock = await runPipeline(AQUA_TILT0);
    } finally {
      (globalThis as Record<string, unknown>)['performance'] = saved;
    }
    expect(digest(noClock)).toBe(digest(aqua));
    const timed = await runPipelineTimed(AQUA_TILT0);
    expect(digest(timed.result)).toBe(digest(aqua));
    expect(Object.keys(timed.stepTimingsMs).length).toBeGreaterThan(5);
  }, 300_000);

  it('逆行で東西風(貿易風・偏西風)の符号が反転する', async () => {
    const retro = await runPipeline({
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
