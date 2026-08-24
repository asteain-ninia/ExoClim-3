// Step 6: 降水(mm/月)。docs/spec/06_降水.md
// 水収支モデル: 風上追跡による水蒸気供給(海面蒸発 ∝ 飽和水蒸気圧、
// 距離減衰、陸面再蒸発の 2 パス)× 持ち上げ効率(ITCZ 収束・ストームトラック・
// 地形性上昇)× 抑制(亜熱帯沈降・雨陰・寒流沿岸)。
// derle-climate の系統バイアス(教訓 §8.2)への正面対応:
//  - シベリア過乾燥 → 長い偏西風輸送 + 陸面再蒸発の 2 パス
//  - 地中海性気候の欠落 → 寒候期に赤道側へ移るストームトラック
//  - アラビア過湿 → 沈降域の強い抑制と供給の距離減衰
//  - 東岸モンスーン → 夏の大陸低圧への onshore 風(Step 4)が供給を運ぶ

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, cellHeightKm, cellWidthKm, wrapCol } from '@/domain/grid';
import type { Grid } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import { solveMoistureTransport, SECONDS_PER_MONTH } from './moisture_transport';
import {
  computeOceanEvaporation,
  saturatedColumnMm,
  type EvaporationResult,
} from './evaporation';
import { itczInfluenceAt } from './step01_itcz';
import type {
  AirflowResult,
  ItczResult,
  OceanCurrentResult,
  PrecipCouplingDiagnostics,
  PrecipitationResult,
  SimContext,
  TemperatureResult,
  WindBeltResult,
} from './types';
import type { RunOptions, TraceConstants, TraceStaticFields } from './accel';
import { throwIfCancelled, yieldToEventLoop } from './run_control';

/**
 * 月別降水から表示用の PrecipitationResult を組む(**配列は複製する**)。
 *
 * 途中経過を流すのに使う。複製が要るのは、結合反復中の precipEst が
 * 次の反復でも読まれる生の作業配列だから — そのまま渡すとワーカー境界で
 * 構造化複製の対象になるだけでなく、将来 transfer に切り替えたときに
 * 計算そのものが壊れる。
 */
function buildPrecipitationResult(
  monthly: Float32Array[],
  cellCount: number,
  coupling: PrecipCouplingDiagnostics,
): PrecipitationResult {
  const monthlyPrecipMm = monthly.map((a) => a.slice());
  const annualPrecipMm = new Float32Array(cellCount);
  for (const month of monthlyPrecipMm) {
    for (let i = 0; i < cellCount; i++)
      annualPrecipMm[i] = (annualPrecipMm[i] ?? 0) + (month[i] ?? 0);
  }
  return { monthlyPrecipMm, annualPrecipMm, coupling };
}

/**
 * 保存型の水収支の診断(報告用。物理結果には含めない)。
 * **パイプラインの入口で初期化する**(resetConservativeStats)。
 * 収束していない輸送の解を黙って採用しないために置く。
 */
/** 段 45b: コンベアの移送量の計器(診断用。走行ごとに computePrecipitation が初期化) */
export const CONVEYOR_STATS = {
  /** Σ 取水(mm/月 × cos緯度重み)。全結合反復・全月の合計 */
  takeMmArea: 0,
  /** applyConveyor の呼び出し数(有効時のみ数える) */
  calls: 0,
  /** warmStart 不在で不発だった回数 */
  skippedNoWarm: 0,
};

export const CONSERVATIVE_STATS = {
  /** 収束しなかった月の数(12 か月 × 結合反復ぶん数える) */
  nonConverged: 0,
  /** 収束しなかった中での最悪の相対残差 */
  worstResidual: 0,
  /** 反復数の合計(費用の目安) */
  iterations: 0,
  /** virga の外側反復が収束しなかった月の数 */
  virgaNonConverged: 0,
  /**
   * **全球の可降水量 W の面積重み平均(mm)**。実物は約 25mm。
   *
   * P = λ·G·W なので、λ と G の平均は**互いに縮退している**
   * (αG と λ/α は同じ方程式を与える)。したがって「滞留時間 1/(λG)」を
   * 独立に検証する道は 1 つしかない — **W の絶対値**である。
   * 実物の 25mm と比べれば、λ·G の全球平均が正しいかが分かる(2026-08-13)
   */
  meanWaterMm: 0,
  waterSamples: 0,
};

/**
 * 雲底下の再蒸発は降水量そのものに依存する(弱い雨ほど多く失われる)ので、
 * 凝結率を下げて解き直す**外側反復**が要る。
 * 反復数と減衰は**答えを決めてはならない** — 収束を確かめたうえで使う。
 */
/**
 * virga の外側反復の上限。**6 → 60(2026-08-15)。**
 *
 * 6 が足りるかは一度も確かめられていなかった。`subCloudEvapCoef = 1` で測ると
 * **216 か月ぶん未収束**になり、段 22 の掃引の行が丸ごと適用範囲外になった。
 *
 * 残差列は発散でも停滞でもなく**緩慢**で、適応緩和へ替えたうえで測ると
 * 4° 格子で **204/204・192/192 が収束し、最悪の月で 30〜32 回**だった
 * (docs/診断_virgaの外側反復は緩慢_2026-08-15.md)。
 *
 * 60 は**上限が答えを決めないところまで上げる**という EBM で確立した作法に
 * 従った値で、余裕を 2 倍取ってある。収束すれば月ごとに即座に抜けるので、
 * 上げても収束の速い月の費用は増えない。
 * **virga は既定で無効(`subCloudEvapCoef = 0`)なので出荷時の費用は変わらない。**
 */
const VIRGA_OUTER_ITERATIONS = 60;
/**
 * virga の外側反復の打ち切りを実験で振るための上書き口(既定 0 = 上の定数)。
 *
 * `COUPLING_OVERRIDE` と同じ役目。**反復の打ち切りが答えを決めていた例を
 * EBM で 3 件、結合反復で 1 件踏んでいる**ので、ここも同じ疑いで検査できる
 * ようにしておく。通常経路の既定は変えない。
 *
 * 2026-08-15 に実害が出た: `subCloudEvapCoef = 1` で外側反復が
 * **216 か月ぶん未収束**になり、掃引の行が丸ごと適用範囲外になった。
 * 6 回で足りるかは一度も確かめられていなかった
 * (docs/事前登録_乾いた端_2026-08-15.md)。
 *
 * `trace` を有効にすると、呼び出しごとの maxChange の列が `series` に積まれる。
 * **収束しないと分かったら、次に見るのは成績ではなく残差の列と隣接比**である
 * (docs/教訓.md §9)。検査: scripts/diag_virga_ratio.ts
 */
export const VIRGA_OVERRIDE = {
  maxIterations: 0,
  /**
   * 緩和の上書き(0 = 既定の `VIRGA_RELAXATION` を使う)。
   *
   * **緩和は不動点を変えない** — `x = (1−α)x + αF(x)` は `x = F(x)` と同値なので、
   * 収束したときの答えは α に依らない。したがってこれは**物理の変更ではなく
   * 解き方の変更**であり、較正のつまみにしてはならない。
   *
   * 既定の 0.6 は「P ↓ → 失われる割合 ↑ の帰還が振動しうる」ことへの備えとして
   * 入っているが、**実測の壊れ方は振動ではなく緩慢**だった(2026-08-15)。
   * 緩慢に対して α < 1 は実効比を `1 − α(1 − L)` にするので**逆効果**である。
   */
  relaxation: 0,
  trace: false,
  series: [] as number[][],
};
/**
 * 水蒸気輸送の反復上限。**答えを決めてはならない量**なので、
 * 到達しなかった解は診断で適用範囲外にする(黙って採用しない)。
 */
export const TRANSPORT_MAX_ITERATIONS = 20000;
// 旧定数 `VIRGA_RELAXATION = 0.6`(固定緩和)は 2026-08-15 に**適応緩和へ置き換えた**。
// 固定 0.6 は「P ↓ → 失われる割合 ↑ の帰還が振動しうる」ことへの備えとして
// 置かれたが、実測の壊れ方は振動ではなく**緩慢**が主で、0.6 は足を引っ張っていた
// (204 呼び出し中の収束が 78 件 → α=1 なら 184 件)。
// ただし少数の月は本当に振動するので、単一の α では救えない。
// 適応の実装は下の外側反復にある。固定したいときは `VIRGA_OVERRIDE.relaxation`。
const VIRGA_TOLERANCE = 5e-3;

/**
 * Anderson 加速の履歴と、次の点の組み立て(段 24)。
 *
 * 差分形式の標準形を使う(和が 1 という制約を消せるので数値的に安定):
 * ```
 *   f_k  = F(x_k) − x_k
 *   ΔF_i = f_{i+1} − f_i,   ΔX_i = x_{i+1} − x_i
 *   γ    = argmin ‖f_k − ΔF γ‖        （m×m の正規方程式）
 *   x_{k+1} = x_k + f_k − (ΔX + ΔF) γ
 * ```
 * 場は「12 か月 × セル」を 1 本の平坦な配列として扱う(月をまたいだ相関も
 * 使えるので、月ごとに解くより素直)。
 */
export class AndersonAccelerator {
  private readonly dF: Float64Array[] = [];
  private readonly dX: Float64Array[] = [];
  private prevX: Float64Array | null = null;
  private prevF: Float64Array | null = null;

  constructor(
    private readonly depth: number,
    private readonly regularization: number,
  ) {}

  /**
   * 現在の点 x と残差 f = F(x) − x から次の点を組む。
   * 履歴が空の 1 回目は素のピカール `x + f` を返す。
   * **戻り値は x を上書きした同じ配列**(呼び出し側が書き戻す)。
   */
  next(x: Float64Array, f: Float64Array): Float64Array {
    const n = x.length;
    if (this.prevX && this.prevF) {
      const df = new Float64Array(n);
      const dx = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        df[i] = (f[i] ?? 0) - (this.prevF[i] ?? 0);
        dx[i] = (x[i] ?? 0) - (this.prevX[i] ?? 0);
      }
      this.dF.push(df);
      this.dX.push(dx);
      while (this.dF.length > this.depth) {
        this.dF.shift();
        this.dX.shift();
      }
    }
    this.prevX = Float64Array.from(x);
    this.prevF = Float64Array.from(f);

    const m = this.dF.length;
    // 1 回目、または履歴が無いときは素のピカール
    if (m === 0) {
      for (let i = 0; i < n; i++) x[i] = (x[i] ?? 0) + (f[i] ?? 0);
      return x;
    }
    // 正規方程式 (ΔFᵀΔF + λI) γ = ΔFᵀ f
    const a: number[][] = [];
    const b: number[] = [];
    for (let r = 0; r < m; r++) {
      const row: number[] = [];
      const fr = this.dF[r] as Float64Array;
      for (let c = 0; c < m; c++) {
        const fc = this.dF[c] as Float64Array;
        let s = 0;
        for (let i = 0; i < n; i++) s += (fr[i] ?? 0) * (fc[i] ?? 0);
        row.push(r === c ? s + this.regularization : s);
      }
      let s = 0;
      for (let i = 0; i < n; i++) s += (fr[i] ?? 0) * (f[i] ?? 0);
      a.push(row);
      b.push(s);
    }
    const gamma = solveSmallSpd(a, b);
    // γ が解けなかった(退化)なら素のピカールへ落ちる。**黙って壊れない**
    if (!gamma) {
      for (let i = 0; i < n; i++) x[i] = (x[i] ?? 0) + (f[i] ?? 0);
      return x;
    }
    for (let i = 0; i < n; i++) {
      let corr = 0;
      for (let j = 0; j < m; j++) {
        corr += (gamma[j] ?? 0) * (((this.dX[j] as Float64Array)[i] ?? 0) + ((this.dF[j] as Float64Array)[i] ?? 0));
      }
      x[i] = (x[i] ?? 0) + (f[i] ?? 0) - corr;
    }
    return x;
  }
}

