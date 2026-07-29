// Step 3: 海流。docs/spec/03_海流.md
// 海盆のトポロジー(緯度行ごとの連続海域)から境界流・高緯度吹送流・赤道湧昇を
// 判定し、海面温度偏差(°C)として定量化する。地理決め打ちはしない。
// 逆行自転では東西が鏡像になる。

import { latDegOfRow, cellWidthKm } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { OceanCurrentResult, SimContext } from './types';

export function computeOceanCurrent(ctx: SimContext): OceanCurrentResult {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = terrain.landMask;
  const prograde = params.body.rotationDirection >= 0;

  const sstAnomalyC = new Float32Array(grid.cellCount);
  const currentClass = new Int8Array(grid.cellCount);

  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    const absLat = Math.abs(lat);
    if (absLat > 72) continue;
    const kmPerCell = cellWidthKm(grid, row, params.body.radiusKm);

    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (land[i]) continue;

      // 同一行内で西向き・東向きに陸まで何セルか(最大 1 周)
      let westCells = -1;
      let eastCells = -1;
      for (let d = 1; d < W; d++) {
        if (westCells < 0 && land[row * W + ((col - d + W * 4) % W)]) westCells = d;
        if (eastCells < 0 && land[row * W + ((col + d) % W)]) eastCells = d;
        if (westCells >= 0 && eastCells >= 0) break;
      }
      if (westCells < 0 || eastCells < 0) continue; // 周極海(陸なし行)は中立

      const basinCells = westCells + eastCells - 1;
      const basinWidthDeg = basinCells * grid.resolutionDeg;
      const basinPos = westCells / (basinCells + 1); // 0 = 海盆西端、1 = 東端
      const westKm = westCells * kmPerCell;
      const eastKm = eastCells * kmPerCell;
      // 逆行自転では海盆の東西役割が入れ替わる
      const nearWestBoundaryKm = prograde ? westKm : eastKm;
      const nearEastBoundaryKm = prograde ? eastKm : westKm;
      const pos = prograde ? basinPos : 1 - basinPos;

      let anomaly = 0;
      // 亜熱帯: 西岸境界流(暖・極向き)と東岸境界流(寒・赤道向き)
      if (absLat >= 8 && absLat <= 45) {
        const bandW = bellBand(absLat, 8, 45, 6);
        if (nearWestBoundaryKm < K.boundaryCurrentReachKm) {
          anomaly +=
            K.warmBoundaryCurrentC * (1 - nearWestBoundaryKm / K.boundaryCurrentReachKm) * bandW;
        }
        if (nearEastBoundaryKm < K.boundaryCurrentReachKm) {
          anomaly +=
            K.coldBoundaryCurrentC * (1 - nearEastBoundaryKm / K.boundaryCurrentReachKm) * bandW;
        }
      }
      // 中高緯度: 暖流吹送域(海盆東側ほど暖かい: 北大西洋海流の相当物)
      if (absLat >= 42 && absLat <= 68) {
        const bandW = bellBand(absLat, 42, 68, 7);
        const widthFactor = Math.min(1, basinWidthDeg / 55); // 狭い海では発達しない
        anomaly += K.warmDriftC * Math.pow(pos, 1.4) * bandW * widthFactor;
        if (pos < 0.35) {
          anomaly += K.coldReturnC * (1 - pos / 0.35) * bandW * widthFactor;
        }
      }
      // 赤道湧昇(海盆東側の寒水舌)
      if (absLat < 7 && pos > 0.5 && basinWidthDeg > 40) {
        anomaly += K.equatorialUpwellingC * ((pos - 0.5) / 0.5) * (1 - absLat / 7);
      }

      sstAnomalyC[i] = anomaly;
      currentClass[i] = anomaly > 0.5 ? 1 : anomaly < -0.5 ? -1 : 0;
    }
  }
  return { sstAnomalyC, currentClass };
}

/** 帯 [lo, hi] 内で 1、外側へ幅 edge の余韻で減衰 */
function bellBand(x: number, lo: number, hi: number, edge: number): number {
  if (x >= lo && x <= hi) return 1;
  const d = x < lo ? lo - x : x - hi;
  return Math.exp(-(d * d) / (edge * edge));
}
