// EBM(step5 気温)の時間積分の WebGPU 実装。
//
// 対応 spec: docs/spec/05_気温.md。CPU 実装 step05_temperature.ts の integrate()
// と同じ式・同じ作用素で移植する。
//
// なぜ GPU 化が**正しさの要求**でもあるか(2026-08-01 の実測):
//   陰的ステップの線形解を 8 スイープで打ち切っていたが、16・32・…・256 と
//   増やすと気温場が面積平均で計 2.1°C 動いた。つまり打ち切り回数が答えを
//   決めており、拡散・移流係数はその誤差を打ち消す向きに較正されていた
//   (CLAUDE.md が禁じる隠しパラメータ)。収束には 1 ステップあたり 256 反復
//   要り、CPU では 1 回の実行に 5 分以上かかって較正が回らない。
//   詳細: docs/実験記録_EBM赤黒順序_2026-08-01.md
//
// 設計(src/sim/gpu/device.ts の実測制約に従う):
//   - 反復は**赤黒順序**。市松の色は (row+col) の偶奇で、5 点ステンシルの
//     隣接は必ず相手色なので同色内は完全に並列。収束解は一意なので、
//     行優先 Gauss-Seidel と同じ答えになる(実測: 大分類の差 0.01pt)。
//   - **1 時間ステップ = 1 submit**。1 つのコマンドエンコーダへ
//     前処理 2 回 + 反復 3×N 回 + 残差 1 回をまとめて積む。ディスパッチは
//     エンコーダ内なら安いが、submit と読み戻しは高い(往復 1 回 0.3ms)。
//   - **読み戻しは積分が終わってから 1 回だけ**。往復を数百回繰り返すと
//     不安定になる実測制約への対処。
//   - 残差は**合成作用素の変化量**で測る。掃引と極行平滑は互いに押し戻すため、
//     掃引だけの変化量は 0 に落ちない(極行で下げ止まる)。
//     1 反復まるごとの前後差を見るのが正しい収束判定。

import { GPU_WORKGROUP_SIZE, ReadbackStage, asBufferSource, type GpuContext } from './device';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import type {
  AccelControl,
  EbmAccel,
  EbmAccelResult,
  EbmConstants,
  EbmStaticFields,
} from '../accel';
import { throwIfCancelled, yieldToEventLoop } from '../run_control';

/** セル別静的場の本数(WGSL 側の添字と一致させる) */
const CELL_FIELDS = 10;
/** 月別セル別の場の数: 0 cloud, 1 windU, 2 windV, 3 evap, 4 evapFbK, 5 evapRefT */
const MONTHLY_FIELDS = 6;
/** 作業領域の本数 */
const WORK_FIELDS = 14;
/**
 * 残差バッファに収まる時間ステップ数の上限。
 *
 * **掲げた上限が下流の上限に収まっているか**(教訓 §9)。step05 は周期定常に
 * 達しないと全熱容量の年数を 24 → 48 → …(上限 EBM_MAX_FULL_CAPACITY_YEARS
 * = 64)と倍増させる。240 刻みなので **64 年 + 加速期 2 年 = 15,840 ステップ**
 * が要る。旧値 8192 では 34 年ぶんしか無く、掲げた 64 年に原理的に到達できず、
 * しかも未収束と診断される前に例外で死んでいた(2026-08-02 に前セッションが
 * 発見、未修正のまま申し送り)。
 * 増やす費用は残差バッファ 64KB とステージング 32KB だけで、実質ゼロ。
 */
const MAX_STEPS = 16384;

