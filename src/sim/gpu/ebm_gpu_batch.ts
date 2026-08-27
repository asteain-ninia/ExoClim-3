// EBM(step5 気温)の WebGPU 実装の**バッチ版** — 掃引の水準 L をまとめて解く。
//
// 対応 spec: docs/spec/05_気温.md。移植元は単発版 src/sim/gpu/ebm_gpu.ts で、
// **物理・数値の式は 1 対 1 に同じ**。設計の出発点と実測は
// docs/実験記録_掃引のGPUバッチ化案_2026-08-19.md。
//
// なぜバッチ化するか(2026-08-21 のミニベンチ scripts/bench_gpu_batch.ts):
//   1° 格子(360×180 = 64,800 セル、254 WG)は RTX 4080 に対して
//   1 ディスパッチが小さすぎ、掃引はコマンド律速(使用率 100% 表示で 70W)。
//   水準 L をまとめて 1 ディスパッチに載せると、ディスパッチ回数そのままで
//   ワークグループだけ L 倍になり、実効スループット 5〜6 倍(L=8〜16 実測)。
//
// レイアウト(「緯度方向に水準を積む」):
//   総行数 = L×H、総セル = L×N。水準 lvl のセルはグローバル添字
//   [lvl×N, (lvl+1)×N) を占める。
//   - セル別(cells/monthly/temp/work/accum/ice): 各 field のストライドが L×N
//   - 行別(rows): 各 field のストライドが L×H
//   緯度・行物理は**局所行**(r % P.ch)で評価する。近傍ガードも局所行で
//   行うので、水準境界 = 極行のクランプになり、水準間のリークは構造的に
//   起きない(bench_gpu_batch.ts で検証した形と同じ)。
//
// 水準別の定数(単発版ではユニフォームだった k 由来の項目)は
// var<storage, read> の LevelParams 配列へ移し、カーネル内で
// lvl = (i / P.cw) / P.ch から引く。ユニフォームには全水準で共通の
// 時間ステップ状態(月・刻み・積算スロットなど)だけを残す。
//
// 単発版との使い分け:
//   - バッチ版は**掃引専用**。onCoarseSnapshot(プレビュー)は持たない
//     (control の cancel と progress だけ尊重する)。
//   - 反復回数は全水準一括(最悪水準に合わせる)。保守的で、答えは変わらない
//     (収束すれば線形系の解は一意 — docs/実験記録_EBM赤黒順序_2026-08-01.md)。

import { GPU_WORKGROUP_SIZE, ReadbackStage, asBufferSource, type GpuContext } from './device';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import type { AccelControl, EbmAccelResult, EbmConstants, EbmStaticFields } from '../accel';
import { throwIfCancelled, yieldToEventLoop } from '../run_control';

/** セル別静的場の本数(単発版と同じ。WGSL 側の添字と一致させる) */
const CELL_FIELDS = 11;
/** 月別セル別の場の数: 0 cloud, 1 windU, 2 windV, 3 evap, 4 evapFbK, 5 evapRefT */
const MONTHLY_FIELDS = 6;
/** 作業領域の本数 */
const WORK_FIELDS = 14;
/**
 * 共有ユニフォーム(Params)の大きさ。水準別の定数を LevelParams(storage)へ
 * 追い出したので単発版(192B)より小さい。**WGSL の struct と CPU 側の
 * ArrayBuffer が必ずこれを共有すること**(はみ出した書き込みは黙って捨てられる
 * — 単発版の注記)。16 バイトの倍数であること。
 */
const PARAM_BYTES = 64;
/**
 * 水準別定数 1 水準ぶんのワード数(f32/u32 32 個 = 128 バイト)。
 * **WGSL の LevelParams struct の並びと CPU 側の詰め込みを必ず一致させること。**
 * 余りはパディング(将来の項目追加でストライドが動かないよう切りよく取る)。
 */
const LEVEL_PARAM_WORDS = 32;
/**
 * 残差バッファに収まる時間ステップ数の上限(単発版と同じ根拠 — 64 年 +
 * 加速期 2 年 = 15,840 ステップが要る。教訓 §9「掲げた上限が下流の上限に
 * 収まっているか」)。バッチ版の残差はステップ×水準の 2 次元で、
 * ステップ s・水準 lvl の残差を residual[s * L + lvl] に置く。
 */
const MAX_STEPS = 16384;
/**
 * maxSteps の値の輸出(単発版 ebm_gpu.ts の MAX_STEPS と同値)。
 * バッチ実行器(scripts/gpu_batch_pool.ts — 掃引と較正が共有)が worker_threads 側の
 * 代理 EbmAccel に **同期プロパティとして**渡すために要る — step05 は
 * `ebmAccel.maxSteps` を同期に読んで年数の倍化を抑えるので、
 * 代理側は主スレッドへ問い合わせずに答えられなければならない。
 */
export const EBM_BATCH_MAX_STEPS = MAX_STEPS;
/** 行別バッファの確保上限(単発版と同じ) */
const MAX_ROWS = 512;

