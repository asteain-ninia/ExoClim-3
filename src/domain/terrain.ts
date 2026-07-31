// 地形の解決層: TerrainSource → TerrainField(標高 + 陸海マスク)。
// 実在地球は ETOPO 2022 1°(scripts/build_earth_fixtures.py 生成)を使用。
// 手続き生成は種子付き fBm 値ノイズ(経度方向は継ぎ目なし)。

import type { Grid } from './grid';
import { areaWeightOfRow, cellIndex, latDegOfRow, lonDegOfCol } from './grid';
import type { TerrainSource } from './planetParams';
import earthTerrainJson from './data/earth_terrain_1deg.json';

export interface TerrainField {
  /** 標高 m(海セルは負の水深) */
  elevationMeters: Float32Array;
  /** 1 = 陸、0 = 海 */
  landMask: Uint8Array;
}

interface EarthTerrainJson {
  widthCells: number;
  heightCells: number;
  elevationMeters: number[];
  landMask: number[];
}

const OCEAN_FLOOR_M = -4000;

export function resolveTerrain(grid: Grid, source: TerrainSource): TerrainField {
  switch (source.kind) {
    case 'preset':
      switch (source.preset) {
        case 'earth':
          return earthTerrain(grid);
        case 'idealized_continent':
          return hypotheticalContinent(grid, false);
        case 'two_continents':
          return hypotheticalContinent(grid, true);
        case 'aquaplanet':
          return uniform(grid, false);
        case 'all_land':
          return uniform(grid, true);
      }
      break;
    case 'procedural':
      return procedural(grid, source.seed, source.landFraction, source.reliefScale);
  }
}

function uniform(grid: Grid, land: boolean): TerrainField {
  const elevationMeters = new Float32Array(grid.cellCount).fill(land ? 300 : OCEAN_FLOOR_M);
  const landMask = new Uint8Array(grid.cellCount).fill(land ? 1 : 0);
  return { elevationMeters, landMask };
}

/** 実在地球(1° データを目標分解能へ再標本化) */
function earthTerrain(grid: Grid): TerrainField {
  const src = earthTerrainJson as EarthTerrainJson;
  const elevationMeters = new Float32Array(grid.cellCount);
  const landMask = new Uint8Array(grid.cellCount);
  const factor = grid.resolutionDeg; // 1° ソース → factor セルを集約(1 なら素通し)
  if (Number.isInteger(factor) && factor >= 1) {
    const f = factor;
    for (let row = 0; row < grid.heightCells; row++) {
      for (let col = 0; col < grid.widthCells; col++) {
        let landCount = 0;
        let landElevSum = 0;
        let oceanElevSum = 0;
        let n = 0;
        for (let dr = 0; dr < f; dr++) {
          for (let dc = 0; dc < f; dc++) {
            const sr = row * f + dr;
            const sc = col * f + dc;
            const si = sr * src.widthCells + sc;
            const e = src.elevationMeters[si] ?? OCEAN_FLOOR_M;
            const l = src.landMask[si] ?? 0;
            if (l) {
              landCount++;
              landElevSum += e;
            } else {
              oceanElevSum += e;
            }
            n++;
          }
        }
        const i = cellIndex(grid, row, col);
        const isLand = landCount * 2 >= n; // 過半で陸
        landMask[i] = isLand ? 1 : 0;
        elevationMeters[i] = isLand
          ? landElevSum / Math.max(1, landCount)
          : oceanElevSum / Math.max(1, n - landCount);
      }
    }
  } else {
    // 細分(0.5° 等)は最近傍
    for (let row = 0; row < grid.heightCells; row++) {
      const srcRow = Math.min(src.heightCells - 1, Math.floor((90 - latDegOfRow(grid, row)) / 1));
      for (let col = 0; col < grid.widthCells; col++) {
        const srcCol = Math.min(
          src.widthCells - 1,
          Math.floor((lonDegOfCol(grid, col) + 180) / 1),
        );
        const si = srcRow * src.widthCells + srcCol;
        const i = cellIndex(grid, row, col);
        elevationMeters[i] = src.elevationMeters[si] ?? OCEAN_FLOOR_M;
        landMask[i] = src.landMask[si] ?? 0;
      }
    }
  }
  return { elevationMeters, landMask };
}

/**
 * 仮想大陸: 地球の全大陸を一定経度(0°)を中心に集めた仮想の大陸
 * (高校地理の「仮想大陸」図と同じ発想)。各緯度の陸幅 = 実在地球の
 * その緯度の陸割合 × 360° とし、輪郭は緯度方向 ±2° で平滑化する。
 * 標高は一様 300m(教育図と同じく無地形 — 気候帯の理想配置を見るため)。
 * split = true は赤道 [-6°, +6°] を海峡で分断した変種。
 */