/** 小さい対称正定値系をガウス消去で解く(m ≤ 8 程度)。退化したら null */
function solveSmallSpd(a: number[][], b: number[]): number[] | null {
  const m = b.length;
  const mat = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(mat[r]?.[col] ?? 0) > Math.abs(mat[piv]?.[col] ?? 0)) piv = r;
    }
    const pivRow = mat[piv];
    const colRow = mat[col];
    if (!pivRow || !colRow) return null;
    if (Math.abs(pivRow[col] ?? 0) < 1e-300) return null;
    mat[piv] = colRow;
    mat[col] = pivRow;
    const cur = mat[col] as number[];
    const d = cur[col] ?? 1;
    for (let c = col; c <= m; c++) cur[c] = (cur[c] ?? 0) / d;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const row = mat[r] as number[];
      const factor = row[col] ?? 0;
      if (factor === 0) continue;
      for (let c = col; c <= m; c++) row[c] = (row[c] ?? 0) - factor * (cur[c] ?? 0);
    }
  }
  const out: number[] = [];
  for (let r = 0; r < m; r++) {
    const v = mat[r]?.[m] ?? 0;
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

export function resetConservativeStats(): void {
  CONSERVATIVE_STATS.nonConverged = 0;
  CONSERVATIVE_STATS.worstResidual = 0;
  CONSERVATIVE_STATS.iterations = 0;
  CONSERVATIVE_STATS.virgaNonConverged = 0;
  // **W の積算も必ずここで消す(2026-08-14)。**
  // 消し忘れていたため、同一プロセスで複数回パイプラインを回す掃引
  // (scripts/exp_pressure_lever.ts)では W が「その水準の値」ではなく
  // 「それまでの全水準の累積平均」になっていた。段 20 の看板だった
  // 「鋭さ 4 で W が 29.1mm、実物 25mm に着地」はこの汚染の産物である。
  // 単発で測る scripts/diag_water_vapor.ts は自前で 0 にしていたので無傷。
  CONSERVATIVE_STATS.meanWaterMm = 0;
  CONSERVATIVE_STATS.waterSamples = 0;
}

/** 飽和水蒸気圧 hPa(Magnus 式)。水蒸気供給のスケールとして使用 */
export function saturationVaporPressureHpa(tempC: number): number {
  return 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
}

// ---- R1 診断(地域降水 FB §5)----
// 降水の内部要因(供給 3 種・持上げ/抑制の各倍率)を診断時のみ捕捉する。
// 通常実行では一切割り当てず、計算経路も変えない(倍率の named 化は乗算順を
// 保存しており出力はビット不変 — テストで担保)。
// 再構成恒等式(月 m・セル i、床再配分と月ブレンドの前):
//   preAdjustMm = (supplyOcean + supplyLand + supplyStorm)
//                 × upwindBlock × liftItcz × liftFrontal × liftOther部の storm
//                 ... 正確には liftItcz × liftFrontal × liftStorm × liftOrographic
//                 × subsidenceResidual × coldCoast × warmHumid の積 = lift。
//   ここでは FB の 8 因子以外(liftStorm・coldCoast・warmHumid)を liftOther に
//   まとめ、preAdjustMm = 供給和 × upwindBlock × liftItcz × liftFrontal ×
//   liftOrographic × subsidenceResidual × liftOther × 変換係数 で厳密再構成できる。
//   最終降水との差は床再配分・月ブレンド(陸のみ)による。
export interface PrecipDiagnostics {
  /** [month][cell] 海洋由来供給(無次元供給量) */
  supplyOcean: Float32Array[];
  /** [month][cell] 陸面再循環由来供給(全供給 − 海洋のみ供給) */
  supplyLand: Float32Array[];
  /** [month][cell] ストームトラック渦由来供給 */
  supplyStorm: Float32Array[];
  liftItcz: Float32Array[];
  liftFrontal: Float32Array[];
  liftOrographic: Float32Array[];
  /** R4: 湿潤収束による持上げ倍率(1 = 収束なし) */
  liftConvergence: Float32Array[];
  /** R4: 水蒸気フラックス収束指数(供給単位、正 = 収束)。倍率ではなく生の場 */
  convergenceIndex: Float32Array[];
  /** 亜熱帯沈降の残存倍率(1 = 抑制なし) */
  subsidenceResidual: Float32Array[];
  /** 沈降の内訳(残存率 0〜1、2026-08-17)。subs ≈ (1−descW 抑制)×各緩和 */
  subsDescW: Float32Array[];
  subsItczProt: Float32Array[];
  subsEastRel: Float32Array[];
  subsConvRel: Float32Array[];
  /** 風上山脈の遮蔽倍率(1 = 遮蔽なし) */
  upwindBlock: Float32Array[];
  /** その他の倍率の積(ストーム帯持上げ × 寒流沿岸 × 高温湿潤対流) */
  liftOther: Float32Array[];
  /** 柱相対湿度による指数抑制の倍率(1 = 抑制なし。sharpness 0 なら全セル 1) */
  crhSuppression: Float32Array[];
  /**
   * **保存型のときのみ**: 凝結率の係数 G = 上の全倍率の積。
   * 保存型では降水は倍率の積では書けない(輸送方程式の解なので)。
   * 因子分解が意味を持つのは**この G まで**であって、降水そのものではない。
   * 非保存のときは空配列。
   */
  condRateG: Float32Array[];
  /**
   * **保存型のときのみ**: 輸送方程式が解いた可降水量 W(mm)。
   * virga の外側反復があるときは**最後に解いた W**(凝結量と対になるもの)。
   *
   * なぜ要るか(2026-08-15): 保存型の降水は `P = λ·G·W` で、λ と G の平均は
   * 互いに縮退している。したがってこの 3 つを分けて論じるには W の**場**が
   * 要るのに、これまで出せたのは全球平均(CONSERVATIVE_STATS.meanWaterMm)
   * だけだった。「モデルの大気は実物の 7 分の 1 しか水を持っていない」
   * (W 3.4mm 対 25mm)という残る本丸は、どこの W が足りないのかを
   * 見ないと先へ進めない。非保存のときは空配列。
   */
  waterMm: Float32Array[];
  /** 床再配分・月ブレンド前の降水 mm/月 */
  preAdjustMm: Float32Array[];
  /**
   * 後処理(冬季床再配分 + 月ブレンド、陸のみ)による差分 mm/月。
   * 最終降水 = preAdjustMm + postAdjustDeltaMm(全セルで厳密)
   */
  postAdjustDeltaMm: Float32Array[];
  /** mm 変換係数(precipScaleMmPerUnit × 気圧係数) — 再構成用 */
  mmPerSupplyUnit: number;
}

/** 診断の受け皿。computePrecipitation に渡すと fields が割り当てられる */
export interface PrecipDiagBox {
  fields?: PrecipDiagnostics;
  /** R3 土壌水分の周期定常解(有効時のみ) */
  soil?: SoilWaterResult;
}

// ---- R4(地域降水 FB §8): 水蒸気フラックス収束 ----
// 局所水蒸気量の代理を既存の供給場 q とし、地表風 V との積で水平フラックスを
// つくり、球面計量で発散を取る:
//   div(qV) = (1/(a cosφ)) [ ∂(q u)/∂λ + ∂(q v cosφ)/∂φ ]
// 収束(div < 0)かつ湿潤な場所だけ持上げを増やし、亜熱帯沈降の実効抑制を
// 連続的に弱める。乾いた収束(供給が乏しい低圧)では何も起こらない。
// 中国東部の梅雨前線・ラプラタへの暖湿流・アマゾン内陸収束・米国南東部を
// 同じ原理で表現する(地域名は使わない)。
//
// 実装上の要点(2026-08-01 の外部レビュー指摘への対応):
//  - **有限体積形**で発散を取る(共有面フラックス × 辺長 / セル面積)。
//    中心差分 + max(20km) のセル幅では高緯度で保存性を失う。極の辺長は 0。
//    Σ(面積 × 発散) ≈ 0 をテストで担保する。
//  - 供給場 q は「局所水蒸気量」ではなく風上経路の到達可能性であり、海岸や
//    稜線を跨ぐ経路差で不連続に跳ぶ。そのまま微分すると偽の収束線ができる
//    ため、**固定角半径で平滑化してから**フラックスを作る。
//  - 乾燥ゲートは局所 q で割らない(乾燥域で比が発散する)。基準値 q_ref で
//    無次元化し、飽和関数 x/(1+x) で [0,1) に収める。
//  - 発散演算の中で自転方向を掛けない(風場が既に反転済み)。
const DIVERGENCE_SMOOTH_DEG = 1.5;
/**
 * **収束を作るときの供給場の平滑幅の上書き(段 30、2026-08-15)。**
 * 0 = 既定の `DIVERGENCE_SMOOTH_DEG`(1.5°)を使う。
 *
 * 2026-08-15 に、収束指数の空間相関長が **100〜170km** しかないと分かった
 * (1 セル 0.571、2 セル 0.066)。実物の温帯低気圧の収束帯は 1000km 級で
 * **1 桁足りない**。1.5° は 40° 付近で約 130km で、**測った相関長と一致する** —
 * つまり**この平滑幅が収束の空間スケールをそのまま決めている**。
 *
 * 平滑そのものは必要である(供給場は経路差で不連続に跳ぶので、
 * そのまま微分すると偽の収束線ができる)。問題は幅が
 * 「偽を消す最小限」であって「実物の収束帯の広がり」ではないこと。
 *
 * **固定角なので緯度で実距離が変わる。** 採用するなら度のままではなく
 * 惑星の大きさ・自転から決まる形(変形半径)にしてから入れること。
 *
 * 事前登録: docs/事前登録_収束の平滑幅_2026-08-15.md
 */
export const CONVERGENCE_SMOOTH = { deg: 0 };
/** 収束指数を供給と同じ単位へ戻す時間スケール(基準長 1000km / 基準風速 5m/s) */
const CONVERGENCE_TIME_SCALE_S = 1_000_000 / 5;

/** 固定角半径の円形平均で場を平滑化(解像度不変) */
function smoothAngular(grid: Grid, field: Float32Array, radiusDeg: number): Float32Array {
  const out = new Float32Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    for (let col = 0; col < grid.widthCells; col++) {
      let sum = 0;
      let n = 0;
      forEachCellWithinAngularRadius(grid, row, col, radiusDeg, (j) => {
        sum += field[j] ?? 0;
        n++;
      });
      out[row * grid.widthCells + col] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/**
 * 水蒸気フラックスの収束指数(供給と同じ単位、正 = 収束)。
 * 有限体積形: D = (F_E L_E − F_W L_W + F_N L_N − F_S L_S) / A。
 * 経度は周期境界、極の辺長は 0。返り値は −D × 時間スケール。
 */
export function moistureConvergenceIndex(
  grid: Grid,
  radiusKm: number,
  supply: Float32Array,
  u: Float32Array,
  v: Float32Array,
): Float32Array {
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const q = smoothAngular(
    grid,
    supply,
    CONVERGENCE_SMOOTH.deg > 0 ? CONVERGENCE_SMOOTH.deg : DIVERGENCE_SMOOTH_DEG,
  );
  const aM = radiusKm * 1000;
  const dPhi = (grid.resolutionDeg * Math.PI) / 180;
  const dLam = (grid.resolutionDeg * Math.PI) / 180;
  // 南北の辺長は一定(経線に沿う長さ)、東西の辺長は面の緯度の cos に比例
  const lenMeridionalM = aM * dPhi;
  const cosFaceOf = (rowFaceNorthOf: number): number => {
    // row と row−1 の境界(= row の北面)の緯度
    const latFace = 90 - rowFaceNorthOf * grid.resolutionDeg;
    return Math.max(0, Math.cos((latFace * Math.PI) / 180));
  };
  for (let row = 0; row < H; row++) {
    const latC = latDegOfRow(grid, row);
    const cosC = Math.max(1e-6, Math.cos((latC * Math.PI) / 180));
    const areaM2 = aM * aM * dLam * dPhi * cosC;
    const lenNorthM = aM * dLam * cosFaceOf(row); // 北面(row と row−1 の境)
    const lenSouthM = aM * dLam * cosFaceOf(row + 1); // 南面
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const iE = row * W + wrapCol(grid, col + 1);
      const iW = row * W + wrapCol(grid, col - 1);
      const iN = row > 0 ? (row - 1) * W + col : -1;
      const iS = row < H - 1 ? (row + 1) * W + col : -1;
      const qu = (q[i] ?? 0) * (u[i] ?? 0);
      // 面フラックスは両側セルの平均(共有面で一意 = 保存的)
      const fE = 0.5 * (qu + (q[iE] ?? 0) * (u[iE] ?? 0));
      const fW = 0.5 * (qu + (q[iW] ?? 0) * (u[iW] ?? 0));
      const qv = (q[i] ?? 0) * (v[i] ?? 0);
      const fN = iN >= 0 ? 0.5 * (qv + (q[iN] ?? 0) * (v[iN] ?? 0)) : 0;
      const fS = iS >= 0 ? 0.5 * (qv + (q[iS] ?? 0) * (v[iS] ?? 0)) : 0;
      const netOutflow = (fE - fW) * lenMeridionalM + fN * lenNorthM - fS * lenSouthM;
      const divergence = netOutflow / areaM2;
      out[i] = -divergence * CONVERGENCE_TIME_SCALE_S;
    }
  }
  return out;
}

/** 収束の実効度 0〜1(飽和関数)。局所 q で割らない — 乾燥域で発散するため */
export function convergenceStrength01(convIndex: number, refNorm: number): number {
  const x = Math.max(0, convIndex) / Math.max(1e-9, refNorm);
  return x / (1 + x);
}

/** 湿潤ゲート(smoothstep)。乾いた収束では降水を作らない */
export function wetnessGate01(supplyValue: number, wetNorm: number): number {
  const t = Math.min(1, Math.max(0, supplyValue / Math.max(1e-9, wetNorm)));
  return t * t * (3 - 2 * t);
}

// ---- R3(地域降水 FB §7): 土壌水分の季節記憶 ----
// 各陸セルの月別貯水を状態として持ち、乾季へ前月までの雨を持ち越す。
//   S[m] = clamp(S[m-1] + P[m] − ET[m], 0, 容量)、超過分は流出
//   ET[m] = 可能蒸発散(気温) × (S[m-1] / 容量)  ← 供給律速の線形近似
// 陸面水蒸気供給は「当月降水に比例」ではなく実蒸発散に比例させる。
// 12 月 → 1 月を接続し、周期定常解へ収束するまで空回しする。
// バケツ収支は風上追跡を含まないため安価。
//
// **解は一意ではない**(2026-08-02 実測、旧コメントの「初期値に依らない
// 決定的な解」は誤り)。available ≥ 容量 の月は wet が 1 に飽和して ET が
// 貯水に依らなくなり、写像の傾きがちょうど 1 になる(陸セル月の 33.5%)。
// 12 か月ぶんの傾きの積が 1 のままのセルが**陸の 11.15%** あり、
// そこでは周期定常解が連続族をなす。空回しを何年増やしても閉じない。
//
// ただし**下流は無事**: 縮退するのはまさに「ET が貯水に依らない」領域なので、
// 大気へ渡る実蒸発散は初期値に依らない(空 対 満杯で面積平均の相対差 0.00%、
// 局所最大 5.3mm/月)。貯水そのものを絶対値として読むのは誤りで、
// 水収支診断で信用してよいのは ET と流出。
// 詳細: docs/実験記録_土壌の縮退_2026-08-01.md

/** 可能蒸発散(mm/月)。0°C 以下は凍結として 0 */
export function potentialEtMmPerMonth(tempC: number): number {
  if (tempC <= 0) return 0;
  return (
    (K.soilPetScaleMmPerMonth * saturationVaporPressureHpa(tempC)) / saturationVaporPressureHpa(20)
  );
}

export interface SoilWaterResult {
  /** [month][cell] 実蒸発散 mm/月 */
  actualEtMm: Float32Array[];
  /** [month][cell] 月末貯水 mm */
  storageMm: Float32Array[];
  /** [month][cell] 流出 mm/月 */
  runoffMm: Float32Array[];
  /** [month][cell] 利用可能水(前月貯水 + 当月降水)/ 容量の 0〜1 クランプ */
  wetness01: Float32Array[];
  /** [cell] 記録年の貯水変化(年末 − 年初)。周期定常なら 0 */
  storageChangeMm: Float32Array;
  /** 実施した空回し年数 */
  spinupYears: number;
  /** 最終年の年間貯水変化の陸セル平均絶対値(mm)— 周期定常への到達度 */
  meanAnnualStorageDriftMm: number;
  /** 同・最大絶対値(mm)。中立帯のセルに支配されるため参考値 */
  maxAnnualStorageDriftMm: number;
  /** 周期定常解へ収束したか(上限年数に達した場合は false) */
  converged: boolean;
}

/**
 * 周期定常判定の許容差(mm/年)。結果を見る前に固定 — 較正つまみではない。
 * 判定は陸セルの**平均**絶対ドリフトで行う(2026-07-31 に統計量を最大値から
 * 平均へ変更。理由: 利用可能水が容量〜容量+可能蒸発散の帯にある月は
 * ET が貯水に依存せず写像の傾きが 1 になり、中立(縮小しない)固定点の
 * 連続族ができる。この帯のセルではドリフトが線形にしか減らず、最大値は
 * 数百年でも 2mm/年程度で下げ止まる。バケツモデル固有の縮退であり、
 * 収支・場の値には効かない[実測: 面積重み ΔS = 0.006mm/年]。
 * 閾値そのものは緩めていない。最大値も併せて報告する)
 */
export const SOIL_SPINUP_TOLERANCE_MM = 0.05;

/**
 * 土壌水分の周期定常解。降水場・気温場を固定し、年間の貯水変化が
 * SOIL_SPINUP_TOLERANCE_MM を下回るまで空回しする(上限 maxYears)。
 * 手順は決定的(乱数なし)だが、**解は一意ではない** — 陸セルの 11.15% で
 * 年間縮小率が 1 になり初期貯水が残る(上の注記)。initialFillFrac は
 * その縮退を確かめるための初期値指定でもある。
 * 極寒・極乾など蒸発散が極端に小さい惑星では収束に多くの年数を要するため、
 * 固定年数ではなくドリフト判定にしている(第四 FB の退化条件対応)。
 */
export function solveSoilWater(
  cellCount: number,
  isLand: (i: number) => boolean,
  precipByMonth: Float32Array[],
  tempByMonth: Float32Array[],
  capacityMm: number,
  maxYears: number,
  initialFillFrac = 0,
  /**
   * 初期貯水(mm)。結合反復のウォームスタート用 — 前反復の周期定常解を
   * 渡すと必要な空回し年数が大幅に減る。周期定常への収束判定は同じなので
   * 得られる解は許容差内で同一(テストで担保)
   */
  initialStorage?: ArrayLike<number>,
): SoilWaterResult {
  const storage = new Float64Array(cellCount);
  if (capacityMm > 0 && initialStorage) {
    for (let i = 0; i < cellCount; i++) {
      if (isLand(i)) {
        storage[i] = Math.min(capacityMm, Math.max(0, initialStorage[i] ?? 0));
      }
    }
  } else if (capacityMm > 0 && initialFillFrac > 0) {
    for (let i = 0; i < cellCount; i++) {
      if (isLand(i)) storage[i] = capacityMm * initialFillFrac;
    }
  }
  const actualEtMm: Float32Array[] = [];
  const storageMm: Float32Array[] = [];
  const runoffMm: Float32Array[] = [];
  const wetness01: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    actualEtMm.push(new Float32Array(cellCount));
    storageMm.push(new Float32Array(cellCount));
    runoffMm.push(new Float32Array(cellCount));
    wetness01.push(new Float32Array(cellCount));
  }
  const storageChangeMm = new Float32Array(cellCount);
  if (capacityMm <= 0) {
    return {
      actualEtMm,
      storageMm,
      runoffMm,
      wetness01,
      storageChangeMm,
      spinupYears: 0,
      meanAnnualStorageDriftMm: 0,
      maxAnnualStorageDriftMm: 0,
      converged: true,
    };
  }
  const limitYears = Math.max(1, Math.round(maxYears));
  const yearStart = new Float64Array(cellCount);
  let drift = Number.POSITIVE_INFINITY;
  let maxDrift = Number.POSITIVE_INFINITY;
  let usedYears = 0;
  let converged = false;
  for (let y = 0; y < limitYears; y++) {
    usedYears = y + 1;
    yearStart.set(storage);
    // 年間ドリフトが許容内に入った次の年を記録年にする(前年の判定結果で決める
    // ため、記録年そのものが周期定常であることが保証される)
    const record = converged || y === limitYears - 1;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const p = precipByMonth[m];
      const t = tempByMonth[m];
      for (let i = 0; i < cellCount; i++) {
        if (!isLand(i)) continue;
        // 第四 FB P0-2: 前月貯水へ**当月降水を加えてから**湿り度を決める。
        // 降水前の s0 で湿り度を測ると、空の土壌に大雨が降っても当月 ET が 0 に
        // なり、季節記憶ではなく 1 か月の位相ずれで乾季が改善してしまう
        const available = (storage[i] ?? 0) + (p?.[i] ?? 0);
        const pet = potentialEtMmPerMonth(t?.[i] ?? 0);
        // 供給律速: 利用可能水が少ないほど蒸発散が減る(乾季の自己制限)
        const wet = Math.min(1, Math.max(0, available / capacityMm));
        const et = Math.min(available, pet * wet);
        const remaining = available - et;
        let s = remaining;
        let runoff = 0;
        if (s > capacityMm) {
          runoff = s - capacityMm;
          s = capacityMm;
        }
        if (s < 0) s = 0;
        storage[i] = s;
        if (record) {
          actualEtMm[m]![i] = et;
          storageMm[m]![i] = s;
          runoffMm[m]![i] = runoff;
          wetness01[m]![i] = wet;
        }
      }
    }
    // 年間ドリフト(年末 − 年初)。判定は陸セル平均、最大値も記録する
    let sum = 0;
    let count = 0;
    maxDrift = 0;
    for (let i = 0; i < cellCount; i++) {
      if (!isLand(i)) continue;
      const d = (storage[i] ?? 0) - (yearStart[i] ?? 0);
      if (record) storageChangeMm[i] = d;
      const ad = Math.abs(d);
      sum += ad;
      count++;
      if (ad > maxDrift) maxDrift = ad;
    }
    drift = count > 0 ? sum / count : 0;
    if (record) break; // 周期定常の年を記録し終えた
    if (drift <= SOIL_SPINUP_TOLERANCE_MM) converged = true; // 次の年を記録年にする
  }
  return {
    actualEtMm,
    storageMm,
    runoffMm,
    wetness01,
    storageChangeMm,
    spinupYears: usedYears,
    meanAnnualStorageDriftMm: drift,
    maxAnnualStorageDriftMm: maxDrift,
    converged,
  };
}

// ---- 結合反復の収束(第四 FB P0-1、2026-07-31 事前登録)----
// 土壌水分 → 実蒸発散 → 陸面供給 → 月ブレンド → 変換 → 後処理(冬季床・
// 月平滑)までを一つの演算子とし、その固定点を求める。反復内と最終出力で
// 同じ演算子を使う(旧実装は反復内が月ブレンドと後処理を欠いており、
// 土壌が収支計算に使った降水と最終降水が一致しなかった = 構造的残差 6.2%)。
// 許容差と上限は結果を見る前に固定する(較正つまみにしない)。
export const COUPLING_TOLERANCE_MM_PER_MONTH = 0.2;
/**
 * 結合反復の上限。**8 → 24(2026-08-10)。**
 *
 * 自転軸 80° の惑星で収束しなかった(tests/unit/sim/water_budget.test.ts の
 * 退化条件)。`scripts/diag_hightilt_coupling.ts` で残差を追うと、
 * 振動でも発散でもなく**単調に比 0.79 で減っており、13 回で収束する**。
 * 上限 8 が足りていなかっただけである。
 *
 *   傾斜 80°: 3.46 → 2.41 → 1.81 → … → 0.53(8 回目)→ … → 0.175(13 回目)
 *   地球    : 7 回・残差 0.14 で収束(1° 格子でも 4° 格子でも 7 回)
 *
 * **地球は 7 回で抜けるので、上限を上げても答えは 1 ビットも変わらない。**
 * ただし余裕が 1 回しかなかった — 惑星を少し動かせば無言で打ち切られる位置に
 * いた。EBM で 3 件踏んだ「反復の打ち切りが答えを決める」型
 * (docs/実験記録_EBM数値の点検_2026-08-02.md)と同じなので、
 * **上限が答えを決めないところまで上げる**。収束すれば即座に抜けるので、
 * 上げても地球型の費用は増えない。
 */
export const COUPLING_MAX_ITERATIONS = 24;

/**
 * 結合反復の打ち切りを実験で振るための上書き口(既定 0 = 上の定数を使う)。
 *
 * EBM で「反復の打ち切り」が答えを決めていた例が 3 件見つかったので
 * (docs/実験記録_EBM数値の点検_2026-08-02.md)、ここも同じ疑いで検査できる
 * ようにしておく。**通常経路の既定は変えない**。
 * 検査: scripts/exp_coupling_tolerance.ts
 */
/**
 * 結合反復の **Anderson 加速**(段 24、2026-08-15)。
 *
 * `depth = 0`(既定)で無効 = 素のピカール = 従来と厳密に一致する。
 *
 * なぜ要るか: CRH の指数抑制は「湿潤域で 1 のまま、乾燥域だけで落ちる」という
 * **乾いた端に要る形を満たす唯一既知の機構**だが(段 22・23)、結合系を硬くする。
 * 適応緩和つき・上限 200 でも残差 1.96(許容 0.2)で、比が 0.999 に張り付く。
 *
 * **緩和は原理的に足りない** — 実効比 `1 − α(1 − L)` は L → 1 でどう α を
 * 選んでも 1 へ近づく。要るのは過去の残差からの**外挿**である。
 *
 * **加速は不動点を変えない**(`x = F(x)` は γ に依らない)ので、
 * 物理の変更ではなく解き方の変更である。したがって深さは
 * **答えを決めてはならない量**で、較正の探索空間に入れてはならない。
 *
 * 事前登録: docs/事前登録_結合反復のAnderson加速_2026-08-15.md
 */
