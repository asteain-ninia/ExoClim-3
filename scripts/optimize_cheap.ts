// **較正の検証専用の安い設定(既定は無効。実際の較正では設定しないこと)。**
//
// なぜ要るか(2026-08-23):
//   較正の並列評価をプロセス並列から worker_threads + EBM バッチへ載せ替えた
//   (scripts/optimize_batch_lib.ts)。旧経路と新経路が**同じ答えを出す**ことを
//   確かめるには、1 評価 500 秒の本条件ではなく数十秒で回る条件が要る。
//   条件は親・子プロセス・worker_threads の**全経路に同じに**掛からなければ
//   比較にならない(2026-08-15 に `EBM_SOLVER.adaptive` の写し間違いで
//   v3 が 0.02〜0.06 ずれた前科がある)。掃引側の SWEEP_GRID_DEG 等
//   (scripts/sweep_lib.ts)と同じ作りで、環境変数で掛ける。
//
// **このファイルを optimize_lib.ts に置いてはならない。** 較正の来歴の指紋
//   (optimize.ts の calibrationFingerprint)は optimize_lib.ts と scoring.ts の
//   中身を hash しており、そこへ手を入れると**走行中の較正が再開を拒否する**。
//   検証の道具立てのために本番の較正を止めるのは筋が悪い。
//
// 使い方(検証だけ):
//   OPTIMIZE_GRID_DEG=2 OPTIMIZE_EBM_SWEEPS=64 OPTIMIZE_EBM_YEARS=4 npx tsx ...

import { EARTH_PARAMS, type PlanetParams } from '../src/domain/planetParams';
import { EBM_FULL_CAPACITY_YEARS, EBM_SOLVER } from '../src/sim/step05_temperature';

/** 0 = 素の EARTH_PARAMS(既定)。> 0 でその解像度に差し替える */
export const OPTIMIZE_CHEAP_GRID_DEG = Number(process.env['OPTIMIZE_GRID_DEG'] ?? 0);

// **トップレベルで掛ける。** 較正の親も、子プロセスのワーカーも、
// worker_threads のワーカーも、必ずこのモジュールを読む(= 全経路に同じ条件)
if (process.env['OPTIMIZE_EBM_SWEEPS']) {
  EBM_SOLVER.sweeps = Number(process.env['OPTIMIZE_EBM_SWEEPS']);
}
if (process.env['OPTIMIZE_EBM_YEARS']) {
  EBM_FULL_CAPACITY_YEARS.years = Number(process.env['OPTIMIZE_EBM_YEARS']);
}

/** 較正が回す惑星パラメータ。既定は EARTH_PARAMS そのもの(同一の参照) */
export function optimizeRunParams(): PlanetParams {
  return OPTIMIZE_CHEAP_GRID_DEG > 0
    ? { ...EARTH_PARAMS, gridResolutionDeg: OPTIMIZE_CHEAP_GRID_DEG }
    : EARTH_PARAMS;
}

/** 安い設定が効いているか(記録に残す用) */
export function optimizeCheapNote(): string | null {
  const parts: string[] = [];
  if (OPTIMIZE_CHEAP_GRID_DEG > 0) parts.push(`格子 ${OPTIMIZE_CHEAP_GRID_DEG}°`);
  if (process.env['OPTIMIZE_EBM_SWEEPS']) parts.push(`EBM反復 ${EBM_SOLVER.sweeps}`);
  if (process.env['OPTIMIZE_EBM_YEARS']) {
    parts.push(`EBM全熱容量 ${EBM_FULL_CAPACITY_YEARS.years} 年`);
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}
