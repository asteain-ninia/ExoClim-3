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
    // **分母は陸セル数(2026-08-17 修正)。** elevSum は陸だけを足しているのに
    // 帯内の全セル数 n で割っていたため、計算されていたのは
    // 「陸平均標高 × 陸割合」だった。引き寄せの式には既に landFrac が
    // 掛かっているので、陸割合が 2 乗で効き、陸率の低い経度列ほど
    // 高所加熱が余分に薄まっていた(物理棚卸し 01 の最重要指摘)。
    // 係数 itczMonsoonElevBoostPerKm は「陸平均標高」を前提に置かれた値である。
    const elevBoost = 1 + K.itczMonsoonElevBoostPerKm * (nLand > 0 ? elevSum / nLand / 1000 : 0);
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

  // ---- 件 2(v31): 湿った陸の対流源への一般化吸引(既定 0 = 完全無効)----
  // docs/事前登録_v31物理バッチ_2026-08-21.md 件 2。
  // 既存の吸引はプラトー(高所加熱)と大陸モンスーンの 2 本で、島・半島
  // (マダガスカル・メキシコ西岸)の対流源に線が寄らない(所見_計算順デバッグFB
  // 2026-08-21 Step1)。ここでは経度列ごとに「低平で海に近い陸」の帯内占有から
  // 吸引ポテンシャル φ(度)を作り、夏半球側へ ITCZ 中心を追加で引く。
  //
  // 二重計上への設計判断(max 融合、加算しない):
  //   既存 2 本も「夏の陸への吸引」なので、φ を素朴に加算すると同じ物理を
  //   二度数える(インド東部は既に強すぎるという FB に逆行する)。そこで
  //   「どの列も夏の陸への吸引 ≥ φ」だけを保証する — 既存吸引の**実効値**
  //   (12° 広域平滑 + 混ぜ戻し後に列に残る量)を φ が上回る不足分のみ足す。
  //   実効値と比べるのは、島の既存吸引は広域平滑でほぼ消える(これこそ島に
  //   吸引が立たない根)ためで、生値と比べると不足分を過小評価する。
  //   大陸モンスーンが既に強い列(インド・アフリカ内陸)では不足分が 0 になり
  //   何も足さない。既定 0 では下の if ごと飛ぶのでビット一致。
  const moistExtraN = new Float64Array(W);
  const moistExtraS = new Float64Array(W);
  if (K.itczMoistLandPullDeg > 0) {
    // 供給の代理は step01 で読める量だけで組む(step06 の供給場は無い):
    // 海岸から近い陸(水蒸気の入り口)。**標高は入れない** — 高所は既存吸引の
    // 側(標高増強・プラトー)が既に数えており、下の max 融合で eff として
    // 差し引かれる。φ にも標高を入れると山地を持つ列を二重に罰し、低地の
    // 対流源と高原が同居する列(メキシコ西岸)で吸引が立たない(実測)。
    const supplyAt = (i: number): number =>
      Math.exp(-(ctx.landDistToCoastKm[i] ?? 0) / 600); // 内陸 600km で 1/e
    // 列の生重み = 陸率 × 供給の代理(帯平均)。対流源は帯(35°)を埋め尽くさ
    // なくても線を留めるので、帯の 1/6 の実効占有で飽和させる(プラトー吸引の
    // cover01 の ×6 飽和と同じ扱い。×3 では島・半島規模(マダガスカル級)が
    // 飽和に届かず吸引が立たない — 実測)
    const scanMoist = (col: number, row0: number, row1: number): number => {
      let n = 0;
      let sum = 0;
      for (let row = row0; row <= row1; row++) {
        n++;
        const i = row * W + col;
        if (terrain.landMask[i]) sum += supplyAt(i);
      }
      return Math.min(1, (n > 0 ? sum / n : 0) * 6);
    };
    const wRawN = new Float32Array(W);
    const wRawS = new Float32Array(W);
    // 既存吸引(モンスーン + プラトー)の declNorm=1 あたりの生値
    const basePerDeclN = new Float32Array(W);
    const basePerDeclS = new Float32Array(W);
    for (let col = 0; col < W; col++) {
      wRawN[col] = scanMoist(col, rowN35, rowEq);
      wRawS[col] = scanMoist(col, rowEq + 1, rowS35);
      basePerDeclN[col] =
        K.itczMonsoonPullDeg * (landFracN[col] ?? 0) * (elevBoostN[col] ?? 1) + (plateauPullN[col] ?? 0);
      basePerDeclS[col] =
        K.itczMonsoonPullDeg * (landFracS[col] ?? 0) * (elevBoostS[col] ?? 1) + (plateauPullS[col] ?? 0);
    }
    // 島・半島は経度 2〜4 列しか持たず単独列では重みが立たないため、
    // ±3° の近傍列移動平均で平滑してから φ にする
    const phiN = smoothCyclic(wRawN, grid.resolutionDeg, 3);
    const phiS = smoothCyclic(wRawS, grid.resolutionDeg, 3);
    // 既存吸引の実効値: centers に入った後と同じ 12° 平滑 + 混ぜ戻しを通す
    const effWideN = smoothCyclic(basePerDeclN, grid.resolutionDeg);
    const effWideS = smoothCyclic(basePerDeclS, grid.resolutionDeg);
    const blend = K.itczSmoothLocalBlend;
    for (let col = 0; col < W; col++) {
      const effN = (1 - blend) * (effWideN[col] ?? 0) + blend * (basePerDeclN[col] ?? 0);
      const effS = (1 - blend) * (effWideS[col] ?? 0) + blend * (basePerDeclS[col] ?? 0);
      moistExtraN[col] = Math.max(0, K.itczMoistLandPullDeg * (phiN[col] ?? 0) - effN);
      moistExtraS[col] = Math.max(0, K.itczMoistLandPullDeg * (phiS[col] ?? 0) - effS);
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const decl = laggedDeclinationDeg(insolation.monthlyDeclinationDeg, m, K.circulationLagMonths);
    const declNorm = decl / tilt; // -1..1
    const centers = new Float32Array(W);
    for (let col = 0; col < W; col++) {
      // 海上の ITCZ は熱慣性でほとんど動かず、陸上では太陽を大きく追う
      // (Log/Pasta の明示規則)。経度列の帯内陸率で季節追従を減衰する
      const landness = Math.min(1, (landFracN[col] ?? 0) + (landFracS[col] ?? 0));
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
    // 件 2: 湿った陸の吸引は**広域平滑の後**に足す。centers に混ぜると島の
    // 局所吸引が 12° 平滑で希釈され、この機構を作った意味が消えるため
    // (φ 自体は ±3° で平滑済み)。夏ゲートは既存吸引と同じ declNorm。
    // 北半球夏(declNorm > 0)は北の対流源へ、南半球夏は南の対流源へ引く
    if (K.itczMoistLandPullDeg > 0) {
      for (let col = 0; col < W; col++) {
        smoothed[col] =
          (smoothed[col] ?? 0) +
          declNorm * (declNorm >= 0 ? (moistExtraN[col] ?? 0) : (moistExtraS[col] ?? 0));
      }
    }
    monthlyCenterLatDegByCol.push(smoothed);
  }
  return { monthlyCenterLatDegByCol, halfWidthDeg: K.itczHalfWidthDeg };
}

/** 経度循環の移動平均(半幅 halfWidthDeg 度。省略時は K.itczSmoothingHalfWidthDeg) */
function smoothCyclic(
  values: Float32Array,
  resolutionDeg: number,
  halfWidthDeg: number = K.itczSmoothingHalfWidthDeg,
): Float32Array {
  const W = values.length;
  const half = Math.max(1, Math.round(halfWidthDeg / resolutionDeg));
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

/**
 * 段 46: 循環が参照する赤緯(暦の遅れつき)。lag = 0 なら配列参照と厳密一致。
 * 円環の線形補間(月 11.5 と 0.5 の間も正しく繋ぐ)
 */
function laggedDeclinationDeg(monthlyDeclinationDeg: ArrayLike<number>, m: number, lagMonths: number): number {
  if (lagMonths === 0) return monthlyDeclinationDeg[m] ?? 0;
  const n = 12;
  let t = m - lagMonths;
  while (t < 0) t += n;
  const i0 = Math.floor(t) % n;
  const i1 = (i0 + 1) % n;
  const f = t - Math.floor(t);
  return (monthlyDeclinationDeg[i0] ?? 0) * (1 - f) + (monthlyDeclinationDeg[i1] ?? 0) * f;
}