/**
 * **CRH を輸送の内部で解く(段 25、2026-08-15)。**
 *
 * 既定 `enabled = false` = 従来どおり、CRH は前の結合反復が解いた W から作られ、
 * G に畳み込まれて輸送へ渡る。つまり解いている式は
 * `P_k = λ·G(W_{k−1})·W_k` という **1 段遅れの帰還**である。
 *
 * 遅延つき帰還は 2 周期振動を生む典型的な形で、段 24 で実測した
 * 「残差が偶奇 2 系列に分裂する」という形と正確に一致する
 * (深さ・緩和を変えても必ず割れた。Anderson の実装は線形問題で検証済み)。
 *
 * 有効にすると、G から CRH を外し(`G_base`)、virga と同じ外側反復の中で
 * **いま解いている W** から CRH を作り直して解き直す。
 *
 * **不動点は変わらない** — 収束解では `W_k = W_{k−1}` なので同じ方程式である。
 * したがって物理の変更ではなく、式の解き方の変更。
 * **鋭さ 0 では CRH が恒等的に 1 なので、有効にしても答えは 1 ビットも動かない。**
 *
 * 事前登録: docs/事前登録_CRHを輸送の内部で解く_2026-08-15.md
 */
export const CRH_INNER = { enabled: false };

/**
 * **地形性上昇の倍率を面積平均 1 へ正規化する(段 28、2026-08-15)。**
 *
 * 既定 false = 従来どおり。
 *
 * なぜ要るか: 2026-08-15 に 4 つの機構を測って、**すべて同じ落ち方**をした。
 * 滞留時間(段 19)・virga(段 22)・CRH(段 25)は λ·G の面積平均を**下げ**、
 * 地形性上昇の基準勾配(段 27)は**上げ**たが、**どちらでも中位の陸が痩せた**。
 * 中位の陸は「水が通り過ぎる場所」で、平均をどちらへ動かしても損をする。
 *
 * そこで地形性上昇を**再配分だけの演算子**にする — 面積重み平均を 1 に
 * 正規化すれば、場所ごとの相対差は残しつつ全球の凝結率水準を動かさない。
 * **物理としても筋が通る**(地形は水を配り直すが惑星の凝結効率は変えない)。
 *
 * 基準は「その惑星・その月の平均」なので、地球の観測を計算層へ持ち込まない。
 *
 * 事前登録: docs/事前登録_凝結率の正規化_2026-08-15.md
 */
export const COND_RATE_NORMALIZE = { enabled: false };

/**
 * **ストームトラックの混合を「拡散の場」として保存型へ繋ぐ(段 36、2026-08-15)。**
 *
 * 既定 0 = 無効(拡散はスカラーのまま = 従来と厳密に一致)。
 *
 * `stormMoistureSupply` は非保存の降水式にしか入っておらず、
 * **保存型では完全に死んでいた**(段 6 の移行漏れ。掃引が全水準ビット一致して
 * 発覚)。しかも較正の探索空間に入っており、**答えに 1 ビットも影響しない定数を
 * 82% まで上げていた**。
 *
 * 繋ぎ直すとき「源泉 `src` に足す」のは**誤り**である。その機構は
 * 「移動性低気圧が**海の水を陸へ運ぶ**」もので、源泉に足すと陸で水が湧き出す
 * (海から引かないので収支が閉じない)。
 *
 * **正しくは拡散を場所依存にする** — 混合は月平均で見れば実効的な拡散であり、
 * **拡散は保存的なので水は湧かない**:
 * ```
 *   D(i) = D₀ × (1 + boost × supplyW × exp(−coastKm / decayKm))
 * ```
 * 緯度重み `supplyW` と海岸減衰は、既存の `stormSupply` の形をそのまま使う。
 *
 * 設計: docs/設計_ストーム供給を保存型へ繋ぐ_2026-08-15.md
 */
export const STORM_DIFFUSION = { boost: 0 };

export const COUPLING_ANDERSON = {
  /** 履歴の深さ。0 = 無効(既定)。1 で割線法 / Aitken と等価 */
  depth: 0,
  /** 正規方程式の Tikhonov 正則化(ΔF が退化したときの保険) */
  regularization: 1e-10,
};

export const COUPLING_OVERRIDE = {
  maxIterations: 0,
  /**
   * 結合反復の緩和を**固定**する(0 = 既定の適応)。診断用。
   * **緩和は不動点を変えない**ので、収束したときの答えは α に依らない。
   * したがって較正のつまみにしてはならない(答えを決めてはならない量)。
   */
  relaxation: 0,
};

// ---- R2(地域降水 FB §6): 供給場の循環 3 点月ブレンド ----
// 月平均風の単一方向トレースは風向の月替わりで供給が断絶する
// (ガンジス 7 月 589mm → 8 月 0mm — レビュー H8)。実際の遷移月はどちらの
// 風も吹くため、供給場を前/当/翌月で 0.25/0.5/0.25 に均す。
// 後段の precipMonthBlend(最終降水場の平滑)とは役割が異なる: こちらは
// 変換(持上げ・抑制の非線形)の**前**に供給の断絶を埋める。
// 旧実装は 0/1/0 の恒等写像でコメントと不一致だった(FB 指摘)。
// 2026-07-31 R2 単独実験として 0.25 を復活(採否は事前凍結基準で判定)。
export const SUPPLY_MONTH_BLEND_SIDE = 0.25;

/** 循環 3 点ブレンド(1 月と 12 月は互いに隣接)。side=0 で恒等 */
export function blendSupplyMonths(
  arr: Float32Array[],
  m: number,
  cellCount: number,
  side: number = SUPPLY_MONTH_BLEND_SIDE,
): Float32Array {
  const prev = arr[(m + MONTHS_PER_YEAR - 1) % MONTHS_PER_YEAR];
  const cur = arr[m];
  const next = arr[(m + 1) % MONTHS_PER_YEAR];
  const out = new Float32Array(cellCount);
  const center = 1 - 2 * side;
  for (let i = 0; i < cellCount; i++) {
    out[i] = side * (prev?.[i] ?? 0) + center * (cur?.[i] ?? 0) + side * (next?.[i] ?? 0);
  }
  return out;
}

interface PrecipDiagMonth {
  supplyStorm: Float32Array;
  liftItcz: Float32Array;
  liftFrontal: Float32Array;
  liftOrographic: Float32Array;
  liftConvergence: Float32Array;
  convergenceIndex: Float32Array;
  subsidenceResidual: Float32Array;
  /**
   * 沈降の内訳(2026-08-17 追加)。subs = descW × itczProt × eastRel × convRel。
   * C→B 誤分類の主因が沈降残存(0.48 対 0.71)と判明し、緩和 3 経路の
   * どのゲートが閉じているかを分解するために出す。すべて 0〜1 の残存率
   * (1 = その経路の抑制なし)
   */
  subsDescW: Float32Array;
  subsItczProt: Float32Array;
  subsEastRel: Float32Array;
  subsConvRel: Float32Array;
  upwindBlock: Float32Array;
  liftOther: Float32Array;
  crhSuppression: Float32Array;
  /** 保存型の凝結率係数 G(非保存では埋めない) */
  condRateG: Float32Array;
  /** 保存型の可降水量 W mm(非保存では埋めない) */
  waterMm: Float32Array;
  preAdjustMm: Float32Array;
}

function newDiagMonth(n: number): PrecipDiagMonth {
  return {
    supplyStorm: new Float32Array(n),
    liftItcz: new Float32Array(n),
    liftFrontal: new Float32Array(n),
    liftOrographic: new Float32Array(n),
    liftConvergence: new Float32Array(n),
    convergenceIndex: new Float32Array(n),
    subsidenceResidual: new Float32Array(n),
    subsDescW: new Float32Array(n),
    subsItczProt: new Float32Array(n),
    subsEastRel: new Float32Array(n),
    subsConvRel: new Float32Array(n),
    upwindBlock: new Float32Array(n),
    liftOther: new Float32Array(n),
    crhSuppression: new Float32Array(n),
    condRateG: new Float32Array(n),
    waterMm: new Float32Array(n),
    preAdjustMm: new Float32Array(n),
  };
}

