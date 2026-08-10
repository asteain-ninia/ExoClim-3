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

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const u = new Float32Array(grid.cellCount);
    const v = new Float32Array(grid.cellCount);
    const p = windBelt.monthlyPressureAnomalyHpa[m];
    const centers = itcz.monthlyCenterLatDegByCol[m];
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;

    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        const itczLat = centers?.[col] ?? 0;

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

        let bu = 0;
        let bv = 0;
        if (lat > itczLat && lat <= ridgeN) {
          // 北半球貿易風(北東風 → 西南西へ吹く: u 負、v は ITCZ へ向かい負)
          const t = bandWeight(lat, itczLat, ridgeN);
          bu = -K.tradeWindMs * t * dirSign * zonalRev;
          bv = -K.tradeWindMs * 0.4 * t;
        } else if (lat <= itczLat && lat >= ridgeS) {
          const t = bandWeight(lat, itczLat, ridgeS);
          bu = -K.tradeWindMs * t * dirSign * zonalRev;
          bv = K.tradeWindMs * 0.4 * t;
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
