// 較正は数値的に解けなかった評価を**失格**にしなければならない。
//
// 2026-08-14 まで、失格の判定は optimize_worker.ts の 1 行
// (EBM_SOLVER_STATS.capHits > 0)だけで、収束を要する 5 系統のうち
// 1 系統しか見ていなかった。しかも逐次経路(--parallel 1)には判定が
// 1 つも無く、完全に無防備だった。
//
// **未収束の解にも成績はつく。** 実測では、結合反復の残差が許容の 233 倍の
// 設定(鋭さ 4)の v3 が 81.781 で、収束している鋭さ 2 の 78.251 より良い。
// 目的関数は数値の破綻を検出できないので、関門が要る。
//
// 詳細: docs/実験記録_凝結率の幅の再測定_2026-08-14.md、docs/教訓.md §9

import { describe, expect, it } from 'vitest';
import { UNSOLVED_FITNESS, disqualifyIfUnsound, type Scores } from '../../../scripts/optimize_lib';
import { evaluateNumericalSoundness } from '../../../scripts/validate_criteria';

function scores(sound: boolean, failures: string[] = []): Scores {
  return {
    majorPct: 74.5,
    detailPct: 44.9,
    gates: 13,
    tempRmse: 3.5,
    precipRmse: 700,
    landMeanMm: 700,
    itczRmse: 1,
    fitness: 85.235,
    fitnessV2: 80,
    fitnessV3: 84,
    fitnessV4: 83,
    fitnessV5: 82.5,
    fitnessV6: 82.4,
    sstAnomRmseC: 1.2,
    landWindRmseMs: 2.5,
    precipPhaseBandMeanDays: 65,
    precipPhaseRmseDays: 71,
    continuousV3: 70,
    gateShare: 7.5,
    precipQuantileLogErr: 0.6,
    precipQuantiles: [],
    numericallySound: sound,
    numericalFailures: failures,
    tempRangeRmse: 9,
    tempPhaseRmseDays: 71,
    precipDriestRmse: 20,
    precipWettestRmse: 100,
  };
}

/** 健全な評価の指標(現行の実測値に近い値) */
const 健全 = {
  ebmMaxResidualC: 2.48e-5,
  ebmMeanYearDriftC: 3.19e-2,
  precipCouplingConverged: true,
  soilConverged: true,
  moistureTransportNonConverged: 0,
  virgaNonConverged: 0,
};

describe('較正の数値的関門', () => {
  it('健全でない評価は失格になる(減点ではなく失格)', () => {
    const s = disqualifyIfUnsound(scores(false, ['結合反復が未収束']));
    expect(s.fitness).toBe(UNSOLVED_FITNESS);
  });

  it('健全な評価の成績は変えない', () => {
    const s = disqualifyIfUnsound(scores(true));
    expect(s.fitness).toBe(85.235);
  });

  it('現行の実測値は関門を通る', () => {
    expect(evaluateNumericalSoundness(健全).pass).toBe(true);
  });

  // ---- 5 系統それぞれが単独で関門を落とせること ----
  // 1 つでも見落とすと、その系統が発散した解が「良い成績」として採用される。

  it('結合反復の未収束だけで落ちる', () => {
    const v = evaluateNumericalSoundness({ ...健全, precipCouplingConverged: false });
    expect(v.pass).toBe(false);
    expect(v.failures.length).toBeGreaterThan(0);
  });

  it('土壌の未収束だけで落ちる', () => {
    expect(evaluateNumericalSoundness({ ...健全, soilConverged: false }).pass).toBe(false);
  });

  it('輸送の未収束だけで落ちる', () => {
    expect(
      evaluateNumericalSoundness({ ...健全, moistureTransportNonConverged: 1 }).pass,
    ).toBe(false);
  });

  it('virga の未収束だけで落ちる', () => {
    expect(evaluateNumericalSoundness({ ...健全, virgaNonConverged: 1 }).pass).toBe(false);
  });

  it('EBM の線形解の残差だけで落ちる', () => {
    expect(evaluateNumericalSoundness({ ...健全, ebmMaxResidualC: 1 }).pass).toBe(false);
  });

  it('EBM の周期定常のドリフトだけで落ちる', () => {
    expect(evaluateNumericalSoundness({ ...健全, ebmMeanYearDriftC: 1 }).pass).toBe(false);
  });
});
