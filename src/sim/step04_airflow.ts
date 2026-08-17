// Step 4: 地表風。docs/spec/04_気流.md
// 帯状の卓越風(貿易風・偏西風・極東風)に、気圧偏差場からの勾配風
// (回転成分 + 摩擦による横断成分)を合成する。山岳は風を減衰させる。
// 低緯度では回転成分を弱め、横断(気圧の低い方へ)成分を優先する。

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { AirflowResult, ItczResult, SimContext, WindBeltResult } from './types';

export function computeAirflow(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
): AirflowResult {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const dirSign = params.body.rotationDirection >= 0 ? 1 : -1;
  const dyKm = cellHeightKm(grid, params.body.radiusKm);

  const monthlyWindU: Float32Array[] = [];
  const monthlyWindV: Float32Array[] = [];

  // 段 42: モンスーン反転の経度ゲート(経度列の熱帯陸割合)。
  // step02 の troughLandFrac と同じ定義。**係数 0 のときは計算ごと飛ばす**
  // (既定でビット一致を保つ + 費用ゼロ)
  const colLandFrac = new Float64Array(W);
  if (K.monsoonMeridionalReversal > 0 || K.monsoonInflowMs > 0) {
    const rowN30 = Math.max(0, Math.round((90 - 30) / grid.resolutionDeg) - 1);
    const rowS30 = Math.min(H - 1, Math.round((90 + 30) / grid.resolutionDeg));
    for (let col = 0; col < W; col++) {
      let n = 0;
      let nLand = 0;
      for (let row = rowN30; row <= rowS30; row++) {
        n++;
        if (terrain.landMask[row * W + col]) nLand++;
      }
      colLandFrac[col] = n > 0 ? nLand / n : 0;
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const u = new Float32Array(grid.cellCount);
    const v = new Float32Array(grid.cellCount);
    const p = windBelt.monthlyPressureAnomalyHpa[m];
    const centers = itcz.monthlyCenterLatDegByCol[m];
    const ridgeBaseN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeBaseS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    // リッジは経度で動く(段 16)。押し上げ量 0 のときは従来と厳密に一致する
    const ridgeShiftCol = windBelt.monthlyRidgeShiftDegByCol[m];
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;

    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        const itczLat = centers?.[col] ?? 0;
        const rShift = ridgeShiftCol?.[col] ?? 0;
        const ridgeN = ridgeBaseN + rShift;
        const ridgeS = ridgeBaseS - rShift;

        // --- 帯状卓越風 ---
        // 注(WL#29 赤道越えモンスーン): 2 度実装して 2 度撤回(較正記録参照)。
        // 2 回目(2026-07-30、高原トラフ 21-24°N 実現後、ITCZ>10° の経度限定
        // ゲート付き)でも大分類 −0.2〜−0.3pt。東風→西風の反転は風上を海から
        // 陸(西隣の乾燥大陸)へ切り替えて逆効果になる。インドの A 群化の真の
        // ブロッカーは南半島の冬温度(EBM)と判明 — そちらが先。
        //
        // **2026-08-10(段 8)に再開**: 上の棄却理由は「風上追跡の上流が海か陸か」
        // という**非保存の到達可能性指数の性質そのもの**であり、降水が保存型に
        // なった今は成り立たない(docs/事前登録_保存則で無効化された過去の棄却)。
        // 既定は `crossEquatorialMonsoon: 0` = 従来と厳密に一致。
        //
        // 機構: ITCZ が赤道から離れた経度では、対岸半球の貿易風が赤道を越えて
        // 流れ込む。越えた先ではコリオリの向きが反転するので気流は曲げられ、
        // 東風成分が西風成分へ変わる(実物の南西モンスーン)。
        // 効くのは**赤道と ITCZ の間の帯**だけで、赤道で 0、ITCZ 線上で最大。
        // 緯度や経度の名指しはしない — ITCZ の変位だけで決まる。
        let crossEq = 0;
        if (itczLat !== 0 && lat * itczLat > 0 && Math.abs(lat) < Math.abs(itczLat)) {
          const disp = Math.min(1, Math.abs(itczLat) / K.crossEquatorialRefDeg);
          const turn = Math.abs(lat) / Math.abs(itczLat); // 赤道 0 → ITCZ 1
          crossEq = K.crossEquatorialMonsoon * disp * turn;
        }
        /** 1 で従来の東風、0 で無風、−1 で同じ強さの西風 */
        const zonalRev = 1 - 2 * crossEq;
        /**
         * 子午面成分の反転(段 41、2026-08-16 に配線を訂正)。
         * 1 で従来の赤道向き、−1 で同じ強さの極向き。
         * **既定 0 のとき meridRev = 1 で従来とビット一致。**
         *
         * 実物の夏のモンスーンは下層で海から大陸へ吹き込む極向きの流れで、
         * 水を運ぶのは子午面成分のほうである(2026-08-16 の診断)。
         *
         * > **初版の配線は誤りだった**(同日、掃引が全水準ビット一致して発覚)。
         * > `crossEq` を駆動源にしたが、これは `crossEquatorialMonsoon`(既定 0)を
         * > 含むので**常に 0** であり、何を掛けても効かなかった。
         * > さらに `crossEq` が効く範囲は「赤道と ITCZ の間」で、
         * > ITCZ は夏でも 20〜25° までしか北上しないため
         * > **狙った亜熱帯(30〜37°)には最初から届かない**。
         *
         * 訂正後の駆動源は **ITCZ の変位そのもの**(`disp`)と
         * **夏半球であること**の 2 つ。ITCZ が夏半球へ北上しているとき、
         * その極側の貿易風帯で子午面成分を弱め、やがて反転させる。
         * これは実物のモンスーン循環(ITCZ の北上に伴い下層が海から大陸へ吹く)
         * の素直な表現であり、緯度も経度も名指ししない。
         */
        let monsoonMerid = 0;
        if (K.monsoonMeridionalReversal > 0 && itczLat !== 0 && lat * itczLat > 0) {
          // ITCZ が赤道からどれだけ離れたか(0〜1)。夏の強さそのもの
          const disp = Math.min(1, Math.abs(itczLat) / K.crossEquatorialRefDeg);
          // ITCZ の**極側**で効く。ITCZ 線上で最大、リッジで 0 へ落ちる
          const ridge = lat >= 0 ? ridgeN : ridgeS;
          const span = Math.abs(ridge) - Math.abs(itczLat);
          if (span > 1) {
            const away = (Math.abs(lat) - Math.abs(itczLat)) / span; // ITCZ 0 → リッジ 1
            if (away >= 0 && away <= 1) {
              // 経度ゲート(段 42): 熱帯陸割合が ref 以上の経度で全開、海だけなら 0。
              // 段 41 はこれが無く、海上にも極向き流を立てて分布を均してしまった
              const gate = Math.min(1, (colLandFrac[col] ?? 0) / K.monsoonLandFracRef);
              monsoonMerid = K.monsoonMeridionalReversal * disp * (1 - away) * gate;
            }
          }
        }
        const meridRev = 1 - 2 * monsoonMerid;

        let bu = 0;
        let bv = 0;
        if (lat > itczLat && lat <= ridgeN) {
          // 北半球貿易風(北東風 → 西南西へ吹く: u 負、v は ITCZ へ向かい負)
          const t = bandWeight(lat, itczLat, ridgeN);
          bu = -K.tradeWindMs * t * dirSign * zonalRev;
          bv = -K.tradeWindMs * 0.4 * t * meridRev;
        } else if (lat <= itczLat && lat >= ridgeS) {
          const t = bandWeight(lat, itczLat, ridgeS);
          bu = -K.tradeWindMs * t * dirSign * zonalRev;
          bv = K.tradeWindMs * 0.4 * t * meridRev;
        } else if (lat > ridgeN && lat <= pfN) {
          const t = bandWeight(lat, ridgeN, pfN);
          bu = K.westerlyWindMs * t * dirSign;
          bv = K.westerlyWindMs * 0.15 * t;
        } else if (lat < ridgeS && lat >= pfS) {
          const t = bandWeight(lat, ridgeS, pfS);
          bu = K.westerlyWindMs * t * dirSign;
          bv = -K.westerlyWindMs * 0.15 * t;
        } else if (lat > pfN) {
          bu = -K.polarEasterlyMs * dirSign;
          bv = -K.polarEasterlyMs * 0.3;
        } else if (lat < pfS) {
          bu = -K.polarEasterlyMs * dirSign;
          bv = K.polarEasterlyMs * 0.3;
        }

        // --- モンスーン吸い込み流(段 43)。既定 0 = この節は丸ごと飛ぶ ---
        if (K.monsoonInflowMs > 0 && itczLat !== 0 && lat * itczLat > 0) {
          const halfW = Math.max(1, itcz.halfWidthDeg);
          const ridge = lat >= 0 ? ridgeN : Math.abs(ridgeS);
          const aLat = Math.abs(lat);
          const aItcz = Math.abs(itczLat);
          // ITCZ の雨帯を守る: 影響圏の内側では 0、そこから halfWidth でランプ
          const ramp = Math.min(1, Math.max(0, (aLat - aItcz) / halfW));
          // リッジの先は halfWidth で減衰(偏西風帯まで持ち込まない)
          const fade = aLat <= ridge ? 1 : Math.max(0, 1 - (aLat - ridge) / halfW);
          if (ramp > 0 && fade > 0) {
            const disp = Math.min(1, aItcz / K.crossEquatorialRefDeg);
            const gate = Math.min(1, (colLandFrac[col] ?? 0) / K.monsoonLandFracRef);
            const add = K.monsoonInflowMs * disp * ramp * fade * gate;
            // 極向き(夏半球で赤道から陸へ)。海セルにも通す = fetch
            bv += (lat >= 0 ? 1 : -1) * add;
          }
        }

        // --- 気圧勾配風(合計を上限で抑える。実地表風は 5〜10 m/s 級) ---
        if (p) {
          const east = row * W + wrapCol(grid, col + 1);
          const west = row * W + wrapCol(grid, col - 1);
          const north = row > 0 ? (row - 1) * W + col : i;
          const south = row < H - 1 ? (row + 1) * W + col : i;
          // hPa / 1000km
          const dpdx = (((p[east] ?? 0) - (p[west] ?? 0)) / (2 * dxKm)) * 1000;
          const dpdy = (((p[north] ?? 0) - (p[south] ?? 0)) / (2 * dyKm)) * 1000;
          // コリオリの効く緯度では等圧線沿い(回転)、低緯度では横断(気圧の低い方へ)が主。
          // モンスーン流は非地衡なので回転成分は |lat|<30° で滑らかに殺す
          const f = Math.sin((Math.abs(lat) * Math.PI) / 180);
          const rotRamp = Math.min(1, Math.max(0, (Math.abs(lat) - 10) / 20));
          const rotSign = (lat >= 0 ? 1 : -1) * dirSign;
          const rotW = K.pressureGradientRotationalMsPerHpaPerMm * f * rotRamp;
          const crossW = K.pressureGradientCrossMsPerHpaPerMm * (1 - 0.5 * f);
          let pu = rotSign * rotW * -dpdy - crossW * dpdx;
          let pv = rotSign * rotW * dpdx - crossW * dpdy;
          const pMag = Math.hypot(pu, pv);
          const P_MAX = 8;
          if (pMag > P_MAX) {
            pu *= P_MAX / pMag;
            pv *= P_MAX / pMag;
          }
          bu += pu;
          bv += pv;
        }

        // --- 山岳減衰(高地は地表風が地形に削られる) ---
        const elev = terrain.elevationMeters[i] ?? 0;
        if (elev > 1500) {
          const damp = Math.max(0.35, 1 - (elev - 1500) / 4000);
          bu *= damp;
          bv *= damp;
        }
        // 合計風速の上限(地表月平均としての妥当域)
        const mag = Math.hypot(bu, bv);
        const MAX_WIND = 13;
        if (mag > MAX_WIND) {
          bu *= MAX_WIND / mag;
          bv *= MAX_WIND / mag;
        }
        u[i] = bu;
        v[i] = bv;
      }
    }
    monthlyWindU.push(u);
    monthlyWindV.push(v);
  }
  return { monthlyWindU, monthlyWindV };
}

/**
 * 帯の内側の重み。端で 0.5、中央で 1.0(0.5→1→0.5)。
 * 帯の境界でも風は消えない — 隣の帯へ連続に受け渡すため下限 0.5 を持つ。
 * (旧コメントは「0→1→0」と書いていたが実装と不一致だった。挙動は不変)
 */
function bandWeight(lat: number, edge0: number, edge1: number): number {
  const t = (lat - edge0) / (edge1 - edge0);
  if (t < 0 || t > 1) return 0;
  return Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.5 + 0.5;
}
