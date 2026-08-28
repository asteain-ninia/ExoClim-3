// 段 25: CRH を輸送の内部で解く経路を守る。
//
// なぜ要るか(2026-08-15):
//   CRH は前の結合反復が解いた W から作られており、解いていた式は
//   `P_k = λ·G(W_{k−1})·W_k` という **1 段遅れの帰還**だった。
//   遅延つき帰還は 2 周期振動を生む形で、実測でも残差が偶奇 2 系列に割れ、
//   外側の緩和・Anderson 加速・その併用のどれでも救えなかった(段 23・24)。
//   G と W を輸送の内部で一緒に解くと 5 回で収束する(段 25)。
//
//   **この経路は既定で無効**(`CRH_INNER.enabled = false`)なので、
//   通常のテストでは 1 行も踏まれない。**踏まれない道は静かに腐る**ので、
//   ここで明示的に踏んでおく。
//
// 守る不変量は 2 つ:
//   1. 診断の `condRateG` に CRH が**掛け戻されている**こと。
//      内部で解くと G から CRH が外れるので、掛け戻しを忘れると
//      因子分解の恒等式(倍率の積 = G)が静かに壊れる。
//   2. W が凝結量と対であること(含意される凝結率が λ·G を超えない)。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EARTH_PARAMS } from '../../../src/domain/planetParams';
import { runPipelineWithPrecipDiag } from '../../../src/sim/pipeline';
import type { PipelineResult } from '../../../src/sim/types';
import type { PrecipDiagnostics } from '../../../src/sim/step06_precipitation';
import { CRH_INNER } from '../../../src/sim/step06_precipitation';
import { MODEL_CONSTANTS } from '../../../src/sim/constants';

/** 定数は readonly なので、実験用に書き換えるときだけキャストで開ける */
const K = MODEL_CONSTANTS as unknown as Record<string, number>;
import { SECONDS_PER_MONTH } from '../../../src/sim/moisture_transport';

const P2 = { ...EARTH_PARAMS, gridResolutionDeg: 2 };
const SHARPNESS = 2;

let run: { result: PipelineResult; precipDiag: PrecipDiagnostics };
let baseSharpness = 0;

beforeAll(async () => {
  baseSharpness = K['crhSuppressionSharpness'] ?? 0;
  K['crhSuppressionSharpness'] = SHARPNESS;
  CRH_INNER.enabled = true;
  run = await runPipelineWithPrecipDiag(P2);
}, 600_000);

afterAll(() => {
  // **必ず戻す。** モジュール全体の可変状態なので、漏らすと他のテストが汚れる
  CRH_INNER.enabled = false;
  K['crhSuppressionSharpness'] = baseSharpness;
});

describe('CRH を輸送の内部で解く(段 25)', () => {
  it('この設定で CRH が実際に効いている(倍率が 1 でないセルがある)', () => {
    const d = run.precipDiag;
    let suppressed = 0;
    for (let m = 0; m < 12; m += 3) {
      const c = d.crhSuppression[m];
      if (!c) continue;
      for (let i = 0; i < c.length; i += 7) {
        if ((c[i] ?? 1) < 0.99) suppressed++;
      }
    }
    // 効いていなければ、以降の不変量は何も検査していないことになる
    expect(suppressed).toBeGreaterThan(100);
  });

  it('診断の G に CRH が掛け戻されている(因子分解の恒等式が保たれる)', () => {
    const d = run.precipDiag;
    let checked = 0;
    let maxRelErr = 0;
    for (let m = 0; m < 12; m++) {
      const g = d.condRateG[m];
      if (!g) continue;
      for (let i = 0; i < g.length; i += 11) {
        const factors =
          (d.upwindBlock[m]?.[i] ?? 1) *
          (d.liftItcz[m]?.[i] ?? 1) *
          (d.liftFrontal[m]?.[i] ?? 1) *
          (d.liftOrographic[m]?.[i] ?? 1) *
          (d.liftConvergence[m]?.[i] ?? 1) *
          (d.subsidenceResidual[m]?.[i] ?? 1) *
          (d.liftOther[m]?.[i] ?? 1) *
          (d.crhSuppression[m]?.[i] ?? 1);
        const gv = g[i] ?? 0;
        maxRelErr = Math.max(maxRelErr, Math.abs(factors - gv) / Math.max(1e-3, gv));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(maxRelErr).toBeLessThan(1e-4);
  });

  it('可降水量 W は凝結量と対のまま(含意される凝結率が閉包の上限を超えない)', () => {
    const d = run.precipDiag;
    const land = run.result.context.terrain.landMask;
    const travelKmPerMonth = (MODEL_CONSTANTS.condensationRefWindMs * SECONDS_PER_MONTH) / 1000;
    // 凝結閉包の二成分化(2026-08-26)後の上限(2026-08-28 更新):
    //   C = lin·W + conv·max(0, W − cap) ≤ [lin + c·conv]·W
    //   lin = (1−c)·rate_old + c·(30.44/τ_bg)
    // 旧検査は rate_old だけを上限にしており、v37(c=0.24)採用の瞬間から
    // 恒等的に破れていた(HEAD でも再現する既存不具合として 2026-08-28 に発見)。
    // cap 項は 0 で抑えた保守的上限なので、原理性は保ったまま閉包に追随する。
    const c = MODEL_CONSTANTS.condensationClosureBlend as number;
    const bgRate = c > 0 ? 30.44 / Math.max(0.1, MODEL_CONSTANTS.backgroundCondensationTimeDays) : 0;
    const convRate = c > 0 ? 30.44 / Math.max(0.05, MODEL_CONSTANTS.convectiveAdjustmentDays) : 0;
    let checked = 0;
    let worstRatio = 0;
    for (let m = 0; m < 12; m++) {
      const w = d.waterMm[m];
      const pre = d.preAdjustMm[m];
      const g = d.condRateG[m];
      if (!w || !pre || !g) continue;
      for (let i = 0; i < w.length; i += 11) {
        const water = w[i] ?? 0;
        if (water <= 1e-6) continue;
        const lKm = land[i]
          ? MODEL_CONSTANTS.moistureDecayLandKm
          : MODEL_CONSTANTS.moistureDecayOceanKm;
        const rateOld = Math.max(0.05, (travelKmPerMonth / Math.max(1, lKm)) * (g[i] ?? 0));
        const rate = c > 0 ? (1 - c) * rateOld + c * bgRate + c * convRate : rateOld;
        worstRatio = Math.max(worstRatio, (pre[i] ?? 0) / water / Math.max(1e-9, rate));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // **許容は原理から出る値を使う(実測に合わせた値ではない)。**
    // 外側反復は収束を `|target − prev| / rate < VIRGA_TOLERANCE (5e-3)` で判定し、
    // 実際に使う率は `rateEff = prev + α(target − prev)` である。したがって
    //   |rateEff − target| = (1−α)|prev − target| < VIRGA_TOLERANCE · rate
    // となり、比の上限は **1 + 5e-3** になる。緩和つき反復である以上、
    // これより厳しい一致は原理的に要求できない
    // (virga も CRH も無効なら緩和が無いので厳密に一致し、
    //  precip_diag.test.ts はそちらを 1e-3 で守っている)。
    expect(worstRatio).toBeLessThan(1 + 5e-3);
  });

  it('結合反復が収束する(2 周期に割れない)', () => {
    const c = run.result.precipitation.coupling;
    expect(c.finalResidualMmPerMonth).toBeLessThanOrEqual(c.toleranceMmPerMonth);
    expect(c.converged).toBe(true);
  });
});
