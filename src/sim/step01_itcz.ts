// Step 1: ITCZ(熱帯収束帯)。docs/spec/01_ITCZ.md
// 熱赤道 = 赤緯追従(海上基準)+ 夏半球大陸への引き寄せ(モンスーン)を
// 経度列ごとに求め、経度方向に平滑化する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, rowOfLatDeg } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { ItczResult, SimContext } from './types';

/**
 * hemisOffsetDeg: 半球間非対称による ITCZ の恒常オフセット(度、北偏が正)。
 * 実物の ITCZ は海洋の半球間熱輸送(AMOC 型)で暖かい半球へ ~3°/K 寄り、
 * 年平均 2〜6°N に座る(赤道対称ではない)。パイプラインがプレパスの
 * SST 非対称から算出して渡す(初回パスは 0)。
 */
export function computeItcz(ctx: SimContext, hemisOffsetDeg = 0): ItczResult {
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
  // 高原引き寄せ(度): ≥1,500m の陸(チベット型)は平均標高で希釈されるため
  // 別集計。高原の高さ(1.5→4km で 0→1)× 帯内占有率で追加の北上量にする
  const plateauPullN = new Float64Array(W);
  const plateauPullS = new Float64Array(W);
  const scanBand = (col: number, row0: number, row1: number) => {
    let n = 0;
    let nLand = 0;
    let elevSum = 0;
    let highN = 0;
    let highElevSum = 0;
    for (let row = row0; row <= row1; row++) {
      n++;
      const i = row * W + col;
      if (terrain.landMask[i]) {
        nLand++;
        const e = Math.max(0, terrain.elevationMeters[i] ?? 0);
        elevSum += e;
        if (e >= 1500) {
          highN++;
          highElevSum += e;
        }
      }
    }
    const landFrac = n > 0 ? nLand / n : 0;
    const elevBoost = 1 + K.itczMonsoonElevBoostPerKm * (n > 0 ? elevSum / n / 1000 : 0);
    const highElevKm = highN > 0 ? highElevSum / highN / 1000 : 0;
    const height01 = Math.min(1, Math.max(0, (highElevKm - 1.5) / 2.5));
    const cover01 = Math.min(1, (n > 0 ? highN / n : 0) * 6);
    return { landFrac, elevBoost, plateauPull: K.itczPlateauPullDeg * height01 * cover01 };
  };
  for (let col = 0; col < W; col++) {
    const bn = scanBand(col, rowN35, rowEq);
    landFracN[col] = bn.landFrac;
    elevBoostN[col] = bn.elevBoost;
    plateauPullN[col] = bn.plateauPull;
    const bs = scanBand(col, rowEq + 1, rowS35);
    landFracS[col] = bs.landFrac;
    elevBoostS[col] = bs.elevBoost;
    plateauPullS[col] = bs.plateauPull;
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const decl = insolation.monthlyDeclinationDeg[m] ?? 0;
    const declNorm = decl / tilt; // -1..1
    const centers = new Float32Array(W);
    for (let col = 0; col < W; col++) {
      // 海上の ITCZ は熱慣性でほとんど動かず、陸上では太陽を大きく追う
      // (Log/Pasta の明示規則)。経度列の帯内陸率で季節追従を減衰する
      const landness = Math.min(1, ((landFracN[col] ?? 0) + (landFracS[col] ?? 0)));
      const followDamp = K.itczOceanFollowDamp + (1 - K.itczOceanFollowDamp) * landness;
      const base = K.itczDeclinationFollowRatio * decl * followDamp;
      // 夏半球の大陸が ITCZ を引き寄せる(高所加熱で増強、冬半球の大陸は押し返す)
      const pull =
        declNorm >= 0
          ? K.itczMonsoonPullDeg * declNorm * (landFracN[col] ?? 0) * (elevBoostN[col] ?? 1) +
            declNorm * (plateauPullN[col] ?? 0) -
            K.itczMonsoonPullDeg * 0.25 * declNorm * (landFracS[col] ?? 0)
          : K.itczMonsoonPullDeg * declNorm * (landFracS[col] ?? 0) * (elevBoostS[col] ?? 1) +
            declNorm * (plateauPullS[col] ?? 0) -
            K.itczMonsoonPullDeg * 0.25 * declNorm * (landFracN[col] ?? 0);
      centers[col] = base + pull + hemisOffsetDeg;
    }
    const smoothed = smoothCyclic(centers, grid.resolutionDeg);
    // 完全平滑はモンスーンの経度局所性(大陸で深く、海で浅い)を希釈するため
    // 生値を一部混ぜ戻す
    const b = K.itczSmoothLocalBlend;
    for (let col = 0; col < W; col++) {
      smoothed[col] = (1 - b) * (smoothed[col] ?? 0) + b * (centers[col] ?? 0);
    }
    monthlyCenterLatDegByCol.push(smoothed);
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

/**
 * 指定セルの ITCZ 影響度(0〜1、中心で 1)。他ステップから利用。
 * widthScale で用途別に幅を変えられる(降水影響圏は WL#31 の ±15° 規則に
 * 合わせて広め、雲・トラフは狭め — 較正記録 2026-07-30「幅の共有は諸刃」)
 */
export function itczInfluenceAt(
  itcz: ItczResult,
  month: number,
  col: number,
  latDeg: number,
  widthScale = 1,
): number {
  const centers = itcz.monthlyCenterLatDegByCol[month];
  if (!centers) return 0;
  const center = centers[col] ?? 0;
  const d = Math.abs(latDeg - center) / (itcz.halfWidthDeg * widthScale);
  return Math.exp(-d * d);
}

export { latDegOfRow };