const WGSL = /* wgsl */ `
// 全水準で共通の時間ステップ状態だけを持つ(水準別の定数は PL へ)
struct Params {
  cw : u32, ch : u32, n : u32, levels : u32,
  iters : u32, m0 : u32, m1 : u32, monthIndex : u32,
  stepIndex : u32, frac : f32, capScale : f32, dtSec : f32,
  dPhi : f32, resDeg : f32, accumulate : u32, accumSlot : u32,
};

// 水準別の較正定数(単発版のユニフォームの k 由来項目と同名・同意味)。
// **並びは CPU 側の詰め込み(LEVEL_PARAM_WORDS)と 1 対 1**。
struct LevelParams {
  gamma : f32, iceRamp : f32, albedoIce : f32, permIceAlbedo : f32,
  seaIceInsul : f32, olrB : f32, dBase : f32, zonalDiff : f32,
  hadleyBoost : f32, chanFactor : f32, summerAdv : f32, advCoupling : f32,
  winterInvDiff : f32, winterInvAdv : f32, ridgeAbsN : f32, ridgeAbsS : f32,
  summerN : u32, summerS : u32, hasEvap : u32, hasEvapFb : u32,
  slabIce : u32, seaFreeze : f32, iceK : f32, iceLatent : f32,
  iceMinH : f32, iceCoverScale : f32,
  advConservative : u32, _q1 : u32, _q2 : u32, _q3 : u32, _q4 : u32, _q5 : u32,
};

@group(0) @binding(0) var<uniform> P : Params;
// セル別静的場(各 field のストライドは L×N): 0 heatCap, 1 aEff,
// 2 surfAlbedoBase, 3 iceOnset, 4 qFlux, 5 elevM, 6 landFrac,
// 7 diffFactor, 8 interior01, 9 permanentIce, 10 insCapFrac(海氷断熱の掛け先 = 熱容量の海成分率)
@group(0) @binding(1) var<storage, read> cells : array<f32>;
// 行別(各 field のストライドは L×H): 0 cosCenter, 1 metricZonal,
// 2 rowIsChannel, 3 insolAnnual, 4.. 12 か月の日射
@group(0) @binding(2) var<storage, read> rows : array<f32>;
// 月別セル別(各 12×L×N): 0 cloud, 1 windU, 2 windV, 3 evap,
//                        4 evapFbK(W/m²/K), 5 evapRefT(°C)
@group(0) @binding(3) var<storage, read> monthly : array<f32>;
// **temp は二役**(単発版の注記のとおり): 各時間ステップの入口では前ステップの
// 温度 T^n、prepA 以降は反復の作業変数。prepA より前に書き換えてはいけない
@group(0) @binding(4) var<storage, read_write> temp : array<f32>;
// 作業(各 field のストライドは L×N): 0 rhs, 1 diag, 2 gzE, 3 gzW, 4 gN,
// 5 gS, 6 advCu, 7 advCv, 8 upwindU, 9 upwindV, 10 dfEff, 11 cOverDt,
// 12 evapK, 13 iceCond
@group(0) @binding(5) var<storage, read_write> work : array<f32>;
@group(0) @binding(6) var<storage, read_write> accum : array<f32>;
/** [step × L] のステップ別・水準別残差 */
@group(0) @binding(7) var<storage, read_write> residual : array<f32>;
/** 反復前の温度(残差 = 合成作用素の変化量 を測るための控え) */
@group(0) @binding(8) var<storage, read_write> tPrev : array<f32>;
/** 前年の月別積算。最終年との差が周期定常への到達度になる */
@group(0) @binding(9) var<storage, read_write> accumPrev : array<f32>;
/** 海氷の厚さ(水等価 mm)。水準の slabIce が無効なら誰も読み書きしない */
@group(0) @binding(10) var<storage, read_write> ice : array<f32>;
/** 水準別の較正定数 */
@group(0) @binding(11) var<storage, read> PL : array<LevelParams>;

const WG : u32 = ${GPU_WORKGROUP_SIZE}u;
var<workgroup> partial : array<f32, ${GPU_WORKGROUP_SIZE}>;

// アクセサは**グローバル添字**(i は 0..L×N、r は 0..L×H)を取る。
// ストライドだけが単発版の P.n → P.n×P.levels、P.ch → P.ch×P.levels に変わる
fn cellF(field : u32, i : u32) -> f32 { return cells[field * P.n * P.levels + i]; }
fn workF(field : u32, i : u32) -> f32 { return work[field * P.n * P.levels + i]; }
fn setWork(field : u32, i : u32, v : f32) { work[field * P.n * P.levels + i] = v; }
fn rowF(field : u32, r : u32) -> f32 { return rows[field * P.ch * P.levels + r]; }
fn insolOf(month : u32, r : u32) -> f32 {
  return rows[(4u + month) * P.ch * P.levels + r];
}
fn monthlyF(field : u32, month : u32, i : u32) -> f32 {
  return monthly[field * 12u * P.n * P.levels + month * P.n * P.levels + i];
}
// 緯度は**局所行**(r % P.ch)で決まる — 水準はグローバル行に積んであるだけ
fn latOfRow(r : u32) -> f32 { return 90.0 - (f32(r % P.ch) + 0.5) * P.resDeg; }

/** 行の実効南北拡散係数(ハドレー増強込み)。定数は行が属す水準のものを引く */
fn dMeridOfRow(r : u32) -> f32 {
  let L = PL[r / P.ch];
  let lat = latOfRow(r);
  var ridgeAbs = L.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = L.ridgeAbsN; }
  let hadleyW = max(0.0, 1.0 - (lat / ridgeAbs) * (lat / ridgeAbs));
  return L.dBase * (1.0 + L.hadleyBoost * hadleyW);
}

// ---- 段 C-0: 保存的移流の外向き係数(L.advConservative == 1u のときだけ使う)----
// 単発版 ebm_gpu.ts の同名関数と同形(CPU 前計算 advOutE/W/N/S と同じ式)。
// j はグローバル添字。行因子は行が属す水準の定数・行場から引き、
// 南北の行き先の範囲検査は**局所行**で行う(水準境界 = 極行と同じ扱い)。
// dir: 0 = 東、1 = 西、2 = 北、3 = 南
fn advOutTo(j : u32, dir : u32) -> f32 {
  let rj = j / P.cw;             // グローバル行
  let L = PL[rj / P.ch];
  let lat = latOfRow(rj);
  var isSummer = L.summerS == 1u;
  if (lat >= 0.0) { isSummer = L.summerN == 1u; }
  var seasonFactor = 1.0;
  if (isSummer) { seasonFactor = L.summerAdv; }
  var inv = 1.0;
  if (insolOf(P.m0, rj) < rowF(3u, rj)) {
    inv = 1.0 - (1.0 - L.winterInvAdv) * cellF(8u, j);
  }
  let advScale = seasonFactor * inv * L.advCoupling;
  if (dir <= 1u) {
    // 東西: u > 0 は東向き、u < 0 は西向き(u == 0 はどちらにも出ない)
    let uMs = monthlyF(1u, P.m0, j);
    if ((dir == 0u && uMs > 0.0) || (dir == 1u && uMs < 0.0)) {
      return advScale * (min(9.0, abs(uMs)) / 4.0);
    }
    return 0.0;
  }
  // 南北: v > 0 は北向き、v < 0 は南向き(v == 0 はどちらにも出ない)。
  // 行き先の範囲検査は局所行(CPU の targetRow 範囲検査と同じ)
  let vMs = monthlyF(2u, P.m0, j);
  if (dir == 2u && vMs <= 0.0) { return 0.0; }
  if (dir == 3u && vMs >= 0.0) { return 0.0; }
  let rl = rj % P.ch;            // 局所行
  if (vMs > 0.0 && rl == 0u) { return 0.0; }
  if (vMs < 0.0 && rl >= P.ch - 1u) { return 0.0; }
  var targetRow = rj + 1u;       // 局所範囲内なので ±1 は水準を出ない
  if (vMs > 0.0) { targetRow = rj - 1u; }
  var ridgeAbs = L.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = L.ridgeAbsN; }
  let vBandW = clamp((abs(lat) - ridgeAbs) / 10.0, 0.0, 1.0);
  let chanV = 1.0 - (1.0 - L.chanFactor) * max(rowF(2u, rj), rowF(2u, targetRow));
  let landGrip = 0.25 + 0.75 * cellF(6u, j);
  return advScale * vBandW * chanV * landGrip * (min(5.0, abs(vMs)) / 4.0);
}

// ---- 第 1 段: 実効熱容量・実効拡散係数・右辺(t に依存する) ----
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn prepA(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n * P.levels) { return; }
  let r = i / P.cw;              // グローバル行(= lvl×H + 局所行)
  let L = PL[r / P.ch];
  let s0 = insolOf(P.m0, r);
  let s1 = insolOf(P.m1, r);
  let s = s0 * (1.0 - P.frac) + s1 * P.frac;

  let tSurf = temp[i] - L.gamma * cellF(5u, i);
  // **陸の季節雪と海氷は別の量**(単発版・CPU 版と同じ扱い)
  let snowW = clamp((cellF(3u, i) - tSurf) / L.iceRamp, 0.0, 1.0);
  var seaW = snowW;
  let oceanFrac = 1.0 - cellF(6u, i);
  // 無効時は混合式を通さない(1ulp のずれで単発版との一致が壊れるため)
  var iceW = snowW;
  if (L.slabIce == 1u) {
    seaW = min(1.0, ice[i] / L.iceCoverScale);
    iceW = cellF(6u, i) * snowW + oceanFrac * seaW;
  }
  let base = cellF(2u, i);
  var aSurf = base + (L.albedoIce - base) * iceW;
  if (cellF(9u, i) >= 0.5) { aSurf = max(aSurf, L.permIceAlbedo); }
  let cloud = monthlyF(0u, P.m0, i) * (1.0 - P.frac) + monthlyF(0u, P.m1, i) * P.frac;
  let albedo = cloud + (1.0 - cloud) * aSurf;

  // 断熱は海の側だけの現象なので seaW で掛ける
  let capEff = cellF(0u, i) * (1.0 - L.seaIceInsul * seaW * cellF(10u, i)) * P.capScale;
  // 氷を通じた海からの伝導 F = k(T_freeze − T)/h。T の関数なので陰的に扱う
  var iceCond = 0.0;
  if (L.slabIce == 1u && ice[i] > 0.0) {
    iceCond = (L.iceK * oceanFrac * 1000.0) / max(L.iceMinH, ice[i]);
  }
  setWork(13u, i, iceCond);
  var evap = 0.0;
  if (L.hasEvap == 1u) {
    evap = monthlyF(3u, P.m0, i) * (1.0 - P.frac) + monthlyF(3u, P.m1, i) * P.frac;
  }
  // 蒸発帰還 ∂LE/∂T。対角へ k、右辺へ k·T_ref
  var evapK = 0.0;
  var evapRhs = 0.0;
  if (L.hasEvapFb == 1u) {
    evapK = monthlyF(4u, P.m0, i) * (1.0 - P.frac) + monthlyF(4u, P.m1, i) * P.frac;
    let tRef = monthlyF(5u, P.m0, i) * (1.0 - P.frac) + monthlyF(5u, P.m1, i) * P.frac;
    evapRhs = evapK * tRef;
  }
  setWork(12u, i, evapK);
  let cOverDt = capEff / P.dtSec;
  setWork(0u, i, cOverDt * temp[i] + iceCond * L.seaFreeze + s * (1.0 - albedo)
    - cellF(1u, i) + cellF(4u, i) - evap + evapRhs);
  // 冬(月日射 < 年平均)の陸は接地逆転層で拡散が地表に届きにくい
  var invD = 1.0;
  if (insolOf(P.m0, r) < rowF(3u, r)) {
    invD = 1.0 - (1.0 - L.winterInvDiff) * cellF(8u, i);
  }
  setWork(10u, i, cellF(7u, i) * invD);
  setWork(11u, i, cOverDt);
}

// ---- 第 2 段: 界面伝導度・移流結合・対角(t に依存しない) ----
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn prepB(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n * P.levels) { return; }
  let W = P.cw;
  let r = i / W;                 // グローバル行
  let rl = r % P.ch;             // 局所行(近傍ガードはこれで行う)
  let L = PL[r / P.ch];
  let c = i % W;
  let lat = latOfRow(r);
  let cosC = max(1.0e-3, rowF(0u, r));
  let gz = (L.dBase * L.zonalDiff * rowF(1u, r)) / (P.dPhi * P.dPhi);
  var ridgeAbs = L.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = L.ridgeAbsN; }
  let phiEdgeN = (lat + P.resDeg * 0.5) * 0.017453292519943295;
  let phiEdgeS = (lat - P.resDeg * 0.5) * 0.017453292519943295;
  // 海峡らしさは 0〜1 の重み。r±1 は**局所行のガード**の下でだけ踏むので
  // 水準境界を越えない(越えるときは自行にクランプ = 極行と同じ扱い)
  var chW_N = rowF(2u, r);
  if (rl > 0u) { chW_N = max(chW_N, rowF(2u, r - 1u)); }
  var chanN = 1.0 - (1.0 - L.chanFactor) * chW_N;
  var chW_S = rowF(2u, r);
  if (rl < P.ch - 1u) { chW_S = max(chW_S, rowF(2u, r + 1u)); }
  var chanS = 1.0 - (1.0 - L.chanFactor) * chW_S;
  // 南北の面伝導度は**面の量**(単発版の注記のとおり両側平均)
  var gN = 0.0;
  if (rl > 0u) {
    let dm = 0.5 * (dMeridOfRow(r) + dMeridOfRow(r - 1u));
    gN = (chanN * dm * cos(phiEdgeN)) / (P.dPhi * P.dPhi * cosC);
  }
  var gS = 0.0;
  if (rl < P.ch - 1u) {
    let dm = 0.5 * (dMeridOfRow(r) + dMeridOfRow(r + 1u));
    gS = (chanS * dm * cos(phiEdgeS)) / (P.dPhi * P.dPhi * cosC);
  }
  var isSummer = L.summerS == 1u;
  if (lat >= 0.0) { isSummer = L.summerN == 1u; }
  var seasonFactor = 1.0;
  if (isSummer) { seasonFactor = L.summerAdv; }
  let vBandW = clamp((abs(lat) - ridgeAbs) / 10.0, 0.0, 1.0);

  // 近傍のグローバル添字。東西は同じグローバル行の中で折り返し、
  // 南北は局所行でガードするので水準はまたがない
  let east = r * W + ((c + 1u) % W);
  let west = r * W + ((c + W - 1u) % W);
  var north = i;
  if (rl > 0u) { north = (r - 1u) * W + c; }
  var south = i;
  if (rl < P.ch - 1u) { south = (r + 1u) * W + c; }

  let uMs = monthlyF(1u, P.m0, i);
  let vMs = monthlyF(2u, P.m0, i);
  var inv = 1.0;
  if (insolOf(P.m0, r) < rowF(3u, r)) {
    inv = 1.0 - (1.0 - L.winterInvAdv) * cellF(8u, i);
  }
  let advScale = seasonFactor * inv * L.advCoupling;
  let advCu = advScale * (min(9.0, abs(uMs)) / 4.0);
  var upwindU = east;
  if (uMs >= 0.0) { upwindU = west; }
  var upwindV = north;
  if (vMs >= 0.0) { upwindV = south; }
  // upwindV / W はグローバル行なので rowF にそのまま渡せる
  let chW_V = max(rowF(2u, r), rowF(2u, upwindV / W));
  var chanV = 1.0 - (1.0 - L.chanFactor) * chW_V;
  let landGrip = 0.25 + 0.75 * cellF(6u, i);
  var advCv = 0.0;
  if (upwindV != i) {
    advCv = advScale * vBandW * chanV * landGrip * (min(5.0, abs(vMs)) / 4.0);
  }

  // 界面伝導度 = 両セルの実効拡散係数の平均(i→j と j→i で同一 = 保存的)
  let dfI = workF(10u, i);
  let gzE = gz * 0.5 * (dfI + workF(10u, east));
  let gzW = gz * 0.5 * (dfI + workF(10u, west));
  let gNEff = gN * 0.5 * (dfI + workF(10u, north));
  let gSEff = gS * 0.5 * (dfI + workF(10u, south));
  if (L.advConservative == 0u) {
    // 旧式(風上 1 点参照)。**この分岐は原式そのまま — 1 文字も変えない**
    setWork(1u, i, workF(11u, i) + L.olrB + workF(12u, i) + workF(13u, i)
      + gzE + gzW + gNEff + gSEff + advCu + advCv);
    setWork(2u, i, gzE);
    setWork(3u, i, gzW);
    setWork(4u, i, gNEff);
    setWork(5u, i, gSEff);
    setWork(6u, i, advCu);
    setWork(7u, i, advCv);
    setWork(8u, i, f32(upwindU));
    setWork(9u, i, f32(upwindV));
  } else {
    // 段 C-0: 保存形(単発版 prepB の同名分岐と同形)。面係数 = 両側セルの
    // 外向き係数の和、南北は cos(面)/cos(中心) の計量。東西を gzE/gzW、
    // 南北/cosC を gN/gS の作業場へ畳み込み、風上 1 点参照の項は 0 にする
    let cEf = advOutTo(i, 0u) + advOutTo(east, 1u);
    let cWf = advOutTo(i, 1u) + advOutTo(west, 0u);
    var cNf = 0.0;
    if (rl > 0u) { cNf = (advOutTo(i, 2u) + advOutTo(north, 3u)) * cos(phiEdgeN); }
    var cSf = 0.0;
    if (rl < P.ch - 1u) { cSf = (advOutTo(i, 3u) + advOutTo(south, 2u)) * cos(phiEdgeS); }
    setWork(1u, i, workF(11u, i) + L.olrB + workF(12u, i) + workF(13u, i)
      + gzE + gzW + gNEff + gSEff + cEf + cWf + (cNf + cSf) / cosC);
    setWork(2u, i, gzE + cEf);
    setWork(3u, i, gzW + cWf);
    setWork(4u, i, gNEff + cNf / cosC);
    setWork(5u, i, gSEff + cSf / cosC);
    setWork(6u, i, 0.0);
    setWork(7u, i, 0.0);
    setWork(8u, i, f32(i));
    setWork(9u, i, f32(i));
  }
}

fn sweepCell(i : u32, color : u32) {
  let W = P.cw;
  let r = i / W;
  let rl = r % P.ch;
  let c = i % W;
  // 市松の色は**局所行**で取る(単発版の (r+c) と厳密に同じ塗り分けになる。
  // グローバル行で取ると H が奇数のとき水準ごとに赤黒が入れ替わり、
  // 反復の順序が単発版とずれる)
  if ((rl + c) % 2u != color) { return; }
  let east = r * W + ((c + 1u) % W);
  let west = r * W + ((c + W - 1u) % W);
  var north = i;
  if (rl > 0u) { north = (r - 1u) * W + c; }
  var south = i;
  if (rl < P.ch - 1u) { south = (r + 1u) * W + c; }
  let off =
    workF(2u, i) * temp[east] +
    workF(3u, i) * temp[west] +
    workF(4u, i) * temp[north] +
    workF(5u, i) * temp[south] +
    workF(6u, i) * temp[u32(workF(8u, i))] +
    workF(7u, i) * temp[u32(workF(9u, i))];
  temp[i] = (workF(0u, i) + off) / workF(1u, i);
}

// 赤黒の 2 巡は別のエントリ(同じエンコーダ内でユニフォームを書き換えられない)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepRed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n * P.levels) { return; }
  sweepCell(gid.x, 0u);
}
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepBlack(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n * P.levels) { return; }
  sweepCell(gid.x, 1u);
}

// ---- 極行の帯状平滑(反復作用素の一部)----
// 1 行を 1 スレッドが担当(グローバル行なので L×H 行ぶんディスパッチする)。
// 加算順を固定して決定性を保つ
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn polar(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= P.ch * P.levels) { return; }
  if (abs(latOfRow(r)) < 84.0) { return; }
  let W = P.cw;
  var sum = 0.0;
  for (var c = 0u; c < W; c = c + 1u) { sum = sum + temp[r * W + c]; }
  let mean = sum / f32(W);
  for (var c = 0u; c < W; c = c + 1u) {
    let i = r * W + c;
    temp[i] = temp[i] * 0.5 + mean * 0.5;
  }
}

// ---- 海氷の厚さを更新する(0 層模型)----
// **CPU 版・単発 GPU 版と 1 対 1**。順序も同じ: 反復の後 → 氷更新 → 積算
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn updateIce(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n * P.levels) { return; }
  let L = PL[(i / P.cw) / P.ch];
  if (L.slabIce == 0u) { return; }
  let oceanFrac = 1.0 - cellF(6u, i);
  if (oceanFrac <= 0.0) { return; }
  let capEff = workF(11u, i) * P.dtSec;
  let tNew = temp[i];
  var h = ice[i];
  if (h > 0.0) {
    // 海 → 氷底の伝導ぶんだけ凍る(負なら融ける)
    let cond = workF(13u, i) * (L.seaFreeze - tNew);
    h = h + (cond * P.dtSec) / (L.iceLatent * P.capScale);
    if (h < 0.0) {
      let leftoverJ = -h * L.iceLatent * P.capScale;
      h = 0.0;
      let cFull = cellF(0u, i) * P.capScale;
      if (cFull > 0.0) { temp[i] = L.seaFreeze + leftoverJ / cFull; }
    }
    // 融解中の表面は凍結点に留まる(余分な熱は全部潜熱に食われる)
    let tAfter = temp[i];
    if (h > 0.0 && tAfter > L.seaFreeze) {
      let excessJ = capEff * oceanFrac * (tAfter - L.seaFreeze);
      let meltMm = excessJ / (L.iceLatent * P.capScale);
      if (meltMm < h) {
        h = h - meltMm;
        temp[i] = tAfter - oceanFrac * (tAfter - L.seaFreeze);
      } else {
        let usedJ = h * L.iceLatent * P.capScale;
        h = 0.0;
        if (capEff > 0.0) { temp[i] = tAfter - usedJ / capEff; }
      }
    }
    ice[i] = h;
  } else if (tNew < L.seaFreeze) {
    // 氷なしで凍結点を下回った: 超過分を氷に変え、温度を凍結点へ戻す
    let deficitJ = capEff * oceanFrac * (L.seaFreeze - tNew);
    ice[i] = h + deficitJ / (L.iceLatent * P.capScale);
    temp[i] = tNew + oceanFrac * (L.seaFreeze - tNew);
  }
}

// ---- 残差(合成作用素 1 反復ぶんの最大変化量)を**水準ごと**に測る ----
// 1 水準 = 1 ワークグループ(dispatch L 個)。各ワークグループが自水準の
// N セルを固定順で縮約するので、単発版と同じ順序・同じ答えになる。
// **氷の更新より前に測ること**(単発版の注記のとおり — 反復の外の物理を
// 混ぜると反復回数の適応が決して下がらない残差を追いかける)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn measureResidual(
  @builtin(local_invocation_id) lid : vec3<u32>,
  @builtin(workgroup_id) wid : vec3<u32>,
) {
  let tid = lid.x;
  let lvl = wid.x;
  let base = lvl * P.n;
  var m = 0.0;
  for (var i = tid; i < P.n; i = i + WG) {
    m = max(m, abs(temp[base + i] - tPrev[base + i]));
  }
  partial[tid] = m;
  workgroupBarrier();
  if (tid == 0u) {
    var mm = 0.0;
    for (var k = 0u; k < WG; k = k + 1u) { mm = max(mm, partial[k]); }
    residual[P.stepIndex * P.levels + lvl] = mm;
  }
}

// ---- 月別積算(水準ごとのスラブに積む)----
// **氷の更新より後に積算する**(そのステップの最終温度を積む — 単発版と同じ)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn accumulate(
  @builtin(local_invocation_id) lid : vec3<u32>,
  @builtin(workgroup_id) wid : vec3<u32>,
) {
  let tid = lid.x;
  if (P.accumulate == 1u) {
    let base = wid.x * P.n;
    for (var i = tid; i < P.n; i = i + WG) {
      let idx = P.monthIndex * P.n * P.levels + base + i;
      if (P.accumSlot == 1u) {
        accum[idx] = accum[idx] + temp[base + i];
      } else {
        accumPrev[idx] = accumPrev[idx] + temp[base + i];
      }
    }
  }
}
`;

