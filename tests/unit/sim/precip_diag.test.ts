// R1(地域降水 FB §5): 降水内部要因の診断。
// 受入条件: 各因子から最終降水を許容誤差内で再構成できる/
// 診断を無効にした通常実行の配列を退行させない(ビット一致)。

import { beforeAll, describe, expect, it } from 'vitest';
import { EARTH_PARAMS } from '../../../src/domain/planetParams';
import { runPipeline, runPipelineWithPrecipDiag } from '../../../src/sim/pipeline';
import type { PipelineResult } from '../../../src/sim/types';
import type { PrecipDiagnostics } from '../../../src/sim/step06_precipitation';
import { MODEL_CONSTANTS } from '../../../src/sim/constants';
import { digestOf } from '../../helpers/numericWalk';

const P2 = { ...EARTH_PARAMS, gridResolutionDeg: 2 };

let plain: PipelineResult;
let diagRun: { result: PipelineResult; precipDiag: PrecipDiagnostics };

beforeAll(async () => {
  plain = await runPipeline(P2);
  diagRun = await runPipelineWithPrecipDiag(P2);
}, 300_000);

describe('降水内部要因の診断(R1)', () => {
  it('診断の有無で物理結果が配列までビット一致(通常実行を退行させない)', async () => {
    expect(digestOf(diagRun.result)).toBe(digestOf(plain));
  });

  // 因子分解が何を再構成できるかは**どちらの降水の作り方か**で変わる。
  //   非保存: 降水そのもの = 供給 × 倍率の積 × 変換係数
  //   保存型: 降水は輸送方程式の解。倍率の積が再構成するのは**凝結率の係数 G**
  //           までで、降水そのものではない(2026-08-10 に取り違えが発覚 —
  //           診断は段 6 以降ずっと旧経路を走らせ直して報告していた)
  it('全因子から、実際に走った演算子の量を再構成できる', async () => {
    const d = diagRun.precipDiag;
    const conservative = MODEL_CONSTANTS.conservativeMoisture > 0;
    let checked = 0;
    let maxRelErr = 0;
    for (let m = 0; m < 12; m++) {
      const pre = d.preAdjustMm[m]!;
      for (let i = 0; i < pre.length; i += 11) {
        const factors =
          (d.upwindBlock[m]?.[i] ?? 1) *
          (d.liftItcz[m]?.[i] ?? 1) *
          (d.liftFrontal[m]?.[i] ?? 1) *
          (d.liftOrographic[m]?.[i] ?? 1) *
          (d.liftConvergence[m]?.[i] ?? 1) *
          (d.subsidenceResidual[m]?.[i] ?? 1) *
          (d.liftOther[m]?.[i] ?? 1) *
          (d.crhSuppression[m]?.[i] ?? 1);
        if (conservative) {
          const g = d.condRateG[m]?.[i] ?? 0;
          maxRelErr = Math.max(maxRelErr, Math.abs(factors - g) / Math.max(1e-3, g));
        } else {
          const supply =
            (d.supplyOcean[m]?.[i] ?? 0) +
            (d.supplyLand[m]?.[i] ?? 0) +
            (d.supplyStorm[m]?.[i] ?? 0);
          const recon = supply * factors * d.mmPerSupplyUnit;
          maxRelErr = Math.max(maxRelErr, Math.abs(recon - (pre[i] ?? 0)) / Math.max(1, pre[i] ?? 0));
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(maxRelErr).toBeLessThan(1e-4); // 因子積の恒等式
  });

  // 後処理は陸のみ・全セルで厳密な加算差分。**この不変量は両方の経路で成り立つ**
  it('最終降水 = 後処理前 + 後処理差分(全セルで厳密)', async () => {
    const d = diagRun.precipDiag;
    let maxErrMm = 0;
    for (let m = 0; m < 12; m++) {
      const pre = d.preAdjustMm[m]!;
      const fin = diagRun.result.precipitation.monthlyPrecipMm[m]!;
      for (let i = 0; i < pre.length; i += 11) {
        const recon = (pre[i] ?? 0) + (d.postAdjustDeltaMm[m]?.[i] ?? 0);
        maxErrMm = Math.max(maxErrMm, Math.abs(recon - (fin[i] ?? 0)));
      }
    }
    expect(maxErrMm).toBeLessThan(0.01);
  });

  it('後処理差分は陸のみ(海セルでは 0 = 最終と変換直後が一致)', async () => {
    const d = diagRun.precipDiag;
    const land = diagRun.result.context.terrain.landMask;
    let landDeltaCells = 0;
    for (let m = 0; m < 12; m += 3) {
      const pre = d.preAdjustMm[m]!;
      const fin = diagRun.result.precipitation.monthlyPrecipMm[m]!;
      const delta = d.postAdjustDeltaMm[m]!;
      for (let i = 0; i < pre.length; i += 13) {
        if (!land[i]) {
          expect(fin[i]).toBe(pre[i]);
          expect(delta[i]).toBe(0);
        } else if (Math.abs(delta[i] ?? 0) > 0.1) {
          landDeltaCells++;
        }
      }
    }
    expect(landDeltaCells).toBeGreaterThan(0); // 後処理が実在することの確認
  });

  it('倍率は物理的に妥当な範囲(遮蔽・沈降残存は (0,1]、持上げは ≥1 または雨陰下限以上)', async () => {
    const d = diagRun.precipDiag;
    for (let m = 0; m < 12; m += 4) {
      for (let i = 0; i < (d.liftItcz[m]?.length ?? 0); i += 17) {
        expect(d.upwindBlock[m]?.[i] ?? 1).toBeGreaterThan(0);
        expect(d.upwindBlock[m]?.[i] ?? 1).toBeLessThanOrEqual(1);
        expect(d.subsidenceResidual[m]?.[i] ?? 1).toBeGreaterThan(0);
        expect(d.subsidenceResidual[m]?.[i] ?? 1).toBeLessThanOrEqual(1);
        expect(d.liftItcz[m]?.[i] ?? 1).toBeGreaterThanOrEqual(1);
        expect(d.liftFrontal[m]?.[i] ?? 1).toBeGreaterThanOrEqual(1);
        expect(d.liftOrographic[m]?.[i] ?? 1).toBeGreaterThan(0);
        const supplies = (d.supplyOcean[m]?.[i] ?? 0) + (d.supplyStorm[m]?.[i] ?? 0);
        expect(Number.isFinite(supplies)).toBe(true);
        expect(d.supplyOcean[m]?.[i] ?? 0).toBeGreaterThanOrEqual(0);
        expect(d.supplyStorm[m]?.[i] ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
