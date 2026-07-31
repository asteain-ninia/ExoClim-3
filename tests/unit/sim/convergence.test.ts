// R4(地域降水 FB §8): 水蒸気フラックス収束。
// 外部レビュー(2026-08-01)で指摘された受入条件を固定する:
//  - 有限体積形の保存性: Σ(セル面積 × 発散) ≈ 0(周期境界・極の辺長 0)
//  - 局所 q で割らない(乾燥域で発散しない)
//  - 解像度で収束の強さが大きく変わらない
//  - 対称な全海惑星で経度模様を作らない
//  - 自転反転で東西位相が反転する

import { describe, expect, it } from 'vitest';
import { createGrid, latDegOfRow } from '../../../src/domain/grid';
import {
  convergenceStrength01,
  moistureConvergenceIndex,
  wetnessGate01,
} from '../../../src/sim/step06_precipitation';

const R_KM = 6371;

/** 解析的な収束場を作る: q 一定、u = −sin(経度) → 経度 0 で収束 */
function zonalWave(resolutionDeg: number, amplitude = 5) {
  const grid = createGrid(resolutionDeg);
  const q = new Float32Array(grid.cellCount).fill(1);
  const u = new Float32Array(grid.cellCount);
  const v = new Float32Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = -180 + (col + 0.5) * resolutionDeg;
      u[row * grid.widthCells + col] = -amplitude * Math.sin((lon * Math.PI) / 180);
    }
  }
  return { grid, q, u, v };
}

describe('水蒸気フラックス収束(R4)', () => {
  it('保存性: 面積重み付きの発散の総和がほぼ 0(有限体積形)', () => {
    const { grid, q, u, v } = zonalWave(2);
    // 南北成分も入れて一般性を持たせる
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        v[row * grid.widthCells + col] = 3 * Math.cos((lat * Math.PI) / 90);
      }
    }
    const conv = moistureConvergenceIndex(grid, R_KM, q, u, v);
    let signed = 0;
    let magnitude = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const c = conv[row * grid.widthCells + col] ?? 0;
        signed += w * c;
        magnitude += w * Math.abs(c);
      }
    }
    // 総和は個々の大きさに比べて桁違いに小さい(保存的)
    expect(Math.abs(signed) / Math.max(1e-9, magnitude)).toBeLessThan(0.01);
  });

  it('東西波: 収束は経度 0 付近が最大、経度 180 付近は発散(符号が正しい)', () => {
    const { grid, q, u, v } = zonalWave(2);
    const conv = moistureConvergenceIndex(grid, R_KM, q, u, v);
    const row = Math.floor(grid.heightCells / 2);
    const at = (lonDeg: number) =>
      conv[row * grid.widthCells + Math.round((lonDeg + 180) / 2 - 0.5)] ?? 0;
    expect(at(0)).toBeGreaterThan(0); // u が東向きに減る = 収束
    expect(at(180)).toBeLessThan(0);
  });

  it('解像度不変: 0.5°/1°/2° で収束の大きさが大きく変わらない', () => {
    const peak: number[] = [];
    for (const res of [0.5, 1, 2]) {
      const { grid, q, u, v } = zonalWave(res);
      const conv = moistureConvergenceIndex(grid, R_KM, q, u, v);
      const row = Math.floor(grid.heightCells / 2);
      const col = Math.round((0 + 180) / res - 0.5);
      peak.push(conv[row * grid.widthCells + col] ?? 0);
    }
    const lo = Math.min(...peak);
    const hi = Math.max(...peak);
    expect(lo).toBeGreaterThan(0);
    expect(hi / lo).toBeLessThan(1.25); // 25% 以内
  });

  it('全海の帯状対称な場では経度方向に模様を作らない', () => {
    const grid = createGrid(2);
    const q = new Float32Array(grid.cellCount);
    const u = new Float32Array(grid.cellCount);
    const v = new Float32Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        q[i] = 2 + Math.cos((lat * Math.PI) / 180);
        u[i] = 6 * Math.sin((lat * Math.PI) / 45);
        v[i] = 2 * Math.cos((lat * Math.PI) / 90);
      }
    }
    const conv = moistureConvergenceIndex(grid, R_KM, q, u, v);
    for (let row = 1; row < grid.heightCells - 1; row += 7) {
      const base = conv[row * grid.widthCells] ?? 0;
      for (let col = 1; col < grid.widthCells; col += 11) {
        expect(Math.abs((conv[row * grid.widthCells + col] ?? 0) - base)).toBeLessThan(1e-6);
      }
    }
  });

  it('自転反転相当(u の符号反転)で東西の収束パターンが鏡映する', () => {
    const { grid, q, u, v } = zonalWave(2);
    const conv = moistureConvergenceIndex(grid, R_KM, q, u, v);
    const uRev = Float32Array.from(u, (x) => -x);
    const convRev = moistureConvergenceIndex(grid, R_KM, q, uRev, v);
    const row = Math.floor(grid.heightCells / 2);
    for (let col = 0; col < grid.widthCells; col += 5) {
      expect(convRev[row * grid.widthCells + col] ?? 0).toBeCloseTo(
        -(conv[row * grid.widthCells + col] ?? 0),
        6,
      );
    }
  });

  it('収束強度は [0,1) に収まり、乾燥域で発散しない(局所 q で割らない)', () => {
    expect(convergenceStrength01(-5, 2)).toBe(0);
    expect(convergenceStrength01(0, 2)).toBe(0);
    expect(convergenceStrength01(2, 2)).toBeCloseTo(0.5, 6);
    expect(convergenceStrength01(1e9, 2)).toBeLessThan(1);
    expect(convergenceStrength01(1e9, 2)).toBeGreaterThan(0.999);
  });

  it('湿潤ゲート: 供給 0 で 0、基準以上で 1、単調増加(乾いた収束を弾く)', () => {
    expect(wetnessGate01(0, 3)).toBe(0);
    expect(wetnessGate01(3, 3)).toBe(1);
    expect(wetnessGate01(10, 3)).toBe(1);
    expect(wetnessGate01(1.5, 3)).toBeCloseTo(0.5, 6);
    let prev = -1;
    for (let s = 0; s <= 3; s += 0.25) {
      const g = wetnessGate01(s, 3);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });

  it('非有限を作らない(供給 0・風 0・極でも有限)', () => {
    const grid = createGrid(4);
    const q = new Float32Array(grid.cellCount);
    const u = new Float32Array(grid.cellCount);
    const v = new Float32Array(grid.cellCount);
    const conv = moistureConvergenceIndex(grid, R_KM, q, u, v);
    for (let i = 0; i < conv.length; i++) {
      expect(Number.isFinite(conv[i] ?? 0)).toBe(true);
      expect(Math.abs(conv[i] ?? 0)).toBe(0); // ±0 を区別しない
    }
  });
});