export async function computePrecipitation(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
  ocean: OceanCurrentResult,
  airflow: AirflowResult,
  temperature: TemperatureResult,
  diagOut?: PrecipDiagBox,
  opts?: RunOptions,
): Promise<PrecipitationResult> {
  const { grid, params, terrain } = ctx;
  const monthlyPrecipMm: Float32Array[] = [];
  const annualPrecipMm = new Float32Array(grid.cellCount);
  // R1 診断: 要求時のみ割り当て(通常実行はゼロコスト)
  const diag: PrecipDiagnostics | null = diagOut
    ? {
        supplyOcean: [],
        supplyLand: [],
        supplyStorm: [],
        liftItcz: [],
        liftFrontal: [],
        liftOrographic: [],
        liftConvergence: [],
        convergenceIndex: [],
        subsidenceResidual: [],
        subsDescW: [],
        subsItczProt: [],
        subsEastRel: [],
        subsConvRel: [],
        upwindBlock: [],
        liftOther: [],
        crhSuppression: [],
        condRateG: [],
        waterMm: [],
        preAdjustMm: [],
        postAdjustDeltaMm: [],
        mmPerSupplyUnit:
          K.precipScaleMmPerUnit *
          Math.pow(Math.max(0.1, params.atmosphere.surfacePressureBar), 0.5),
      }
    : null;
  if (diag && diagOut) diagOut.fields = diag;
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  const smallWater = buildSmallWaterMask(ctx);
  const crestElev = buildCrestElev(ctx);

  // 「自転方向の東」側の海までの距離(km)とその海の SST 偏差。
  // 亜熱帯高気圧の西翼湿潤化は「東の海が暖流のとき」だけ効かせる
  // (アラビア海のような非暖流の東海で誤発火しない — 2026-07-30 レビュー A2)。
  // 順行 = 東、逆行 = 西。行内スキャン(最大 40 セル)。
  const eastOceanKm = new Float32Array(grid.cellCount).fill(1e9);
  const eastOceanSstA = new Float32Array(grid.cellCount);
  {
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    const W = grid.widthCells;
    for (let row = 0; row < grid.heightCells; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!terrain.landMask[i]) {
          eastOceanKm[i] = 0;
          eastOceanSstA[i] = ocean.sstAnomalyC[i] ?? 0;
          continue;
        }
        const maxScan = Math.max(10, Math.round(4400 / dxKm)); // 距離基準(解像度非依存)
        for (let d = 1; d <= maxScan; d++) {
          const j = row * W + wrapCol(grid, col + dir * d);
          if (!terrain.landMask[j]) {
            eastOceanKm[i] = d * dxKm;
            eastOceanSstA[i] = ocean.sstAnomalyC[j] ?? 0;
            break;
          }
        }
      }
    }
  }

  // ---- 沈降の海盆非対称の幾何場(2026-08-24、事前登録_沈降の海盆非対称)----
  // g[i] = exp(−海盆西縁距離/decay) × 幅ゲート。月に依らないので一度だけ作る。
  // 亜熱帯高気圧は海盆東側の細胞であり、海盆西部(大陸東岸沖)では沈降が
  // 開く、の幾何。幅ゲート (幅°−35)/20 は境界流の 55° と同じ尺で、
  // 地中海・アラビア海・ベンガル湾・メキシコ湾を自動除外する(縁海の教訓)。
  // **subsidenceBasinAsymmetry = 0 なら作らない = 従来とビット一致。**
  let basinAsymG: Float32Array | null = null;
  if ((K.subsidenceBasinAsymmetry as number) !== 0) {
    basinAsymG = new Float32Array(grid.cellCount);
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    const W = grid.widthCells;
    const widthGateOf = (widthDeg: number): number =>
      Math.min(1, Math.max(0, (widthDeg - 35) / 20));
    /** 海セルの幅ゲート(陸セルが東の海から引き継ぐために別持ち) */
    const oceanWidthGate = new Float32Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (terrain.landMask[i]) continue;
        // 自転の西向きに海上を辿り、最初の陸まで(= 海盆西縁距離)
        let dWest = -1;
        for (let d = 1; d < W; d++) {
          const j = row * W + wrapCol(grid, col - dir * d);
          if (terrain.landMask[j]) {
            dWest = d;
            break;
          }
        }
        if (dWest < 0) continue; // 全周が海の行(南大洋)= 非対称なし
        let dEast = -1;
        for (let d = 1; d < W; d++) {
          const j = row * W + wrapCol(grid, col + dir * d);
          if (terrain.landMask[j]) {
            dEast = d;
            break;
          }
        }
        const widthCells = dWest + (dEast < 0 ? W : dEast) - 1;
        const wg = widthGateOf(widthCells * grid.resolutionDeg);
        oceanWidthGate[i] = wg;
        basinAsymG[i] =
          Math.exp(-(dWest * dxKm) / K.subsidenceBasinAsymDecayKm) * wg;
      }
      // 陸セル: 東の海までの距離(eastOceanKm)で減衰し、その海の幅ゲートを引き継ぐ
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!terrain.landMask[i]) continue;
        const dKm = eastOceanKm[i] ?? 1e9;
        if (dKm >= 1e8) continue; // 東に海が無い(西岸・内陸)= 非対称なし
        const maxScan = Math.max(10, Math.round(4400 / dxKm));
        for (let d = 1; d <= maxScan; d++) {
          const j = row * W + wrapCol(grid, col + dir * d);
          if (!terrain.landMask[j]) {
            basinAsymG[i] =
              Math.exp(-dKm / K.subsidenceBasinAsymDecayKm) * (oceanWidthGate[j] ?? 0);
            break;
          }
        }
      }
    }
  }

  // ---- 段 45b: モンスーンコンベア(事前登録_コンベア接続_2026-08-18)----
  // 夏半球の亜熱帯で「大陸東岸沖の暖流域」から水を取り、その東海岸帯へ注ぐ。
  // 取水は前反復の W に比例(在る水しか運べない)。給水は海岸帯まで —
  // 内陸への配分は保存型ソルバの風・拡散・地形が担う(段 45a の教訓:
  // 経路の幾何をスカラー走査で書くと地形の網の目に負ける)。
  // 月・半球ごとに取水計 = 給水計(面積重み)。conveyorStrength = 0 なら
  // この準備ごと飛び、従来とビット一致。
  CONVEYOR_STATS.takeMmArea = 0;
  CONVEYOR_STATS.calls = 0;
  CONVEYOR_STATS.skippedNoWarm = 0;
  const conveyorPrep = K.conveyorStrength > 0 ? buildConveyorPrep() : null;
  function buildConveyorPrep(): {
    /** 海セル: 西(自転の逆)の陸までの距離 km(東岸沖 = 取水候補) */
    westLandKmOcean: Float32Array;
    /** 海セル: 西向き走査の流着列(海岸の経度列)。−1 = 流着なし */
    landfallCol: Int32Array;
    /** 陸セル: 東向き走査の海岸列(自セルの東海岸の経度列)。−1 = 海岸なし */
    coastCol: Int32Array;
    /** 月別・列別の R-H 西側沈降の因子(1 = 抑制なし)。段 44 の hCol 規則の鏡像 */
    rhWestFactorByMonth: Float64Array[];
    /** 月別・行別の夏ゲート(0〜1.2)。step02 と同じ日射の季節偏差規格化 */
    summerWByMonth: Float64Array[];
  } {
    const W = grid.widthCells;
    const H = grid.heightCells;
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    const westLandKmOcean = new Float32Array(grid.cellCount).fill(1e9);
    // 45b-2: セクター別保存のための流着列(海側)と海岸列(陸側)。
    // 半球プールは大西洋の水をアジアへテレポートさせた(掃引の分解で発覚)
    const landfallCol = new Int32Array(grid.cellCount).fill(-1);
    const coastCol = new Int32Array(grid.cellCount).fill(-1);
    for (let row = 0; row < H; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      const maxScan = Math.max(10, Math.round(K.conveyorFetchKm / dxKm));
      const maxScanLand = Math.max(10, Math.round(4400 / dxKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (terrain.landMask[i]) {
          for (let d = 1; d <= maxScanLand; d++) {
            const c2 = wrapCol(grid, col + dir * d);
            if (!terrain.landMask[row * W + c2]) {
              coastCol[i] = c2;
              break;
            }
          }
          continue;
        }
        for (let d = 1; d <= maxScan; d++) {
          const c2 = wrapCol(grid, col - dir * d);
          if (terrain.landMask[row * W + c2]) {
            westLandKmOcean[i] = d * dxKm;
            // 流着列は陸に当たる直前の海の列(= その海岸の海側の列)
            landfallCol[i] = wrapCol(grid, c2 + dir);
            break;
          }
        }
      }
    }
    const rhWestFactorByMonth: Float64Array[] = [];
    const summerWByMonth: Float64Array[] = [];
    const rowN30 = Math.max(0, Math.round((90 - 30) / grid.resolutionDeg) - 1);
    const rowS30 = Math.min(H - 1, Math.round((90 + 30) / grid.resolutionDeg));
    const landFracCol = new Float64Array(W);
    for (let col = 0; col < W; col++) {
      let n = 0;
      let nl = 0;
      for (let row = rowN30; row <= rowS30; row++) {
        n++;
        if (terrain.landMask[row * W + col]) nl++;
      }
      landFracCol[col] = n > 0 ? nl / n : 0;
    }
    const degPerCol = 360 / W;
    const minD = Math.max(1, Math.round(5 / degPerCol));
    const maxD = Math.round(60 / degPerCol);
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const centers = itcz.monthlyCenterLatDegByCol[m];
      const hCol = new Float64Array(W);
      for (let col = 0; col < W; col++) {
        const disp = Math.min(1, Math.abs(centers?.[col] ?? 0) / K.crossEquatorialRefDeg);
        hCol[col] = disp * Math.min(1, (landFracCol[col] ?? 0) / K.monsoonLandFracRef);
      }
      const rhF = new Float64Array(W);
      for (let col = 0; col < W; col++) {
        let eastH = 0;
        for (let dd = minD; dd <= maxD; dd++) {
          const c2 = (((col + dir * dd) % W) + W) % W;
          eastH = Math.max(eastH, (hCol[c2] ?? 0) * Math.exp(-(dd * degPerCol) / 30));
        }
        rhF[col] =
          1 -
          Math.min(1, Math.max(0, (eastH - (hCol[col] ?? 0)) / K.monsoonHeatContrastNorm));
      }
      rhWestFactorByMonth.push(rhF);
      const sw = new Float64Array(H);
      const insMonth = ctx.insolation.monthlyByRow[m];
      for (let row = 0; row < H; row++) {
        const dev = ((insMonth?.[row] ?? 0) - (ctx.insolation.annualMeanByRow[row] ?? 0)) / 120;
        sw[row] = Math.max(0, Math.min(1.2, dev));
      }
      summerWByMonth.push(sw);
    }
    return { westLandKmOcean, landfallCol, coastCol, rhWestFactorByMonth, summerWByMonth };
  }

  /**
   * コンベアの源泉・シンクを src に足し込む(保存: 半球ごとに取水計 = 給水計)。
   * wPrev が無い(初回の結合反復)あるいは給水先が無い半球では何もしない。
   * 取水はセルの蒸発源泉の半分を上限とし、src が負にならないことを保証する。
   */
  function applyConveyor(m: number, src: Float32Array, wPrev: Float32Array | null): void {
    if (!conveyorPrep) return;
    CONVEYOR_STATS.calls++;
    if (!wPrev) {
      CONVEYOR_STATS.skippedNoWarm++;
      return;
    }
    const W = grid.widthCells;
    const H = grid.heightCells;
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const centers = itcz.monthlyCenterLatDegByCol[m];
    const rhF = conveyorPrep.rhWestFactorByMonth[m];
    const summerW = conveyorPrep.summerWByMonth[m];
    // 45b-2: セクター(経度 10° ビン × 半球)別に取水と給水候補を集める。
    // ビンの鍵 = 半球 × nBins + (流着列 or 海岸列の 10° ビン)
    const binDeg = 10;
    const nBins = Math.max(1, Math.round(360 / binDeg));
    const colToBin = (c: number): number =>
      Math.min(nBins - 1, Math.floor((c / grid.widthCells) * nBins));
    const take = new Float32Array(grid.cellCount);
    const giveW = new Float32Array(grid.cellCount);
    const binOf = new Int32Array(grid.cellCount).fill(-1);
    const takeSum = new Float64Array(2 * nBins);
    const giveSum = new Float64Array(2 * nBins);
    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      const hemi = lat >= 0 ? 0 : 1;
      const sw = summerW?.[row] ?? 0;
      if (sw <= 0) continue;
      const areaW = Math.cos((lat * Math.PI) / 180);
      const ridge = lat >= 0 ? ridgeN : ridgeS;
      const aLat = Math.abs(lat);
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        // 緯度窓(ITCZ 極側 〜 リッジ+5°、外は 3° で減衰)— 45a と同じ形
        const lo = Math.abs(centers?.[col] ?? 0);
        const hi = Math.abs(ridge) + K.conveyorLatPolewardDeg;
        let latW = 0;
        if (aLat >= lo && aLat <= hi) latW = 1;
        else if (aLat < lo) latW = Math.max(0, 1 - (lo - aLat) / K.conveyorLatSoftDeg);
        else latW = Math.max(0, 1 - (aLat - hi) / K.conveyorLatSoftDeg);
        if (latW <= 0) continue;
        if (terrain.landMask[i]) {
          // 給水候補: 東海岸帯(奥行き conveyorCoastKm)× R-H 因子。
          // セクター = 自セルの東海岸の経度ビン(45b-2)
          const cc = conveyorPrep.coastCol[i] ?? -1;
          if (cc < 0) continue;
          const g =
            Math.exp(-(eastOceanKm[i] ?? 1e9) / K.conveyorCoastKm) * sw * latW * (rhF?.[col] ?? 1);
          if (g > 1e-9) {
            const bin = hemi * nBins + colToBin(cc);
            giveW[i] = g;
            binOf[i] = bin;
            giveSum[bin] = (giveSum[bin] ?? 0) + g * areaW;
          }
        } else {
          // 取水候補: 東岸沖の暖流域。前反復の W に比例、蒸発源泉の半分が上限。
          // セクター = 西向き走査の流着列の経度ビン(45b-2)
          const lf = conveyorPrep.landfallCol[i] ?? -1;
          if (lf < 0) continue;
          const anchor =
            Math.max(0, ocean.sstAnomalyC[i] ?? 0) *
            Math.exp(-(conveyorPrep.westLandKmOcean[i] ?? 1e9) / K.conveyorFetchKm) *
            sw *
            latW;
          if (anchor <= 1e-9) continue;
          const t = Math.min(
            0.5 * (src[i] ?? 0),
            K.conveyorStrength * anchor * (wPrev[i] ?? 0),
          );
          if (t > 0) {
            const bin = hemi * nBins + colToBin(lf);
            take[i] = t;
            binOf[i] = bin;
            takeSum[bin] = (takeSum[bin] ?? 0) + t * areaW;
          }
        }
      }
    }
    // セクターごとに配分(給水先の無いセクターは取水もしない = 保存を厳守)
    for (let i = 0; i < grid.cellCount; i++) {
      const bin = binOf[i] ?? -1;
      if (bin < 0) continue;
      const total = takeSum[bin] ?? 0;
      const denom = giveSum[bin] ?? 0;
      if (total <= 0 || denom <= 1e-12) continue;
      if (terrain.landMask[i]) {
        if ((giveW[i] ?? 0) > 0) src[i] = (src[i] ?? 0) + ((giveW[i] ?? 0) * total) / denom;
      } else if ((take[i] ?? 0) > 0) {
        src[i] = (src[i] ?? 0) - (take[i] ?? 0);
        CONVEYOR_STATS.takeMmArea += take[i] ?? 0;
      }
    }
  }

  // 年平均 ITCZ 中心(経度列別)。赤道常湿帯の残留影響に使う —
  // 実物の熱赤道近傍は ITCZ が年 2 回通過し遠くへ行かないため乾季でも雨が残る
  // (Pasta/Log の「赤道 = 雨林」の定量化)。トラフが片半球へ深く出る経度でも
  // 年平均線の周りは湿ったままにする
  const meanItczCenters = new Float32Array(grid.widthCells);
  {
    for (let col = 0; col < grid.widthCells; col++) {
      let s = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        s += itcz.monthlyCenterLatDegByCol[m]?.[col] ?? 0;
      }
      meanItczCenters[col] = s / MONTHS_PER_YEAR;
    }
  }

  // 近傍最冷 SST 偏差(寒流沿岸の判定)。月に依らないので 1 回だけ解く。
  // 対象は寒流沿岸の条件に入りうるセルだけ(陸・|緯度| 10〜50°・海岸 300km 以内)
  const coldAnomalyCache = new Float32Array(grid.cellCount);
  {
    const W = grid.widthCells;
    for (let row = 0; row < grid.heightCells; row++) {
      const aLat = Math.abs(latDegOfRow(grid, row));
      if (aLat <= 10 || aLat >= 50) continue;
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!terrain.landMask[i]) continue;
        if ((ctx.landDistToCoastKm[i] ?? 1e9) >= 300) continue;
        coldAnomalyCache[i] = nearestOceanAnomaly(ctx, ocean, row, col);
      }
    }
  }

  // ---- 風上追跡(12 か月)。加速器があれば 1 カーネルで一度に解く ----
  // 加速器は「渡されたら使う」だけで、無ければ CPU 実装に落ちる(src/sim/accel.ts)。
  // GPU 版は 12 か月ぶんを 777,600 スレッドで一度に解くため、月ごとに呼ばず
  // **12 か月を配列で渡す**形にしている
  const traceAccel = opts?.accel?.moistureTrace(grid.cellCount) ?? null;
  const traceFields: TraceStaticFields | null = traceAccel
    ? {
        widthCells: grid.widthCells,
        heightCells: grid.heightCells,
        dyKm,
        radiusKm: params.body.radiusKm,
        resolutionDeg: grid.resolutionDeg,
        elevationMeters: terrain.elevationMeters,
        crestElevationMeters: crestElev,
        landMask: Float32Array.from(terrain.landMask),
        smallWater: Float32Array.from(smallWater),
      }
    : null;
  const traceConstants: TraceConstants = {
    orographicDepletionM: K.orographicDepletionM,
    moistureTraceMaxKm: K.moistureTraceMaxKm,
    moistureDecayLandKm: K.moistureDecayLandKm,
    moistureDecayOceanKm: K.moistureDecayOceanKm,
    fetchOpenOceanCapKm: K.fetchOpenOceanCapKm,
  };
  const traceAllMonths = async (landSource: Float32Array[] | null): Promise<Float32Array[]> => {
    if (traceAccel && traceFields) {
      return traceAccel.run(traceFields, traceConstants, {
        temperature: temperature.monthlyTemperatureC,
        windU: airflow.monthlyWindU,
        windV: airflow.monthlyWindV,
        landSource,
      });
    }
    const out: Float32Array[] = [];
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const tField = temperature.monthlyTemperatureC[m];
      const u = airflow.monthlyWindU[m];
      const v = airflow.monthlyWindV[m];
      out.push(
        tField && u && v
          ? traceMoistureSupply(
              ctx,
              smallWater,
              crestElev,
              tField,
              u,
              v,
              landSource?.[m] ?? null,
              0,
            )
          : new Float32Array(grid.cellCount),
      );
    }
    return out;
  };

  // ---- パス 1: 海洋のみを供給源として風上追跡(全月)----
  const supplies1 = await traceAllMonths(null);
  const blend = (arr: Float32Array[], m: number): Float32Array =>
    blendSupplyMonths(arr, m, grid.cellCount);

  // ---- パス 2: 陸面再蒸発を供給源に加えて再追跡(結合反復)----
  // 実物の内陸雨林は降水の 5〜8 割が再蒸発の再循環で自己保持される。
  // 1 回パスだと海から遠い赤道内陸が立ち上がれない(鶏と卵 — 仮想大陸の
  // 赤道内陸が砂漠化する実測 2026-07-31)ため、固定点に向けて反復する。
  // R3: 陸面供給は「当月降水に比例」ではなく土壌水分バケツの実蒸発散に
  // 比例させる(乾季へ前月までの雨を持ち越す)。月をまたぐ状態を持つため
  // 結合反復を月ループの外側に置く — 土壌無効時は月ごと独立で従来と同一。
  /**
   * 土壌水分の周期解。**conservativeMonth より前に宣言する**必要がある
   * (保存型の源泉が陸面蒸発散を読むため。以前は結合反復の直前で宣言しており、
   * TDZ で `Cannot access 'soil' before initialization` になった — 2026-08-09)。
   */
  let soil: SoilWaterResult | null = null;

  // ---- 保存型の水収支(段 1)。既定は無効 ----
  // 海面蒸発は月・セルにしか依らないので 1 度だけ作って使い回す
  const evapCache: { v: EvaporationResult | null } = { v: null };
  /**
   * 月ごとの前回解(温間開始)。同じ月を結合反復で何度も解き直すので、
   * 前回の水蒸気量から始めれば反復数が大きく減る。
   *
   * **答えが初期値に依らないことは実測で確かめること**(cold と warm を
   * 突き合わせる)。速度のために答えを動かしては本末転倒である。
   */
  const warmStart: Array<Float32Array | null> = new Array(MONTHS_PER_YEAR).fill(null);
  /** 蒸発の季節変調係数(台帳 項目 3)の前反復値 — 緩和用 */
  const evapSeasonF: Array<Float32Array | null> = new Array(MONTHS_PER_YEAR).fill(null);

  /**
   * 降水を**凝結量**として作る。
   *   0 = S − C(W) − ∇·(WV) ,  C = λ·G·W ,  P = C
   * S は蒸発(海面 + 陸面)、G は既存の乗数の積、λ は凝結の時定数。
   * **precipScaleMmPerUnit はここに存在しない** — 収支が mm を決めるので、
   * 無次元の供給を mm へ換算する定数は置き場所が無い。
   */
  const conservativeMonth = (
    m: number,
    tField: Float32Array,
    u: Float32Array,
    v: Float32Array,
    supply: Float32Array,
    diagM?: PrecipDiagMonth,
  ): Float32Array => {
    const out = conservativeMonthCore(m, tField, u, v, supply, diagM);
    // 因子分解の診断は**実際に走った演算子**のものでなければならない。
    // 保存型では降水 = 凝結量なので、後処理前の値はこの戻り値そのもの
    if (diagM) diagM.preAdjustMm.set(out);
    return out;
  };

  const conservativeMonthCore = (
    m: number,
    tField: Float32Array,
    u: Float32Array,
    v: Float32Array,
    supply: Float32Array,
    diagM?: PrecipDiagMonth,
  ): Float32Array => {
    const N = grid.cellCount;
    // 凝結率の係数 G = 既存の乗数の積(この段では 1 つも外さない)
    const G = new Float32Array(N);
    /**
     * **CRH を輸送の内部で解くための受け皿(段 25)。**
     * `CRH_INNER = 0`(既定)なら null で、従来どおり G に畳み込まれる。
     * 有効なときは G から CRH が外れ、下の外側反復で W から作り直される。
     * **鋭さ 0 では CRH が恒等的に 1 なので、どちらでも答えは同じ。**
     */
    const crhInner =
      CRH_INNER.enabled && K.crhSuppressionSharpness > 0 && K.crhFromWater > 0
        ? new Float32Array(N)
        : null;
    /** 地形性上昇を面積平均 1 へ正規化するための受け皿(段 28) */
    const oroNorm = COND_RATE_NORMALIZE.enabled ? new Float32Array(N) : null;
    /** ストーム混合を拡散の場へ繋ぐための受け皿(段 36) */
    const stormMix = STORM_DIFFUSION.boost > 0 ? new Float32Array(N) : null;
    convertToPrecip(
      ctx, itcz, m, tField, u, v, supply,
      windBelt.monthlyRidgeLatNDeg[m] ?? 31,
      windBelt.monthlyRidgeLatSDeg[m] ?? -31,
      windBelt.monthlyPolarFrontLatNDeg[m] ?? 60,
      windBelt.monthlyPolarFrontLatSDeg[m] ?? -60,
      dyKm, ocean, eastOceanKm, eastOceanSstA, basinAsymG, meanItczCenters, crestElev,
      coldAnomalyCache, diagM, G,
      // 前反復が解いた W と、リッジの経度別の押し上げ量を渡す
      // **前反復が解いた W** を渡す(前線の判定に使う。既定では見られない)。
      // G は W を決める方程式の係数なので、同じ反復の W は原理的に使えない。
      // 結合反復が収束すれば前反復と当反復の W は一致するので自己整合する
      warmStart[m] ?? undefined,
      windBelt.monthlyRidgeShiftDegByCol[m],
      // **CRH を輸送の内部で解く(段 25)。** 渡すと G から CRH が外れる。
      // 鋭さ 0 では CRH が恒等的に 1 なので、渡しても渡さなくても同じ値になる
      crhInner ?? undefined,
      oroNorm ?? undefined,
      stormMix ?? undefined,
    );
    // 内部で解く場合、G には CRH が掛かっていないので、診断には掛け戻す
    // **地形性上昇を面積平均 1 へ正規化してから G へ掛け戻す(段 28)。**
    // こうすると地形は「場所ごとの相対差」だけを作り、全球の凝結率水準を
    // 動かさない。今日 4 つの機構がすべて「平均を動かして中位を痩せさせた」
    // ので、平均を保つ制約そのものを試している。
    if (oroNorm) {
      let sw = 0;
      let ww = 0;
      for (let row = 0; row < grid.heightCells; row++) {
        const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
        for (let col = 0; col < grid.widthCells; col++) {
          sw += cw * (oroNorm[row * grid.widthCells + col] ?? 1);
          ww += cw;
        }
      }
      const mean = sw / Math.max(1e-9, ww);
      for (let i = 0; i < N; i++) G[i] = (G[i] ?? 0) * ((oroNorm[i] ?? 1) / Math.max(1e-9, mean));
    }

    // 診断の G は「実際に走った演算子」でなければならない。
    // 内部で外した因子(CRH・地形性上昇)は掛け戻す。
    // **正規化を有効にしたときは G に既に正規化後の oro が入っている**ので
    // ここでは掛けない(oroNorm の分岐は上の正規化で済んでいる)
    if (diagM) {
      if (crhInner) {
        for (let i = 0; i < N; i++) diagM.condRateG[i] = (G[i] ?? 0) * (crhInner[i] ?? 1);
      } else {
        diagM.condRateG.set(G);
      }
    }
    // 源泉 S = 海面蒸発 + 陸面蒸発散
    if (!evapCache.v) evapCache.v = computeOceanEvaporation(ctx, temperature, airflow);
    const src = new Float32Array(N);
    const etM = soil?.actualEtMm[m];
    const oceanE = evapCache.v.monthlyOceanEvapMm[m];
    for (let i = 0; i < N; i++) {
      src[i] = terrain.landMask[i] ? (etM?.[i] ?? 0) : (oceanE?.[i] ?? 0);
    }
    // 台帳 項目 3(2026-08-24): 海上蒸発の季節変調。前の結合反復の W で
    // 大気側湿度を変調する: 蒸発 × ((1 − RH·f) / (1 − RH))、f = clamp((W_m/W̄)^k, 0.5, 1.2)。
    // 冬に W が少ない海で RH が下がり蒸発が増える(実物の冬の蒸発極大)。
    // 既定 k=0 では f=1 で係数 1 = 従来とビット一致。初回(W 無し)も変調なし
    if (K.evapHumiditySeasonalExp > 0 && warmStart.every((w) => w !== null)) {
      // **緩和が要る**(2026-08-24 実測): 前反復の W をそのまま使うと
      // W→蒸発→W の正帰還が 2 周期振動になり結合反復が収束しない
      // (k=1〜3 の全水準で健全性 ×)。係数 f を前反復の f と半々に混ぜ、
      // 振れ幅も [0.7, 1.15] に絞る(教訓: 反復が 2 周期に割れたら遅延を疑う)
      // 定式化(2 版、2026-08-24): RH を変調すると (1−RH)=0.2 が相対的に大きく
      // 動き、W の ±20% が蒸発の ±80% になる(ループ利得 ≈ 4、緩和でも発散)。
      // **湿度欠損 (1−RH) を直接 (W̄/W_m)^k で変調**すれば利得は k そのもの。
      // 乾いた月(W が平均より少ない)ほど欠損が大きく蒸発が増える — 物理は同じ
      const wPrevM = warmStart[m] as Float32Array;
      const fPrev = evapSeasonF[m] ?? (evapSeasonF[m] = new Float32Array(N).fill(1));
      for (let i = 0; i < N; i++) {
        if (terrain.landMask[i]) continue;
        let wBar = 0;
        for (let mm = 0; mm < MONTHS_PER_YEAR; mm++) wBar += (warmStart[mm] as Float32Array)[i] ?? 0;
        wBar /= MONTHS_PER_YEAR;
        const wm = wPrevM[i] ?? 0;
        if (!(wBar > 1e-6) || !(wm > 1e-6)) continue;
        const fRaw = Math.pow(wBar / wm, K.evapHumiditySeasonalExp);
        const f = Math.min(1.3, Math.max(0.75, 0.5 * (fPrev[i] ?? 1) + 0.5 * fRaw));
        fPrev[i] = f;
        src[i] = (src[i] ?? 0) * f;
      }
    }
    // 段 45b: コンベアの源泉・シンク対(既定 0 では conveyorPrep が null で不発。
    // 初回の結合反復は warmStart が無いので不発 — 2 回目以降で自己整合する)
    applyConveyor(m, src, warmStart[m] ?? null);
    // 凝結率 λ·G。λ = U_ref / L で、既存の距離減衰を**凝結寿命**として写す
    const rate = new Float32Array(N);
    const travelKmPerMonth = (K.condensationRefWindMs * SECONDS_PER_MONTH) / 1000;
    for (let i = 0; i < N; i++) {
      const lKm = terrain.landMask[i] ? K.moistureDecayLandKm : K.moistureDecayOceanKm;
      // 0 のセルは水蒸気が溜まり続けるので下限を置く(輸送側でも安全側に効く)
      rate[i] = Math.max(0.05, (travelKmPerMonth / Math.max(1, lKm)) * (G[i] ?? 0));
    }
    // **ストーム混合を拡散の場として組む(段 36)。**
    // D(i) = D₀ × (1 + boost × supplyW × exp(−coastKm/decayKm))
    // **拡散は保存的なので水は湧かない**(源泉に足すのとは違う)。
    // boost = 0（既定）なら null のままで、従来どおりスカラーが渡る
    let diffField: Float32Array | null = null;
    if (stormMix) {
      diffField = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        diffField[i] =
          K.moistureEddyDiffusivityM2PerS * (1 + STORM_DIFFUSION.boost * (stormMix[i] ?? 0));
      }
    }
    const diffOpt: number | Float32Array = diffField ?? K.moistureEddyDiffusivityM2PerS;
    const r = solveMoistureTransport(
      grid,
      ctx.params.body.radiusKm,
      u,
      v,
      src,
      rate,
      {
        diffusivityM2PerS: diffOpt,
        // **上限が答えを決めないところまで上げる。** 既定 4000 では 84 か月分が
        // 未収束のまま残った(2026-08-09)。EBM で 3 回踏んだ隠しパラメータと
        // 同じ型なので、収束を確かめてから採点する
        maxIterations: TRANSPORT_MAX_ITERATIONS,
        ...(warmStart[m] ? { initialGuessMm: warmStart[m] as Float32Array } : {}),
      },
    );
    warmStart[m] = r.waterMm;
    {
      // 全球平均の可降水量を積む（実物 25mm との比較用）
      let sw = 0;
      let ww = 0;
      for (let row = 0; row < grid.heightCells; row++) {
        const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
        for (let col = 0; col < grid.widthCells; col++) {
          sw += cw * (r.waterMm[row * grid.widthCells + col] ?? 0);
          ww += cw;
        }
      }
      CONSERVATIVE_STATS.meanWaterMm += sw / Math.max(1e-9, ww);
      CONSERVATIVE_STATS.waterSamples++;
    }
    // **収束していない解を黙って採用しない**
    if (!r.converged) {
      CONSERVATIVE_STATS.nonConverged++;
      CONSERVATIVE_STATS.worstResidual = Math.max(CONSERVATIVE_STATS.worstResidual, r.residual);
    }
    CONSERVATIVE_STATS.iterations += r.iterations;

    // ---- 雲底下の再蒸発(virga)----
    // 非保存の経路は `precipMm` を組んだ**後**に弱い雨を選択的に削っていた。
    // その処理は乗数の積(G)に入らないので、保存型では**まったく効いていなかった**
    // (2026-08-09 に実装を読み直して発覚)。
    //
    // ただし保存型での正しい扱いは「削る」ではない。**雲底下で蒸発した水は
    // 大気へ戻る**ので、消してしまうと水が閉じなくなる。
    // 等価で単純な書き方は「その分だけ凝結しなかったことにする」— 凝結率を
    // (1 − 失われる割合) 倍する。水は気柱に残り、輸送されて別の場所で凝結する。
    //
    // 失われる割合は P に依存する(弱い雨ほど多く失われる)ので非線形。
    // **外側反復**で解く。相対湿度は保存型では W/W_sat で直接得られる —
    // 供給の代用ではなく、輸送が解いた水蒸気量そのものである。
    // **W は凝結量と対で残す。** virga の外側反復は rate を書き換えて解き直すので、
    // 「どの W からこの凝結量が出たか」は抜ける口ごとに違う。
    // 診断だけの代入で、通常実行(diagM なし)では 1 命令も走らない
    /**
     * 診断を**外側反復の結果で締める**(2026-08-15)。
     *
     * `condRateG` と `crhSuppression` は `convertToPrecip` が
     * **外側反復の前**に書いた値(前の結合反復の W 由来)である。
     * CRH を内部で解くと外側反復の中で CRH が更新されるので、
     * **そのまま返すと診断の G と、実際に解いた凝結率がずれる**。
     * 段 25 の不変量テスト(含意される凝結率が λ·G を超えない)が
     * 3% の超過として捕まえた。**診断は実際に走った演算子のものでなければ
     * ならない**(2026-08-10 に同じ型の取り違えを踏んでいる)。
     */
    const finishDiag = (w: Float32Array): void => {
      if (!diagM) return;
      diagM.waterMm.set(w);
      if (!crhInner) return;
      for (let i = 0; i < N; i++) {
        diagM.crhSuppression[i] = crhInner[i] ?? 1;
        diagM.condRateG[i] = (G[i] ?? 0) * (crhInner[i] ?? 1);
      }
    };

    // **CRH を内部で解くときも外側反復が要る(段 25)。** virga と同じループを使う
    if (K.subCloudEvapCoef <= 0 && !crhInner) {
      if (diagM) diagM.waterMm.set(r.waterMm);
      return r.condensationMm;
    }

    const pressureHpa = ctx.params.atmosphere.surfacePressureBar * 1013.25;
    const rateEff = new Float32Array(N);
    let cond = r.condensationMm;
    let water = r.waterMm;
    let last = r;
    const virgaMax =
      VIRGA_OVERRIDE.maxIterations > 0 ? VIRGA_OVERRIDE.maxIterations : VIRGA_OUTER_ITERATIONS;
    const trail: number[] | null = VIRGA_OVERRIDE.trace ? [] : null;
    if (trail) VIRGA_OVERRIDE.series.push(trail);
    // ---- 緩和は**適応**にする(2026-08-15)----
    //
    // 固定の α = 0.6 では 204 呼び出し中 78 件しか収束せず、α = 1.0 では 184 件
    // 収束するが**最悪の月は逆に停滞する**。実測で、壊れ方が 2 種類**同じ実行の
    // 中に共存している**と分かった(docs/診断_virgaの外側反復は緩慢_2026-08-15.md):
    //
    //   ほとんどの月 = 緩慢（比 0.9 前後で単調に縮む）→ α を下げると**逆効果**
    //   少数の月     = 振動（比が 1 を超えて跳ねる）  → α を下げるのが**効く**
    //
    // **単一の α ではどちらかしか救えない。** そこで α = 1 から始め、
    // 残差が増えた回だけ半減させる(標準的な減衰つきピカール)。
    // 増えなければ 1 へ戻していく — 振動が収まった後まで遅いままにしない。
    //
    // **緩和は不動点を変えない**ので、これは物理の変更ではなく解き方の変更である。
    // virga は既定で無効(`subCloudEvapCoef = 0`)なので、出荷時の答えは 1 ビットも
    // 動かない(この関数はその手前で return する)。
    // `VIRGA_OVERRIDE.relaxation > 0` を指定したときだけ、従来どおり α を固定する。
    const fixedAlpha = VIRGA_OVERRIDE.relaxation > 0 ? VIRGA_OVERRIDE.relaxation : 0;
    let alpha = fixedAlpha > 0 ? fixedAlpha : 1;
    let prevChange = Number.POSITIVE_INFINITY;
    for (let outer = 0; outer < virgaMax; outer++) {
      let maxChange = 0;
      const virgaAlpha = alpha;
      for (let i = 0; i < N; i++) {
        const p = cond[i] ?? 0;
        let lost = 0;
        if (p > 0) {
          const wSat = saturatedColumnMm(tField[i] ?? 0, pressureHpa);
          const rh = Math.min(1, (water[i] ?? 0) / Math.max(1e-6, wSat));
          lost = Math.min(K.subCloudEvapMaxFrac, (K.subCloudEvapCoef * (1 - rh)) / Math.sqrt(p));
        }
        // **CRH を「いま解いている W」から作り直す(段 25)。**
        // 外側で `G(W_{k−1})` と代入すると 1 段遅れの帰還になり、
        // 2 周期振動を生む(段 24 で偶奇分裂として実測した)。
        // ここで作れば遅延が無くなり、G と W が同じ方程式の中で釣り合う。
        let crhNow = 1;
        if (crhInner) {
          const wSatC = saturatedColumnMm(tField[i] ?? 0, pressureHpa);
          const crh = Math.min(1, (water[i] ?? 0) / Math.max(1e-6, wSatC));
          crhNow = Math.exp(K.crhSuppressionSharpness * (crh - 1));
          crhInner[i] = crhNow;
        }
        const target = (rate[i] ?? 0) * crhNow * (1 - lost);
        // 減衰つきで更新する(P ↓ → 失われる割合 ↑ の帰還が振動しうる)
        const prev = outer === 0 ? (rate[i] ?? 0) : (rateEff[i] ?? 0);
        const next = prev + virgaAlpha * (target - prev);
        // **収束は「緩和前の差」で測る(2026-08-15 に実測で発覚)。**
        // 以前は `next − prev = α(target − prev)` で測っていたので、
        // **α が小さいほど「収束した」ことになってしまっていた**。
        // 適応緩和で α が 0.1 まで下がると、実際には 5% ずれていても
        // 許容 5e-3 を満たす。段 25 の不変量テスト
        // (含意される凝結率が λ·G を超えない)が 3% の超過として捕まえた。
        // **収束判定が解き方のパラメータに依存してはならない。**
        maxChange = Math.max(maxChange, Math.abs(target - prev) / Math.max(1e-6, rate[i] ?? 1));
        rateEff[i] = next;
      }
      last = solveMoistureTransport(grid, ctx.params.body.radiusKm, u, v, src, rateEff, {
        diffusivityM2PerS: diffOpt,
        maxIterations: TRANSPORT_MAX_ITERATIONS,
        initialGuessMm: water,
      });
      warmStart[m] = last.waterMm;
      if (!last.converged) {
        CONSERVATIVE_STATS.nonConverged++;
        CONSERVATIVE_STATS.worstResidual = Math.max(
          CONSERVATIVE_STATS.worstResidual,
          last.residual,
        );
      }
      CONSERVATIVE_STATS.iterations += last.iterations;
      cond = last.condensationMm;
      water = last.waterMm;
      trail?.push(maxChange);
      // 残差が増えた回だけ半減、減った回は 1 へ戻す(下限 0.1)。
      // 固定 α を指定されているときは触らない
      if (fixedAlpha <= 0) {
        alpha = maxChange > prevChange ? Math.max(0.1, alpha * 0.5) : Math.min(1, alpha * 1.5);
      }
      prevChange = maxChange;
      if (maxChange < VIRGA_TOLERANCE) {
        finishDiag(water);
        return cond;
      }
    }
    // 外側反復が収束しなかった月も**黙って通さない**
    CONSERVATIVE_STATS.virgaNonConverged++;
    finishDiag(water);
    return cond;
  };

  const monthlyConvert = (
    m: number,
    supply: Float32Array,
    diagM?: PrecipDiagMonth,
  ): Float32Array => {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    if (!tField || !u || !v) return new Float32Array(grid.cellCount);
    if (K.conservativeMoisture > 0) return conservativeMonth(m, tField, u, v, supply, diagM);
    return convertToPrecip(
      ctx,
      itcz,
      m,
      tField,
      u,
      v,
      supply,
      windBelt.monthlyRidgeLatNDeg[m] ?? 31,
      windBelt.monthlyRidgeLatSDeg[m] ?? -31,
      windBelt.monthlyPolarFrontLatNDeg[m] ?? 60,
      windBelt.monthlyPolarFrontLatSDeg[m] ?? -60,
      dyKm,
      ocean,
      eastOceanKm,
      eastOceanSstA,
      basinAsymG,
      meanItczCenters,
      crestElev,
      coldAnomalyCache,
      diagM,
      undefined,
      undefined,
      windBelt.monthlyRidgeShiftDegByCol[m],
    );
  };

  // ---- 後処理: 冬季の弱前線の床 + 降水の月平滑(いずれも陸のみ)----
  // 第四 FB P0-1: これらは結合演算子の一部であり、反復の中でも最終出力と
  // 同じものを適用する(旧実装は反復内で欠けており、土壌が収支に使った降水と
  // 最終降水が別物になっていた)。どちらもセル年総量を保存する。
  const applyPostAdjust = (arr: Float32Array[]): void => {
    // 冬季の弱前線の床(年総量保存の再配分)。最乾月が 0mm に張り付く癖
    // (Cwa 最多/最少比)への対策。熱帯のサバナ乾季には掛からない
    {
      const W = grid.widthCells;
      const decls = ctx.insolation.monthlyDeclinationDeg;
      for (let row = 0; row < grid.heightCells; row++) {
        const lat = latDegOfRow(grid, row);
        const aLat = Math.abs(lat);
        for (let col = 0; col < W; col++) {
          const i = row * W + col;
          if (!terrain.landMask[i]) continue;
          let wettest = 0;
          for (let m = 0; m < MONTHS_PER_YEAR; m++) {
            const p = arr[m]?.[i] ?? 0;
            if (p > wettest) wettest = p;
          }
          const floorMm = Math.min(K.winterFloorMaxMm, K.winterFloorFracOfWettest * wettest);
          if (floorMm < 0.5) continue;
          let deficit = 0;
          let surplus = 0;
          const floors: number[] = [];
          for (let m = 0; m < MONTHS_PER_YEAR; m++) {
            // 適用月 = 盛夏以外(正規化赤緯 < 0.5)。冬限定だと 4〜5 月の
            // 「春の谷」が夏半年の最乾月になり、秋こぶ(10 月)との組で
            // タイガが夏乾 Ds に誤判定される(s 条件: 4月 < 10月/3)
            const summerNorm =
              (lat >= 0 ? (decls[m] ?? 0) : -(decls[m] ?? 0)) /
              Math.max(1e-6, ctx.params.body.axialTiltDeg);
            const ridge =
              lat >= 0
                ? (windBelt.monthlyRidgeLatNDeg[m] ?? 31)
                : (windBelt.monthlyRidgeLatSDeg[m] ?? -31);
            const pf =
              lat >= 0
                ? (windBelt.monthlyPolarFrontLatNDeg[m] ?? 60)
                : (windBelt.monthlyPolarFrontLatSDeg[m] ?? -60);
            const inBand = aLat > Math.abs(ridge) + 1 && aLat < Math.abs(pf) + 12;
            const f = summerNorm < 0.5 && inBand ? floorMm : 0;
            floors.push(f);
            const p = arr[m]?.[i] ?? 0;
            if (p < f) deficit += f - p;
            else surplus += p - f;
          }
          if (deficit <= 0 || surplus <= 0) continue;
          // 移転は湿潤月の余剰の 35% まで(無制限だと夏の雨をほぼ全部持って
          // いき、タイガが夏乾の Ds に化ける — 実測)
          const transfer = Math.min(deficit, surplus * 0.35);
          const k = transfer / surplus;
          const fill = transfer / deficit;
          for (let m = 0; m < MONTHS_PER_YEAR; m++) {
            const a = arr[m];
            if (!a) continue;
            const p = a[i] ?? 0;
            const f = floors[m] ?? 0;
            a[i] = p < f ? p + (f - p) * fill : p - (p - f) * k;
          }
        }
      }
    }
    // 降水の月平滑(循環 3 点)。風向の月替わりで遷移月が 0 近くまで陥没し
    // 「夏半年の最乾月」になってタイガが夏乾 Ds に誤判定される対策。
    // 乾季が連続する所(サバナ・地中海の夏)は隣接月も乾いており不変
    if (K.precipMonthBlend > 0) {
      const b = K.precipMonthBlend;
      const before = arr.map((a) => Float32Array.from(a));
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const cur = arr[m];
        const prev = before[(m + MONTHS_PER_YEAR - 1) % MONTHS_PER_YEAR];
        const next = before[(m + 1) % MONTHS_PER_YEAR];
        if (!cur || !prev || !next) continue;
        for (let i = 0; i < grid.cellCount; i++) {
          if (!terrain.landMask[i]) continue;
          cur[i] = (1 - 2 * b) * (before[m]?.[i] ?? 0) + b * (prev[i] ?? 0) + b * (next[i] ?? 0);
        }
      }
    }
  };

  /** 陸面積重み付き平均 |ΔP|(mm/月) — 結合反復の収束指標 */
  const meanAbsChange = (a: Float32Array[], b: Float32Array[]): number => {
    let acc = 0;
    let wsum = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (!terrain.landMask[i]) continue;
        wsum += w;
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          acc += w * Math.abs((a[m]?.[i] ?? 0) - (b[m]?.[i] ?? 0));
        }
      }
    }
    return wsum > 0 ? acc / (wsum * MONTHS_PER_YEAR) : 0;
  };

  let supplies2: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) supplies2.push(new Float32Array(grid.cellCount));

  // 初期推定: 海洋のみ供給 → 変換 → 後処理(演算子は反復内と同一)
  let precipEst: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    precipEst.push(
      tField && u && v ? monthlyConvert(m, blend(supplies1, m)) : new Float32Array(grid.cellCount),
    );
  }
  applyPostAdjust(precipEst);

  const soilOn = K.soilWaterCapacityMm > 0;
  const isLand = (i: number): boolean => terrain.landMask[i] === 1;
  const soilAccel = soilOn ? (opts?.accel?.soilWater(grid.cellCount) ?? null) : null;
  // 収束予算(省略時はこの段の既定定数 = 確定品質)
  const bSoilSpinupYears = opts?.budget?.soilSpinupYears ?? K.soilSpinupYears;
  const solveSoil = async (
    precip: Float32Array[],
    warmStart?: ArrayLike<number>,
  ): Promise<SoilWaterResult> => {
    if (soilAccel) {
      return soilAccel.run({
        landMask: terrain.landMask,
        precipByMonth: precip,
        tempByMonth: temperature.monthlyTemperatureC,
        capacityMm: K.soilWaterCapacityMm,
        petScaleMmPerMonth: K.soilPetScaleMmPerMonth,
        maxYears: bSoilSpinupYears,
        toleranceMm: SOIL_SPINUP_TOLERANCE_MM,
        initialStorage: warmStart,
      });
    }
    return solveSoilWater(
      grid.cellCount,
      isLand,
      precip,
      temperature.monthlyTemperatureC,
      K.soilWaterCapacityMm,
      bSoilSpinupYears,
      0,
      warmStart,
    );
  };
  let iterations = 0;
  let residual = Number.POSITIVE_INFINITY;
  let converged = false;
  /** 結合反復の適応緩和(段 23)。1 = 素のピカール = 2026-08-15 までの挙動 */
  let couplingAlpha = COUPLING_OVERRIDE.relaxation > 0 ? COUPLING_OVERRIDE.relaxation : 1;
  let prevCouplingResidual = Number.POSITIVE_INFINITY;
  /** Anderson 加速(段 24)。深さ 0(既定)なら null = 従来経路 */
  const anderson =
    COUPLING_ANDERSON.depth > 0
      ? new AndersonAccelerator(COUPLING_ANDERSON.depth, COUPLING_ANDERSON.regularization)
      : null;
  /** 最後に走った結合反復の因子分解(診断を採る実行でのみ埋まる) */
  let lastDiagMonths: PrecipDiagMonth[] | null = null;
  const couplingMax =
    COUPLING_OVERRIDE.maxIterations > 0
      ? COUPLING_OVERRIDE.maxIterations
      : (opts?.budget?.precipCouplingIterations ?? COUPLING_MAX_ITERATIONS);
  for (let it = 1; it <= couplingMax; it++) {
    iterations = it;
    // 結合反復 1 回は風上追跡 12 か月ぶん(実測で降水の主費用)。
    // 反復の境目で中断を見て、制御をイベントループへ返す
    throwIfCancelled(opts?.signal, '降水');
    opts?.progress?.({
      fraction: (it - 1) / couplingMax,
      detail: `降水の結合反復 ${it}/${couplingMax}`,
    });
    await yieldToEventLoop();
    if (soilOn) {
      // 結合反復のウォームスタート(前反復の 12 月末貯水)。周期定常への
      // 収束判定は同じなので解は許容差内で同一、空回し年数だけ減る
      soil = await solveSoil(precipEst, soil?.storageMm[MONTHS_PER_YEAR - 1]);
    }
    const landSources: Float32Array[] = [];
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const landSource = new Float32Array(grid.cellCount);
      landSources.push(landSource);
      const etM = soil?.actualEtMm[m];
      for (let i = 0; i < grid.cellCount; i++) {
        if (!terrain.landMask[i]) continue;
        // 大気への水蒸気供給は実蒸発散(質量フラックス)に比例させ、20°C 基準の
        // 可能蒸発散で無次元化する(旧: 当月降水 / 40mm)。
        // 湿り度分数 S/容量 での正規化も試したが、暑く湿った熱帯で実蒸発散が
        // 可能蒸発散に近づく効果が落ちて全指標が悪化した(2026-07-31 実測:
        // 容量 300mm で詳細 43.47→42.61、アマゾン最乾 68→57mm)。
        // 供給は「フラックス」であって「湿り具合」ではない
        const wetness = soilOn
          ? Math.min(1, (etM?.[i] ?? 0) / K.soilPetScaleMmPerMonth)
          : Math.min(1, (precipEst[m]?.[i] ?? 0) / 40);
        landSource[i] = K.landRecyclingStrength * wetness;
      }
    }
    supplies2 = await traceAllMonths(landSources);
    const next: Float32Array[] = [];
    // 因子分解の診断は**この反復の**変換で捕まえる。収束後に別途走らせ直すと、
    // 保存型では輸送の初期値(温間開始)が変わって最終場と厳密には一致しない。
    // 「最終 = 後処理前 + 後処理差分」は厳密に成り立たなければならない不変量
    if (diag) lastDiagMonths = [];
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const dm = lastDiagMonths ? newDiagMonth(grid.cellCount) : undefined;
      next.push(monthlyConvert(m, blend(supplies2, m), dm));
      if (lastDiagMonths && dm) lastDiagMonths.push(dm);
    }
    applyPostAdjust(next);
    // 残差は**緩和の前**で測る。収束判定は不動点への近さ `F(x) − x` であって
    // 「今回どれだけ動かしたか」ではない。緩和を入れても判定の意味を変えない
    residual = meanAbsChange(next, precipEst);
    // ---- 適応緩和(2026-08-15、段 23)----
    //
    // 結合反復は段 6 以来**素のピカール** `P(k+1) = F(P(k))` だった。
    // 通常の地球は縮小比 0.55 で 8 回で抜けるので困らないが、
    // CRH の指数抑制を入れると比が 1 へ近づき、やがて 2 周期の振動に落ちる
    // (docs/実験記録_凝結率の幅の再測定_2026-08-14.md)。
    //
    // 段 21 は「緩慢には緩和が逆効果、停滞には効く。単一の α では救えない」と
    // 見て実装を見送った。**前提は正しいが、単一の α しか見ていなかった。**
    // virga の外側反復でまったく同じ混在に当たり、**適応緩和で解けることを
    // 実測した**(固定 0.6 で 78/204、固定 1.0 で 184/204、適応で 204/204)。
    //
    // α = 1 から始め、残差が増えた回だけ半減(下限 0.1)、減った回は 1 へ戻す。
    // 緩慢な区間は α = 1 のままで速く、振動した回だけ絞る。
    //
    // **緩和は不動点を変えない**ので物理の変更ではなく解き方の変更である。
    // 地球は残差が単調に減るので α は 1 のまま = 現行と厳密に一致する
    // (事前登録の判定 1。動いたらそれ自体が発見なので即座に棄却する)。
    // ---- Anderson 加速(段 24)----
    // 深さ 0(既定)では 1 命令も走らず、下の緩和経路がそのまま使われる。
    // **加速は不動点を変えない**ので物理の変更ではなく解き方の変更である。
    if (anderson) {
      const cells = grid.cellCount;
      const flatX = new Float64Array(MONTHS_PER_YEAR * cells);
      const flatF = new Float64Array(MONTHS_PER_YEAR * cells);
      // **緩和と加速は併用できる**(段 21 が「両方が要る」と書いた形)。
      // 緩和つきピカール `F_α(x) = x + α(F(x) − x)` を新しい写像とみなして
      // Anderson を当てる。α は不動点を変えないので、答えは変わらない。
      //
      // 2026-08-15 の実測で、結合反復の写像は**2 周期の構造**を持つと分かった
      // (Anderson の深さ 1 でも 3 でも残差が偶奇 2 系列に分裂する)。
      // 2 周期には α ≈ 0.5 が効き(固有値 −1 を 0 へ写す)、
      // その裏に残る緩慢な成分に Anderson が効く、というのが段 21 の見立て。
      const accelAlpha = COUPLING_OVERRIDE.relaxation > 0 ? COUPLING_OVERRIDE.relaxation : 1;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const p = precipEst[m];
        const n2 = next[m];
        if (!p || !n2) continue;
        const base = m * cells;
        for (let i = 0; i < cells; i++) {
          flatX[base + i] = p[i] ?? 0;
          flatF[base + i] = accelAlpha * ((n2[i] ?? 0) - (p[i] ?? 0));
        }
      }
      anderson.next(flatX, flatF);
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const p = precipEst[m];
        if (!p) continue;
        const base = m * cells;
        // **降水は負になれない。** 外挿は行き過ぎうるので床で受ける
        for (let i = 0; i < cells; i++) p[i] = Math.max(0, flatX[base + i] ?? 0);
      }
    } else if (couplingAlpha >= 1) {
      precipEst = next;
    } else {
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const p = precipEst[m];
        const n = next[m];
        if (!p || !n) continue;
        for (let i = 0; i < p.length; i++) p[i] = (p[i] ?? 0) + couplingAlpha * ((n[i] ?? 0) - (p[i] ?? 0));
      }
    }
    if (COUPLING_OVERRIDE.relaxation > 0) {
      couplingAlpha = COUPLING_OVERRIDE.relaxation;
    } else {
      couplingAlpha =
        residual > prevCouplingResidual
          ? Math.max(0.1, couplingAlpha * 0.5)
          : Math.min(1, couplingAlpha * 1.5);
    }
    prevCouplingResidual = residual;
    // 反復ごとの降水場を表示へ流す。**複製して渡す** — precipEst は次の反復で
    // 読み続ける生の作業配列なので、そのまま渡して転送されると計算が壊れる
    opts?.progress?.({
      fraction: it / couplingMax,
      detail: `降水の結合反復 ${it}/${couplingMax}(残差 ${residual.toFixed(2)} mm/月)`,
      partial: {
        precipitation: buildPrecipitationResult(precipEst, grid.cellCount, {
          iterations: it,
          maxIterations: couplingMax,
          toleranceMmPerMonth: COUPLING_TOLERANCE_MM_PER_MONTH,
          finalResidualMmPerMonth: residual,
          converged: residual <= COUPLING_TOLERANCE_MM_PER_MONTH,
        }),
      },
    });
    if (residual <= COUPLING_TOLERANCE_MM_PER_MONTH) {
      converged = true;
      break;
    }
  }
  // 最終の土壌診断は収束後の最終降水場で解き直す(返す ET・流出・貯水が
  // 最終降水と同じ周期解になり、統合水収支が閉じる)
  if (soilOn) {
    soil = await solveSoil(precipEst);
  }
  if (diagOut && soil) diagOut.soil = soil;
  const coupling: PrecipCouplingDiagnostics = {
    iterations,
    maxIterations: couplingMax,
    toleranceMmPerMonth: COUPLING_TOLERANCE_MM_PER_MONTH,
    finalResidualMmPerMonth: residual,
    converged,
  };

  for (let m = 0; m < MONTHS_PER_YEAR; m++) monthlyPrecipMm.push(precipEst[m]!);

  // R1 診断: **最後の結合反復で捕まえた**因子分解をそのまま返す。
  //
  // 以前はここで収束後の供給から convertToPrecip を走らせ直していたが、
  // それには 2 つの誤りがあった:
  //   1. 保存型が既定になった後も**旧(非保存)の演算子**を呼んでいたので、
  //      実際に走ったのと別のモデルの因子分解を報告していた(段 6 以降ずっと)
  //   2. 走らせ直すと輸送の温間開始が変わり、最終場と厳密には一致しない
  // 不変量「最終 = 後処理前 + 後処理差分」を厳密に保つには、反復の中で
  // 捕まえるほかない(tests/unit/sim/precip_diag.test.ts が門になっている)
  if (diag) {
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const N = grid.cellCount;
      const diagM = lastDiagMonths?.[m] ?? newDiagMonth(N);
      // 海洋由来 = 海のみトレース(パス 1)、陸面再循環由来 = 全供給 − 海のみ
      const supply2 = blend(supplies2, m);
      const supply1b = blend(supplies1, m);
      const so = new Float32Array(N);
      const sl = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        so[i] = supply1b[i] ?? 0;
        sl[i] = (supply2[i] ?? 0) - (supply1b[i] ?? 0);
      }
      diag.supplyOcean.push(so);
      diag.supplyLand.push(sl);
      diag.supplyStorm.push(diagM.supplyStorm);
      diag.liftItcz.push(diagM.liftItcz);
      diag.liftFrontal.push(diagM.liftFrontal);
      diag.liftOrographic.push(diagM.liftOrographic);
      diag.liftConvergence.push(diagM.liftConvergence);
      diag.convergenceIndex.push(diagM.convergenceIndex);
      diag.subsidenceResidual.push(diagM.subsidenceResidual);
      diag.subsDescW.push(diagM.subsDescW);
      diag.subsItczProt.push(diagM.subsItczProt);
      diag.subsEastRel.push(diagM.subsEastRel);
      diag.subsConvRel.push(diagM.subsConvRel);
      diag.upwindBlock.push(diagM.upwindBlock);
      diag.liftOther.push(diagM.liftOther);
      diag.crhSuppression.push(diagM.crhSuppression);
      if (K.conservativeMoisture > 0) {
        diag.condRateG.push(diagM.condRateG);
        diag.waterMm.push(diagM.waterMm);
      }
      diag.preAdjustMm.push(diagM.preAdjustMm);
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const arr = monthlyPrecipMm[m];
    if (!arr) continue;
    for (let i = 0; i < grid.cellCount; i++) {
      annualPrecipMm[i] = (annualPrecipMm[i] ?? 0) + (arr[i] ?? 0);
    }
  }
  // R1 診断: 後処理差分(最終 − 変換直後)。全セルで 最終 = pre + delta が成立
  if (diag) {
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const N = grid.cellCount;
      const delta = new Float32Array(N);
      const fin = monthlyPrecipMm[m];
      const pre = diag.preAdjustMm[m];
      for (let i = 0; i < N; i++) {
        delta[i] = (fin?.[i] ?? 0) - (pre?.[i] ?? 0);
      }
      diag.postAdjustDeltaMm.push(delta);
    }
  }
  // 陸面の水の状態を返す(気温の 2 パス目が潜熱と熱容量に使う)。
  // 渡す soil は最終降水で解き直した周期解で、以後書き換えられないので複製しない
  const land = soil
    ? { monthlyEtMm: soil.actualEtMm, monthlyWetness01: soil.wetness01 }
    : undefined;
  return {
    monthlyPrecipMm,
    annualPrecipMm,
    coupling,
    ...(land ? { land } : {}),
    ...(soil
      ? {
          soil: {
            converged: soil.converged,
            spinupYears: soil.spinupYears,
            meanAnnualStorageDriftMm: soil.meanAnnualStorageDriftMm,
            maxAnnualStorageDriftMm: soil.maxAnnualStorageDriftMm,
          },
        }
      : {}),
    ...(K.conservativeMoisture > 0
      ? {
          transport: {
            nonConvergedSolves: CONSERVATIVE_STATS.nonConverged,
            worstResidual: CONSERVATIVE_STATS.worstResidual,
            maxIterations: TRANSPORT_MAX_ITERATIONS,
          },
        }
      : {}),
  };
}