const WGSL = /* wgsl */ `
struct Params {
  cw : u32, ch : u32, n : u32, iters : u32,
  m0 : u32, m1 : u32, monthIndex : u32, stepIndex : u32,
  frac : f32, capScale : f32, dtSec : f32, gamma : f32,
  iceRamp : f32, albedoIce : f32, permIceAlbedo : f32, seaIceInsul : f32,
  olrB : f32, dBase : f32, zonalDiff : f32, hadleyBoost : f32,
  chanFactor : f32, summerAdv : f32, advCoupling : f32, winterInvDiff : f32,
  winterInvAdv : f32, dPhi : f32, resDeg : f32, ridgeAbsN : f32,
  ridgeAbsS : f32, summerN : u32, summerS : u32, hasEvap : u32,
  accumulate : u32, accumSlot : u32, hasEvapFb : u32, slabIce : u32,
  seaFreeze : f32, iceK : f32, iceLatent : f32, iceMinH : f32,
  iceCoverScale : f32, _p1 : u32, _p2 : u32, _p3 : u32,
};

@group(0) @binding(0) var<uniform> P : Params;
// セル別静的場: 0 heatCap, 1 aEff, 2 surfAlbedoBase, 3 iceOnset, 4 qFlux,
//               5 elevM, 6 landFrac, 7 diffFactor, 8 interior01, 9 permanentIce
@group(0) @binding(1) var<storage, read> cells : array<f32>;
// 行別(間隔は ch): 0 cosCenter, 1 metricZonal, 2 rowIsChannel, 3 insolAnnual,
//                   4.. 12 か月の日射
@group(0) @binding(2) var<storage, read> rows : array<f32>;
// 月別セル別(各 12*N): 0 cloud, 1 windU, 2 windV, 3 evap,
//                     4 evapFbK(W/m²/K), 5 evapRefT(°C)
@group(0) @binding(3) var<storage, read> monthly : array<f32>;
// **temp は二役**: 各時間ステップの入口では前ステップの温度 T^n(prepA が
// 右辺 (C/dt)·T^n を作るのに読む)、以降は反復の作業変数。prepA より前に
// temp を書き換えると右辺の T^n を壊し、物理が変わる
// (2026-08-02 に初期推定の外挿を prepA の前へ置いて気温 RMSE 3000°C を出した)
@group(0) @binding(4) var<storage, read_write> temp : array<f32>;
// 作業: 0 rhs, 1 diag, 2 gzE, 3 gzW, 4 gN, 5 gS, 6 advCu, 7 advCv,
//       8 upwindU, 9 upwindV, 10 dfEff, 11 cOverDt, 12 evapK, 13 iceCond
// dfEff と diag を別の場に分けるのは、第 2 段が隣接セルの dfEff を読みながら
// 自セルへ diag を書くため(同じ場だと未読のスレッドの入力を壊す)
@group(0) @binding(5) var<storage, read_write> work : array<f32>;
@group(0) @binding(6) var<storage, read_write> accum : array<f32>;
// 前年の月別積算(周期定常への到達度を測るため)。binding 10

@group(0) @binding(7) var<storage, read_write> residual : array<f32>;
/** 反復前の温度(残差 = 合成作用素の変化量 を測るための控え) */
@group(0) @binding(8) var<storage, read_write> tPrev : array<f32>;
/** 前年の月別積算。最終年との差が周期定常への到達度になる */
@group(0) @binding(9) var<storage, read_write> accumPrev : array<f32>;
/**
 * 海氷の厚さ(水等価 mm)。**時間ステップをまたいで持ち越す状態**。
 * 0 層模型が無効(P.slabIce == 0)なら誰も読み書きしない
 */
@group(0) @binding(10) var<storage, read_write> ice : array<f32>;

const WG : u32 = ${GPU_WORKGROUP_SIZE}u;
var<workgroup> partial : array<f32, ${GPU_WORKGROUP_SIZE}>;

fn cellF(field : u32, i : u32) -> f32 { return cells[field * P.n + i]; }
fn workF(field : u32, i : u32) -> f32 { return work[field * P.n + i]; }
fn setWork(field : u32, i : u32, v : f32) { work[field * P.n + i] = v; }
fn rowF(field : u32, r : u32) -> f32 { return rows[field * P.ch + r]; }
fn insolOf(month : u32, r : u32) -> f32 { return rows[(4u + month) * P.ch + r]; }
fn monthlyF(field : u32, month : u32, i : u32) -> f32 {
  return monthly[field * 12u * P.n + month * P.n + i];
}
fn latOfRow(r : u32) -> f32 { return 90.0 - (f32(r) + 0.5) * P.resDeg; }

/** 行の実効南北拡散係数(ハドレー増強込み)。面の伝導度はこの両側平均 */
fn dMeridOfRow(r : u32) -> f32 {
  let lat = latOfRow(r);
  var ridgeAbs = P.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = P.ridgeAbsN; }
  let hadleyW = max(0.0, 1.0 - (lat / ridgeAbs) * (lat / ridgeAbs));
  return P.dBase * (1.0 + P.hadleyBoost * hadleyW);
}

// ---- 第 1 段: 実効熱容量・実効拡散係数・右辺(t に依存する) ----
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn prepA(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let r = i / P.cw;
  let s0 = insolOf(P.m0, r);
  let s1 = insolOf(P.m1, r);
  let s = s0 * (1.0 - P.frac) + s1 * P.frac;

  let tSurf = temp[i] - P.gamma * cellF(5u, i);
  // **陸の季節雪と海氷は別の量**(CPU 版と同じ扱い)。
  // 陸 = 気温で決まる季節雪、海 = 0 層模型なら氷量で決まる被覆率
  let snowW = clamp((cellF(3u, i) - tSurf) / P.iceRamp, 0.0, 1.0);
  var seaW = snowW;
  let oceanFrac = 1.0 - cellF(6u, i);
  // 無効時は混合式を通さない(1ulp のずれで旧結果との一致が壊れるため)
  var iceW = snowW;
  if (P.slabIce == 1u) {
    seaW = min(1.0, ice[i] / P.iceCoverScale);
    iceW = cellF(6u, i) * snowW + oceanFrac * seaW;
  }
  let base = cellF(2u, i);
  var aSurf = base + (P.albedoIce - base) * iceW;
  if (cellF(9u, i) >= 0.5) { aSurf = max(aSurf, P.permIceAlbedo); }
  let cloud = monthlyF(0u, P.m0, i) * (1.0 - P.frac) + monthlyF(0u, P.m1, i) * P.frac;
  let albedo = cloud + (1.0 - cloud) * aSurf;

  // 断熱は海の側だけの現象なので seaW で掛ける
  let capEff = cellF(0u, i) * (1.0 - P.seaIceInsul * seaW * oceanFrac) * P.capScale;
  // 氷を通じた海からの伝導 F = k(T_freeze − T)/h。T の関数なので陰的に扱う
  var iceCond = 0.0;
  if (P.slabIce == 1u && ice[i] > 0.0) {
    iceCond = (P.iceK * oceanFrac * 1000.0) / max(P.iceMinH, ice[i]);
  }
  setWork(13u, i, iceCond);
  var evap = 0.0;
  if (P.hasEvap == 1u) {
    evap = monthlyF(3u, P.m0, i) * (1.0 - P.frac) + monthlyF(3u, P.m1, i) * P.frac;
  }
  // 蒸発帰還 ∂LE/∂T。対角へ k、右辺へ k·T_ref(CPU 版と同じ月按分)
  var evapK = 0.0;
  var evapRhs = 0.0;
  if (P.hasEvapFb == 1u) {
    evapK = monthlyF(4u, P.m0, i) * (1.0 - P.frac) + monthlyF(4u, P.m1, i) * P.frac;
    let tRef = monthlyF(5u, P.m0, i) * (1.0 - P.frac) + monthlyF(5u, P.m1, i) * P.frac;
    evapRhs = evapK * tRef;
  }
  setWork(12u, i, evapK);
  let cOverDt = capEff / P.dtSec;
  setWork(0u, i, cOverDt * temp[i] + iceCond * P.seaFreeze + s * (1.0 - albedo)
    - cellF(1u, i) + cellF(4u, i) - evap + evapRhs);
  // 冬(月日射 < 年平均)の陸は接地逆転層で拡散が地表に届きにくい
  var invD = 1.0;
  if (insolOf(P.m0, r) < rowF(3u, r)) {
    invD = 1.0 - (1.0 - P.winterInvDiff) * cellF(8u, i);
  }
  setWork(10u, i, cellF(7u, i) * invD);
  setWork(11u, i, cOverDt);
}

// ---- 第 2 段: 界面伝導度・移流結合・対角(t に依存しない) ----
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn prepB(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let W = P.cw;
  let H = P.ch;
  let r = i / W;
  let c = i % W;
  let lat = latOfRow(r);
  let cosC = max(1.0e-3, rowF(0u, r));
  let gz = (P.dBase * P.zonalDiff * rowF(1u, r)) / (P.dPhi * P.dPhi);
  var ridgeAbs = P.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = P.ridgeAbsN; }
  let phiEdgeN = (lat + P.resDeg * 0.5) * 0.017453292519943295;
  let phiEdgeS = (lat - P.resDeg * 0.5) * 0.017453292519943295;
  var chanN = 1.0;
  if (rowF(2u, r) >= 0.5 || (r > 0u && rowF(2u, r - 1u) >= 0.5)) { chanN = P.chanFactor; }
  var chanS = 1.0;
  if (rowF(2u, r) >= 0.5 || (r < H - 1u && rowF(2u, r + 1u) >= 0.5)) { chanS = P.chanFactor; }
  // 南北の面伝導度は**面の量**。ハドレー増強は緯度で変わるので、自セルの緯度で
  // 評価すると i→j と j→i が食い違う(Codex レビュー 2026-08-02)。
  // 面の値 = 両側セルの実効南北拡散係数の平均。cosC で割るのは体積規格化
  var gN = 0.0;
  if (r > 0u) {
    let dm = 0.5 * (dMeridOfRow(r) + dMeridOfRow(r - 1u));
    gN = (chanN * dm * cos(phiEdgeN)) / (P.dPhi * P.dPhi * cosC);
  }
  var gS = 0.0;
  if (r < H - 1u) {
    let dm = 0.5 * (dMeridOfRow(r) + dMeridOfRow(r + 1u));
    gS = (chanS * dm * cos(phiEdgeS)) / (P.dPhi * P.dPhi * cosC);
  }
  var isSummer = P.summerS == 1u;
  if (lat >= 0.0) { isSummer = P.summerN == 1u; }
  var seasonFactor = 1.0;
  if (isSummer) { seasonFactor = P.summerAdv; }
  let vBandW = clamp((abs(lat) - ridgeAbs) / 10.0, 0.0, 1.0);

  let east = r * W + ((c + 1u) % W);
  let west = r * W + ((c + W - 1u) % W);
  var north = i;
  if (r > 0u) { north = (r - 1u) * W + c; }
  var south = i;
  if (r < H - 1u) { south = (r + 1u) * W + c; }

  let uMs = monthlyF(1u, P.m0, i);
  let vMs = monthlyF(2u, P.m0, i);
  var inv = 1.0;
  if (insolOf(P.m0, r) < rowF(3u, r)) {
    inv = 1.0 - (1.0 - P.winterInvAdv) * cellF(8u, i);
  }
  let advScale = seasonFactor * inv * P.advCoupling;
  let advCu = advScale * (min(9.0, abs(uMs)) / 4.0);
  var upwindU = east;
  if (uMs >= 0.0) { upwindU = west; }
  var upwindV = north;
  if (vMs >= 0.0) { upwindV = south; }
  var chanV = 1.0;
  if (rowF(2u, r) >= 0.5 || rowF(2u, upwindV / W) >= 0.5) { chanV = P.chanFactor; }
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
  setWork(1u, i, workF(11u, i) + P.olrB + workF(12u, i) + workF(13u, i)
    + gzE + gzW + gNEff + gSEff + advCu + advCv);
  setWork(2u, i, gzE);
  setWork(3u, i, gzW);
  setWork(4u, i, gNEff);
  setWork(5u, i, gSEff);
  setWork(6u, i, advCu);
  setWork(7u, i, advCv);
  setWork(8u, i, f32(upwindU));
  setWork(9u, i, f32(upwindV));
}

fn sweepCell(i : u32, color : u32) {
  let W = P.cw;
  let H = P.ch;
  let r = i / W;
  let c = i % W;
  if ((r + c) % 2u != color) { return; }
  let east = r * W + ((c + 1u) % W);
  let west = r * W + ((c + W - 1u) % W);
  var north = i;
  if (r > 0u) { north = (r - 1u) * W + c; }
  var south = i;
  if (r < H - 1u) { south = (r + 1u) * W + c; }
  let off =
    workF(2u, i) * temp[east] +
    workF(3u, i) * temp[west] +
    workF(4u, i) * temp[north] +
    workF(5u, i) * temp[south] +
    workF(6u, i) * temp[u32(workF(8u, i))] +
    workF(7u, i) * temp[u32(workF(9u, i))];
  temp[i] = (workF(0u, i) + off) / workF(1u, i);
}

// 赤黒の 2 巡は別のエントリにする。同じエンコーダ内でユニフォームを
// 書き換えられないため(色を uniform で渡すと 1 ステップ 1 色になってしまう)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepRed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n) { return; }
  sweepCell(gid.x, 0u);
}
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepBlack(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n) { return; }
  sweepCell(gid.x, 1u);
}

// ---- 極行の帯状平滑(反復作用素の一部)----
// 1 行を 1 スレッドが担当し、加算順を固定して決定性を保つ
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn polar(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= P.ch) { return; }
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
// **CPU 版 step05_temperature.ts の同名ブロックと 1 対 1 に対応させること。**
// 片方だけ直すと加速器の有無で物理が変わる。順序も同じ:
//   反復の後 → 氷更新 → 積算(finish)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn updateIce(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  if (P.slabIce == 0u) { return; }
  let oceanFrac = 1.0 - cellF(6u, i);
  if (oceanFrac <= 0.0) { return; }
  let capEff = workF(11u, i) * P.dtSec;
  let tNew = temp[i];
  var h = ice[i];
  if (h > 0.0) {
    // 海 → 氷底の伝導ぶんだけ凍る(負なら融ける)。潜熱も加速期に同じ比率で縮める
    let cond = workF(13u, i) * (P.seaFreeze - tNew);
    h = h + (cond * P.dtSec) / (P.iceLatent * P.capScale);
    if (h < 0.0) {
      let leftoverJ = -h * P.iceLatent * P.capScale;
      h = 0.0;
      let cFull = cellF(0u, i) * P.capScale;
      if (cFull > 0.0) { temp[i] = P.seaFreeze + leftoverJ / cFull; }
    }
    // 融解中の表面は凍結点に留まる(余分な熱は全部潜熱に食われる)
    let tAfter = temp[i];
    if (h > 0.0 && tAfter > P.seaFreeze) {
      let excessJ = capEff * oceanFrac * (tAfter - P.seaFreeze);
      let meltMm = excessJ / (P.iceLatent * P.capScale);
      if (meltMm < h) {
        h = h - meltMm;
        temp[i] = tAfter - oceanFrac * (tAfter - P.seaFreeze);
      } else {
        let usedJ = h * P.iceLatent * P.capScale;
        h = 0.0;
        if (capEff > 0.0) { temp[i] = tAfter - usedJ / capEff; }
      }
    }
    ice[i] = h;
  } else if (tNew < P.seaFreeze) {
    // 氷なしで凍結点を下回った: 超過分を氷に変え、温度を凍結点へ戻す
    let deficitJ = capEff * (P.seaFreeze - tNew);
    ice[i] = h + deficitJ / (P.iceLatent * P.capScale);
    temp[i] = P.seaFreeze;
  }
}

// ---- 残差(合成作用素 1 反復ぶんの最大変化量)と月別積算 ----
// 縮約は 1 ワークグループ・固定順で行う(atomic や順序不定の並列縮約は
// 実行ごとに答えが変わる — device.ts の注記)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn finish(@builtin(local_invocation_id) lid : vec3<u32>) {
  let tid = lid.x;
  var m = 0.0;
  for (var i = tid; i < P.n; i = i + WG) {
    m = max(m, abs(temp[i] - tPrev[i]));
  }
  partial[tid] = m;
  workgroupBarrier();
  if (tid == 0u) {
    var mm = 0.0;
    for (var k = 0u; k < WG; k = k + 1u) { mm = max(mm, partial[k]); }
    residual[P.stepIndex] = mm;
  }
  if (P.accumulate == 1u) {
    for (var i = tid; i < P.n; i = i + WG) {
      let idx = P.monthIndex * P.n + i;
      if (P.accumSlot == 1u) {
        accum[idx] = accum[idx] + temp[i];
      } else {
        accumPrev[idx] = accumPrev[idx] + temp[i];
      }
    }
  }
}
`;

