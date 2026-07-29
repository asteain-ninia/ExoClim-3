// SimContext の構築: 地形解決・日射・海岸距離の前計算。
// 海岸距離は 2 パス Chamfer 距離変換(経度循環対応)を km 換算する。

import { createGrid, cellHeightKm, cellWidthKm } from '@/domain/grid';
import type { Grid } from '@/domain/grid';
import { computeInsolation } from '@/domain/insolation';
import type { PlanetParams } from '@/domain/planetParams';
import { resolveTerrain } from '@/domain/terrain';
import type { SimContext } from './types';

/** target=1 のセルからの距離(セル単位)を Chamfer 2 パスで求める(経度循環) */
export function chamferDistanceCells(grid: Grid, isSource: (i: number) => boolean): Float32Array {
  const { widthCells: W, heightCells: H } = grid;
  const INF = 1e9;
  const dist = new Float32Array(W * H).fill(INF);
  for (let i = 0; i < W * H; i++) if (isSource(i)) dist[i] = 0;
  const DIAG = 1.41421356;
  // 前方パス(左上→右下)、経度は 2 周して循環を吸収
  for (let pass = 0; pass < 2; pass++) {
    for (let row = 0; row < H; row++) {
      for (let sweep = 0; sweep < 2; sweep++) {
        for (let c = 0; c < W; c++) {
          const col = sweep === 0 ? c : W - 1 - c;
          const i = row * W + col;
          let d = dist[i] ?? INF;
          const west = row * W + ((col + W - 1) % W);
          const east = row * W + ((col + 1) % W);
          if (sweep === 0) d = Math.min(d, (dist[west] ?? INF) + 1);
          else d = Math.min(d, (dist[east] ?? INF) + 1);
          if (row > 0) {
            d = Math.min(d, (dist[(row - 1) * W + col] ?? INF) + 1);
            d = Math.min(d, (dist[(row - 1) * W + ((col + W - 1) % W)] ?? INF) + DIAG);
            d = Math.min(d, (dist[(row - 1) * W + ((col + 1) % W)] ?? INF) + DIAG);
          }
          dist[i] = d;
        }
      }
    }
    // 後方パス(下→上)
    for (let row = H - 1; row >= 0; row--) {
      for (let sweep = 0; sweep < 2; sweep++) {
        for (let c = 0; c < W; c++) {
          const col = sweep === 0 ? W - 1 - c : c;
          const i = row * W + col;
          let d = dist[i] ?? INF;
          const west = row * W + ((col + W - 1) % W);
          const east = row * W + ((col + 1) % W);
          if (sweep === 0) d = Math.min(d, (dist[east] ?? INF) + 1);
          else d = Math.min(d, (dist[west] ?? INF) + 1);
          if (row < H - 1) {
            d = Math.min(d, (dist[(row + 1) * W + col] ?? INF) + 1);
            d = Math.min(d, (dist[(row + 1) * W + ((col + W - 1) % W)] ?? INF) + DIAG);
            d = Math.min(d, (dist[(row + 1) * W + ((col + 1) % W)] ?? INF) + DIAG);
          }
          dist[i] = d;
        }
      }
    }
  }
  return dist;
}

export function buildSimContext(params: PlanetParams): SimContext {
  const grid = createGrid(params.gridResolutionDeg);
  const terrain = resolveTerrain(grid, params.terrain);
  const insolation = computeInsolation(grid, params.orbital, params.body.axialTiltDeg);

  const land = terrain.landMask;
  const distToOceanCells = chamferDistanceCells(grid, (i) => !land[i]);
  const distToLandCells = chamferDistanceCells(grid, (i) => land[i] === 1);

  // セル距離 → km(南北セル寸法で代表。東西は高緯度で縮むため控えめな近似)
  const cellKm = cellHeightKm(grid, params.body.radiusKm);
  const landDistToCoastKm = new Float32Array(grid.cellCount);
  const oceanDistToLandKm = new Float32Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    // 東西方向の実距離は緯度で縮む。行の平均セル幅と南北幅の平均を距離係数にする。
    const kmPerCell = (cellKm + cellWidthKm(grid, row, params.body.radiusKm)) / 2;
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (land[i]) {
        landDistToCoastKm[i] = (distToOceanCells[i] ?? 0) * kmPerCell;
      } else {
        oceanDistToLandKm[i] = (distToLandCells[i] ?? 0) * kmPerCell;
      }
    }
  }
  return { grid, params, terrain, insolation, landDistToCoastKm, oceanDistToLandKm };
}