/**
 * 遮蔽・脱水に使う稜線標高。
 *
 * R5(地域降水 FB §9、2026-08-01): 生の高解像度標高(ETOPO 60 秒)から作った
 * **セル内 p95 標高**(terrain.crestElevationMeters)を第一候補とする。
 * 実測: 南部アンデスは平均 989m に対し p95 1,734m(1.75 倍)、チベット高原は
 * 4,914m → 5,277m(1.07 倍)、アマゾン平地は 33m → 43m。狭い山脈だけが跳ね、
 * 広い高原の縁を誤って狭い山脈と判定しない。
 *
 * 高解像度データの無い地形(手続き生成・簡易プリセット)では平均標高と同じ値に
 * なるため、隣接との比高(プロミネンス)による推定を加算で補う
 * (K.crestProminenceFactor。既定 0 = 無効 — 高原の縁と区別できず熱帯を壊した
 * 実測があるため)。演算子は全惑星で同一で、入力データの精細さだけが違う。
 */
export function buildCrestElev(ctx: SimContext): Float32Array {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const e = Math.max(0, terrain.elevationMeters[i] ?? 0);
      const dataCrest = Math.max(e, terrain.crestElevationMeters[i] ?? 0);
      let minNb = e;
      const nbs = [
        row > 0 ? (row - 1) * W + col : -1,
        row < H - 1 ? (row + 1) * W + col : -1,
        row * W + ((col + 1) % W),
        row * W + ((col + W - 1) % W),
      ];
      for (const nb of nbs) {
        if (nb < 0) continue;
        const en = Math.max(0, terrain.elevationMeters[nb] ?? 0);
        if (en < minNb) minNb = en;
      }
      // セル内分位で足りない分だけプロミネンス推定で補う(二重計上しない)
      const prominence = K.crestProminenceFactor * Math.max(0, e - minNb);
      out[i] = Math.max(dataCrest, e + prominence);
    }
  }
  return out;
}