export function createEbmGpu(gpu: GpuContext, cellCount: number): EbmAccel {
  const { device } = gpu;
  const N = cellCount;
  const M = MONTHS_PER_YEAR;
  const ST = GPUBufferUsage.STORAGE;
  const CS = GPUBufferUsage.COPY_SRC;
  const CD = GPUBufferUsage.COPY_DST;
  /** 行別バッファの本数: cos, metric, channel, 年平均日射 + 12 か月 */
  const ROW_FIELDS = 4 + M;
  const MAX_ROWS = 512;

  const bufCells = device.createBuffer({ size: CELL_FIELDS * N * 4, usage: ST | CD });
  const bufRows = device.createBuffer({ size: ROW_FIELDS * MAX_ROWS * 4, usage: ST | CD });
  const bufMonthly = device.createBuffer({ size: MONTHLY_FIELDS * M * N * 4, usage: ST | CD });
  const bufTemp = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufWork = device.createBuffer({ size: WORK_FIELDS * N * 4, usage: ST });
  const bufAccum = device.createBuffer({ size: M * N * 4, usage: ST | CS | CD });
  const bufResidual = device.createBuffer({ size: MAX_STEPS * 4, usage: ST | CS | CD });
  const bufPrev = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufAccumPrev = device.createBuffer({ size: M * N * 4, usage: ST | CS | CD });
  const bufIce = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufParams = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | CD });
  const stage = new ReadbackStage(device, 2 * M * N + N + MAX_STEPS + N);

  const module = device.createShaderModule({ code: WGSL });
  // **明示レイアウトが必須**。layout: 'auto' はエントリごとに「実際に使う
  // バインディングだけ」のレイアウトを作るため、polar のように一部しか触らない
  // カーネルに全 9 本の束ねを渡すと検証エラーになる(2026-08-01 実測)。
  // 明示レイアウトなら、使っていないバインディングが宣言されていても構わない
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
  const pipeFinish = mk('finish');
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
  ];
  // レイアウトが共通なので束ねは 1 つで足りる
  const bind = device.createBindGroup({ layout: bindLayout, entries });

  const cellGroups = Math.ceil(N / GPU_WORKGROUP_SIZE);
  const scratchCells = new Float32Array(CELL_FIELDS * N);
  const scratchRows = new Float32Array(ROW_FIELDS * MAX_ROWS);
  const scratchMonthly = new Float32Array(MONTHLY_FIELDS * M * N);
  const scratchTemp = new Float32Array(N);
  const scratchIce = new Float32Array(N);
  const scratchZeroCells = new Float32Array(M * N);
  const scratchResidual = new Float32Array(MAX_STEPS);
  const zeroMonth = new Float32Array(N);
  const paramBuf = new ArrayBuffer(144);
  const pu = new Uint32Array(paramBuf);
  const pf = new Float32Array(paramBuf);

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
      ]) {
        b.destroy();
      }
      stage.destroy();
    },

    async run(
      fields: EbmStaticFields,
      k: EbmConstants,
      control?: AccelControl,
    ): Promise<EbmAccelResult> {
      const CW = fields.widthCells;
      const CH = fields.heightCells;
      if (CW * CH !== N) throw new Error(`EBM のセル数が違う(確保 ${N} / 要求 ${CW * CH})`);
      if (CH > MAX_ROWS) throw new Error(`行数が上限を超えた(${CH} > ${MAX_ROWS})`);
      // 市松 (row+col)%2 が経度の折り返しで成立するのは**経度セル数が偶数**のとき
      // だけ。奇数だと col=CW-1 と col=0 が同色になり、同じディスパッチ内で
      // 同一セルの読み書きが競合して結果が非決定になる(Codex レビュー 2026-08-02)。
      // 解像度は 0.25〜5° を許しているので 2.7°(CW=133)などで実際に起こりうる。
      if (CW % 2 !== 0) {
        throw new Error(
          `EBM の GPU 経路は経度セル数が偶数であることを要求する(CW=${CW})。` +
            '赤黒順序の市松が経度の折り返しで壊れる。CPU 経路(行優先)を使うこと',
        );
      }

      const cellSrc = [
        fields.heatCap,
        fields.aEff,
        fields.surfAlbedoBase,
        fields.iceOnset,
        fields.qFlux,
        fields.elevM,
        fields.landFrac,
        fields.diffFactor,
        fields.interior01,
        fields.permanentIce,
      ];
      for (let f = 0; f < CELL_FIELDS; f++) scratchCells.set(cellSrc[f]!, f * N);
      device.queue.writeBuffer(bufCells, 0, asBufferSource(scratchCells));

      // 行別。**間隔は CH**(シェーダ側の rowF が P.ch を掛けている)
      scratchRows.fill(0);
      scratchRows.set(fields.cosCenter, 0);
      scratchRows.set(fields.metricZonal, CH);
      scratchRows.set(fields.rowIsChannel, 2 * CH);
      scratchRows.set(fields.insolAnnualByRow, 3 * CH);
      for (let m = 0; m < M; m++) {
        scratchRows.set(fields.insolMonthlyByRow.subarray(m * CH, (m + 1) * CH), (4 + m) * CH);
      }
      device.queue.writeBuffer(bufRows, 0, asBufferSource(scratchRows));

      const monthlySrc = [fields.cloudAlbedo, fields.windU, fields.windV];
      for (let f = 0; f < 3; f++) {
        for (let m = 0; m < M; m++) {
          scratchMonthly.set(monthlySrc[f]![m] ?? zeroMonth, (f * M + m) * N);
        }
      }
      for (let m = 0; m < M; m++) {
        scratchMonthly.set(fields.evapAnom?.[m] ?? zeroMonth, (3 * M + m) * N);
        scratchMonthly.set(fields.evapFeedback?.k[m] ?? zeroMonth, (4 * M + m) * N);
        scratchMonthly.set(fields.evapFeedback?.refTempC[m] ?? zeroMonth, (5 * M + m) * N);
      }
      device.queue.writeBuffer(bufMonthly, 0, asBufferSource(scratchMonthly));

      if (fields.initialT) {
        scratchTemp.set(fields.initialT);
      } else {
        for (let row = 0; row < CH; row++) {
          const init = -20 + 48 * (fields.cosCenter[row] ?? 0);
          for (let col = 0; col < CW; col++) scratchTemp[row * CW + col] = init;
        }
      }
      device.queue.writeBuffer(bufTemp, 0, asBufferSource(scratchTemp));
      // 氷厚は**パスをまたいで持ち越す状態**。渡されなければ 0 から始める
      if (fields.initialIce) {
        scratchIce.set(fields.initialIce);
      } else {
        scratchIce.fill(0);
      }
      device.queue.writeBuffer(bufIce, 0, asBufferSource(scratchIce));
      scratchZeroCells.fill(0);
      device.queue.writeBuffer(bufAccum, 0, asBufferSource(scratchZeroCells));
      device.queue.writeBuffer(bufAccumPrev, 0, asBufferSource(scratchZeroCells));
      scratchResidual.fill(0);
      device.queue.writeBuffer(bufResidual, 0, asBufferSource(scratchResidual));

      const totalSteps = fields.years * fields.stepsPerYear;
      // ここに来る時点で呼び出し側が maxSteps を見て抑えているはず。
      // それでも超えたら実装の不整合なので、黙って切り詰めず明示的に落とす
      if (totalSteps > MAX_STEPS) {
        throw new Error(
          `時間ステップ数が上限を超えた(${totalSteps} > ${MAX_STEPS})。` +
            `呼び出し側が EbmAccel.maxSteps を見て年数を抑えていない`,
        );
      }
      // 全熱容量の年数は**呼び出し側から受け取る**。ここにベタ書きすると
      // CPU 側の定数を振っても GPU に届かず、実験が無効になる(2026-08-02 実害)
      const spinupSteps = Math.max(
        0,
        (fields.years - fields.fullCapacityYears) * fields.stepsPerYear,
      );
      const lastYearStart = (fields.years - 1) * fields.stepsPerYear;
      const prevYearStart = Math.max(0, (fields.years - 2) * fields.stepsPerYear);
      const iters = Math.max(1, Math.round(k.iterationsPerStep));
      const monthCount = new Array<number>(M).fill(0);
      const polarGroups = Math.ceil(CH / GPU_WORKGROUP_SIZE);

      // ---- 中断と進捗の刻み ----
      // 1 submit は 1 時間ステップぶん(反復 512 で実測 40ms 前後)。ここで
      // イベントループへ返さないと Worker が「キャンセル」を受け取れず、
      // 数分間まったく反応しない。刻みは実測に合わせて選ぶ:
      //   刻みすぎ → yield と読み戻しの固定費が乗る
      //   粗すぎ   → 中断の反応が鈍り、途中経過が飛び飛びになる
      // 刻みは **1 か月ぶんの時間ステップ**(既定 240/12 = 20)にする。
      // こうするとスナップショットが各月ちょうど 1 回ずつ落ちるので、
      // 呼び出し側は 1 モデル年で 12 か月ぶんの表示用の場を組める。
      // 20 ステップ ≈ 1 秒間隔。yield は数十 µs、読み戻しは 0.3ms。
      const TICK_STEPS = Math.max(1, Math.round(fields.stepsPerYear / M));
      const wantsSnapshot = control?.onCoarseSnapshot !== undefined;

      for (let step = 0; step < totalSteps; step++) {
        // 中断は**次の submit を積む前**に見る。積んでしまった仕事は
        // GPU 側で走り切るので、細かく見ても反応は速くならない
        if (step % TICK_STEPS === 0) throwIfCancelled(control?.signal, 'EBM');
        const capScale = step < spinupSteps ? 1 / 16 : 1;
        const yearFrac = (step % fields.stepsPerYear) / fields.stepsPerYear;
        const monthFloat = yearFrac * M;
        const m0 = Math.floor(monthFloat - 0.5 + M) % M;
        const m1 = (m0 + 1) % M;
        const frac = (monthFloat - 0.5 + M) % 1;
        const ridgeNNow = fields.ridgeLatN[m0] ?? 31;
        const ridgeSNow = fields.ridgeLatS[m0] ?? -31;
        const accumulate = step >= prevYearStart;
        const accumSlot = step >= lastYearStart ? 1 : 0;
        const monthIndex = Math.min(M - 1, Math.floor(yearFrac * M));
        if (accumSlot === 1) monthCount[monthIndex] = (monthCount[monthIndex] ?? 0) + 1;

        pu[0] = CW;
        pu[1] = CH;
        pu[2] = N;
        pu[3] = iters;
        pu[4] = m0;
        pu[5] = m1;
        pu[6] = monthIndex;
        pu[7] = step;
        pf[8] = frac;
        pf[9] = capScale;
        pf[10] = fields.dtSeconds;
        pf[11] = k.lapseRateGammaCPerM;
        pf[12] = k.iceRampWidthC;
        pf[13] = k.albedoIce;
        pf[14] = k.permanentIceAlbedo;
        pf[15] = k.seaIceInsulationFactor;
        pf[16] = k.olrBWm2PerC;
        pf[17] = k.diffusionBase;
        pf[18] = k.zonalDiffusionFactor;
        pf[19] = k.hadleyDiffusionBoost;
        pf[20] = k.circumpolarChannelFactor;
        pf[21] = k.summerAdvectionFactor;
        pf[22] = k.zonalAdvectionCouplingWm2PerK;
        pf[23] = k.winterInversionDiffusionFactor;
        pf[24] = k.winterInversionAdvectionFactor;
        pf[25] = (360 / CW) * (Math.PI / 180);
        pf[26] = 360 / CW;
        pf[27] = Math.max(15, Math.abs(ridgeNNow));
        pf[28] = Math.max(15, Math.abs(ridgeSNow));
        pu[29] = ridgeNNow > fields.meanRidgeN ? 1 : 0;
        pu[30] = ridgeSNow < fields.meanRidgeS ? 1 : 0;
        pu[31] = fields.evapAnom ? 1 : 0;
        pu[34] = fields.evapFeedback ? 1 : 0;
        pu[35] = k.slabIce ? 1 : 0;
        pf[36] = k.seaFreezeC;
        pf[37] = k.seaIceConductivityWmK;
        pf[38] = k.seaIceLatentJPerMm;
        pf[39] = k.seaIceMinThicknessMm;
        pf[40] = k.seaIceCoverScaleMm;
        pu[32] = accumulate ? 1 : 0;
        pu[33] = accumSlot;
        device.queue.writeBuffer(bufParams, 0, paramBuf);

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
        for (let it = 0; it < iters; it++) {
          // 最終反復の直前に控えを取り、合成作用素 1 回ぶんの変化量を残差にする
          if (it === iters - 1) enc.copyBufferToBuffer(bufTemp, 0, bufPrev, 0, N * 4);
          run(pipeRed, cellGroups);
          run(pipeBlack, cellGroups);
          run(pipePolar, polarGroups);
        }
        // 氷更新は**反復の後・積算の前**(CPU 版と同じ順序)
        if (k.slabIce) run(pipeUpdateIce, cellGroups);
        run(pipeFinish, 1);
        // 途中経過の読み戻しは**計算と同じ submit** に積む。別々に submit すると
        // 3 回目の読み戻しでアクセス違反が起きた(device.ts の実測注記)。
        const tickEnd = step % TICK_STEPS === TICK_STEPS - 1 || step === totalSteps - 1;
        const emit = wantsSnapshot && tickEnd;
        if (emit) stage.enqueueCopyAt(enc, bufTemp, 0, N);
        device.queue.submit([enc.finish()]);
        const yearNow = Math.floor(step / fields.stepsPerYear) + 1;
        if (emit) {
          // mapAsync は GPU の完了を待つので、ここでイベントループへ返る
          // (= キャンセル要求を受け取れる)。別途 yield する必要は無い
          const view = await stage.map(N);
          control?.onCoarseSnapshot?.({
            valuesC: view.subarray(0, N),
            monthIndex,
            year: yearNow,
          });
        } else if (tickEnd) {
          // 進捗の受け手がいなくても、中断を受け取るために制御は返す
          await yieldToEventLoop();
        }
        if (tickEnd) {
          control?.progress?.({
            fraction: (step + 1) / totalSteps,
            detail: `EBM 積分 ${yearNow}/${fields.years} 年目・反復 ${iters}`,
          });
        }
      }

      // 読み戻しは 1 回だけ(積算 + 最終温度 + 残差)
      const enc = device.createCommandEncoder();
      stage.enqueueCopyAt(enc, bufAccum, 0, M * N);
      stage.enqueueCopyAt(enc, bufAccumPrev, M * N, M * N);
      stage.enqueueCopyAt(enc, bufTemp, 2 * M * N, N);
      stage.enqueueCopyAt(enc, bufResidual, 2 * M * N + N, MAX_STEPS);
      stage.enqueueCopyAt(enc, bufIce, 2 * M * N + N + MAX_STEPS, N);
      device.queue.submit([enc.finish()]);
      const flat = await stage.map(2 * M * N + N + MAX_STEPS + N);

      const monthAccum: Float32Array[] = [];
      for (let m = 0; m < M; m++) monthAccum.push(flat.slice(m * N, (m + 1) * N));
      const finalT = flat.slice(2 * M * N, 2 * M * N + N);
      let maxResidualC = 0;
      for (let s = 0; s < totalSteps; s++) {
        const v = flat[2 * M * N + N + s] ?? 0;
        if (v > maxResidualC) maxResidualC = v;
      }
      // 許容差を満たしたかを**返す**。渡された許容差を使わずに残差を記録する
      // だけだと、ある惑星条件で反復が足りなくてもそのまま採用されてしまう
      // (Codex レビュー 2026-08-02)
      // 最終年と前年の差 = 周期定常への到達度。
      // 積分年数が足りているかは**これ**で検証する(年数を増やしても
      // 加速期が伸びるだけ、という取り違えを防ぐ。2026-08-02)。
      //
      // 指標は**年平均の面積重み平均 |Δ|**。時間離散化の誤差(0.13°C)を
      // 同じ物差しで測っており、許容差はそれと比べて決めたので揃える必要がある。
      // 全セルの最大値だと極の小さなセル 1 つに支配され、桁が変わってしまう。
      let sumW = 0;
      let sumWD = 0;
      let maxYearDriftC = 0;
      for (let i = 0; i < N; i++) {
        const row = Math.floor(i / CW);
        const w = fields.cosCenter[row] ?? 0;
        let annualA = 0;
        let annualB = 0;
        for (let m = 0; m < M; m++) {
          const cnt = Math.max(1, monthCount[m] ?? 1);
          annualA += (flat[m * N + i] ?? 0) / cnt;
          annualB += (flat[M * N + m * N + i] ?? 0) / cnt;
        }
        const d = Math.abs(annualA - annualB) / M;
        if (d > maxYearDriftC) maxYearDriftC = d;
        sumW += w;
        sumWD += w * d;
      }
      const meanYearDriftC = sumW > 0 ? sumWD / sumW : 0;
      return {
        monthAccum,
        monthCount,
        finalT,
        finalIce: flat.slice(2 * M * N + N + MAX_STEPS, 2 * M * N + N + MAX_STEPS + N),
        maxResidualC,
        converged: maxResidualC <= k.solveToleranceC,
        maxYearDriftC,
        meanYearDriftC,
      };
    },
  };
}