function hypotheticalContinent(grid: Grid, split: boolean): TerrainField {
  const src = earthTerrainJson as EarthTerrainJson;
  // 1° ソース行ごとの陸割合 → ±2 行移動平均で輪郭を滑らかに
  const frac = new Float64Array(src.heightCells);
  for (let r = 0; r < src.heightCells; r++) {
    let n = 0;
    for (let c = 0; c < src.widthCells; c++) n += src.landMask[r * src.widthCells + c] ?? 0;
    frac[r] = n / src.widthCells;
  }
  const fracSmooth = new Float64Array(src.heightCells);
  for (let r = 0; r < src.heightCells; r++) {
    let s = 0;
    let n = 0;
    for (let d = -2; d <= 2; d++) {
      const rr = r + d;
      if (rr < 0 || rr >= src.heightCells) continue;
      s += frac[rr] ?? 0;
      n++;
    }
    fracSmooth[r] = n > 0 ? s / n : 0;
  }

  const elevationMeters = new Float32Array(grid.cellCount).fill(OCEAN_FLOOR_M);
  const landMask = new Uint8Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const srcRow = Math.min(src.heightCells - 1, Math.max(0, Math.floor(90 - lat)));
    const halfWidthDeg = (fracSmooth[srcRow] ?? 0) * 180;
    if (halfWidthDeg <= 0) continue;
    const inStrait = split && lat >= -6 && lat <= 6;
    if (inStrait) continue;
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      if (Math.abs(lon) > halfWidthDeg) continue;
      const i = cellIndex(grid, row, col);
      landMask[i] = 1;
      elevationMeters[i] = 300;
    }
  }
  return { elevationMeters, landMask };
}

// ---- 手続き生成(種子付き fBm 値ノイズ) ----

/**
 * 整数座標ハッシュ → [-1, 1]。乱数種子・オクターブ番号・固定角度格子座標から
 * 決定的に値を返す(P0-1: 表示解像度は同じ連続ノイズ場の標本密度だけを変える)
 */
function hashNoise(seed: number, octave: number, i: number, j: number): number {
  let h = (seed | 0) ^ Math.imul(octave + 1, 0x9e3779b9);
  h = Math.imul(h ^ (i | 0), 0x85ebca6b);
  h = Math.imul(h ^ (j | 0), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/**
 * 角度定義の値ノイズ 1 オクターブ(経度周期・格子は固定角度)。
 * sizeDeg は 360 を割り切る値にする(周期の整合)
 */
function angleNoiseOctave(
  grid: Grid,
  out: Float32Array,
  seed: number,
  octave: number,
  sizeDeg: number,
  amplitude: number,
): void {
  const nLon = Math.round(360 / sizeDeg);
  const nLat = Math.round(180 / sizeDeg);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let row = 0; row < grid.heightCells; row++) {
    const v = (90 - latDegOfRow(grid, row)) / sizeDeg; // 0 .. nLat
    const j0 = Math.min(nLat - 1, Math.max(0, Math.floor(v)));
    const ty = smooth(Math.min(1, Math.max(0, v - j0)));
    for (let col = 0; col < grid.widthCells; col++) {
      const u = (lonDegOfCol(grid, col) + 180) / sizeDeg;
      const i0 = ((Math.floor(u) % nLon) + nLon) % nLon;
      const i1 = (i0 + 1) % nLon;
      const tx = smooth(u - Math.floor(u));
      const v00 = hashNoise(seed, octave, i0, j0);
      const v10 = hashNoise(seed, octave, i1, j0);
      const v01 = hashNoise(seed, octave, i0, j0 + 1);
      const v11 = hashNoise(seed, octave, i1, j0 + 1);
      const val = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
      const idx = row * grid.widthCells + col;
      out[idx] = (out[idx] ?? 0) + val * amplitude;
    }
  }
}

function procedural(
  grid: Grid,
  seed: number,
  landFraction: number,
  reliefScale: number,
): TerrainField {
  const noise = new Float32Array(grid.cellCount);
  // オクターブは角度で定義(360 を割り切る値)。解像度は標本密度だけを変える
  const octaves: Array<[number, number]> = [
    [90, 1.0],
    [45, 0.55],
    [22.5, 0.3],
    [11.25, 0.16],
    [5.625, 0.08],
  ];
  octaves.forEach(([sizeDeg, amp], o) =>
    angleNoiseOctave(grid, noise, Math.floor(seed), o, sizeDeg, amp),
  );

  // 面積重み付き分位点で海水準を決めて landFraction を達成する
  const entries: Array<[number, number]> = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      entries.push([noise[row * grid.widthCells + col] ?? 0, w]);
    }
  }
  entries.sort((a, b) => a[0] - b[0]);
  const totalW = entries.reduce((s, e) => s + e[1], 0);
  let acc = 0;
  let seaLevel = 0;
  const target = (1 - Math.min(0.95, Math.max(0.02, landFraction))) * totalW;
  for (const [v, w] of entries) {
    acc += w;
    if (acc >= target) {
      seaLevel = v;
      break;
    }
  }

  const elevationMeters = new Float32Array(grid.cellCount);
  const landMask = new Uint8Array(grid.cellCount);
  let maxAbove = 1e-6;
  for (let i = 0; i < grid.cellCount; i++) {
    const above = (noise[i] ?? 0) - seaLevel;
    if (above > maxAbove) maxAbove = above;
  }
  for (let i = 0; i < grid.cellCount; i++) {
    const above = (noise[i] ?? 0) - seaLevel;
    if (above >= 0) {
      landMask[i] = 1;
      // 正規化した高さの 1.6 乗で山を尖らせる。最高 ~5500m × reliefScale
      elevationMeters[i] = Math.pow(above / maxAbove, 1.6) * 5500 * reliefScale + 1;
    } else {
      landMask[i] = 0;
      elevationMeters[i] = Math.max(OCEAN_FLOOR_M, (above / Math.abs(seaLevel + 1e-9)) * 4000);
    }
  }
  return { elevationMeters, landMask };
}