/**
 * 閉じた内海・湖(面積 < 1.2M km² の海成分)のマスク。Fetch 則の対象。
 * 海峡で外洋に繋がる縁辺海(地中海など)は外洋と同成分になり対象外。
 */
export function buildSmallWaterMask(ctx: SimContext): Uint8Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const label = new Int32Array(grid.cellCount).fill(-1);
  const mask = new Uint8Array(grid.cellCount);
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  let next = 0;
  const stack: number[] = [];
  for (let seed = 0; seed < grid.cellCount; seed++) {
    if (terrain.landMask[seed] || (label[seed] ?? 0) >= 0) continue;
    const id = next++;
    let areaKm2 = 0;
    const cells: number[] = [];
    stack.push(seed);
    label[seed] = id;
    while (stack.length > 0) {
      const i = stack.pop();
      if (i === undefined) break;
      const row = Math.floor(i / W);
      const col = i % W;
      areaKm2 += cellWidthKm(grid, row, params.body.radiusKm) * dyKm;
      cells.push(i);
      const nbs = [
        row > 0 ? (row - 1) * W + col : -1,
        row < H - 1 ? (row + 1) * W + col : -1,
        row * W + ((col + 1) % W),
        row * W + ((col + W - 1) % W),
      ];
      for (const nb of nbs) {
        if (nb >= 0 && !terrain.landMask[nb] && (label[nb] ?? 0) < 0) {
          label[nb] = id;
          stack.push(nb);
        }
      }
    }
    if (areaKm2 < 1_200_000) {
      for (const i of cells) mask[i] = 1;
    }
  }
  return mask;
}

/**
 * 風上追跡による水蒸気供給量(無次元)。各セルから風を遡り、
 * 海セルで q_sat(SST) に比例した蒸発を拾い、距離減衰で持ち込む。
 * landSource ≠ null のとき陸セルも(局所降水に応じて)供給源になる。
 * 閉じた内海(smallWater)からの供給は Fetch 則で内陸到達を制限する。
 */
export function traceMoistureSupply(
  ctx: SimContext,
  smallWater: Uint8Array,
  crestElev: Float32Array,
  tField: Float32Array,
  u: Float32Array,
  v: Float32Array,
  landSource: Float32Array | null,
  rotRad: number,
): Float32Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  const q0 = saturationVaporPressureHpa(20); // 規格化基準(20°C の海面)

  for (let row = 0; row < H; row++) {
    const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
    for (let col = 0; col < W; col++) {
      const i0 = row * W + col;
      // 現在位置(セル座標、浮動小数)
      let fr = row + 0.5;
      let fc = col + 0.5;
      let traveledKm = 0;
      let attenuation = 1;
      let supply = 0;
      // 供給は経路の線積分(ステップ距離で重み付け。解像度に依存させない。
      // 基準は 1° の南北セル寸法 ≈ 111km)。ステップ数上限も距離基準
      const stepWeight = dyKm / 111;
      const maxSteps = Math.min(200, Math.ceil(K.moistureTraceMaxKm / dyKm) + 4);
      // Fetch 則(WL#32): 閉じた内海・湖の湿潤は「水域の風上幅(Fetch)」まで
      // しか内陸へ届かない。外洋(縁辺海含む)は対象外 — 到達は減衰長が決める。
      // 内海ごとに供給を保留し、横断幅が確定した時点でゲートを掛けて計上する。
      let landKmFromTarget = 0; // 対象セルからこれまでに歩いた陸の距離
      let inWater = false; // いま「内海」を横断中か(外洋は含めない)
      let bodyFetchKm = 0; // いま横断中の内海の幅
      let bodyLandAtEntry = 0; // その内海に入る手前までの陸距離
      let pendingSupply = 0; // その内海からの保留供給
      const commitBody = () => {
        if (pendingSupply > 0) {
          // Fetch を超えた先も完全遮断はしない(下限 0.12)— 黒海・バルト海は
          // 遠方にも幾らか湿潤を送る。0.3 ではペルシャ湾型(q_sat が巨大な熱い
          // 内海)の漏れが大きすぎ、アラビア内陸が Aw 化した(2026-07-31)
          const reach = Math.min(bodyFetchKm, K.fetchOpenOceanCapKm);
          const f = Math.min(1, Math.max(0.12, (reach + 250 - bodyLandAtEntry) / 500));
          supply += pendingSupply * f;
        }
        pendingSupply = 0;
        bodyFetchKm = 0;
      };
      // 自セルが海なら足元の蒸発をまず拾う。
      // 経路障壁の脱水(2026-07-30 レビュー P1): 供給源と対象の間の最高障壁を
      // 越える際、障壁が両端より高い分だけ水蒸気が風上斜面の雨として失われる。
      // 逐次の複利にすると丘陵の起伏が累積して全球が乾く(実測)ため、
      // 「これまでの最高標高」1 本で判定する
      const targetElev = Math.max(0, terrain.elevationMeters[i0] ?? 0);
      let maxBarrierM = targetElev;
      for (let step = 0; step < maxSteps; step++) {
        const r = Math.min(H - 1, Math.max(0, Math.floor(fr)));
        const c = wrapCol(grid, Math.floor(fc));
        const i = r * W + c;
        const eHere = Math.max(0, terrain.elevationMeters[i] ?? 0);
        // 障壁は稜線推定標高で判定(狭い山脈が 1° 平均で均される問題への対策)
        const crestHere = crestElev[i] ?? eHere;
        if (crestHere > maxBarrierM) maxBarrierM = crestHere;
        const barrierOver = Math.max(0, maxBarrierM - Math.max(eHere, targetElev));
        const barrierFactor = Math.max(0.25, Math.exp(-barrierOver / K.orographicDepletionM));
        const tHere = tField[i] ?? 0;
        const qRel = (saturationVaporPressureHpa(tHere) / q0) * barrierFactor;
        if (!terrain.landMask[i]) {
          if (smallWater[i]) {
            if (!inWater) {
              inWater = true;
              bodyLandAtEntry = landKmFromTarget;
              bodyFetchKm = 0;
              pendingSupply = 0;
            }
            pendingSupply += attenuation * qRel * stepWeight;
          } else {
            if (inWater) {
              inWater = false;
              commitBody();
            }
            supply += attenuation * qRel * stepWeight;
          }
        } else {
          if (inWater) {
            inWater = false;
            commitBody();
          }
          if (landSource) {
            supply += attenuation * qRel * (landSource[i] ?? 0) * stepWeight;
          }
        }
        if (traveledKm >= K.moistureTraceMaxKm) break;
        // 風上へ 1 セルぶん移動(風が弱い所は打ち切り)。rotRad で方位を振る
        const u0 = u[i] ?? 0;
        const v0 = v[i] ?? 0;
        const cosR = Math.cos(rotRad);
        const sinR = Math.sin(rotRad);
        const uu = u0 * cosR - v0 * sinR;
        const vv = u0 * sinR + v0 * cosR;
        const speed = Math.hypot(uu, vv);
        if (speed < 0.5) break;
        const stepKm = dyKm; // 1 ステップ = 南北 1 セル相当の距離
        const dcCells = (-uu / speed) * (stepKm / dxKm);
        const drCells = (vv / speed) * (stepKm / dyKm); // 北向き風 → 南から来た(row 増加方向)
        fc += dcCells;
        fr += drCells;
        if (fr < 0 || fr >= H) break;
        traveledKm += stepKm;
        if (terrain.landMask[i]) landKmFromTarget += stepKm;
        else if (smallWater[i]) bodyFetchKm += stepKm;
        const decayKm = terrain.landMask[i] ? K.moistureDecayLandKm : K.moistureDecayOceanKm;
        attenuation *= Math.exp(-stepKm / decayKm);
        if (attenuation < 0.02) break;
      }
      if (inWater) commitBody(); // 途中終了した水域の保留分を精算
      out[i0] = supply;
    }
  }
  return out;
}

