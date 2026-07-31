// 空間ホールドアウト分割(FB 2026-07-31 P1-1)。
// 分割定義は実運用前に本ファイルと docs/FB対応記録.md で凍結する。
//
// 定義: 30°×30° の粗ブロック(緯度 6 × 経度 12 = 72 個)を決定的ハッシュで
// 5 区画(fold 0〜4)へ割り当てる。ブロックを粗くするのは、隣接セルが訓練と
// 検証へ細切れに混ざって空間自己相関で漏れるのを防ぐため。
// 全セルはちょうど 1 区画に属する(重複なし・和は全球)。
// 地域ゲートは枠中心の属す区画へ事前登録する(gateFoldAssignments)。

import { REGION_GATES } from './scoring';

export const HOLDOUT_FOLDS = 5;
export const HOLDOUT_BLOCK_DEG = 30;

/** セル(または任意の点)の属す区画 0〜4。決定的・解像度非依存 */
export function foldOfLatLon(latDeg: number, lonDeg: number): number {
  const blockRow = Math.min(
    180 / HOLDOUT_BLOCK_DEG - 1,
    Math.max(0, Math.floor((90 - latDeg) / HOLDOUT_BLOCK_DEG)),
  );
  const blockCol = Math.min(
    360 / HOLDOUT_BLOCK_DEG - 1,
    Math.max(0, Math.floor(((lonDeg + 540) % 360) / HOLDOUT_BLOCK_DEG)),
  );
  let h = Math.imul(blockRow + 1, 0x9e3779b9) ^ Math.imul(blockCol + 1, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) % HOLDOUT_FOLDS;
}

/** 指定区画を除外するセルフィルタ(訓練側)。undefined 区画なら全通し */
export function keepExcludingFold(
  holdoutFold: number | undefined,
): ((latDeg: number, lonDeg: number) => boolean) | undefined {
  if (holdoutFold === undefined) return undefined;
  return (lat, lon) => foldOfLatLon(lat, lon) !== holdoutFold;
}

/** 指定区画のみ通すセルフィルタ(保留検証側) */
export function keepOnlyFold(fold: number): (latDeg: number, lonDeg: number) => boolean {
  return (lat, lon) => foldOfLatLon(lat, lon) === fold;
}

/** 地域ゲートの事前登録: 枠中心の属す区画(南極ゲートは全経度のため中心 0°E) */
export function gateFoldAssignments(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of REGION_GATES) {
    out[g.id] = foldOfLatLon((g.latMin + g.latMax) / 2, (g.lonMin + g.lonMax) / 2);
  }
  return out;
}
