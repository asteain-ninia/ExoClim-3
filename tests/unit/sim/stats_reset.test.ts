// 診断の積算器は、リセット関数が**全項目**を戻さなければならない。
//
// 2026-08-14: `resetConservativeStats()` が meanWaterMm / waterSamples を
// 戻しておらず、同一プロセスで複数回パイプラインを回す掃引
// (scripts/exp_pressure_lever.ts)で、表示される W が「その水準の値」ではなく
// 「それまでの全水準の累積平均」になっていた。これが段 20 の主結論
// (「W が実物 25mm に着地した」)を丸ごと無効にした。
// 単発で測る診断スクリプトは自前で 0 にしていたので正しく、**矛盾に気づく
// 機会が無かった**のが厄介なところ。
//
// 項目を足したときにリセット側を直し忘れても、ここで落ちる。
// 詳細: docs/診断_Wの累積汚染_2026-08-14.md、docs/教訓.md §9

import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_STATS,
  resetConservativeStats,
} from '../../../src/sim/step06_precipitation';
import {
  EBM_SOLVER_STATS,
  resetEbmSolverStats,
} from '../../../src/sim/step05_temperature';

/**
 * 積算器に「使用済み」の値を入れてからリセットし、全項目が初期状態に
 * 戻ることを確かめる。**キーを列挙せず Object.keys で回す**ので、
 * 新しい項目を足したらリセットを直さない限り自動的に落ちる。
 */
function 汚してからリセットを確かめる(
  stats: Record<string, unknown>,
  reset: () => void,
   初期値: Record<string, unknown>,
): void {
  for (const key of Object.keys(stats)) {
    const v = stats[key];
    if (typeof v === 'number') {
      stats[key] = 123.456;
    } else if (Array.isArray(v)) {
      (v as unknown[]).push({ 汚し: true });
    } else if (v === null) {
      stats[key] = new Float32Array([1, 2, 3]);
    }
  }

  reset();

  for (const key of Object.keys(初期値)) {
    const actual = stats[key];
    const expected = 初期値[key];
    if (Array.isArray(expected)) {
      expect((actual as unknown[]).length, `${key} が空に戻っていない`).toBe(0);
    } else {
      expect(actual, `${key} がリセットされていない`).toEqual(expected);
    }
  }
}

describe('診断の積算器はリセットで完全に初期化される', () => {
  it('CONSERVATIVE_STATS の全項目が戻る(W の積算を含む)', () => {
    汚してからリセットを確かめる(
      CONSERVATIVE_STATS as unknown as Record<string, unknown>,
      resetConservativeStats,
      {
        nonConverged: 0,
        worstResidual: 0,
        iterations: 0,
        virgaNonConverged: 0,
        meanWaterMm: 0,
        waterSamples: 0,
      },
    );
  });

  it('CONSERVATIVE_STATS に未知の項目が増えていない(増やしたらリセットも直す)', () => {
    // 期待表と実物のキー集合が一致することを確かめる。上のテストは
    // 「期待表に書いた項目」しか見ないので、この 1 件で取りこぼしを塞ぐ。
    expect(Object.keys(CONSERVATIVE_STATS).sort()).toEqual(
      [
        'iterations',
        'meanWaterMm',
        'nonConverged',
        'virgaNonConverged',
        'waterSamples',
        'worstResidual',
      ].sort(),
    );
  });

  it('EBM_SOLVER_STATS の全項目が戻る', () => {
    汚してからリセットを確かめる(
      EBM_SOLVER_STATS as unknown as Record<string, unknown>,
      resetEbmSolverStats,
      {
        totalSweeps: 0,
        steps: 0,
        maxSweeps: 0,
        capHits: 0,
        maxResidualC: 0,
        maxYearDriftC: 0,
        meanYearDriftC: 0,
        fullCapacityYears: 0,
        calls: [],
        stepResidualsC: null,
      },
    );
  });

  it('EBM_SOLVER_STATS に未知の項目が増えていない', () => {
    expect(Object.keys(EBM_SOLVER_STATS).sort()).toEqual(
      [
        'calls',
        'capHits',
        'fullCapacityYears',
        'maxResidualC',
        'maxSweeps',
        'maxYearDriftC',
        'meanYearDriftC',
        'stepResidualsC',
        'steps',
        'totalSweeps',
      ].sort(),
    );
  });
});
