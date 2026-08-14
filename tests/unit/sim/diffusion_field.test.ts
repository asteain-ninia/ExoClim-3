// 渦拡散を「セルごとの場」で渡せるようにした変更を守る(2026-08-15)。
//
// なぜ要るか:
//   ストームトラックの水蒸気供給が保存型で死んでいた(段 6 の移行漏れ)。
//   繋ぎ直すとき「源泉に足す」のは**誤り**で、それは海の水を陸へ運ぶ機構
//   なので陸で水が湧き出す。正しくは**拡散を場所依存にする** —
//   混合は月平均で見れば実効的な拡散で、**拡散は保存的なので水は湧かない**
//   (docs/設計_ストーム供給を保存型へ繋ぐ_2026-08-15.md)。
//
//   これは**輸送ソルバの中核への変更**なので、2 つを機械で守る:
//     1. スカラーを渡したときに従来と厳密に一致すること
//     2. 場を渡しても**全球の水収支が閉じる**こと(保存が壊れたら即座に棄却)

import { describe, expect, it } from 'vitest';
import { createGrid } from '../../../src/domain/grid';
import { globalBalanceResidual, solveMoistureTransport } from '../../../src/sim/moisture_transport';

const RADIUS_KM = 6371;

/** 試験用の格子と場。風は帯状 + 経度依存を混ぜる */
function setup(res: number) {
  const grid = createGrid(res);
  const n = grid.cellCount;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const src = new Float32Array(n);
  const rate = new Float32Array(n);
  for (let row = 0; row < grid.heightCells; row++) {
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const lat = 90 - (row + 0.5) * res;
      const lon = -180 + (col + 0.5) * res;
      u[i] = 8 * Math.cos((lat * Math.PI) / 90) + 2 * Math.sin((lon * Math.PI) / 180);
      v[i] = 3 * Math.sin((lat * Math.PI) / 45);
      src[i] = 20 + 15 * Math.cos((lat * Math.PI) / 180);
      rate[i] = 12 + 4 * Math.cos((lon * Math.PI) / 180);
    }
  }
  return { grid, u, v, src, rate };
}

describe('渦拡散の場(2026-08-15)', () => {
  it('スカラーと「全セル同値の場」が**厳密に一致**する', () => {
    const { grid, u, v, src, rate } = setup(4);
    const D = 2.0e6;
    const asScalar = solveMoistureTransport(grid, RADIUS_KM, u, v, src, rate, {
      diffusivityM2PerS: D,
      maxIterations: 20000,
    });
    const field = new Float32Array(grid.cellCount).fill(D);
    const asField = solveMoistureTransport(grid, RADIUS_KM, u, v, src, rate, {
      diffusivityM2PerS: field,
      maxIterations: 20000,
    });
    expect(asScalar.converged).toBe(true);
    expect(asField.converged).toBe(true);
    for (let i = 0; i < grid.cellCount; i += 7) {
      // **ビット一致を要求する。** 面の平均は両側同値なのでスカラーと同じ式になる
      expect(asField.waterMm[i]).toBe(asScalar.waterMm[i]);
      expect(asField.condensationMm[i]).toBe(asScalar.condensationMm[i]);
    }
  });

  it('**場を渡しても全球の水収支が閉じる**(保存が壊れていない)', () => {
    const { grid, u, v, src, rate } = setup(4);
    // 場所で 10 倍変わる拡散(ストーム帯の混合を模す)
    const field = new Float32Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = Math.abs(90 - (row + 0.5) * 4);
      const boost = lat > 30 && lat < 60 ? 10 : 1;
      for (let col = 0; col < grid.widthCells; col++) {
        field[row * grid.widthCells + col] = 3.0e5 * boost;
      }
    }
    const r = solveMoistureTransport(grid, RADIUS_KM, u, v, src, rate, {
      diffusivityM2PerS: field,
      maxIterations: 20000,
    });
    expect(r.converged).toBe(true);
    // 閉包残差 |Σ A(S − P)| / Σ A·S。**拡散は保存的なので水は湧かない**
    const residual = globalBalanceResidual(grid, src, r.condensationMm);
    expect(residual).toBeLessThan(1e-6);
  });

  it('拡散が強い帯では W が均される(場が実際に効いている)', () => {
    const { grid, u, v, src, rate } = setup(4);
    const weak = new Float32Array(grid.cellCount).fill(3.0e5);
    const strong = new Float32Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = Math.abs(90 - (row + 0.5) * 4);
      const inBand = lat > 30 && lat < 60;
      for (let col = 0; col < grid.widthCells; col++) {
        strong[row * grid.widthCells + col] = inBand ? 3.0e6 : 3.0e5;
      }
    }
    const a = solveMoistureTransport(grid, RADIUS_KM, u, v, src, rate, {
      diffusivityM2PerS: weak,
      maxIterations: 20000,
    });
    const b = solveMoistureTransport(grid, RADIUS_KM, u, v, src, rate, {
      diffusivityM2PerS: strong,
      maxIterations: 20000,
    });
    /** その帯の中での W の経度方向のばらつき */
    const spread = (w: Float32Array): number => {
      let s = 0;
      let n = 0;
      for (let row = 0; row < grid.heightCells; row++) {
        const lat = Math.abs(90 - (row + 0.5) * 4);
        if (lat <= 30 || lat >= 60) continue;
        let mean = 0;
        for (let col = 0; col < grid.widthCells; col++) mean += w[row * grid.widthCells + col] ?? 0;
        mean /= grid.widthCells;
        for (let col = 0; col < grid.widthCells; col++) {
          const d = (w[row * grid.widthCells + col] ?? 0) - mean;
          s += d * d;
          n++;
        }
      }
      return Math.sqrt(s / Math.max(1, n));
    };
    // **強い拡散の帯では、ばらつきが小さくなる**。効いていなければ同じになる
    expect(spread(b.waterMm)).toBeLessThan(spread(a.waterMm));
  });
});
