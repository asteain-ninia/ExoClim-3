// P2-1(FB 2026-07-31 中期案): 保存型の水蒸気輸送。
// 外部レビューの導入順に従い、まず合成格子で以下を固定する:
//  - 面フラックスの相殺(保存性): 定常解で Σ A(S − P) ≈ 0
//  - 非負性(風上流束を使う理由)
//  - 解像度不変
//  - 極・経度周期境界の扱い
//  - 凝結率が小さくても W が発散しない

import { describe, expect, it } from 'vitest';
import { createGrid, latDegOfRow } from '../../../src/domain/grid';
import { globalBalanceResidual, solveMoistureTransport } from '../../../src/sim/moisture_transport';

const R_KM = 6371;

function uniformFields(grid: ReturnType<typeof createGrid>, uMs: number, vMs: number) {
  const u = new Float32Array(grid.cellCount).fill(uMs);
  const v = new Float32Array(grid.cellCount).fill(vMs);
  return { u, v };
}

describe('保存型水蒸気輸送(P2-1)', () => {
  it('全球の水収支が閉じる(Σ A(蒸発 − 降水) / Σ A·蒸発 ≤ 1e-4)', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 6, 2);
    const src = new Float32Array(grid.cellCount);
    const rate = new Float32Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        // 熱帯の海で蒸発が多い、という素朴な源
        src[i] = 120 * Math.max(0, Math.cos((lat * Math.PI) / 180));
        rate[i] = 6 + 3 * Math.cos((col * Math.PI) / 45); // 1/月
      }
    }
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
      tolerance: 1e-7,
      maxIterations: 3000,
    });
    expect(res.converged).toBe(true);
    expect(globalBalanceResidual(grid, src, res.condensationMm)).toBeLessThanOrEqual(1e-4);
  });

  it('非負性: どのセルでも水蒸気量・凝結量が負にならない', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, -9, 4);
    const src = new Float32Array(grid.cellCount);
    const rate = new Float32Array(grid.cellCount).fill(5);
    // 源を 1 点だけに集中させる(強い勾配 = 中心差分なら負値が出る条件)
    src[Math.floor(grid.cellCount / 2)] = 5000;
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 2000 });
    for (let i = 0; i < grid.cellCount; i++) {
      expect(res.waterMm[i] ?? -1).toBeGreaterThanOrEqual(0);
      expect(res.condensationMm[i] ?? -1).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(res.waterMm[i] ?? NaN)).toBe(true);
    }
  });

  it('風下へ運ばれる: 東風では源の西側が湿る(移流の向きが正しい)', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, -8, 0); // 西向きの風
    const src = new Float32Array(grid.cellCount);
    const rate = new Float32Array(grid.cellCount).fill(4);
    const row = Math.floor(grid.heightCells / 2);
    const col = Math.floor(grid.widthCells / 2);
    src[row * grid.widthCells + col] = 3000;
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 2000 });
    const west = res.waterMm[row * grid.widthCells + col - 1] ?? 0;
    const east = res.waterMm[row * grid.widthCells + col + 1] ?? 0;
    expect(west).toBeGreaterThan(east); // 西向きの風 → 西が湿る
  });

  it('解像度不変: 2°/4° で全球平均の可降水量が近い', () => {
    const means: number[] = [];
    for (const res of [4, 2]) {
      const grid = createGrid(res);
      const { u, v } = uniformFields(grid, 6, 0);
      const src = new Float32Array(grid.cellCount);
      const rate = new Float32Array(grid.cellCount).fill(6);
      for (let row = 0; row < grid.heightCells; row++) {
        const lat = latDegOfRow(grid, row);
        for (let col = 0; col < grid.widthCells; col++) {
          src[row * grid.widthCells + col] = 120 * Math.max(0, Math.cos((lat * Math.PI) / 180));
        }
      }
      const out = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
        tolerance: 1e-7,
        maxIterations: 3000,
      });
      let s = 0;
      let w = 0;
      for (let row = 0; row < grid.heightCells; row++) {
        const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
        for (let col = 0; col < grid.widthCells; col++) {
          s += cw * (out.waterMm[row * grid.widthCells + col] ?? 0);
          w += cw;
        }
      }
      means.push(s / w);
    }
    const [a, b] = means as [number, number];
    expect(Math.abs(a - b) / a).toBeLessThan(0.05); // 5% 以内
  });

  it('凝結率が小さくても発散しない(下限が効く)', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 3, 1);
    const src = new Float32Array(grid.cellCount).fill(100);
    const rate = new Float32Array(grid.cellCount); // すべて 0
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 500 });
    for (let i = 0; i < grid.cellCount; i++) {
      expect(Number.isFinite(res.waterMm[i] ?? NaN)).toBe(true);
    }
  });

  it('無風・一様源では局所平衡 W = S/λ になる(解析解と一致)', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 0, 0);
    const src = new Float32Array(grid.cellCount).fill(90);
    const rate = new Float32Array(grid.cellCount).fill(6);
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 500 });
    for (let i = 0; i < grid.cellCount; i += 17) {
      expect(res.waterMm[i] ?? 0).toBeCloseTo(15, 4); // 90/6
      expect(res.condensationMm[i] ?? 0).toBeCloseTo(90, 3); // 源と等しい
    }
  });

  it('決定的: 同じ入力で同じ結果', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 5, -2);
    const src = new Float32Array(grid.cellCount).fill(80);
    const rate = new Float32Array(grid.cellCount).fill(5);
    const a = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 300 });
    const b = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 300 });
    expect([...a.waterMm]).toEqual([...b.waterMm]);
  });
  // ---- 閾値凝結(2026-08-04 追加)----
  it('閾値凝結: 保持容量を下回る柱は降らせず、水を素通しする', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 0, 0);
    const src = new Float32Array(grid.cellCount).fill(90);
    const rate = new Float32Array(grid.cellCount).fill(6);
    // 局所平衡は W = 90/6 = 15mm。容量 40mm ならどのセルも閾値に届かない
    const cap = new Float32Array(grid.cellCount).fill(40);
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
      maxIterations: 500,
      holdingCapacityMm: cap,
    });
    // 降らないので水が溜まり続ける — 無風・源ありでは定常解が存在しない。
    // ここで確かめたいのは「閾値未満では降水が 0 になる」ことだけ
    for (let i = 0; i < grid.cellCount; i += 37) {
      if ((res.waterMm[i] ?? 0) <= 40) expect(res.condensationMm[i] ?? 0).toBeCloseTo(0, 6);
    }
  });

  it('閾値凝結: 容量 0 は従来(C = rate·W)と厳密に一致する', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 4, 1);
    const src = new Float32Array(grid.cellCount).fill(70);
    const rate = new Float32Array(grid.cellCount).fill(4);
    const zero = new Float32Array(grid.cellCount); // すべて 0
    const a = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 400 });
    const b = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
      maxIterations: 400,
      holdingCapacityMm: zero,
    });
    expect([...b.condensationMm]).toEqual([...a.condensationMm]);
  });

  // ---- 鉛直輸出(2026-08-04 追加)----
  // **水を漏らさないことを固定する**。輸出は水の破壊ではなく、単層モデルが
  // 解けない鉛直輸送のパラメタリゼーションなので、抜けた量は必ず
  // exportedMm に現れ、呼び出し側が上昇域へ返して閉じられなければならない。
  it('鉛直輸出: 源 = 降水 + 輸出 が全球で閉じる(漏れを作らない)', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 5, -1);
    const src = new Float32Array(grid.cellCount).fill(80);
    const rate = new Float32Array(grid.cellCount).fill(5);
    const xr = new Float32Array(grid.cellCount);
    for (let i = 0; i < grid.cellCount; i++) xr[i] = i % 3 === 0 ? 3 : 0;
    const res = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
      maxIterations: 4000,
      verticalExportRatePerMonth: xr,
    });
    let s = 0;
    let pe = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        s += w * (src[i] ?? 0);
        pe += w * ((res.condensationMm[i] ?? 0) + (res.exportedMm[i] ?? 0));
      }
    }
    expect(Math.abs(s - pe) / s).toBeLessThan(1e-4);
  });

  it('鉛直輸出: 輸出率 0 なら従来と厳密に一致し、輸出量も 0', () => {
    const grid = createGrid(4);
    const { u, v } = uniformFields(grid, 3, 2);
    const src = new Float32Array(grid.cellCount).fill(60);
    const rate = new Float32Array(grid.cellCount).fill(4);
    const zero = new Float32Array(grid.cellCount);
    const a = solveMoistureTransport(grid, R_KM, u, v, src, rate, { maxIterations: 400 });
    const b = solveMoistureTransport(grid, R_KM, u, v, src, rate, {
      maxIterations: 400,
      verticalExportRatePerMonth: zero,
    });
    expect([...b.condensationMm]).toEqual([...a.condensationMm]);
    expect(b.exportedMm.every((x) => x === 0)).toBe(true);
  });
});