/** 供給 × 持ち上げ × 抑制 → mm/月 */
function convertToPrecip(
  ctx: SimContext,
  itcz: ItczResult,
  month: number,
  tField: Float32Array,
  u: Float32Array,
  v: Float32Array,
  supply: Float32Array,
  ridgeN: number,
  ridgeS: number,
  pfN: number,
  pfS: number,
  dyKm: number,
  ocean: OceanCurrentResult,
  eastOceanKm: Float32Array,
  eastOceanSstA: Float32Array,
  /** 沈降の海盆非対称の幾何場(null = 機構 off。事前登録 2026-08-24) */
  basinAsymG: Float32Array | null,
  meanItczCenters: Float32Array,
  crestElev: Float32Array,
  /**
   * 近傍最冷 SST 偏差の事前計算([cell]、null なら都度計算)。
   * ocean.sstAnomalyC だけの関数で**月に依らない**のに、旧実装は月ごとに
   * 解き直していた(12 倍の無駄)。値は同じなので結果は変わらない
   */
  coldAnomalyCache: Float32Array | null,
  diagM?: PrecipDiagMonth,
  /**
   * **保存型の水収支で使う凝結率の係数 G**(与えたときだけ書く)。
   * 中身は「風上遮蔽 × 持上げ × CRH」の積で、現行の降水乗数と**同じもの**。
   * 意味だけが「降水の乗数」から「凝結率の係数」へ変わる。
   * 段階置換の段 1 ではここで 1 つも外さない
   * (docs/計画_保存則の段階的置換_2026-08-09.md)。
   */
  condRateOut?: Float32Array,
  /**
   * **前反復が解いた可降水量 W**(保存型のときだけ渡す)。
   * 前線の判定はこれまで `supply`(風上追跡で作った到達可能性の代理場)の
   * 南北勾配で行っていたが、保存型では実際の水は W である。
   * 段 6 の移行で置き忘れていた疑い。
   * 事前登録: docs/事前登録_前線の判定を保存量で_2026-08-11.md
   */
  waterMm?: Float32Array,
  /** [col] リッジの経度別の押し上げ量（度、段 16）。未指定なら帯状一様 */
  ridgeShiftByCol?: Float32Array,
  /**
   * **CRH の抑制倍率を別に返す口(段 25)**。渡すと `condRateOut` からは
   * CRH が外れる(`G_base`)ので、呼び出し側が輸送の内部で
   * 「W が更新されるたびに CRH を作り直す」ことができる。
   * 渡さなければ従来どおり G に畳み込まれる。
   */
  crhOut?: Float32Array,
  /**
   * **地形性上昇の倍率を別に返す口(段 28)**。渡すと `condRateOut` からは
   * 地形性上昇が外れるので、呼び出し側が面積平均で正規化してから掛け直せる。
   */
  oroOut?: Float32Array,
  /**
   * **ストーム混合の強さを返す口(段 36)**。
   * `supplyW × exp(−coastKm/decayKm)` の形で 0〜1。
   * 呼び出し側が拡散の場を作るのに使う(降水式には影響しない)。
   */
  stormMixOut?: Float32Array,
): Float32Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const elev = terrain.elevationMeters;
  // 段 46c: 冬ゲート(winterDepth01)の暦は独自の遅れを持てる。lag 0 では
  // monthlyDeclinationDeg[month] と厳密一致(円環補間が恒等になる)
  const decl = laggedDeclinationDegLocal(
    ctx.insolation.monthlyDeclinationDeg,
    month,
    K.winterGateLagMonths,
  );
  /** 供給の規格化基準(20°C の飽和水蒸気圧)。供給を作った側と同じ基準にする */
  const q0Local = saturationVaporPressureHpa(20);
  // 段 44: モンスーントラフの R-H 位相(経度列ごと)。既定 0 では計算ごと飛ぶ
  let troughPhase: Float64Array | null = null;
  const troughItczByCol = itcz.monthlyCenterLatDegByCol[month];
  if (K.monsoonTroughSubsRelief > 0) {
    const centers = troughItczByCol;
    const rowN30 = Math.max(0, Math.round((90 - 30) / grid.resolutionDeg) - 1);
    const rowS30 = Math.min(H - 1, Math.round((90 + 30) / grid.resolutionDeg));
    const hCol = new Float64Array(W);
    for (let col = 0; col < W; col++) {
      let n = 0;
      let nl = 0;
      for (let row = rowN30; row <= rowS30; row++) {
        n++;
        if (terrain.landMask[row * W + col]) nl++;
      }
      const frac = n > 0 ? nl / n : 0;
      const itczLat = centers?.[col] ?? 0;
      // 定数を参照する(15 と 0.3 のリテラル複製は隠しパラメータ —
      // 2026-08-17 の棚卸しで指摘され即日修正。値は同じなのでビット一致)
      const disp = Math.min(1, Math.abs(itczLat) / K.crossEquatorialRefDeg);
      hCol[col] = disp * Math.min(1, frac / K.monsoonLandFracRef);
    }
    // 東方(自転方向)5〜60° の加熱の距離減衰つき最大。
    // R-H: 加熱の西側に下降 → 東に強い加熱があるほど緩和を許さない
    const degPerCol = 360 / W;
    const dirE = params.body.rotationDirection >= 0 ? 1 : -1;
    const minD = Math.max(1, Math.round(5 / degPerCol));
    const maxD = Math.round(60 / degPerCol);
    troughPhase = new Float64Array(W);
    for (let col = 0; col < W; col++) {
      let eastH = 0;
      for (let dd = minD; dd <= maxD; dd++) {
        const c2 = (((col + dirE * dd) % W) + W) % W;
        eastH = Math.max(eastH, (hCol[c2] ?? 0) * Math.exp(-(dd * degPerCol) / 30));
      }
      troughPhase[col] = Math.min(
        1,
        Math.max(0, ((hCol[col] ?? 0) - eastH) / K.monsoonHeatContrastNorm),
      );
    }
  }

  // R4: 水蒸気フラックス収束(供給場と地表風から。診断時は生の場も返す)
  const convergenceOn =
    K.convergenceLiftBoost > 0 || K.convergenceSubsidenceRelief > 0 || diagM !== undefined;
  const convIndex = convergenceOn
    ? moistureConvergenceIndex(grid, params.body.radiusKm, supply, u, v)
    : null;

  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
    const ridgeZonal = lat >= 0 ? ridgeN : ridgeS;
    const pf = lat >= 0 ? pfN : pfS;
    // 冬の深さ(0〜1、至点で最大)。二値の寒候期ブーストは秋分直後から全開に
    // なり 10 月にスパイクを作る(秋こぶ — 西シベリア Dsa の源)。初回試験は
    // −0.3 で撤回したが、床・再循環の再較正後に再試験して採用(詳細 +0.6、
    // europe_russia が Df 首位に。2026-07-31)
    const winterDepth01 = Math.min(
      1,
      Math.max(0, (lat >= 0 ? -decl : decl) / Math.max(1e-6, ctx.params.body.axialTiltDeg)),
    );
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      let lift = 1;

      // リッジは経度で動く(段 16)。沈降帯・前線の窓・ストーム帯がすべて
      // これを見ているので、東アジアが夏に沈降帯から外れるかどうかを決める。
      // 押し上げ量 0 のときは従来と厳密に一致
      const ridge =
        ridgeZonal + (lat >= 0 ? 1 : -1) * (ridgeShiftByCol?.[col] ?? 0);

      // ITCZ 収束。傘は「湿潤収束が海洋起源のときだけ開く」— 供給の乏しい
      // 乾燥内陸ではトラフ直下でも雨にならない(実物のアラビア熱低は乾いた
      // 低気圧 — 2026-07-30 レビュー A1)
      const gIm = itczInfluenceAt(itcz, month, col, lat, K.itczPrecipWidthFactor);
      // 赤道常湿帯: 年平均 ITCZ 線の周りは月別中心が離れた季節でも影響が残る
      const dMean = (lat - (meanItczCenters[col] ?? 0)) / (itcz.halfWidthDeg * 0.55);
      const gIres = K.equatorialItczResidual * Math.exp(-dMean * dMean);
      const gI = Math.max(gIm, gIres);
      const marineW = Math.min(1, (supply[i] ?? 0) / K.itczLiftSupplyNorm);
      // R1 診断のため各倍率を named 化(乗算の順序・値は従来と同一 — ビット不変)
      const liftItczF = 1 + K.itczLiftBoost * gI * marineW;
      lift *= liftItczF;

      // R4: 湿潤収束 = 飽和した収束強度 × 湿潤ゲート(smoothstep)。
      // 乾いた収束(供給の乏しい低圧)では 0 のまま
      const wetConv = convIndex
        ? convergenceStrength01(convIndex[i] ?? 0, K.moistureConvergenceNorm) *
          wetnessGate01(supply[i] ?? 0, K.convergenceWetnessNorm)
        : 0;
      const liftConvF = 1 + K.convergenceLiftBoost * wetConv;
      lift *= liftConvF;

      // 前線収束(WL#29「セル衝突線 = 前線(低圧・湿潤)」の定量化):
      // 湿った空気(高供給)が極向き風で乾いた側へ押し込まれる場所が前線。
      // ITCZ 傘とストーム帯の間(≈25-40°)の梅雨・バイウ前線の空白を埋める
      let liftFrontalF = 1;
      {
        const north2 = row > 0 ? (row - 1) * W + col : i;
        const south2 = row < H - 1 ? (row + 1) * W + col : i;
        const eqNb = lat >= 0 ? south2 : north2;
        const polNb = lat >= 0 ? north2 : south2;
        // **何の勾配で前線を判定するか。** 既定は従来どおり供給の代理場だが、
        // 保存型では実際の水は W(輸送が解いた可降水量)である。
        // 代理場は風上追跡の到達可能性でしかなく、東アジアでは
        // 東から +1139mm/年 の水が入っているのに勾配が 0.103 しか立たない
        // (docs/実験記録_前線の窓_2026-08-11.md)
        const gField = K.frontalGradientUsesWater > 0 && waterMm ? waterMm : supply;
        const gScale =
          K.frontalGradientUsesWater > 0 && waterMm ? K.frontalWaterGradientNorm : 1;
        const gradPoleward = Math.max(
          0,
          ((gField[eqNb] ?? 0) - (gField[polNb] ?? 0)) / gScale,
        );
        const vPoleward = lat >= 0 ? (v[i] ?? 0) : -(v[i] ?? 0);
        const aLat0 = Math.abs(lat);
        if (
          vPoleward > 0 &&
          gradPoleward > 0 &&
          aLat0 > Math.abs(ridge) - K.frontalWindowEquatorwardDeg &&
          aLat0 < Math.abs(pf)
        ) {
          const frontW = Math.min(1.5, (vPoleward / 4) * gradPoleward);
          liftFrontalF = 1 + K.frontalLiftBoost * frontW;
          lift *= liftFrontalF;
        }
      }

      // ストームトラック(リッジの極側〜極前線先の台形プラトー、寒候期に増強)
      // v33 件 1(2026-08-23): **冬だけストーム帯が赤道側へ張り出す。**
      // 実物の地中海型は「冬に高気圧が退いてストームトラックの南縁が届く」で
      // 成立するが、モデルの帯は常にリッジ+4°から始まるため亜熱帯へ決して
      // 届かず、亜熱帯の冬雨の G が平坦(振幅 0.10)だった(2026-08-18 の分解)。
      // 既定 0 でビット一致。事前登録: docs/事前登録_亜熱帯の冬雨機構_2026-08-23.md
      const stLo =
        Math.abs(ridge) + 4 - K.winterStormEquatorwardReachDeg * winterDepth01;
      const stHi = Math.abs(pf) + 12;
      const aLat = Math.abs(lat);
      let stormW = 0;
      let liftStormF = 1;
      if (aLat > stLo && aLat < stHi) {
        const riseW = Math.min(1, (aLat - stLo) / 5);
        const fallW = Math.min(1, (stHi - aLat) / 10);
        stormW = Math.min(riseW, fallW);
        liftStormF =
          1 + (K.stormTrackBoost + K.stormTrackWinterBoost * 1.4 * winterDepth01) * stormW;
        lift *= liftStormF;
      }

      // 地形性上昇 / 局所雨陰(風と標高勾配の内積)
      const east = row * W + wrapCol(grid, col + 1);
      const west = row * W + wrapCol(grid, col - 1);
      const north = row > 0 ? (row - 1) * W + col : i;
      const south = row < H - 1 ? (row + 1) * W + col : i;
      // **気流は峰を越えるのであって、セルの平均標高を越えるのではない。**
      // 1° 平均ではパタゴニアのアンデスが実際の峰の 6 割の高さになる
      // (平均 718m / セル内 p95 1187m — scripts/diag_crest_vs_mean.ts)。
      // 平均で作った勾配では風上で水を絞り切れず、保存則からの雨陰が出ない。
      // 既定 0 = 従来と厳密に一致。**峰の場は気温には使わない**(用途で分ける)
      const liftElev = (n: number): number => {
        const m = Math.max(0, elev[n] ?? 0);
        // **海セルには峰を立てない。** セル内 p95 は 1° の海セルに含まれる
        // 小島を拾うので、1541 セルで峰 > 50m、最大 2465m ある
        // (scripts/check_crest_field.ts)。そのまま混ぜると海の真ん中に
        // 2.5km の山が生えて偽の地形性上昇と雨陰が出る。
        // 海として扱っているセルに総観規模の障壁を置くのは筋が通らない
        if (K.orographicCrestBlend <= 0 || !terrain.landMask[n]) return m;
        const c = Math.max(m, crestElev[n] ?? 0);
        return m + K.orographicCrestBlend * (c - m);
      };
      const dhdx = (liftElev(east) - liftElev(west)) / (2 * dxKm);
      const dhdy = (liftElev(north) - liftElev(south)) / (2 * dyKm);
      const uu = u[i] ?? 0;
      const vv = v[i] ?? 0;
      const upslopeMPerKmPerS = uu * dhdx + vv * dhdy; // m/km × m/s
      // 基準: 8 m/s × 100 m/km。**この 100 m/km は 1° 格子では作れない**
      // (2026-08-12 実測: パタゴニアのアンデスで 4.6 m/km、峰を使っても 7.6、
      //  チベットの峰でも 29.4)。比が 0.05 前後にしかならないので、
      // 地形性上昇は 5% の効果しか持たず、上限 2.5 には遠く及ばない。
      // **格子の粗さが機構を殺している**ので、基準を定数にして測る
      const refSlope = K.orographicRefSlope;
      let liftOroF = 1;
      if (upslopeMPerKmPerS > 0) {
        liftOroF = 1 + K.orographicBoost * Math.min(2.5, upslopeMPerKmPerS / refSlope);
        lift *= liftOroF;
      } else if (upslopeMPerKmPerS < 0) {
        const shadow = Math.min(1, -upslopeMPerKmPerS / refSlope);
        liftOroF = 1 - (1 - K.rainShadowFloor) * shadow;
        lift *= liftOroF;
      }

      // 風上山脈の遮蔽(広域雨陰): 風上へ遡って自セルより十分高い稜線があれば
      // 水蒸気の到達そのものを減衰させる(パタゴニア型の乾燥帯の根本機構)
      const blockFactor = upwindMountainFactor(ctx, elev, crestElev, u, v, row, col, dxKm, dyKm);

      // 亜熱帯沈降: 下降枝の全域(リッジ −16° 〜 +5°)を抑制。ITCZ 影響下は防護
      // 赤道側の広がり。**16 は名前を持たない数だった**(2026-08-13 に命名)。
      // 21° 幅あるので 7 月のリッジ 37°N に対し帯は 21〜42°N となり、
      // east_asia(25〜40°N)が丸ごと入る。凝結率が半減する原因
      const descLo = Math.abs(ridge) - K.subsidenceBandEquatorwardDeg;
      const descHi = Math.abs(ridge) + 5;
      let descW: number;
      if (aLat >= descLo && aLat <= descHi) {
        descW = 1;
      } else {
        const d = aLat < descLo ? descLo - aLat : aLat - descHi;
        descW = Math.exp(-(d * d) / 16);
      }
      // 沈降の海盆非対称(2026-08-24、事前登録_沈降の海盆非対称): 帯を
      // 海盆西部で開く(源泉側)。陸は供給実績ゲート付き(アラビアの守り)
      if (basinAsymG) {
        const gB = basinAsymG[i] ?? 0;
        if (gB > 0) {
          const supplyGateB = terrain.landMask[i]
            ? Math.min(1, (supply[i] ?? 0) / K.eastReliefSupplyNorm)
            : 1;
          descW *= 1 - K.subsidenceBasinAsymmetry * gB * supplyGateB;
        }
      }
      // 注(2026-07-31): 沈降の気圧場駆動(高圧下で増強/湿潤低圧下で緩和)は
      // 両方向とも実測否定 — 増強はリッジ帯自体が +6hPa で飽和して一様乾燥化
      // (−1.4pt)、湿潤側緩和はトラフを開けすぎ(−2.1pt、ゲート −1)。
      // B 帯の縁の緯度直線性は Log の手法自体が「帯として描く」ものでもある
      // (較正記録参照)。
      // 亜熱帯高気圧の西翼(自転方向の東に海が近い)では沈降が緩む。
      // 条件は 2 つ: (a) 東の海が暖流(SST 正偏差 — バミューダ/黒潮型)、
      // (b) その海から実際に湿潤が届いている(供給実績 — アラビア海のように
      // 「暖かいが乾いた流入」の海を自動除外する。2026-07-31: SST だけでは
      // アラビアと華中を区別できず、到達延長がアラビアを再湿潤化した)
      const eastWarmth = Math.min(1, Math.max(0, ((eastOceanSstA[i] ?? 0) + 0.6) / 1.2));
      const supplyGate = Math.min(1, (supply[i] ?? 0) / K.eastReliefSupplyNorm);
      const eastRelief =
        K.eastCoastSubsidenceRelief *
        eastWarmth *
        supplyGate *
        Math.exp(-(eastOceanKm[i] ?? 1e9) / K.eastCoastSubsidenceDecayKm);
      // R4: 湿潤収束があるところは沈降の実効抑制が連続的に弱まる
      // (緯度帯だけで全開にしない — 中国東部・ラプラタの梅雨/暖湿流)
      // 段 44: モンスーントラフの置換(陸のみ・夏半球側 = ITCZ と同符号の緯度)。
      // 湿りに依存しない(乾いた平衡の罠を避ける)。位相は R-H 規則で
      // アラビア型(東に強い加熱)を自動的に除外する
      let troughRelief = 0;
      if (troughPhase && terrain.landMask[i]) {
        const itczHere = troughItczByCol?.[col] ?? 0;
        if (lat * itczHere > 0) {
          troughRelief = K.monsoonTroughSubsRelief * (troughPhase[col] ?? 0);
        }
      }
      const subs =
        descW *
        (1 - K.subsidenceItczProtection * gI * marineW) *
        (1 - eastRelief) *
        (1 - K.convergenceSubsidenceRelief * wetConv) *
        (1 - troughRelief);
      const subsResidualF = 1 - K.subsidenceSuppression * subs;
      lift *= subsResidualF;

      // 寒流沿岸の安定化(亜熱帯〜中緯度の海岸乾燥: 沿岸〜300km。
      // フォークランド型の寒流帰還域まで含めるため上限 50°)
      let coldCoastF = 1;
      if (terrain.landMask[i] && aLat > 10 && aLat < 50) {
        const coastKm = ctx.landDistToCoastKm[i] ?? 1e9;
        if (coastKm < 300) {
          const cold = coldAnomalyCache
            ? (coldAnomalyCache[i] ?? 0)
            : nearestOceanAnomaly(ctx, ocean, row, col);
          if (cold < -0.8) {
            coldCoastF = 1 - K.coldCoastSuppression * Math.min(1, -cold / 2.5);
            lift *= coldCoastF;
          }
        }
      }

      // 高温湿潤の陸での対流性増幅(夏の東岸・熱帯の午後対流)。
      // 分母を 2.8 に上げて高供給の湿潤域だけ発火させる(1.2 では半乾燥内陸まで
      // 飽和して豪州が Aw 化した — 較正記録の撤回理由への対処。レビュー H5)
      let warmHumidF = 1;
      if (terrain.landMask[i]) {
        const warmth = Math.min(1, Math.max(0, ((tField[i] ?? 0) - 22) / 8));
        if (warmth > 0) {
          const supplyNorm = Math.min(1, (supply[i] ?? 0) / K.warmHumidSupplyNorm);
          warmHumidF = 1 + K.warmHumidConvectiveBoost * warmth * supplyNorm * supplyNorm;
          lift *= warmHumidF;
        }
      }

      // ストームトラック帯の渦供給: 移動性低気圧が近傍の海から水蒸気を混合する
      // (月平均風の追跡では表現できない成分。海岸距離で減衰、風上山脈で遮蔽)。
      // 供給帯はリッジ +1° から(持ち上げ帯 +4° より広く — 晩秋の東岸の断絶対策)。
      // 水蒸気量は局所の陸気温ではなく近傍で最も暖かい海面の気温を基準にする
      // (冬の東岸の低気圧は暖流から汲む — 湾流・黒潮型。レビュー H1)
      let stormSupply = 0;
      const stSupplyLo = Math.abs(ridge) + 1;
      if (aLat > stSupplyLo && aLat < stHi && terrain.landMask[i]) {
        const supplyW = Math.min(
          Math.min(1, (aLat - stSupplyLo) / 5),
          Math.min(1, (stHi - aLat) / 10),
        );
        const coastKm = ctx.landDistToCoastKm[i] ?? 1e9;
        const oceanT = nearestOceanTempC(ctx, tField, row, col);
        const qBaseT = oceanT !== null ? Math.max(oceanT, tField[i] ?? 0) : (tField[i] ?? 0);
        const qRel = Math.max(
          K.stormMinQRel,
          saturationVaporPressureHpa(qBaseT + 3) / saturationVaporPressureHpa(20),
        );
        // WL#31: 前線圏の湿気の到達は onshore 2,000km / offshore 1,000km。
        // 短い風上ウォーク(~500km)の海率で on/off を連続判定し減衰長に反映
        let oceanSteps = 0;
        {
          let fr = row + 0.5;
          let fc = col + 0.5;
          const uu2 = u[i] ?? 0;
          const vv2 = v[i] ?? 0;
          const sp = Math.max(0.5, Math.hypot(uu2, vv2));
          for (let s = 0; s < 5; s++) {
            fc -= (uu2 / sp) * (100 / dxKm);
            fr += (vv2 / sp) * (100 / dyKm);
            const rr = Math.min(H - 1, Math.max(0, Math.floor(fr)));
            const cc2 = wrapCol(grid, Math.floor(fc));
            if (!terrain.landMask[rr * W + cc2]) oceanSteps++;
          }
        }
        const onshore01 = oceanSteps / 5;
        const decayKm = K.stormMoistureDecayKm * (0.5 + 0.5 * onshore01);
        const reach = Math.exp(-coastKm / decayKm);
        stormSupply =
          K.stormMoistureSupply * supplyW * qRel * reach * (1 + 0.55 * winterDepth01);
        // **保存型はこの混合を「拡散の場」として受け取る(段 36)。**
        // 降水式には触らない — ここは非保存の経路のままである
        if (stormMixOut) stormMixOut[i] = supplyW * reach;
      }

      // ---- 柱相対湿度による指数的な抑制(2026-08-04)----
      // **「どれだけ水蒸気が届いたか」ではなく「その場の空気が持てる量に対して
      // どれだけか」で降water が決まる**。暑い砂漠は飽和水蒸気圧が巨大なので、
      // そこそこ供給があっても相対湿度は低く、雨にならない。
      //
      // 観測(Bretherton et al. 2004, J. Climate 17, 1517)では熱帯海上の降水は
      // 柱相対湿度 CRH に対して P ∝ exp(15.6·CRH) と**指数的**に応答し、
      // CRH ≈ 0.75 で点火して CRH = 0.5 では 2 桁落ちる。
      // このモデルの亜熱帯沈降の抑制は 0.86 という**線形の倍率**でしかなく、
      // 現実が指数のところを線形で扱っていた(2026-08-04 の診断: 観測 100mm/年
      // 未満の陸で沈降残存 0.864、6 月の降水が観測の 2.7 倍)。
      //
      // CRH の代理: supply は風上経路で拾った飽和水蒸気圧の線積分、つまり
      // **届いた絶対水蒸気量**。これを局所気温の飽和量で割れば相対湿度になる。
      // どちらもその惑星の気温場から出るので、地球固有の量は入らない。
      let crhFactor = 1;
      if (K.crhSuppressionSharpness > 0) {
        let crh: number;
        if (K.crhFromWater > 0 && waterMm) {
          // **保存型では柱相対湿度が厳密に計算できる。** W は輸送方程式の解、
          // W_sat は気温と気圧から決まる飽和柱水量。代理場も正規化定数も要らない
          // (`crhSupplyNormPerQSat` という自由度が 1 つ消える)。
          //
          // なぜ厳密な CRH が要るか(2026-08-13 の考察):
          //   P = λ·G·W なので λ と G の平均は互いに縮退している。意味を持つのは
          //   **G の空間的な幅**だけだが、モデルの G は 3.8 倍しか動かない
          //   (実物のコンゴ/サハラの降水比は 57 倍)。
          //   指数抑制 exp(s(crh−1)) は常に 1 以下なので、**幅を作りながら
          //   平均を自動的に下げる** — 段 19 の「平均だけ下げる」とは別物である。
          //
          //   独立の証拠: 全球平均の可降水量 W が 3.36mm（実物 25mm）しかない。
          //   W は採点にも目的関数にも入っていないので、較正では動かせない量
          const wSat = saturatedColumnMm(
            tField[i] ?? 0,
            params.atmosphere.surfacePressureBar * 1013.25,
          );
          crh = Math.min(1, (waterMm[i] ?? 0) / Math.max(1e-6, wSat));
        } else {
          const qSatLocal = saturationVaporPressureHpa(tField[i] ?? 0) / q0Local;
          crh = Math.min(
            1,
            (supply[i] ?? 0) / Math.max(1e-6, K.crhSupplyNormPerQSat * qSatLocal),
          );
        }
        crhFactor = Math.exp(K.crhSuppressionSharpness * (crh - 1));
      }

      // 供給 × 持ち上げ × 遮蔽 → mm/月(気圧が低い惑星は降水効率も下がる)
      const pressureFactor = Math.pow(Math.max(0.1, params.atmosphere.surfacePressureBar), 0.5);
      let precipMm = Math.max(
        0,
        ((supply[i] ?? 0) + stormSupply) *
          blockFactor *
          lift *
          crhFactor *
          K.precipScaleMmPerUnit *
          pressureFactor,
      );

      // ---- 雲底下での再蒸発(virga)----
      // 乾いた厚い境界層では、上空で凝結しても地面に届く前に蒸発する。
      // 英国気象庁の GCM で使われている形(Gregory 1995, Mon. Wea. Rev. 123, 2716):
      //   E = k · (1 − RH) · √P
      // 失われる**割合**は E/P = k(1−RH)/√P なので、**弱い雨ほど多く失われる**。
      // これは CRH の指数抑制とは別の軸で効く — 砂漠の降水は弱い雨が主体で、
      // そこを選択的に削る。中東で RegCM3 に導入した実測では年降水が最大 20%
      // 減り、湿潤バイアスが観測の 15% 以内へ収束した(Marcella & Eltahir 2008,
      // J. Climate 21, 2976)。乾燥地では雲底下で降水質量の 20〜50% が蒸発する。
      if (K.subCloudEvapCoef > 0 && precipMm > 0) {
        const qSatLocal = saturationVaporPressureHpa(tField[i] ?? 0) / q0Local;
        const rh = Math.min(
          1,
          (supply[i] ?? 0) / Math.max(1e-6, K.crhSupplyNormPerQSat * qSatLocal),
        );
        // √P の P は mm/月。係数が単位を吸収する(較正で決める)
        const lostFrac = Math.min(
          K.subCloudEvapMaxFrac,
          (K.subCloudEvapCoef * (1 - rh)) / Math.sqrt(precipMm),
        );
        precipMm *= 1 - lostFrac;
      }
      out[i] = precipMm;
      // **CRH を分けて返せるようにする(段 25)。**
      // `crhOut` を渡した呼び出しでは G から CRH を外し、CRH は別に返す。
      // こうすると輸送の内部で「W が更新されるたびに CRH を作り直す」ことができ、
      // `P = λ·G(W_{k−1})·W_k` という**1 段遅れの帰還**を外せる。
      // 遅延つき帰還は 2 周期振動を生む形で、実測の偶奇分裂と一致する
      // (docs/事前登録_CRHを輸送の内部で解く_2026-08-15.md)。
      //
      // **鋭さ 0 では crhFactor が恒等的に 1 なので、どちらでも同じ値になる。**
      if (condRateOut) condRateOut[i] = (blockFactor * lift * (crhOut ? 1 : crhFactor)) / (oroOut ? liftOroF : 1);
      if (crhOut) crhOut[i] = crhFactor;
      if (oroOut) oroOut[i] = liftOroF;
      if (diagM) {
        diagM.supplyStorm[i] = stormSupply;
        diagM.liftItcz[i] = liftItczF;
        diagM.liftFrontal[i] = liftFrontalF;
        diagM.liftOrographic[i] = liftOroF;
        diagM.liftConvergence[i] = liftConvF;
        diagM.convergenceIndex[i] = convIndex?.[i] ?? 0;
        diagM.subsidenceResidual[i] = subsResidualF;
        diagM.subsDescW[i] = descW;
        diagM.subsItczProt[i] = 1 - K.subsidenceItczProtection * gI * marineW;
        diagM.subsEastRel[i] = 1 - eastRelief;
        diagM.subsConvRel[i] = 1 - K.convergenceSubsidenceRelief * wetConv;
        diagM.upwindBlock[i] = blockFactor;
        diagM.liftOther[i] = liftStormF * coldCoastF * warmHumidF;
        diagM.crhSuppression[i] = crhFactor;
        diagM.preAdjustMm[i] = out[i] ?? 0;
      }
    }
  }
  return out;
}

