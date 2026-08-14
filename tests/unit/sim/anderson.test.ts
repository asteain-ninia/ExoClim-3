// Anderson 加速(段 24)の実装が正しいことを、**既知の答えがある線形問題**で守る。
//
// なぜ要るか(2026-08-15):
//   結合反復に Anderson を入れて測ったところ、残差が偶奇 2 系列に分裂し、
//   片方だけが下がる形になった。「写像が加速の前提を満たしていない」と
//   結論する前に、**自分の実装が正しいことを確かめていなかった**。
//
//   道具の欠陥を物理(や写像)の結論として記録しないこと — それが前世代の
//   最頻の死に方だった(docs/教訓.md)。実装が壊れているなら、
//   実験の結論はすべて無効になる。
//
// 線形の不動点問題 x = M x + c は答えが解析的に分かる(x* = (I − M)⁻¹ c)。
// M の固有値を 1 に近く取れば、素のピカールは緩慢になり、Anderson は
// **有限回で厳密解に到達する**(深さ ≥ 問題の次元なら、原理的に 1 サイクル)。

import { describe, expect, it } from 'vitest';
import { AndersonAccelerator } from '../../../src/sim/step06_precipitation';

/** x ← M x + c を素のピカール / Anderson で解き、反復数を返す */
function solve(
  M: number[][],
  c: number[],
  depth: number,
  tol = 1e-10,
  maxIt = 5000,
): { iterations: number; x: Float64Array } {
  const n = c.length;
  const x = new Float64Array(n);
  const f = new Float64Array(n);
  const acc = depth > 0 ? new AndersonAccelerator(depth, 1e-14) : null;
  for (let k = 1; k <= maxIt; k++) {
    // f = F(x) − x
    let norm = 0;
    for (let i = 0; i < n; i++) {
      let fx = c[i] ?? 0;
      for (let j = 0; j < n; j++) fx += (M[i]?.[j] ?? 0) * (x[j] ?? 0);
      f[i] = fx - (x[i] ?? 0);
      norm = Math.max(norm, Math.abs(f[i] ?? 0));
    }
    if (norm < tol) return { iterations: k, x };
    if (acc) acc.next(x, f);
    else for (let i = 0; i < n; i++) x[i] = (x[i] ?? 0) + (f[i] ?? 0);
  }
  return { iterations: maxIt, x };
}

describe('Anderson 加速(段 24)', () => {
  // 固有値 0.99 の対角写像。素のピカールの比はちょうど 0.99 になるので、
  // 結合反復で実測した「比 0.99 の緩慢」と同じ形をしている
  const SLOW: number[][] = [
    [0.99, 0, 0],
    [0, 0.97, 0],
    [0, 0, 0.95],
  ];
  const C = [1, 2, 3];
  /** 厳密解 x*_i = c_i / (1 − M_ii) */
  const EXACT = [1 / 0.01, 2 / 0.03, 3 / 0.05];

  it('素のピカールは緩慢(比 0.99 なので数千回かかる)', () => {
    const { iterations, x } = solve(SLOW, C, 0);
    for (let i = 0; i < 3; i++) expect(x[i]).toBeCloseTo(EXACT[i] ?? 0, 6);
    // 0.99^k < 1e-10/100 → k > 約 2750
    expect(iterations).toBeGreaterThan(2000);
  });

  it('Anderson(深さ 3)は同じ問題を**桁違いに速く**解く', () => {
    const { iterations, x } = solve(SLOW, C, 3);
    for (let i = 0; i < 3; i++) expect(x[i]).toBeCloseTo(EXACT[i] ?? 0, 6);
    // 深さ ≥ 次元なので、原理的には数サイクルで厳密解に届く
    expect(iterations).toBeLessThan(30);
  });

  // **どちらも同じ不動点へ行く**ことを、互いにではなく**厳密解**と比べて守る。
  // 互いに比べると、緩慢な素のピカール側の打ち切り誤差(許容 1e-10 で止めるので
  // 解には 1e-8 程度残る)を Anderson の誤差として数えてしまう。
  // 実際 2026-08-15 にそれで一度落として、**Anderson のほうが厳密解に近かった**。
  it('**不動点は加速の有無で同じ**(解き方が答えを変えない)', () => {
    const plain = solve(SLOW, C, 0);
    const acc = solve(SLOW, C, 3);
    for (let i = 0; i < 3; i++) {
      expect(plain.x[i]).toBeCloseTo(EXACT[i] ?? 0, 6);
      expect(acc.x[i]).toBeCloseTo(EXACT[i] ?? 0, 6);
    }
  });

  // 非対角(結合のある)問題でも効くこと。対角だけで通ると
  // 「たまたま」を掴んでいる恐れがある
  it('非対角の結合がある問題でも加速する', () => {
    const M: number[][] = [
      [0.8, 0.15, 0.02],
      [0.1, 0.85, 0.04],
      [0.05, 0.1, 0.82],
    ];
    const plain = solve(M, C, 0);
    const acc = solve(M, C, 3);
    for (let i = 0; i < 3; i++) expect(acc.x[i]).toBeCloseTo(plain.x[i] ?? 0, 6);
    expect(acc.iterations).toBeLessThan(plain.iterations);
  });

  // 深さ 1 は割線法 / Aitken と等価。これも素のピカールより速いはず
  it('深さ 1(割線法)でも素のピカールより速い', () => {
    const plain = solve(SLOW, C, 0);
    const acc = solve(SLOW, C, 1);
    for (let i = 0; i < 3; i++) expect(acc.x[i]).toBeCloseTo(EXACT[i] ?? 0, 5);
    expect(acc.iterations).toBeLessThan(plain.iterations);
  });

  // 退化(ΔF が一次従属)しても壊れず、素のピカールへ落ちること。
  // **黙って NaN を返さない**ことが要件
  it('退化した入力でも有限のまま(素のピカールへ落ちる)', () => {
    const acc = new AndersonAccelerator(3, 1e-14);
    const x = new Float64Array([1, 1, 1]);
    const f = new Float64Array([0, 0, 0]); // 残差ゼロ = ΔF が退化
    for (let k = 0; k < 5; k++) acc.next(x, f);
    for (let i = 0; i < 3; i++) expect(Number.isFinite(x[i] ?? NaN)).toBe(true);
  });
});
