// 第四 FB P0-1/P0-2/P0-3: 統合水収支。
// solveSoilWater 単体ではなく、最終 PipelineResult の降水と同じ実行で得た
// 土壌診断を突き合わせる(結合反復の入力と最終出力が同じ周期解であること)。

import { beforeAll, describe, expect, it } from 'vitest';
import { EARTH_PARAMS, type PlanetParams } from '../../../src/domain/planetParams';
import { runPipelineWithPrecipDiag } from '../../../src/sim/pipeline';
import { areaWeightOfRow } from '../../../src/domain/grid';
import type { PipelineResult } from '../../../src/sim/types';
import type { SoilWaterResult } from '../../../src/sim/step06_precipitation';

interface BudgetSummary {
  precip: number;
  et: number;
  runoff: number;
  storageChange: number;
  signedResidual: number;
  meanAbsResidual: number;
}

/** 面積重み付き全球陸の年水収支(mm/年)とセル別絶対残差平均 */
export function landWaterBudget(result: PipelineResult, soil: SoilWaterResult): BudgetSummary {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  let wsum = 0;
  let p = 0;
  let et = 0;
  let ro = 0;
  let ds = 0;
  let absRes = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!land[i]) continue;
      let cp = 0;
      let cet = 0;
      let cro = 0;
      for (let m = 0; m < 12; m++) {
        cp += result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        cet += soil.actualEtMm[m]?.[i] ?? 0;
        cro += soil.runoffMm[m]?.[i] ?? 0;
      }
      const cds = soil.storageChangeMm[i] ?? 0;
      wsum += w;
      p += w * cp;
      et += w * cet;
      ro += w * cro;
      ds += w * cds;
      absRes += w * Math.abs(cp - cet - cro - cds);
    }
  }
  const n = Math.max(1e-9, wsum);
  return {
    precip: p / n,
    et: et / n,
    runoff: ro / n,
    storageChange: ds / n,
    signedResidual: (p - et - ro - ds) / n,
    meanAbsResidual: absRes / n,
  };
}

describe('統合水収支(第四 FB P0-1)', () => {
  let run: { result: PipelineResult; precipDiag: unknown; soil: SoilWaterResult | null };

  beforeAll(() => {
    const r = runPipelineWithPrecipDiag({ ...EARTH_PARAMS, gridResolutionDeg: 2 });
    run = { result: r.result, precipDiag: r.precipDiag, soil: r.soil };
  }, 600_000);

  it('診断つき実行が土壌診断を返す(捨てない)', () => {
    expect(run.soil).not.toBeNull();
    expect(run.soil?.actualEtMm.length).toBe(12);
  });

  it('全球陸の年水収支が閉じる(|P − ET − 流出 − ΔS| ≤ 1mm/年)', () => {
    const b = landWaterBudget(run.result, run.soil!);
    expect(Math.abs(b.signedResidual)).toBeLessThanOrEqual(1);
    expect(b.precip).toBeGreaterThan(100); // 退化していない
    expect(b.et).toBeGreaterThan(0);
    // 周期定常に到達しているので貯水変化そのものも小さい
    expect(run.soil!.converged).toBe(true);
    expect(Math.abs(b.storageChange)).toBeLessThanOrEqual(1);
  });

  it('セル別年収支の絶対残差平均が 2mm/年以下', () => {
    const b = landWaterBudget(run.result, run.soil!);
    expect(b.meanAbsResidual).toBeLessThanOrEqual(2);
  });

  it('結合反復が上限に到達せず収束している(診断に記録)', () => {
    const c = run.result.precipitation.coupling;
    expect(c).toBeDefined();
    expect(c.converged).toBe(true);
    expect(c.iterations).toBeLessThanOrEqual(c.maxIterations);
    expect(c.finalResidualMmPerMonth).toBeLessThanOrEqual(c.toleranceMmPerMonth);
  });

  it('退化条件(全海・全陸・無降水・高傾斜)で有限かつ収束する', () => {
    const cases: Array<[string, PlanetParams]> = [
      [
        '全海',
        {
          ...EARTH_PARAMS,
          gridResolutionDeg: 4,
          terrain: { kind: 'preset', preset: 'aquaplanet' },
        },
      ],
      [
        '全陸',
        {
          ...EARTH_PARAMS,
          gridResolutionDeg: 4,
          terrain: { kind: 'preset', preset: 'all_land' },
        },
      ],
      [
        '無降水(極寒)',
        {
          ...EARTH_PARAMS,
          gridResolutionDeg: 4,
          orbital: { ...EARTH_PARAMS.orbital, starLuminositySolar: 0.55 },
        },
      ],
      [
        '高傾斜',
        {
          ...EARTH_PARAMS,
          gridResolutionDeg: 4,
          body: { ...EARTH_PARAMS.body, axialTiltDeg: 80 },
        },
      ],
    ];
    for (const [label, p] of cases) {
      const r = runPipelineWithPrecipDiag(p);
      expect(r.result.precipitation.coupling.converged, label).toBe(true);
      for (let m = 0; m < 12; m++) {
        const arr = r.result.precipitation.monthlyPrecipMm[m]!;
        for (let i = 0; i < arr.length; i += 7) {
          expect(Number.isFinite(arr[i] ?? 0), `${label} 月${m}`).toBe(true);
          expect(arr[i] ?? 0, `${label} 月${m}`).toBeGreaterThanOrEqual(0);
        }
      }
      if (r.soil) {
        const b = landWaterBudget(r.result, r.soil);
        expect(Math.abs(b.signedResidual), label).toBeLessThanOrEqual(1);
        expect(b.meanAbsResidual, label).toBeLessThanOrEqual(2);
        expect(r.soil.converged, `${label} 土壌の周期定常`).toBe(true);
      }
    }
  }, 900_000);
});