/**
 * 風上山脈の遮蔽係数(0.3〜1)。風上へ K.upwindBlockScanKm まで遡り、
 * 経路上の最大標高が自セルより K.upwindBlockReliefM 以上高ければ遮蔽最大。
 */
function upwindMountainFactor(
  ctx: SimContext,
  elev: Float32Array,
  crestElev: Float32Array,
  u: Float32Array,
  v: Float32Array,
  row: number,
  col: number,
  dxKm: number,
  dyKm: number,
): number {
  const { grid } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const i0 = row * W + col;
  const uu = u[i0] ?? 0;
  const vv = v[i0] ?? 0;
  const speed = Math.hypot(uu, vv);
  if (speed < 1) return 1;
  const ownElev = Math.max(0, elev[i0] ?? 0);
  let fr = row + 0.5;
  let fc = col + 0.5;
  let traveled = 0;
  let maxRidge = ownElev;
  const steps = Math.max(2, Math.round(K.upwindBlockScanKm / dyKm));
  for (let s = 0; s < steps; s++) {
    fc += (-uu / speed) * (dyKm / dxKm);
    fr += (vv / speed) * 1;
    if (fr < 0 || fr >= H) break;
    traveled += dyKm;
    if (traveled > K.upwindBlockScanKm) break;
    const r = Math.min(H - 1, Math.max(0, Math.floor(fr)));
    const c = wrapCol(grid, Math.floor(fc));
    // 稜線は推定標高で判定(狭い山脈の 1° 平均均し対策)
    const e = Math.max(0, crestElev[r * W + c] ?? elev[r * W + c] ?? 0);
    if (e > maxRidge) maxRidge = e;
  }
  const relief = maxRidge - ownElev;
  if (relief <= 300) return 1;
  const t = Math.min(1, (relief - 300) / K.upwindBlockReliefM);
  return 1 - (1 - K.upwindBlockFloor) * t;
}

/** 近傍(半径 3 セル)の海セル SST 偏差の最小値(寒流検出用) */
// 対応 spec: FB 2026-07-31 P1-2 + 変更レビュー FB P2-3。探索半径は固定セル数
// ではなく球面上の角距離で定義する(解像度を変えても同じ地形で同じ探索対象
// 距離になる)。値は旧実装 ±6/±3 セルの 1° 地球での実効角半径の仕様化。
// 窓は正方形ではなく円形: 候補は dφ² + (dλ·cos(中間緯度))² ≤ R² で判定する
// (境界は R ちょうどを含む)。高緯度では同じ角半径がより多くの経度列に届く。
export const WARM_OCEAN_SEARCH_RADIUS_DEG = 6;
export const COLD_COAST_SEARCH_RADIUS_DEG = 3;

/** 中心セルから球面角距離 radiusDeg 以内の全セルを列挙(近似: cos 補正付き平面) */
export function forEachCellWithinAngularRadius(
  grid: Grid,
  row: number,
  col: number,
  radiusDeg: number,
  visit: (cellIndex: number) => void,
): void {
  const res = grid.resolutionDeg;
  const W = grid.widthCells;
  const lat0 = 90 - (row + 0.5) * res;
  const drMax = Math.ceil(radiusDeg / res);
  const r2 = radiusDeg * radiusDeg;
  for (let dr = -drMax; dr <= drMax; dr++) {
    const r = row + dr;
    if (r < 0 || r >= grid.heightCells) continue;
    const lat1 = 90 - (r + 0.5) * res;
    const dPhi = Math.abs(lat1 - lat0);
    const rem2 = r2 - dPhi * dPhi;
    if (rem2 < -1e-9) continue;
    const cosMid = Math.max(0.05, Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180));
    const dcMax = Math.min(
      Math.floor(W / 2),
      Math.ceil(Math.sqrt(Math.max(0, rem2)) / (res * cosMid)),
    );
    for (let dc = -dcMax; dc <= dcMax; dc++) {
      const dLam = Math.abs(dc) * res * cosMid;
      if (dPhi * dPhi + dLam * dLam > r2 + 1e-9) continue;
      visit(r * W + wrapCol(grid, col + dc));
    }
  }
}

/**
 * 近傍(球面角半径 6°)で最も暖かい海セルの気温(°C)。渦供給の水蒸気量の基準。
 * 冬の東岸の移動性低気圧は局所の陸気温ではなく暖流の海面から水蒸気を汲む
 * (湾流・黒潮の冬の東岸降水 — 2026-07-30 レビュー H1)
 */
export function nearestOceanTempC(
  ctx: SimContext,
  tField: Float32Array,
  row: number,
  col: number,
): number | null {
  const { grid, terrain } = ctx;
  let best: number | null = null;
  forEachCellWithinAngularRadius(grid, row, col, WARM_OCEAN_SEARCH_RADIUS_DEG, (i) => {
    if (terrain.landMask[i]) return;
    const t = tField[i] ?? 0;
    if (best === null || t > best) best = t;
  });
  return best;
}

/** 近傍(球面角半径 3°)で最も冷たい海面偏差(寒流沿岸判定) */
export function nearestOceanAnomaly(
  ctx: SimContext,
  ocean: OceanCurrentResult,
  row: number,
  col: number,
): number {
  const { grid, terrain } = ctx;
  let minA = 0;
  forEachCellWithinAngularRadius(grid, row, col, COLD_COAST_SEARCH_RADIUS_DEG, (i) => {
    if (terrain.landMask[i]) return;
    const a = ocean.sstAnomalyC[i] ?? 0;
    if (a < minA) minA = a;
  });
  return minA;
}

/**
 * 段 46c: 冬ゲートが参照する赤緯(暦の遅れつき)。lag = 0 なら配列参照と
 * 厳密一致。円環の線形補間(step01/step02 の laggedDeclinationDeg と同形 —
 * 計算層の作法により層間 import を増やさず各段に局所で持つ)
 */
function laggedDeclinationDegLocal(
  monthlyDeclinationDeg: ArrayLike<number>,
  m: number,
  lagMonths: number,
): number {
  if (lagMonths === 0) return monthlyDeclinationDeg[m] ?? 0;
  const n = 12;
  let t = m - lagMonths;
  while (t < 0) t += n;
  const i0 = Math.floor(t) % n;
  const i1 = (i0 + 1) % n;
  const f = t - Math.floor(t);
  return (monthlyDeclinationDeg[i0] ?? 0) * (1 - f) + (monthlyDeclinationDeg[i1] ?? 0) * f;
}