/** バッチ版加速器の受け口(単発版 EbmAccel のバッチ対応形) */
export interface EbmGpuBatchAccel {
  /**
   * 水準 L ぶんの EBM を一度に積分する。fieldsList[lvl] と kList[lvl] が
   * 水準 lvl の入力で、結果も同じ並びで返る。
   * **全水準が同じ格子・同じ時間ステップ構造であること**(実行時に検査)。
   */
  runBatch(
    fieldsList: EbmStaticFields[],
    kList: EbmConstants[],
    control?: AccelControl,
  ): Promise<EbmAccelResult[]>;
  /** 回せる時間ステップ数の上限(単発版と同じ意味) */
  readonly maxSteps: number;
  destroy(): void;
}

export function createEbmGpuBatchAccel(
  gpu: GpuContext,
  cellCount: number,
  levels: number,
): EbmGpuBatchAccel {
  if (!(Number.isInteger(levels) && levels >= 1)) {
    throw new Error(`水準数が不正(levels=${levels})`);
  }
  const { device } = gpu;
  const N = cellCount;
  const L = levels;
  const LN = L * N;
  const M = MONTHS_PER_YEAR;
  const ST = GPUBufferUsage.STORAGE;
  const CS = GPUBufferUsage.COPY_SRC;
  const CD = GPUBufferUsage.COPY_DST;
  /** 行別バッファの本数: cos, metric, channel, 年平均日射 + 12 か月 */
  const ROW_FIELDS = 4 + M;

  const bufCells = device.createBuffer({ size: CELL_FIELDS * LN * 4, usage: ST | CD });
  const bufRows = device.createBuffer({ size: ROW_FIELDS * MAX_ROWS * L * 4, usage: ST | CD });
  const bufMonthly = device.createBuffer({ size: MONTHLY_FIELDS * M * LN * 4, usage: ST | CD });
  const bufTemp = device.createBuffer({ size: LN * 4, usage: ST | CS | CD });
  const bufWork = device.createBuffer({ size: WORK_FIELDS * LN * 4, usage: ST });
  const bufAccum = device.createBuffer({ size: M * LN * 4, usage: ST | CS | CD });
  const bufResidual = device.createBuffer({ size: MAX_STEPS * L * 4, usage: ST | CS | CD });
  const bufPrev = device.createBuffer({ size: LN * 4, usage: ST | CS | CD });
  const bufAccumPrev = device.createBuffer({ size: M * LN * 4, usage: ST | CS | CD });
  const bufIce = device.createBuffer({ size: LN * 4, usage: ST | CS | CD });
  const bufParams = device.createBuffer({ size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | CD });
  const bufLevelParams = device.createBuffer({ size: L * LEVEL_PARAM_WORDS * 4, usage: ST | CD });
  const stage = new ReadbackStage(device, 2 * M * LN + LN + MAX_STEPS * L + LN);

  const module = device.createShaderModule({ code: WGSL });
  // **明示レイアウトが必須**(単発版の注記のとおり。layout: 'auto' は
  // 一部しか触らないカーネルへ全バインディングを渡すと検証エラーになる)
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 11, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });
  const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
  const mk = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ layout: pipeLayout, compute: { module, entryPoint } });
  const pipePrepA = mk('prepA');
  const pipePrepB = mk('prepB');
  const pipeRed = mk('sweepRed');
  const pipeBlack = mk('sweepBlack');
  const pipePolar = mk('polar');
  const pipeResidual = mk('measureResidual');
  const pipeAccumulate = mk('accumulate');
  const pipeUpdateIce = mk('updateIce');

  const entries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: bufParams } },
    { binding: 1, resource: { buffer: bufCells } },
    { binding: 2, resource: { buffer: bufRows } },
    { binding: 3, resource: { buffer: bufMonthly } },
    { binding: 4, resource: { buffer: bufTemp } },
    { binding: 5, resource: { buffer: bufWork } },
    { binding: 6, resource: { buffer: bufAccum } },
    { binding: 7, resource: { buffer: bufResidual } },
    { binding: 8, resource: { buffer: bufPrev } },
    { binding: 9, resource: { buffer: bufAccumPrev } },
    { binding: 10, resource: { buffer: bufIce } },
    { binding: 11, resource: { buffer: bufLevelParams } },
  ];
  const bind = device.createBindGroup({ layout: bindLayout, entries });

  const cellGroups = Math.ceil(LN / GPU_WORKGROUP_SIZE);
  const scratchCells = new Float32Array(CELL_FIELDS * LN);
  const scratchRows = new Float32Array(ROW_FIELDS * MAX_ROWS * L);
  const scratchMonthly = new Float32Array(MONTHLY_FIELDS * M * LN);
  const scratchTemp = new Float32Array(LN);
  const scratchIce = new Float32Array(LN);
  const scratchZeroCells = new Float32Array(M * LN);
  const scratchResidual = new Float32Array(MAX_STEPS * L);
  const zeroMonth = new Float32Array(N);
  const paramBuf = new ArrayBuffer(PARAM_BYTES);
  const pu = new Uint32Array(paramBuf);
  const pf = new Float32Array(paramBuf);
  const levelBuf = new ArrayBuffer(L * LEVEL_PARAM_WORDS * 4);
  const lu = new Uint32Array(levelBuf);
  const lf = new Float32Array(levelBuf);

  return {
    maxSteps: MAX_STEPS,
    destroy(): void {
      for (const b of [
        bufCells,
        bufRows,
        bufMonthly,
        bufTemp,
        bufWork,
        bufAccum,
        bufResidual,
        bufPrev,
        bufAccumPrev,
        bufIce,
        bufParams,
        bufLevelParams,
      ]) {
        b.destroy();
      }
      stage.destroy();
    },

    async runBatch(
      fieldsList: EbmStaticFields[],
      kList: EbmConstants[],
      control?: AccelControl,
    ): Promise<EbmAccelResult[]> {
      // ---- 前提ガード ----
      // バッチは 1 本の時間ステップループを全水準で共有する。格子・時間構造が
      // 揃っていない水準を黙って混ぜると答えが静かに壊れるので、全部検査する
      if (fieldsList.length !== L || kList.length !== L) {
        throw new Error(
          `水準数が生成時と違う(確保 ${L} / fields ${fieldsList.length} / k ${kList.length})`,
        );
      }
      const F0 = fieldsList[0]!;
      const CW = F0.widthCells;
      const CH = F0.heightCells;
      if (CW * CH !== N) throw new Error(`EBM のセル数が違う(確保 ${N} / 要求 ${CW * CH})`);
      if (CH > MAX_ROWS) throw new Error(`行数が上限を超えた(${CH} > ${MAX_ROWS})`);
      // 市松が経度の折り返しで成立する条件(単発版と同じ)
      if (CW % 2 !== 0) {
        throw new Error(
          `EBM の GPU 経路は経度セル数が偶数であることを要求する(CW=${CW})。` +
            '赤黒順序の市松が経度の折り返しで壊れる。CPU 経路(行優先)を使うこと',
        );
      }
      for (let lvl = 1; lvl < L; lvl++) {
        const f = fieldsList[lvl]!;
        const same =
          f.widthCells === CW &&
          f.heightCells === CH &&
          f.stepsPerYear === F0.stepsPerYear &&
          f.years === F0.years &&
          f.fullCapacityYears === F0.fullCapacityYears &&
          f.dtSeconds === F0.dtSeconds &&
          f.spinupCapacityFraction === F0.spinupCapacityFraction;
        if (!same) {
          throw new Error(
            `水準 ${lvl} の格子・時間ステップ構造が水準 0 と違う。` +
              'バッチは 1 本の時間ループを共有するので、全水準を揃えること',
          );
        }
      }

      // ---- 静的場の転送(水準ごとに連結)----
      for (let lvl = 0; lvl < L; lvl++) {
        const f = fieldsList[lvl]!;
        const cellSrc = [
          f.heatCap,
          f.aEff,
          f.surfAlbedoBase,
          f.iceOnset,
          f.qFlux,
          f.elevM,
          f.landFrac,
          f.diffFactor,
          f.interior01,
          f.permanentIce,
          f.insCapFrac,
        ];
        for (let fd = 0; fd < CELL_FIELDS; fd++) {
          scratchCells.set(cellSrc[fd]!, fd * LN + lvl * N);
        }
      }
      device.queue.writeBuffer(bufCells, 0, asBufferSource(scratchCells));

      // 行別。**各 field のストライドは L×CH**(シェーダ側の rowF と一致)
      scratchRows.fill(0);
      for (let lvl = 0; lvl < L; lvl++) {
        const f = fieldsList[lvl]!;
        scratchRows.set(f.cosCenter, 0 * L * CH + lvl * CH);
        scratchRows.set(f.metricZonal, 1 * L * CH + lvl * CH);
        scratchRows.set(f.rowIsChannel, 2 * L * CH + lvl * CH);
        scratchRows.set(f.insolAnnualByRow, 3 * L * CH + lvl * CH);
        for (let m = 0; m < M; m++) {
          scratchRows.set(
            f.insolMonthlyByRow.subarray(m * CH, (m + 1) * CH),
            (4 + m) * L * CH + lvl * CH,
          );
        }
      }
      device.queue.writeBuffer(bufRows, 0, asBufferSource(scratchRows));

      for (let lvl = 0; lvl < L; lvl++) {
        const f = fieldsList[lvl]!;
        const monthlySrc = [f.cloudAlbedo, f.windU, f.windV];
        for (let fd = 0; fd < 3; fd++) {
          for (let m = 0; m < M; m++) {
            scratchMonthly.set(monthlySrc[fd]![m] ?? zeroMonth, (fd * M + m) * LN + lvl * N);
          }
        }
        for (let m = 0; m < M; m++) {
          scratchMonthly.set(f.evapAnom?.[m] ?? zeroMonth, (3 * M + m) * LN + lvl * N);
          scratchMonthly.set(f.evapFeedback?.k[m] ?? zeroMonth, (4 * M + m) * LN + lvl * N);
          scratchMonthly.set(f.evapFeedback?.refTempC[m] ?? zeroMonth, (5 * M + m) * LN + lvl * N);
        }
      }
      device.queue.writeBuffer(bufMonthly, 0, asBufferSource(scratchMonthly));

      for (let lvl = 0; lvl < L; lvl++) {
        const f = fieldsList[lvl]!;
        if (f.initialT) {
          scratchTemp.set(f.initialT, lvl * N);
        } else {
          for (let row = 0; row < CH; row++) {
            const init = -20 + 48 * (f.cosCenter[row] ?? 0);
            for (let col = 0; col < CW; col++) scratchTemp[lvl * N + row * CW + col] = init;
          }
        }
        // 氷厚は**パスをまたいで持ち越す状態**。渡されなければ 0 から始める
        if (f.initialIce) scratchIce.set(f.initialIce, lvl * N);
        else scratchIce.fill(0, lvl * N, (lvl + 1) * N);
      }
      device.queue.writeBuffer(bufTemp, 0, asBufferSource(scratchTemp));
      device.queue.writeBuffer(bufIce, 0, asBufferSource(scratchIce));
      scratchZeroCells.fill(0);
      device.queue.writeBuffer(bufAccum, 0, asBufferSource(scratchZeroCells));
      device.queue.writeBuffer(bufAccumPrev, 0, asBufferSource(scratchZeroCells));
      scratchResidual.fill(0);
      device.queue.writeBuffer(bufResidual, 0, asBufferSource(scratchResidual));

      const totalSteps = F0.years * F0.stepsPerYear;
      if (totalSteps > MAX_STEPS) {
        throw new Error(
          `時間ステップ数が上限を超えた(${totalSteps} > ${MAX_STEPS})。` +
            `呼び出し側が maxSteps を見て年数を抑えていない`,
        );
      }
      const spinupSteps = Math.max(0, (F0.years - F0.fullCapacityYears) * F0.stepsPerYear);
      const lastYearStart = (F0.years - 1) * F0.stepsPerYear;
      const prevYearStart = Math.max(0, (F0.years - 2) * F0.stepsPerYear);
      // 反復回数は**全水準一括で最悪水準に合わせる**(保守的で正しい —
      // 余計に回した水準も収束解は同じ。水準別に減らす最適化はしない)
      let iters = 1;
      for (const k of kList) iters = Math.max(iters, Math.round(k.iterationsPerStep));
      // 加速期を抜けた後は 1/4(単発版の実測注記と同じ根拠)
      const itersLate = Math.max(1, iters >> 2);
      const monthCount = new Array<number>(M).fill(0);
      const polarGroups = Math.ceil((CH * L) / GPU_WORKGROUP_SIZE);
      const anySlab = kList.some((k) => k.slabIce);

      // 中断と進捗の刻み(単発版と同じ 1 か月ぶんの時間ステップ)。
      // バッチは掃引用なのでスナップショットは持たない — cancel と progress のみ
      const TICK_STEPS = Math.max(1, Math.round(F0.stepsPerYear / M));

      for (let step = 0; step < totalSteps; step++) {
        if (step % TICK_STEPS === 0) throwIfCancelled(control?.signal, 'EBM(バッチ)');
        const capScale = step < spinupSteps ? F0.spinupCapacityFraction : 1;
        const yearFrac = (step % F0.stepsPerYear) / F0.stepsPerYear;
        const monthFloat = yearFrac * M;
        const m0 = Math.floor(monthFloat - 0.5 + M) % M;
        const m1 = (m0 + 1) % M;
        const frac = (monthFloat - 0.5 + M) % 1;
        const accumulate = step >= prevYearStart;
        const accumSlot = step >= lastYearStart ? 1 : 0;
        const monthIndex = Math.min(M - 1, Math.floor(yearFrac * M));
        if (accumSlot === 1) monthCount[monthIndex] = (monthCount[monthIndex] ?? 0) + 1;

        // 加速期は対角優位が崩れるので反復を減らせない(単発版の注記)
        const itersNow = step < spinupSteps ? iters : itersLate;
        pu[0] = CW;
        pu[1] = CH;
        pu[2] = N;
        pu[3] = L;
        pu[4] = itersNow;
        pu[5] = m0;
        pu[6] = m1;
        pu[7] = monthIndex;
        pu[8] = step;
        pf[9] = frac;
        pf[10] = capScale;
        pf[11] = F0.dtSeconds;
        pf[12] = (360 / CW) * (Math.PI / 180);
        pf[13] = 360 / CW;
        pu[14] = accumulate ? 1 : 0;
        pu[15] = accumSlot;
        device.queue.writeBuffer(bufParams, 0, paramBuf);

        // 水準別定数。リッジ緯度・夏判定が月(m0)で変わるので毎ステップ書く
        // (L×32 float 程度なので費用は無視できる)
        for (let lvl = 0; lvl < L; lvl++) {
          const f = fieldsList[lvl]!;
          const k = kList[lvl]!;
          const ridgeNNow = f.ridgeLatN[m0] ?? 31;
          const ridgeSNow = f.ridgeLatS[m0] ?? -31;
          const o = lvl * LEVEL_PARAM_WORDS;
          lf[o + 0] = k.lapseRateGammaCPerM;
          lf[o + 1] = k.iceRampWidthC;
          lf[o + 2] = k.albedoIce;
          lf[o + 3] = k.permanentIceAlbedo;
          lf[o + 4] = k.seaIceInsulationFactor;
          lf[o + 5] = k.olrBWm2PerC;
          lf[o + 6] = k.diffusionBase;
          lf[o + 7] = k.zonalDiffusionFactor;
          lf[o + 8] = k.hadleyDiffusionBoost;
          lf[o + 9] = k.circumpolarChannelFactor;
          lf[o + 10] = k.summerAdvectionFactor;
          lf[o + 11] = k.zonalAdvectionCouplingWm2PerK;
          lf[o + 12] = k.winterInversionDiffusionFactor;
          lf[o + 13] = k.winterInversionAdvectionFactor;
          lf[o + 14] = Math.max(15, Math.abs(ridgeNNow));
          lf[o + 15] = Math.max(15, Math.abs(ridgeSNow));
          lu[o + 16] = ridgeNNow > f.meanRidgeN ? 1 : 0;
          lu[o + 17] = ridgeSNow < f.meanRidgeS ? 1 : 0;
          lu[o + 18] = f.evapAnom ? 1 : 0;
          lu[o + 19] = f.evapFeedback ? 1 : 0;
          lu[o + 20] = k.slabIce ? 1 : 0;
          lf[o + 21] = k.seaFreezeC;
          lf[o + 22] = k.seaIceConductivityWmK;
          lf[o + 23] = k.seaIceLatentJPerMm;
          lf[o + 24] = k.seaIceMinThicknessMm;
          lf[o + 25] = k.seaIceCoverScaleMm;
          // 段 C-0: 保存的移流(末尾のパディング枠 _q0 を使う — 既存の並びは不変)
          lu[o + 26] = k.advectionConservative !== 0 ? 1 : 0;
        }
        device.queue.writeBuffer(bufLevelParams, 0, levelBuf);

        // 1 時間ステップぶんを 1 つのエンコーダへ積む(submit は 1 回)
        const enc = device.createCommandEncoder();
        const run = (p: GPUComputePipeline, groups: number): void => {
          const pass = enc.beginComputePass();
          pass.setPipeline(p);
          pass.setBindGroup(0, bind);
          pass.dispatchWorkgroups(groups);
          pass.end();
        };
        run(pipePrepA, cellGroups);
        run(pipePrepB, cellGroups);
        for (let it = 0; it < itersNow; it++) {
          // 最終反復の直前に控えを取り、合成作用素 1 回ぶんの変化量を残差にする
          if (it === itersNow - 1) enc.copyBufferToBuffer(bufTemp, 0, bufPrev, 0, LN * 4);
          run(pipeRed, cellGroups);
          run(pipeBlack, cellGroups);
          run(pipePolar, polarGroups);
        }
        // 順序が意味を持つ: 残差は**氷更新の前**、積算は**氷更新の後**(単発版と同じ)。
        // 残差・積算は水準ごとに 1 ワークグループ = L ワークグループを立てる。
        // slabIce が 1 水準でも有効ならディスパッチし、無効な水準はカーネル内の
        // 水準別ガードが素通しする(温度も氷も触らない)
        run(pipeResidual, L);
        if (anySlab) run(pipeUpdateIce, cellGroups);
        run(pipeAccumulate, L);
        device.queue.submit([enc.finish()]);
        const tickEnd = step % TICK_STEPS === TICK_STEPS - 1 || step === totalSteps - 1;
        if (tickEnd) {
          // 進捗の受け手がいなくても、中断を受け取るために制御は返す
          await yieldToEventLoop();
          control?.progress?.({
            fraction: (step + 1) / totalSteps,
            detail:
              `EBM バッチ積分 ${Math.floor(step / F0.stepsPerYear) + 1}/${F0.years} 年目・` +
              `${L} 水準・反復 ${iters}`,
          });
        }
      }

      // 読み戻しは 1 回だけ(積算 + 最終温度 + 残差 + 氷厚。水準ぶんまとめて)
      const enc = device.createCommandEncoder();
      stage.enqueueCopyAt(enc, bufAccum, 0, M * LN);
      stage.enqueueCopyAt(enc, bufAccumPrev, M * LN, M * LN);
      stage.enqueueCopyAt(enc, bufTemp, 2 * M * LN, LN);
      stage.enqueueCopyAt(enc, bufResidual, 2 * M * LN + LN, MAX_STEPS * L);
      stage.enqueueCopyAt(enc, bufIce, 2 * M * LN + LN + MAX_STEPS * L, LN);
      device.queue.submit([enc.finish()]);
      const flat = await stage.map(2 * M * LN + LN + MAX_STEPS * L + LN);

      // ---- 水準ごとに切り出して単発版と同じ形の結果を組む ----
      const resOff = 2 * M * LN + LN;
      const iceOff = resOff + MAX_STEPS * L;
      const results: EbmAccelResult[] = [];
      for (let lvl = 0; lvl < L; lvl++) {
        const f = fieldsList[lvl]!;
        const k = kList[lvl]!;
        const monthAccum: Float32Array[] = [];
        for (let m = 0; m < M; m++) {
          const off = m * LN + lvl * N;
          monthAccum.push(flat.slice(off, off + N));
        }
        const finalT = flat.slice(2 * M * LN + lvl * N, 2 * M * LN + lvl * N + N);
        let maxResidualC = 0;
        const stepResidualsC = new Float32Array(totalSteps);
        for (let s = 0; s < totalSteps; s++) {
          const v = flat[resOff + s * L + lvl] ?? 0;
          stepResidualsC[s] = v;
          if (v > maxResidualC) maxResidualC = v;
        }
        // 周期定常への到達度(単発版と同じ物差し: 年平均の面積重み平均 |Δ|)
        let sumW = 0;
        let sumWD = 0;
        let maxYearDriftC = 0;
        for (let i = 0; i < N; i++) {
          const row = Math.floor(i / CW);
          const w = f.cosCenter[row] ?? 0;
          let annualA = 0;
          let annualB = 0;
          for (let m = 0; m < M; m++) {
            const cnt = Math.max(1, monthCount[m] ?? 1);
            annualA += (flat[m * LN + lvl * N + i] ?? 0) / cnt;
            annualB += (flat[M * LN + m * LN + lvl * N + i] ?? 0) / cnt;
          }
          const d = Math.abs(annualA - annualB) / M;
          if (d > maxYearDriftC) maxYearDriftC = d;
          sumW += w;
          sumWD += w * d;
        }
        const meanYearDriftC = sumW > 0 ? sumWD / sumW : 0;
        results.push({
          monthAccum,
          monthCount: [...monthCount],
          finalT,
          finalIce: flat.slice(iceOff + lvl * N, iceOff + lvl * N + N),
          maxResidualC,
          stepResidualsC,
          converged: maxResidualC <= k.solveToleranceC,
          maxYearDriftC,
          meanYearDriftC,
        });
      }
      return results;
    },
  };
}
