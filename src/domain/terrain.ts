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
          return idealizedContinent(grid, false);
        case 'two_continents':
          return idealizedContinent(grid, true);
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
 * 理想化大陸: 経度 [-30°, +50°]、緯度 [-55°, +70°] の単一大陸。
 * 西岸近くに南北山脈(アンデス相当 3000m 級)、内陸は 300m 平原。
 * split = true では赤道 [-6°, +6°] を海峡で分断した南北二大陸。
 */
function idealizedContinent(grid: Grid, split: boolean): TerrainField {
  const elevationMeters = new Float32Array(grid.cellCount).fill(OCEAN_FLOOR_M);
  const landMask = new Uint8Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon = lon >= -30 && lon <= 50;
      const inLat = lat >= -55 && lat <= 70;
      const inStrait = split && lat >= -6 && lat <= 6;
      if (!inLon || !inLat || inStrait) continue;
      const i = cellIndex(grid, row, col);
      landMask[i] = 1;
      let elev = 300;
      // 西岸山脈(lon -27〜-20 に稜線、最高 3200m)
      const ridgeCenter = -23.5;
      const ridgeHalfWidth = 3.5;
      const d = Math.abs(lon - ridgeCenter);
      if (d < ridgeHalfWidth) {
        elev = 300 + 2900 * (1 - d / ridgeHalfWidth);
      }
      // 東へ向かってなだらかに低下(200m 台へ)
      if (lon > 20) elev = Math.min(elev, 300 - ((lon - 20) / 30) * 100);
      elevationMeters[i] = elev;
    }
  }
  return { elevationMeters, landMask };
}

// ---- 手続き生成(種子付き fBm 値ノイズ) ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 経度方向に周期的な格子値ノイズ 1 オクターブ */
function valueNoiseOctave(
  grid: Grid,
  out: Float32Array,
  cellsPerLatticeX: number,
  amplitude: number,
  rand: () => number,
): void {
  const latticeW = Math.max(2, Math.round(grid.widthCells / cellsPerLatticeX));
  const latticeH = Math.max(2, Math.round(grid.heightCells / cellsPerLatticeX) + 1);
  const lattice = new Float32Array(latticeW * latticeH);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1;
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let row = 0; row < grid.heightCells; row++) {
    const fy = (row / grid.heightCells) * (latticeH - 1);
    const y0 = Math.floor(fy);
    const ty = smooth(fy - y0);
    for (let col = 0; col < grid.widthCells; col++) {
      const fx = (col / grid.widthCells) * latticeW;
      const x0 = Math.floor(fx) % latticeW;
      const x1 = (x0 + 1) % latticeW;
      const tx = smooth(fx - Math.floor(fx));
      const y1 = Math.min(latticeH - 1, y0 + 1);
      const v00 = lattice[y0 * latticeW + x0] ?? 0;
      const v10 = lattice[y0 * latticeW + x1] ?? 0;
      const v01 = lattice[y1 * latticeW + x0] ?? 0;
      const v11 = lattice[y1 * latticeW + x1] ?? 0;
      const v = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
      const idx = row * grid.widthCells + col;
      out[idx] = (out[idx] ?? 0) + v * amplitude;
    }
  }
}

function procedural(
  grid: Grid,
  seed: number,
  landFraction: number,
  reliefScale: number,
): TerrainField {
  const rand = mulberry32(Math.floor(seed));
  const noise = new Float32Array(grid.cellCount);
  const octaves: Array<[number, number]> = [
    [90, 1.0],
    [45, 0.55],
    [22, 0.3],
    [11, 0.16],
    [5, 0.08],
  ];
  for (const [cells, amp] of octaves) valueNoiseOctave(grid, noise, cells, amp, rand);

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
