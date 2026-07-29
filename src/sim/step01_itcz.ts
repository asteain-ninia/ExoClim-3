// Step 1: ITCZ(熱帯収束帯)。docs/spec/01_ITCZ.md
// 熱赤道 = 赤緯追従(海上基準)+ 夏半球大陸への引き寄せ(モンスーン)を
// 経度列ごとに求め、経度方向に平滑化する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, rowOfLatDeg } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { ItczResult, SimContext } from './types';

export function computeItcz(ctx: SimContext): ItczResult {
  const { grid, terrain, insolation } = ctx;
  const W = grid.widthCells;
  const tilt = Math.max(ctx.params.body.axialTiltDeg, 1e-6);
  const monthlyCenterLatDegByCol: Float32Array[] = [];

  // 経度列ごとの「熱帯陸割合」: |lat| ≤ 35° の帯で北側・南側の陸割合
  const rowEq = rowOfLatDeg(grid, 0);
  const rowN35 = rowOfLatDeg(grid, 35);
  const rowS35 = rowOfLatDeg(grid, -35);
  const landFracN = new Float64Array(W);
  const landFracS = new Float64Array(W);
  // 帯内の陸平均標高(km)。高所加熱がモンスーントラフを大きく引き上げる(WL#32)
  const elevBoostN = new Float64Array(W);
  const elevBoostS = new Float64Array(W);
  for (let col = 0; col < W; col++) {
    let n = 0;
    let nLand = 0;
    let nElev = 0;
    for (let row = rowN35; row <= rowEq; row++) {
      n++;
      const i = row * W + col;
      if (terrain.landMask[i]) {
        nLand++;
        nElev += Math.max(0, terrain.elevationMeters[i] ?? 0);
      }
    }
    landFracN[col] = n > 0 ? nLand / n : 0;
    elevBoostN[col] = 1 + K.itczMonsoonElevBoostPerKm * (n > 0 ? nElev / n / 1000 : 0);
    let s = 0;
    let sLand = 0;
    let sElev = 0;
    for (let row = rowEq + 1; row <= rowS35; row++) {
      s++;
      const i = row * W + col;
      if (terrain.landMask[i]) {
        sLand++;
        sElev += Math.max(0, terrain.elevationMeters[i] ?? 0);
      }
    }
    landFracS[col] = s > 0 ? sLand / s : 0;
    elevBoostS[col] = 1 + K.itczMonsoonElevBoostPerKm * (s > 0 ? sElev / s / 1000 : 0);
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const decl = insolation.monthlyDeclinationDeg[m] ?? 0;
    const declNorm = decl / tilt; // -1..1
    const centers = new Float32Array(W);
    for (let col = 0; col < W; col++) {
      const base = K.itczDeclinationFollowRatio * decl;
      // 夏半球の大陸が ITCZ を引き寄せる(高所加熱で増強、冬半球の大陸は押し返す)
      const pull =
        declNorm >= 0
          ? K.itczMonsoonPullDeg * declNorm * (landFracN[col] ?? 0) * (elevBoostN[col] ?? 1) -
            K.itczMonsoonPullDeg * 0.25 * declNorm * (landFracS[col] ?? 0)
          : K.itczMonsoonPullDeg * declNorm * (landFracS[col] ?? 0) * (elevBoostS[col] ?? 1) -
            K.itczMonsoonPullDeg * 0.25 * declNorm * (landFracN[col] ?? 0);
      centers[col] = base + pull;
    }
    monthlyCenterLatDegByCol.push(smoothCyclic(centers, grid.resolutionDeg));
  }
  return { monthlyCenterLatDegByCol, halfWidthDeg: K.itczHalfWidthDeg };
}

/** 経度循環の移動平均(半幅 K.itczSmoothingHalfWidthDeg 度) */
function smoothCyclic(values: Float32Array, resolutionDeg: number): Float32Array {
  const W = values.length;
  const half = Math.max(1, Math.round(K.itczSmoothingHalfWidthDeg / resolutionDeg));
  const out = new Float32Array(W);
  for (let col = 0; col < W; col++) {
    let sum = 0;
    let n = 0;
    for (let d = -half; d <= half; d++) {
      sum += values[(col + d + W * 4) % W] ?? 0;
      n++;
    }
    out[col] = sum / n;
  }
  return out;
}

/** 指定セルの ITCZ 影響度(0〜1、中心で 1)。他ステップから利用。 */
export function itczInfluenceAt(
  itcz: ItczResult,
  month: number,
  col: number,
  latDeg: number,
): number {
  const centers = itcz.monthlyCenterLatDegByCol[month];
  if (!centers) return 0;
  const center = centers[col] ?? 0;
  const d = Math.abs(latDeg - center) / itcz.halfWidthDeg;
  return Math.exp(-d * d);
}

export { latDegOfRow };
