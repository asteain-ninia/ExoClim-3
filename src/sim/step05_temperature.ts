// Step 5: 気温 — 2 次元エネルギー収支モデル(EBM)。docs/spec/05_気温.md
//
//   C·dT/dt = S(t)·(1−α(T, 雲)) − (A_eff + B·T) + ∇·(D∇T) − 移流結合 + Q_ocean
//
// 状態は海面高度相当温度 T_sl。標高は OLR 定数項(−B·Γ·h)として入り、
// 出力時に T_surf = T_sl − Γ·h で降尺度する。時間積分は陰解法(ガウス=ザイデル)。
// 設計上の要点(較正ログ 2026-07-29):
//  - 拡散は異方性: 南北 = 文献値 D、東西 = 弱い拡散 + 方向性の移流結合。
//    等方 + 球面計量では高緯度の大陸規模季節モードが潰れる。
//  - 移流はセル熱容量に掛けない(海面が風速で流される誤り)。固定結合 W/m²/K。
//  - 雲アルベドは循環で変調(沈降域 = 晴天、ITCZ = 曇天)。一様雲は砂漠を 9°C 冷やす。
//  - 恒常氷床は 2 パス目で判定(年平均 < 閾値 → 高アルベド)。単一の温度ランプでは
//    「北半球の春の雪解け」と「南極の恒常氷」を両立できない。
//  - 寒冷開始は雪玉解へ落ちるため温暖側から初期化し、序盤は熱容量 1/16 で加速。
// 教訓 §5「線形の日射→気温変換は極夜極昼で破綻」への根本対策そのもの。

import { createGrid, latDegOfRow } from '@/domain/grid';
import type { Grid } from '@/domain/grid';
import { computeInsolation, MONTHS_PER_YEAR } from '@/domain/insolation';
import { orbitalPeriodYears } from '@/domain/planetParams';
import { resolveTerrain } from '@/domain/terrain';
import type { TerrainField } from '@/domain/terrain';
import { MODEL_CONSTANTS as K } from './constants';
import { chamferDistanceCells } from './context';
import type { AccelControl, EbmConstants, EbmStaticFields, RunOptions } from './accel';
import { throwIfCancelled, yieldToEventLoop } from './run_control';
import type {
  AirflowResult,
  ItczResult,
  OceanCurrentResult,
  SimContext,
  TemperatureResult,
  WindBeltResult,
} from './types';

const RHO_C_WATER = 4.19e6; // J/m³/K
const SECONDS_PER_EARTH_YEAR = 3.156e7;
/**
 * 陰的ステップの線形解を「収束した」とみなす許容差(°C)。
 *
 * **較正つまみではない**。数値解法の打ち切り誤差の上限であって物理量ではなく、
 * 較正ベクトル(MODEL_CONSTANTS)には入れない。値は結果を見る前に固定した。
 * 1e-3°C は気候の意味を持つ最小の差(0.1°C 級)より 2 桁小さい。
 *
 * なぜ回数ではなく残差で止めるか(2026-08-01 の実測):
 *   固定 8 スイープでは線形解が全く収束しておらず、16・32・…・256 と増やすと
 *   気温場が面積平均で計 2.1°C 動き、大分類一致率が 74.32 → 71.93 へ単調に
 *   悪化した。つまり「8 回で打ち切る」という実装詳細が答えを決めており、
 *   拡散・移流係数はその打ち切り誤差を打ち消す向きに較正されていた。
 *   これは CLAUDE.md が禁じる隠しパラメータそのもの。
 *   詳細: docs/実験記録_EBM赤黒順序_2026-08-01.md
 */
export const EBM_SOLVE_TOLERANCE_C = 1e-3;

/** 発散・病的入力の保険。ここに達したら収束せずと報告する(黙って続けない) */
export const EBM_MAX_SWEEPS = 400;

/**
 * 反復の実験用スイッチ。
 *  - order: 'gauss-seidel'(行優先・逐次)/ 'red-black'(市松・並列可)。
 *    収束すれば線形系の解は一意なので、どちらでも同じ答えになる。
 *  - sweeps: > 0 なら残差基準を使わずその回数で打ち切る(収束の調査用)。
 * docs/実験記録_EBM赤黒順序_2026-08-01.md の事前登録実験で使う。
 */
export const EBM_SOLVER = {
  order: 'gauss-seidel' as 'gauss-seidel' | 'red-black',
  /**
   * 反復回数と緩和年数を「収束するまで自動で増やす」か。
   *
   * 較正では **false にする**。理由は費用ではなく設計の正しさ:
   * 自動で増やすと、収束しにくいパラメータ領域は「高くつく」だけで
   * 探索対象として残ってしまう。本来そこは**棄却されるべき**である
   * (許容差内で解けないモデルは採用できない)。
   * false のとき、予算内で収束しなければ EBM_SOLVER_STATS.capHits に計上し、
   * 呼び出し側(較正)がその評価を失格にする。
   */
  adaptive: true,
  /**
   * > 0 で回数固定。0(既定)なら**収束させる**:
   * CPU は EBM_SOLVE_TOLERANCE_C まで反復し(上限 EBM_MAX_SWEEPS)、
   * GPU は EBM_GPU_ITERATIONS 回まわして残差を記録・検証する。
   *
   * 回数を固定するのは調査のときだけ。既定を「収束」にしたのが
   * 隠しパラメータ GS_SWEEPS = 8 の除去そのもの(2026-08-01)。
   * CPU 経路は収束まで回すと 1 実行に数分かかるため、
   * 性質だけを見るテストは明示的に GS_SWEEPS を指定してよい。
   */
  sweeps: 0 as number,
};

/**
 * GPU 経路の 1 ステップあたり反復回数。
 *
 * **決め打ちの魔法数ではない**: GPU は全ステップの残差を記録し、
 * EBM_SOLVER_STATS.maxResidualC として返す。許容差を満たしているかは
 * 実行のたびに検証できる(scripts/check_ebm_gpu.ts)。
 * 残差基準を GPU 内で判定しないのは、判定に読み戻しが要り、
 * 往復を数百回繰り返すと不安定になるため(src/sim/gpu/device.ts の注記)。
 *
 * 512 の根拠(実測 2026-08-01、scripts/exp_ebm_gpu_iters.ts):
 *   反復  128 → 残差 3.6e-2 / 256 → 2.6e-3 / **512 → 1.7e-5** / 1024 → 0
 *   許容差 1e-3 を満たす最小の 2 冪が 512。気温場は 256 の時点で
 *   512 と 0.0012°C しか違わず、採点も同一だが、**しきい値は緩めない**。
 *
 * ただしこれは**地球の値**である。全陸惑星は 512 では収束しない
 * (残差 3.1e-3、2026-08-02 実測)。陸は熱容量が小さく C/dt が効かないため
 * 対角優位が弱く、反復が効きにくい。惑星デザイナとして地球以外を扱う以上、
 * 固定回数は使えない — 下の EBM_GPU_MAX_ITERATIONS まで倍々で再試行する。
 */
export const EBM_GPU_ITERATIONS = 512;

/**
 * 反復回数の再試行上限。ここまで倍々に増やしても収束しなければ、
 * 未収束であることを診断に残す(黙って採用しない)。
 */
export const EBM_GPU_MAX_ITERATIONS = 8192;

/**
 * 収束予算の手掛かり(**性能のためだけの記憶**)。**上下どちらにも動く**。
 *
 * 較正は同じ惑星を数千回解くので、毎回既定から倍々に増やすのは無駄 —
 * 前回足りた値から始めたい。結果には影響しない(倍化のたびに残差と年次
 * ドリフトを検査するので、得られる解は出発点に依らない)。
 *
 * **上げるだけの記憶にしてはいけない**。一度でも重いパラメータ組が予算を
 * 倍化させると、以後の全評価が必要のない費用を永久に払い続ける
 * (2026-08-03 実測: 較正の 1 評価が 307s → 1110s と 3.6 倍に膨らんでいた。
 * 最良パラメータを新しいプロセスで冷間から回すと既定予算 24 年 / 512 反復の
 * まま 313s で収束したので、増分はすべてこのラチェットだった。
 * scripts/diag_hint_ratchet.ts)。
 *
 * そこで **倍化なしで通った回が DECAY_AFTER 回続いたら半減**して既定へ寄せる。
 * 下げ過ぎても次の回が倍化して戻るだけで、答えは変わらない。損は回し直し
 * 1 回ぶんで、払い過ぎを永久に続けるより桁違いに安い。
 */
const HINT_DECAY_AFTER = 3;
const budgetHint = {
  /** 直近に収束した反復回数 */
  iterations: EBM_GPU_ITERATIONS,
  /** 直近に周期定常へ達した全熱容量年数(0 = 記憶なし) */
  fullYears: 0,
  /** 倍化せずに済んだ連続回数(半減の判定用) */
  easyIterations: 0,
  easyYears: 0,
};

/** 試験・診断から手掛かりを初期化する(較正ワーカーの再現性の検査用) */
export function resetEbmBudgetHint(): void {
  budgetHint.iterations = EBM_GPU_ITERATIONS;
  budgetHint.fullYears = 0;
  budgetHint.easyIterations = 0;
  budgetHint.easyYears = 0;
}

/**
 * 全熱容量で積分する年数(末尾から数える)。それ以前は熱容量 1/16 で加速する。
 *
 * **これも収束の問題**: 海洋混合層の時定数は τ = C/B ≈ 3.2 年なので、
 * 2 年では 0.6τ しか緩和しない。1/16 の加速期(τ' = 0.2 年)は速く落ち着くが、
 * そこから全熱容量へ切り替えた後の緩和が足りているかは別の話であり、
 * **積分年数を増やすだけでは検証できない**(加速期が伸びるだけで
 * 全熱容量の年数は 2 のまま。2026-08-02 に一度取り違えた)。
 * 値は scripts/exp_ebm_fullcap.ts で実測して決める。
 */
export const EBM_FULL_CAPACITY_YEARS = {
  /**
   * 0 = 周期定常に達するまで自動で増やす(既定)。> 0 で固定(調査用)。
   * CPU 経路は自動化しない(1 実行に数分かかるため)ので、その場合は明示する。
   */
  years: 0,
};

/** 加速期(熱容量 1/16)の年数。τ' = 0.2 年なので 2 年で十分 */
export const SPINUP_ACCEL_YEARS = 2;

/**
 * 周期定常に達したとみなす年次ドリフトの許容差(°C)。
 * 最終年と前年の年平均の**面積重み平均** |Δ| がこれを下回れば「毎年同じ気候」。
 * 全セルの最大値ではなく面積重み平均で測るのは、許容差を時間離散化の誤差
 * (240 刻みで 0.13°C、これも面積重み平均)と比べて決めているため。
 * 物差しを揃えないと、極の小さなセル 1 つに判定が支配される。
 *
 * **較正つまみではない**。時間離散化の誤差(240 刻みで約 0.13°C)より
 * 小さく取る。0.05°C は気候の意味を持つ差より 1 桁小さい。
 */
export const EBM_PERIODIC_TOLERANCE_C = 0.05;

/**
 * 全熱容量で回す年数の出発点。ここから足りなければ倍々に増やす。
 *
 * 24 の根拠(実測 2026-08-02、scripts/exp_ebm_fullcap.ts):
 *   海洋混合層の時定数 τ = C/B ≈ 3.2 年。年数を振ると気温場は
 *   8→12 で 0.68°C、12→16 で 0.29°C、16→24 で 0.14°C、24→32 で **0.016°C**
 *   しか動かなくなる(面積重み平均)。採点も 24 年で 32 年と 0.02pt しか違わない。
 *   年次ドリフトは 24 年で約 0.014°C と許容差 0.05 を満たす。
 *   16 年は 0.2°C で足りず、倍々だと 32 年へ行き過ぎるので 24 から始める。
 *   従来の **2 年は 0.6τ** しかなく、周期定常に遠く届いていなかった。
 */
export const EBM_FULL_CAPACITY_START_YEARS = 24;

/** 全熱容量の年数の再試行上限。ここまで増やしても収束しなければ診断に残す */
export const EBM_MAX_FULL_CAPACITY_YEARS = 64;

/** 直近の実行の診断(報告用。物理結果には含めない) */
export const EBM_SOLVER_STATS = {
  totalSweeps: 0,
  steps: 0,
  maxSweeps: 0,
  capHits: 0,
  /** GPU 経路で観測した最大残差(°C) */
  maxResidualC: 0,
  /** 最終年と前年の年平均の最大差(°C、参考値) */
  maxYearDriftC: 0,
  /** 同・面積重み平均(°C)。周期定常の判定はこちら */
  meanYearDriftC: 0,
  /** 全熱容量で回した年数 */
  fullCapacityYears: 0,
};

interface CoarseCell {
  landFrac: number;
  meanLandElevM: number;
  sstAnomalyC: number;
}

export async function computeTemperature(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
  ocean: OceanCurrentResult,
  airflow: AirflowResult,
  priorPrecip?: { monthlyPrecipMm: Float32Array[] },
  opts?: RunOptions,
): Promise<TemperatureResult> {
  const { params } = ctx;
  const cg = createGrid(Math.max(K.ebmResolutionDeg, params.gridResolutionDeg));
  const CW = cg.widthCells;
  const CH = cg.heightCells;
  const N = cg.cellCount;

  // ---- 収束予算 ----
  // 省略された項目は**この段が持つ既定の定数**に落ちる(値を複製しない)。
  // 予算を絞ったときに収束しなければ、EBM_SOLVER_STATS.capHits に記録され、
  // 呼び出し側は「未収束」として扱える(黙って採用しない)。
  const budget = opts?.budget;
  const bFullYearsStart = budget?.ebmFullCapacityYears ?? EBM_FULL_CAPACITY_START_YEARS;
  const bMaxFullYears = budget?.ebmMaxFullCapacityYears ?? EBM_MAX_FULL_CAPACITY_YEARS;
  const bIterations = budget?.ebmIterations ?? EBM_GPU_ITERATIONS;
  const bMaxIterations = budget?.ebmMaxIterations ?? EBM_GPU_MAX_ITERATIONS;
  const bSpinupAccelYears = budget?.ebmSpinupAccelYears ?? SPINUP_ACCEL_YEARS;
  /** EBM の予算が既定から動かされているか(手掛かりの読み書きを止める判定) */
  const ebmBudgetOverridden =
    budget?.ebmFullCapacityYears !== undefined ||
    budget?.ebmMaxFullCapacityYears !== undefined ||
    budget?.ebmIterations !== undefined ||
    budget?.ebmMaxIterations !== undefined ||
    budget?.ebmSpinupAccelYears !== undefined;
  const control: AccelControl = {
    signal: opts?.signal,
    progress: opts?.progress,
  };

  // 陸率・標高の集約は常に固定 1° 地形から行う(表示解像度に物理を依存させない。
  // 表示 = EBM 格子だと landFrac が二値になり沿岸の熱容量混合が消える)
  const refGrid = createGrid(Math.min(1, params.gridResolutionDeg));
  const refTerrain =
    refGrid.resolutionDeg === ctx.grid.resolutionDeg
      ? ctx.terrain
      : resolveTerrain(refGrid, params.terrain);
  const coarse = aggregateToCoarse(ctx, refGrid, refTerrain, ocean, cg);
  const insolation = computeInsolation(cg, params.orbital, params.body.axialTiltDeg);

  // 周極海峡: ほぼ陸に遮られない緯度行(地衡流水路 = 南北隔離 + 深い鉛直混合)
  const rowIsChannel = new Uint8Array(CH);
  for (let row = 0; row < CH; row++) {
    if (Math.abs(latDegOfRow(cg, row)) > K.channelMaxAbsLatDeg) continue;
    let landSum = 0;
    for (let col = 0; col < CW; col++) landSum += coarse[row * CW + col]?.landFrac ?? 0;
    rowIsChannel[row] = landSum / CW < K.channelLandFracMax ? 1 : 0;
  }

  // ---- セル定数 ----
  const atm = params.atmosphere;
  const aBase =
    K.olrAWm2 - K.greenhouseDeltaAWm2 * Math.log2(Math.max(0.05, atm.greenhouseStrength));
  const gamma = K.lapseRateCPerKm / 1000;
  const heatCap = new Float64Array(N);
  const aEff = new Float64Array(N);
  const surfAlbedoBase = new Float64Array(N);
  const iceOnset = new Float64Array(N);
  const qFlux = new Float64Array(N);
  const elevM = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = coarse[i];
    if (!c) continue;
    const row = Math.floor(i / CW);
    const landDepth = Math.max(
      0.3,
      K.landEffectiveWaterDepthM + 0.5 * (atm.surfacePressureBar - 1),
    );
    let oceanDepth = atm.oceanMixedLayerDepthM + 2.4 * atm.surfacePressureBar;
    if (rowIsChannel[row]) oceanDepth *= K.channelMixedLayerBoost;
    heatCap[i] = RHO_C_WATER * (c.landFrac * landDepth + (1 - c.landFrac) * oceanDepth);
    const h = c.landFrac * Math.max(0, c.meanLandElevM);
    elevM[i] = h;
    aEff[i] = aBase - K.olrBWm2PerC * gamma * h;
    surfAlbedoBase[i] = K.albedoLand * c.landFrac + K.albedoOcean * (1 - c.landFrac);
    iceOnset[i] = K.iceOnsetC * c.landFrac + K.seaFreezeC * (1 - c.landFrac);
    qFlux[i] = K.sstAnomalyCouplingWm2PerK * c.sstAnomalyC * (1 - c.landFrac);
  }
  // Q フラックスのエネルギー中立化。補償は**海セルのみ**に配賦する —
  // 全セル一律に引くと、qFlux が 0 の陸にまで恒常の寒冷税(全球 ~−4 W/m²
  // ≈ −1.9°C)がかかる(2026-07-30 レビュー指摘。SST 偏差は構造的に正味プラス)
  {
    let sum = 0;
    let wOcean = 0;
    for (let row = 0; row < CH; row++) {
      const w = Math.cos((latDegOfRow(cg, row) * Math.PI) / 180);
      for (let col = 0; col < CW; col++) {
        const i = row * CW + col;
        sum += (qFlux[i] ?? 0) * w;
        wOcean += w * (1 - (coarse[i]?.landFrac ?? 0));
      }
    }
    const meanOcean = wOcean > 1e-9 ? sum / wOcean : 0;
    for (let i = 0; i < N; i++) {
      qFlux[i] = (qFlux[i] ?? 0) - meanOcean * (1 - (coarse[i]?.landFrac ?? 0));
    }
  }

  // ---- 雲アルベドの循環変調(月別・セル別) ----
  const cloudAlbedoMonthly: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const field = new Float32Array(N);
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;
    const declM = insolation.monthlyDeclinationDeg[m] ?? 0;
    const centers = itcz.monthlyCenterLatDegByCol[m];
    const colScale = ctx.grid.widthCells / CW;
    for (let row = 0; row < CH; row++) {
      const lat = latDegOfRow(cg, row);
      const ridge = lat >= 0 ? ridgeN : ridgeS;
      const pf = lat >= 0 ? pfN : pfS;
      // 沈降晴天域はリッジ中心ではなく下降枝の全域(|ridge|−16° 〜 |ridge|+5°)
      const aLatHere = Math.abs(lat);
      const descLo = Math.abs(ridge) - 16;
      const descHi = Math.abs(ridge) + 5;
      let ridgeProx: number;
      if (aLatHere >= descLo && aLatHere <= descHi) {
        ridgeProx = 1;
      } else {
        const d = aLatHere < descLo ? descLo - aLatHere : aLatHere - descHi;
        ridgeProx = Math.exp(-(d * d) / 16);
      }
      // ストームトラック帯(リッジ極側〜極前線先): 海上で雲が厚い
      const aLat = Math.abs(lat);
      const stLo = Math.abs(ridge) + 8;
      const stHi = Math.abs(pf) + 15;
      // 夏半球ではストームトラックが弱まる — ただし弱まるのは大陸側ジェット。
      // 海(南大洋型)は夏も曇天のまま(レビュー仮説 5: 陸海で季節減衰を分離)
      const isStormWinter = lat >= 0 ? declM < 0 : declM > 0;
      const stormWBase =
        aLat > stLo && aLat < stHi ? Math.sin((Math.PI * (aLat - stLo)) / (stHi - stLo)) : 0;
      for (let col = 0; col < CW; col++) {
        const i = row * CW + col;
        const fineCol = Math.min(ctx.grid.widthCells - 1, Math.round((col + 0.5) * colScale));
        const center = centers?.[fineCol] ?? 0;
        // 雲変調の ITCZ 幅は降水・循環より狭い(実物の雲帯は ±3〜5°。
        // 広いと夏の 20-30°N 乾燥帯まで曇らせて寒くする — レビュー仮説 6)
        const dI = (lat - center) / (itcz.halfWidthDeg * K.itczCloudWidthFactor);
        const itczInf = Math.exp(-dI * dI);
        const landFrac = coarse[i]?.landFrac ?? 0;
        const oceanFrac = 1 - landFrac;
        const stormSeason = isStormWinter ? 1 : 0.35 + (K.stormCloudSummerOcean - 0.35) * oceanFrac;
        const stormW = stormWBase * stormSeason;
        const subsidenceWeight = K.subsidenceOceanFactor + (1 - K.subsidenceOceanFactor) * landFrac;
        // 寒流上の層積雲デッキ(SST 負偏差の海で雲が増える)
        const sstA = coarse[i]?.sstAnomalyC ?? 0;
        const scDeck =
          sstA < 0 ? K.stratocumulusBoostPerNegC * Math.min(1.5, -sstA / 2) * oceanFrac : 0;
        // 周極海峡行は常時ストーム雲(南大洋型。上限も少し引き上げる)
        const chanCloud = rowIsChannel[row] ? K.channelCloudBoost * oceanFrac : 0;
        const factor =
          1 -
          K.subsidenceCloudReduction * subsidenceWeight * ridgeProx * (1 - itczInf) +
          K.convectiveCloudBoost * itczInf +
          K.stormTrackCloudBoost * stormW * oceanFrac +
          scDeck +
          chanCloud;
        const capMax = K.cloudAlbedoMax + (rowIsChannel[row] ? 0.08 : 0);
        field[i] = Math.min(capMax, Math.max(0.04, atm.cloudAlbedo * factor));
      }
    }
    cloudAlbedoMonthly.push(field);
  }

  // ---- 拡散・移流係数 ----
  const dPhi = (cg.resolutionDeg * Math.PI) / 180;
  const radiusRatio = 6371 / params.body.radiusKm;
  const dBase =
    K.diffusionWm2PerK * radiusRatio * radiusRatio * Math.max(0.1, atm.heatTransportStrength);
  const cosCenter = new Float64Array(CH);
  const metricZonal = new Float64Array(CH);
  for (let row = 0; row < CH; row++) {
    const phi = (latDegOfRow(cg, row) * Math.PI) / 180;
    cosCenter[row] = Math.cos(phi);
    metricZonal[row] = Math.min(
      K.zonalMetricCap,
      1 / Math.max(1e-6, Math.cos(phi) * Math.cos(phi)),
    );
  }
  const diffFactor = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = coarse[i];
    diffFactor[i] = 1 + (K.oceanDiffusionBoost - 1) * (1 - (c?.landFrac ?? 0));
  }
  // 逆転込みの実効拡散係数(時間ステップごとに再計算 — P2-2 の対称界面用)
  const dfEff = new Float64Array(N);
  // 内陸度(0 = 海岸/海、1 = ~1500km 以上内陸)。冬の接地逆転層は内陸で強い
  // (海沿いの陸は冬も海風で暖まる: 西欧型。内陸は遮断される: シベリア型)
  const interior01 = new Float64Array(N);
  {
    const distToOceanCells = chamferDistanceCells(cg, (i) => (coarse[i]?.landFrac ?? 0) < 0.5);
    const cellKm = (Math.PI * params.body.radiusKm) / CH;
    for (let i = 0; i < N; i++) {
      interior01[i] = Math.min(1, ((distToOceanCells[i] ?? 0) * cellKm) / 1500);
    }
  }
  // 月別 2D 風(Step 4)を EBM 格子へ集約(2026-07-30: 帯状移流を 2D 化。
  // 冬の大陸冷気の吹き出し・海からの暖気移流を経度別に表現する)
  const windOnCg = aggregateWinds(ctx, airflow, cg);

  // 蒸発冷却フィードバック(2026-08-01): 湿った陸は潜熱で冷え、乾いた陸は
  // 乾熱で暑い(実在の砂漠の暑さ・雨林の冷涼)。前回パスの降水の
  // 「陸平均に対する偏差」を月別フラックスにする(偏差なので全球中立)。
  // 降水→気温の初の結線(パイプラインは 温度→降水→温度→降水 の 2 パス)
  const evapAnomWm2: Float32Array[] | null = priorPrecip
    ? buildEvapCoolingAnomaly(ctx, priorPrecip.monthlyPrecipMm, cg, coarse)
    : null;
  // 夏半球は結合を弱める(ジェット弱化で大陸が海洋の影響から解放される —
  // 旧・帯状移流の seasonFactor を踏襲)
  const meanRidgeN =
    windBelt.monthlyRidgeLatNDeg.reduce((a, b) => a + b, 0) / windBelt.monthlyRidgeLatNDeg.length;
  const meanRidgeS =
    windBelt.monthlyRidgeLatSDeg.reduce((a, b) => a + b, 0) / windBelt.monthlyRidgeLatSDeg.length;

  const yearSeconds = orbitalPeriodYears(params.orbital) * SECONDS_PER_EARTH_YEAR;
  const dt = yearSeconds / K.ebmStepsPerYear;

  // ---- 時間積分(クロージャ: 恒常氷マスクを与えて 1 回まわす) ----
  // P1-4 で発見した季節ドリフト(傾斜 0 の全海で 0.027°C/月)への対処:
  // 海洋混合層の時定数 τ = C/B ≈ 3.2 年に対し、全熱容量での積分が 2 年しか
  // 無いため周期定常へ届いていなかった。パス 2 をパス 1 の最終状態から
  // 始めることで、実効的な緩和年数を倍にする(計算量は増えない)
  // CPU 経路。GPU が無い環境(WebGPU 非対応ブラウザ・EXOCLIM_GPU=0)の参照実装。
  // 非同期なのは**中断と進捗のため**で、物理は同期のときと同一
  // (yield は計算の途中には入らず、時間ステップの境目にだけ入る)
  const integrate = async (
    permanentIce: Uint8Array | null,
    initialT: Float64Array | undefined,
    passLabel: string,
    passFrom: number,
    passTo: number,
  ) => {
    const t = new Float64Array(N);
    if (initialT) {
      t.set(initialT);
    } else {
      for (let row = 0; row < CH; row++) {
        const init = -20 + 48 * (cosCenter[row] ?? 0);
        for (let col = 0; col < CW; col++) t[row * CW + col] = init;
      }
    }
    const rhs = new Float64Array(N);
    // 海氷断熱: 氷結セルの実効熱容量(氷量に応じて毎ステップ更新)。
    // 注: 氷厚状態を持つ 0 層海氷(融解 0°C 固定)は 2026-07-30 に試行したが、
    // 断熱×融解固定の正帰還で南極海リングが夏に融け残り −60S が −14°C へ
    // 暴走(双安定)。温度ランプ近似を維持する(較正記録参照)
    const capEff = new Float64Array(N);
    /** 直近の論理スイープでの最大 |Δt|(°C)。残差基準の打ち切りに使う */
    let maxDelta = 0;
    const monthAccum: Float64Array[] = Array.from(
      { length: MONTHS_PER_YEAR },
      () => new Float64Array(N),
    );
    const monthCount = new Array<number>(MONTHS_PER_YEAR).fill(0);
    // CPU 経路は年数を自動調整しない(収束まで回すと 1 実行に数分かかる)。
    // 既定(years = 0 = 自動)のときは従来と同じ 2 年を使う。
    // GPU と揃えて比べたいときは EBM_FULL_CAPACITY_YEARS.years を明示すること
    // CPU 経路は年数を自動調整しない(判定に必要な 2 年ぶんの積算を持たないため)。
    // ただし既定値は **GPU と揃える**。揃えないと EXOCLIM_GPU=0 と有効時で
    // 物理が変わり再現性が壊れる。時間はかかるので、性質だけ見るテストは
    // tests/setup.ts で明示的に短くする。
    const cpuFullYears =
      EBM_FULL_CAPACITY_YEARS.years > 0 ? EBM_FULL_CAPACITY_YEARS.years : bFullYearsStart;
    const totalSteps = Math.max(K.ebmYears, cpuFullYears + bSpinupAccelYears) * K.ebmStepsPerYear;
    const totalYears = totalSteps / K.ebmStepsPerYear;
    const spinupSteps = Math.max(0, (totalYears - cpuFullYears) * K.ebmStepsPerYear);
    // GPU 経路と同じ刻み: **1 か月ぶんの時間ステップ**ごとに制御を返す。
    // こうするとスナップショットが各月ちょうど 1 回ずつ落ち、
    // 1 モデル年で表示用の 12 か月が揃う
    const TICK_STEPS = Math.max(1, Math.round(K.ebmStepsPerYear / MONTHS_PER_YEAR));
    const snapshot = new Float32Array(N);
    const live = makeLiveTemperature();

    for (let step = 0; step < totalSteps; step++) {
      if (step > 0 && step % TICK_STEPS === 0) {
        throwIfCancelled(opts?.signal, 'EBM');
        if (opts?.progress) {
          const yf = (step % K.ebmStepsPerYear) / K.ebmStepsPerYear;
          const mIdx = Math.min(MONTHS_PER_YEAR - 1, Math.floor(yf * MONTHS_PER_YEAR));
          for (let i = 0; i < N; i++) snapshot[i] = t[i] ?? 0;
          const temperature = live.absorb(snapshot, mIdx);
          opts.progress({
            fraction: passFrom + (passTo - passFrom) * (step / totalSteps),
            detail: `${passLabel} — EBM 積分 ${Math.floor(step / K.ebmStepsPerYear) + 1}/${totalYears} 年目 (CPU)`,
            ...(temperature ? { partial: { temperature } } : {}),
          });
        }
        await yieldToEventLoop();
      }
      const capScale = step < spinupSteps ? 1 / 16 : 1;
      const yearFrac = (step % K.ebmStepsPerYear) / K.ebmStepsPerYear;
      const monthFloat = yearFrac * MONTHS_PER_YEAR;
      const m0 = Math.floor(monthFloat - 0.5 + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
      const m1 = (m0 + 1) % MONTHS_PER_YEAR;
      const frac = (monthFloat - 0.5 + MONTHS_PER_YEAR) % 1;
      const cloud0 = cloudAlbedoMonthly[m0];
      const cloud1 = cloudAlbedoMonthly[m1];

      for (let row = 0; row < CH; row++) {
        const s0 = insolation.monthlyByRow[m0]?.[row] ?? 0;
        const s1 = insolation.monthlyByRow[m1]?.[row] ?? 0;
        const s = s0 * (1 - frac) + s1 * frac;
        for (let col = 0; col < CW; col++) {
          const i = row * CW + col;
          const tSurf = (t[i] ?? 0) - gamma * (elevM[i] ?? 0);
          const iceW = Math.min(1, Math.max(0, ((iceOnset[i] ?? 0) - tSurf) / K.iceRampWidthC));
          let aSurf =
            (surfAlbedoBase[i] ?? 0.15) + (K.albedoIce - (surfAlbedoBase[i] ?? 0.15)) * iceW;
          if (permanentIce?.[i]) aSurf = Math.max(aSurf, K.permanentIceAlbedo);
          const cloud = (cloud0?.[i] ?? 0.2) * (1 - frac) + (cloud1?.[i] ?? 0.2) * frac;
          const albedo = cloud + (1 - cloud) * aSurf;
          // 海氷断熱: 氷結海面は混合層を切り離し実効熱容量が陸並みに落ちる
          // (極域の季節振幅の再現に必須 — constants.seaIceInsulationFactor 参照)
          const oceanFrac = 1 - (coarse[i]?.landFrac ?? 0);
          capEff[i] =
            (heatCap[i] ?? 1) * (1 - K.seaIceInsulationFactor * iceW * oceanFrac) * capScale;
          rhs[i] =
            ((capEff[i] ?? 1) / dt) * (t[i] ?? 0) +
            s * (1 - albedo) -
            (aEff[i] ?? K.olrAWm2) +
            (qFlux[i] ?? 0) -
            (evapAnomWm2
              ? (evapAnomWm2[m0]?.[i] ?? 0) * (1 - frac) + (evapAnomWm2[m1]?.[i] ?? 0) * frac
              : 0);
        }
      }

      const uField = windOnCg.u[m0];
      const vField = windOnCg.v[m0];
      const ridgeNNow = windBelt.monthlyRidgeLatNDeg[m0] ?? 31;
      const ridgeSNow = windBelt.monthlyRidgeLatSDeg[m0] ?? -31;
      // リッジは半球別(北半球の値を南に流用すると、南半球の冬にハドレー増強が
      // 12° はみ出し、v 結合の許可帯も誤る — 2026-07-30 レビューで発見のバグ)
      const ridgeAbsN = Math.max(15, Math.abs(ridgeNNow));
      const ridgeAbsS = Math.max(15, Math.abs(ridgeSNow));
      const summerN = ridgeNNow > meanRidgeN;
      const summerS = ridgeSNow < meanRidgeS;
      // P2-2(FB 2026-07-31): 界面伝導度を厳密対称にする。逆転込みの実効拡散
      // 係数をセルごとに前計算し、界面 = 両セルの実効係数の平均で一意に定義する。
      // 旧実装は自セルにだけ逆転係数を掛けており、i→j と j→i の伝導度が
      // 食い違って拡散が厳密には保存しなかった(コメントの意図とも不一致)
      for (let row = 0; row < CH; row++) {
        const winterRow =
          (insolation.monthlyByRow[m0]?.[row] ?? 0) < (insolation.annualMeanByRow[row] ?? 0);
        for (let col = 0; col < CW; col++) {
          const i = row * CW + col;
          const invD = winterRow
            ? 1 - (1 - K.winterInversionDiffusionFactor) * (interior01[i] ?? 0)
            : 1;
          dfEff[i] = (diffFactor[i] ?? 1) * invD;
        }
      }
      // 反復の打ち切り: 既定は残差基準(EBM_SOLVE_TOLERANCE_C)。
      // EBM_SOLVER.sweeps > 0 のときだけ回数固定にする(収束の調査用)。
      const fixedSweeps = EBM_SOLVER.sweeps > 0 ? EBM_SOLVER.sweeps : 0;
      const sweepLimit = fixedSweeps > 0 ? fixedSweeps : EBM_MAX_SWEEPS;
      // 赤黒順序では 1 スイープを「赤 → 黒」の 2 巡に分ける。市松の色は
      // (row + col) の偶奇。5 点ステンシルの隣接は必ず相手色なので、
      // 同色内は完全に並列(= GPU 化できる)で、相手色は更新済みを読む。
      // 経度セル数が奇数だと経度の折り返しで col=CW-1 と col=0 が同色になり、
      // 市松が壊れる(同色内の並列性が失われる)。その場合は赤黒を使わない
      const passesPerSweep = EBM_SOLVER.order === 'red-black' && CW % 2 === 0 ? 2 : 1;
      // 行ごとの実効南北拡散係数(ハドレー増強込み)。面の伝導度はこの両側平均
      const dMeridOfRow = new Float64Array(CH);
      for (let row = 0; row < CH; row++) {
        const lat = latDegOfRow(cg, row);
        const ridgeAbs = lat >= 0 ? ridgeAbsN : ridgeAbsS;
        const hadleyW = Math.max(0, 1 - (lat / ridgeAbs) * (lat / ridgeAbs));
        dMeridOfRow[row] = dBase * (1 + K.hadleyDiffusionBoost * hadleyW);
      }
      let sweepsUsed = 0;
      let converged = false;
      for (let sweep = 0; sweep < sweepLimit * passesPerSweep; sweep++) {
        const colorPass = passesPerSweep === 2 ? sweep % 2 : -1;
        if (colorPass <= 0) maxDelta = 0; // 論理スイープの頭で残差を測り直す
        for (let row = 0; row < CH; row++) {
          const lat = latDegOfRow(cg, row);
          const cosC = Math.max(1e-3, cosCenter[row] ?? 1e-3);
          const gz = (dBase * K.zonalDiffusionFactor * (metricZonal[row] ?? 1)) / (dPhi * dPhi);
          const ridgeAbs = lat >= 0 ? ridgeAbsN : ridgeAbsS;
          const phiEdgeN = ((lat + cg.resolutionDeg / 2) * Math.PI) / 180;
          const phiEdgeS = ((lat - cg.resolutionDeg / 2) * Math.PI) / 180;
          const chanN =
            rowIsChannel[row] || (row > 0 && rowIsChannel[row - 1])
              ? K.circumpolarChannelFactor
              : 1;
          const chanS =
            rowIsChannel[row] || (row < CH - 1 && rowIsChannel[row + 1])
              ? K.circumpolarChannelFactor
              : 1;
          // 南北の面伝導度は**面の量**でなければならない。ハドレー増強は緯度で
          // 変わるので、自セルの緯度で評価すると i→j と j→i が食い違う
          // (リッジ付近の 32°/30° 界面で約 4.6%。Codex レビュー 2026-08-02)。
          // 面の値 = 両側セルの実効南北拡散係数(ハドレー増強込み)の平均。
          // cosC で割るのは各セルの体積で規格化するためで、これは非対称で正しい
          const gN =
            row > 0
              ? (chanN *
                  0.5 *
                  ((dMeridOfRow[row] ?? 0) + (dMeridOfRow[row - 1] ?? 0)) *
                  Math.cos(phiEdgeN)) /
                (dPhi * dPhi * cosC)
              : 0;
          const gS =
            row < CH - 1
              ? (chanS *
                  0.5 *
                  ((dMeridOfRow[row] ?? 0) + (dMeridOfRow[row + 1] ?? 0)) *
                  Math.cos(phiEdgeS)) /
                (dPhi * dPhi * cosC)
              : 0;
          const seasonFactor = (lat >= 0 ? summerN : summerS) ? K.summerAdvectionFactor : 1;
          // 南北結合はリッジより極側のみ(温帯低気圧の南北混合が実在する帯)。
          // ハドレー域の南北輸送は拡散増強で表現済みで、そこに v 結合を足すと
          // 「冷気コンベア」(シベリア→インド)の二重計上になる(2026-07-30 実測)
          const vBandW = Math.min(1, Math.max(0, (Math.abs(lat) - ridgeAbs) / 10));
          // 冬(月日射 < 年平均)の陸は接地逆転層で移流が地表に届きにくい
          const isWinterRow =
            (insolation.monthlyByRow[m0]?.[row] ?? 0) < (insolation.annualMeanByRow[row] ?? 0);
          for (let col = 0; col < CW; col++) {
            if (colorPass >= 0 && (row + col) % 2 !== colorPass) continue;
            const i = row * CW + col;
            const uMs = uField?.[i] ?? 0;
            const vMs = vField?.[i] ?? 0;
            const inv = isWinterRow
              ? 1 - (1 - K.winterInversionAdvectionFactor) * (interior01[i] ?? 0)
              : 1;
            const advScale = seasonFactor * inv * K.zonalAdvectionCouplingWm2PerK;
            const east = row * CW + ((col + 1) % CW);
            const west = row * CW + ((col + CW - 1) % CW);
            const north = row > 0 ? (row - 1) * CW + col : i;
            const south = row < CH - 1 ? (row + 1) * CW + col : i;
            // 2D 風上結合: 東西 = u、南北 = v(v > 0 = 北向き → 南から来る)。
            // 結合は実効風速 9/5 m/s で頭打ち(u 上限 7→9: 冬の偏西風による
            // 西岸の海洋性緩和の到達を伸ばし、C/D 境界の経度波打ちを作る —
            // 実物は大西洋岸 60°N 超まで C、内陸で 45°N まで D)
            const advCu = advScale * (Math.min(9, Math.abs(uMs)) / 4);
            const upwindU = uMs >= 0 ? west : east;
            const upwindV = vMs >= 0 ? south : north;
            // v 結合は (a) 周極海峡の隔離則を尊重(迂回すると南極海が過熱)、
            // (b) 陸で強く外洋で弱い(海面温度への大気移流の掴みは小さい)
            const upwindVRow = Math.floor(upwindV / CW);
            const chanV =
              rowIsChannel[row] || rowIsChannel[upwindVRow] ? K.circumpolarChannelFactor : 1;
            const landGrip = 0.25 + 0.75 * (coarse[i]?.landFrac ?? 0);
            const advCv =
              upwindV === i
                ? 0
                : advScale * vBandW * chanV * landGrip * (Math.min(5, Math.abs(vMs)) / 4);
            const cOverDt = (capEff[i] ?? 1) / dt;
            // 界面伝導度 = 両セルの実効係数(逆転込み dfEff)の平均。
            // i→j と j→i で同一値になり、拡散項の行列が対称 = 保存的(P2-2)
            const gzE = gz * 0.5 * ((dfEff[i] ?? 1) + (dfEff[east] ?? 1));
            const gzW = gz * 0.5 * ((dfEff[i] ?? 1) + (dfEff[west] ?? 1));
            const gNEff = gN * 0.5 * ((dfEff[i] ?? 1) + (dfEff[north] ?? 1));
            const gSEff = gS * 0.5 * ((dfEff[i] ?? 1) + (dfEff[south] ?? 1));
            const diag = cOverDt + K.olrBWm2PerC + gzE + gzW + gNEff + gSEff + advCu + advCv;
            const off =
              gzE * (t[east] ?? 0) +
              gzW * (t[west] ?? 0) +
              gNEff * (t[north] ?? 0) +
              gSEff * (t[south] ?? 0) +
              advCu * (t[upwindU] ?? 0) +
              advCv * (t[upwindV] ?? 0);
            const next = ((rhs[i] ?? 0) + off) / diag;
            const d = Math.abs(next - (t[i] ?? 0));
            if (d > maxDelta) maxDelta = d;
            t[i] = next;
          }
        }
        // 極行の緩和は「1 スイープの終わり」に 1 回。赤黒では黒の後だけ
        if (colorPass < 0 || colorPass === 1) {
          // 極行の平滑も反復作用素の一部なので、その変化量も残差に算入する
          const polarDelta = relaxPolarRows(cg, t);
          if (polarDelta > maxDelta) maxDelta = polarDelta;
          sweepsUsed++;
          // 残差基準(回数固定のときは判定しない)
          if (fixedSweeps === 0 && maxDelta < EBM_SOLVE_TOLERANCE_C) {
            converged = true;
            break;
          }
        }
      }
      EBM_SOLVER_STATS.totalSweeps += sweepsUsed;
      EBM_SOLVER_STATS.steps++;
      if (sweepsUsed > EBM_SOLVER_STATS.maxSweeps) EBM_SOLVER_STATS.maxSweeps = sweepsUsed;
      if (fixedSweeps === 0 && !converged) EBM_SOLVER_STATS.capHits++;

      if (step >= (totalYears - 1) * K.ebmStepsPerYear) {
        const mIdx = Math.min(MONTHS_PER_YEAR - 1, Math.floor(yearFrac * MONTHS_PER_YEAR));
        const acc = monthAccum[mIdx];
        if (acc) {
          for (let i = 0; i < N; i++) acc[i] = (acc[i] ?? 0) + (t[i] ?? 0);
          monthCount[mIdx] = (monthCount[mIdx] ?? 0) + 1;
        }
      }
    }
    return { monthAccum, monthCount, finalT: t };
  };

  /**
   * 途中の気温場を**表示用に**組み立てる係(2026-08-03)。
   *
   * 積分の途中に得られるのは「その瞬間のモデル時刻の粗格子温度」だけで、
   * 確定結果のような月平均ではない。そこで **1 か月ぶんの時間ステップごとに
   * 1 枚ずつ**受け取り、12 枚揃った時点で 1 年ぶんの季節サイクルとみなして
   * 表示格子へ落とす(downscale は確定経路と同じものを使う — 標高減率も
   * 雪氷マスクも同じ処理になり、表示が確定版と地続きになる)。
   *
   * **これは月平均ではなく各月 1 標本のスナップショット**である。確定結果は
   * 末尾 1 年を毎ステップ積算した本物の月平均なので、両者は一致しない。
   * だから表示側は必ず「計算中」と明示すること(教訓 §1)。
   */
  const makeLiveTemperature = (): {
    absorb: (coarse: Float32Array, monthIndex: number) => TemperatureResult | null;
  } => {
    const months: Array<Float64Array | null> = new Array(MONTHS_PER_YEAR).fill(null);
    let filled = 0;
    const counts = new Array<number>(MONTHS_PER_YEAR).fill(1);
    return {
      absorb(coarse, monthIndex): TemperatureResult | null {
        let slot = months[monthIndex];
        if (!slot) {
          slot = new Float64Array(N);
          months[monthIndex] = slot;
          filled++;
        }
        slot.set(coarse);
        // 12 か月が揃うまでは出さない(穴のある季節サイクルは誤解を招く)
        if (filled < MONTHS_PER_YEAR) return null;
        return downscale(ctx, cg, months as Float64Array[], counts, gamma);
      },
    };
  };

  // ---- GPU 加速器がある場合の積分 ----
  // 加速器は「渡されたら使う」だけで、無ければ上の CPU 実装に落ちる。
  // 赤黒順序で反復するが、収束させれば線形系の解は一意なので行優先と同じ答えになる
  // (docs/実験記録_EBM赤黒順序_2026-08-01.md)
  const ebmAccel = opts?.accel?.ebm(N) ?? null;
  const f32 = (a: ArrayLike<number>, n = a.length): Float32Array => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i] ?? 0;
    return out;
  };
  const buildEbmFields = (
    permanentIce: Uint8Array | null,
    initialT?: Float64Array,
  ): EbmStaticFields => {
    const insolFlat = new Float32Array(MONTHS_PER_YEAR * CH);
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      for (let row = 0; row < CH; row++) {
        insolFlat[m * CH + row] = insolation.monthlyByRow[m]?.[row] ?? 0;
      }
    }
    const landFracArr = new Float32Array(N);
    for (let i = 0; i < N; i++) landFracArr[i] = coarse[i]?.landFrac ?? 0;
    return {
      widthCells: CW,
      heightCells: CH,
      dtSeconds: dt,
      stepsPerYear: K.ebmStepsPerYear,
      // GPU 経路では下の runOnce が years と fullCapacityYears を上書きする
      // (周期定常に達するまで年数を増やすため)。ここの値は初期値にすぎない
      years: K.ebmYears,
      fullCapacityYears:
        EBM_FULL_CAPACITY_YEARS.years > 0
          ? EBM_FULL_CAPACITY_YEARS.years
          : EBM_FULL_CAPACITY_START_YEARS,
      heatCap: f32(heatCap),
      aEff: f32(aEff),
      surfAlbedoBase: f32(surfAlbedoBase),
      iceOnset: f32(iceOnset),
      qFlux: f32(qFlux),
      elevM: f32(elevM),
      landFrac: landFracArr,
      diffFactor: f32(diffFactor),
      interior01: f32(interior01),
      permanentIce: permanentIce ? f32(permanentIce) : new Float32Array(N),
      cosCenter: f32(cosCenter),
      metricZonal: f32(metricZonal),
      rowIsChannel: f32(rowIsChannel),
      insolMonthlyByRow: insolFlat,
      insolAnnualByRow: f32(insolation.annualMeanByRow, CH),
      cloudAlbedo: cloudAlbedoMonthly,
      windU: windOnCg.u,
      windV: windOnCg.v,
      evapAnom: evapAnomWm2,
      ridgeLatN: f32(windBelt.monthlyRidgeLatNDeg),
      ridgeLatS: f32(windBelt.monthlyRidgeLatSDeg),
      meanRidgeN,
      meanRidgeS,
      initialT: initialT ? f32(initialT) : null,
    };
  };
  const ebmConstants: EbmConstants = {
    lapseRateGammaCPerM: gamma,
    iceRampWidthC: K.iceRampWidthC,
    albedoIce: K.albedoIce,
    permanentIceAlbedo: K.permanentIceAlbedo,
    seaIceInsulationFactor: K.seaIceInsulationFactor,
    olrBWm2PerC: K.olrBWm2PerC,
    diffusionBase: dBase,
    zonalDiffusionFactor: K.zonalDiffusionFactor,
    hadleyDiffusionBoost: K.hadleyDiffusionBoost,
    circumpolarChannelFactor: K.circumpolarChannelFactor,
    summerAdvectionFactor: K.summerAdvectionFactor,
    zonalAdvectionCouplingWm2PerK: K.zonalAdvectionCouplingWm2PerK,
    winterInversionDiffusionFactor: K.winterInversionDiffusionFactor,
    winterInversionAdvectionFactor: K.winterInversionAdvectionFactor,
    solveToleranceC: EBM_SOLVE_TOLERANCE_C,
    iterationsPerStep: EBM_SOLVER.sweeps > 0 ? EBM_SOLVER.sweeps : EBM_GPU_ITERATIONS,
  };
  const integrateAny = async (
    permanentIce: Uint8Array | null,
    initialT: Float64Array | undefined,
    passLabel: string,
    /** この段の進捗のうち、このパスが占める区間 [passFrom, passTo] */
    passFrom: number,
    passTo: number,
  ): Promise<{ monthAccum: Float64Array[]; monthCount: number[]; finalT: Float64Array }> => {
    if (!ebmAccel) return integrate(permanentIce, initialT, passLabel, passFrom, passTo);
    const fields = buildEbmFields(permanentIce, initialT);
    // 反復回数は**惑星ごとに必要量が違う**。地球は 512 で足りるが、全陸惑星は
    // 熱容量が小さく対角優位が弱いため足りない(2026-08-02 実測)。
    // 収束するまで倍々に増やす。回数を固定すると、地球以外で黙って
    // 未収束の答えを採用してしまう(惑星デザイナとしては致命的)
    const adaptive = EBM_SOLVER.sweeps === 0 && EBM_SOLVER.adaptive;
    // 全熱容量で回す年数も**収束するまで増やす**。海洋の時定数 τ ≈ 3.2 年に対し
    // 従来の 2 年は 0.6τ しかなく、周期定常に遠く届いていなかった(2026-08-02)。
    // 年数を固定すると、その実装詳細が答えを決めてしまう(反復回数と同じ構造)。
    const yearAdaptive = adaptive && EBM_FULL_CAPACITY_YEARS.years <= 0;
    // 自動化しない場合も、年数は既定(検証済みの出発点)を使う。
    // 予算で絞られているときは手掛かり(前回収束した回数・年数)を使わないし
    // 書きもしない。手掛かりは**確定品質の記憶**なので、プレビューが読むと
    // 予算を超え、プレビューが書くと確定品質が汚れる
    const useHint = !ebmBudgetOverridden;
    let fullYears =
      EBM_FULL_CAPACITY_YEARS.years > 0
        ? EBM_FULL_CAPACITY_YEARS.years
        : Math.max(yearAdaptive && useHint ? budgetHint.fullYears : 0, bFullYearsStart);
    let iters =
      EBM_SOLVER.sweeps > 0
        ? ebmConstants.iterationsPerStep
        : adaptive && useHint
          ? Math.max(budgetHint.iterations, bIterations)
          : bIterations;
    // 予算を倍化したか(軸ごとに分けて数える。半減の判定に使う)
    let itersEscalated = false;
    let yearsEscalated = false;
    // 予算を増やして回し直したか(進捗の見積もりが伸びたことを UI に伝える)
    let extended = false;
    // 直近の進捗(途中の気温場を流すときに添える)
    let lastFraction = passFrom;
    let lastDetail = passLabel;
    const live = makeLiveTemperature();
    const runOnce = async (): Promise<Awaited<ReturnType<typeof ebmAccel.run>>> =>
      ebmAccel.run(
        { ...fields, years: fullYears + bSpinupAccelYears, fullCapacityYears: fullYears },
        { ...ebmConstants, iterationsPerStep: iters },
        {
          signal: control.signal,
          // 段の進捗は「今のパス + 予算が伸びたか」を添えて上へ流す。
          // **パスの窓に収める**のを忘れないこと: EBM は氷床判定と確定の
          // 2 パスを回すので、素通しすると 0→1 が 2 回起きて進捗バーが
          // 巻き戻って見える
          progress: control.progress
            ? (p): void => {
                lastFraction =
                  p.fraction === null ? lastFraction : passFrom + (passTo - passFrom) * p.fraction;
                lastDetail = `${passLabel} — ${p.detail}`;
                control.progress?.({
                  fraction: lastFraction,
                  detail: lastDetail,
                  ...(extended ? { budgetExtended: true } : {}),
                });
              }
            : undefined,
          // モデル内 1 年ぶんが揃うたびに、表示格子へ落とした気温を流す
          onCoarseSnapshot: control.progress
            ? (s): void => {
                const temperature = live.absorb(s.valuesC, s.monthIndex);
                if (!temperature) return;
                control.progress?.({
                  fraction: lastFraction,
                  detail: lastDetail,
                  ...(extended ? { budgetExtended: true } : {}),
                  partial: { temperature },
                });
              }
            : undefined,
        },
      );
    let r = await runOnce();
    while (adaptive && !r.converged && iters < bMaxIterations) {
      iters *= 2;
      extended = true;
      itersEscalated = true;
      r = await runOnce();
    }
    while (
      yearAdaptive &&
      r.meanYearDriftC > EBM_PERIODIC_TOLERANCE_C &&
      fullYears < bMaxFullYears
    ) {
      fullYears *= 2;
      extended = true;
      yearsEscalated = true;
      r = await runOnce();
      while (!r.converged && iters < bMaxIterations) {
        iters *= 2;
        itersEscalated = true;
        r = await runOnce();
      }
    }
    // 手掛かりの更新。**倍化が要らなかった回が続いたら半減して既定へ寄せる**
    // (上げるだけにすると払い過ぎが永久に残る。宣言部の注記を参照)
    if (useHint && adaptive && r.converged) {
      budgetHint.iterations = iters;
      if (itersEscalated) budgetHint.easyIterations = 0;
      else if (++budgetHint.easyIterations >= HINT_DECAY_AFTER) {
        budgetHint.iterations = Math.max(EBM_GPU_ITERATIONS, Math.floor(iters / 2));
        budgetHint.easyIterations = 0;
      }
    }
    if (useHint && yearAdaptive && r.meanYearDriftC <= EBM_PERIODIC_TOLERANCE_C) {
      budgetHint.fullYears = fullYears;
      if (yearsEscalated) budgetHint.easyYears = 0;
      else if (++budgetHint.easyYears >= HINT_DECAY_AFTER) {
        budgetHint.fullYears = Math.max(EBM_FULL_CAPACITY_START_YEARS, Math.floor(fullYears / 2));
        budgetHint.easyYears = 0;
      }
    }
    EBM_SOLVER_STATS.maxYearDriftC = Math.max(EBM_SOLVER_STATS.maxYearDriftC, r.maxYearDriftC);
    EBM_SOLVER_STATS.meanYearDriftC = Math.max(EBM_SOLVER_STATS.meanYearDriftC, r.meanYearDriftC);
    EBM_SOLVER_STATS.fullCapacityYears = fullYears;
    EBM_SOLVER_STATS.maxResidualC = Math.max(EBM_SOLVER_STATS.maxResidualC, r.maxResidualC);
    if (iters > EBM_SOLVER_STATS.maxSweeps) EBM_SOLVER_STATS.maxSweeps = iters;
    // 予算内で収束しなかった / 周期定常に達しなかったら診断に残す。
    // 較正はこれを見て評価そのものを失格にする(黙って採用しない)
    if (!r.converged || r.meanYearDriftC > EBM_PERIODIC_TOLERANCE_C) {
      EBM_SOLVER_STATS.capHits++;
    }
    const toF64 = (a: Float32Array): Float64Array => {
      const out = new Float64Array(a.length);
      out.set(a);
      return out;
    };
    return {
      monthAccum: r.monthAccum.map(toF64),
      monthCount: r.monthCount,
      finalT: toF64(r.finalT),
    };
  };

  // パス 1: 恒常氷なしで積分 → 年平均と最暖月の複合条件で氷床を判定
  // (年平均だけではシベリア(夏 +19°C)を誤って氷床にしてしまう)
  const pass1 = await integrateAny(null, undefined, '氷床判定パス (1/2)', 0, 0.5);
  const permanentIce = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let annual = 0;
    let warmest = -1e9;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const v = (pass1.monthAccum[m]?.[i] ?? 0) / Math.max(1, pass1.monthCount[m] ?? 1);
      annual += v;
      if (v > warmest) warmest = v;
    }
    const elevOffset = gamma * (elevM[i] ?? 0);
    annual = annual / MONTHS_PER_YEAR - elevOffset;
    warmest -= elevOffset;
    // 恒常氷床は陸優勢セルのみ(海氷は薄く季節性で、夏は融解が 0°C 近傍に張り付く)
    const landDominant = (coarse[i]?.landFrac ?? 0) > 0.5;
    if (
      landDominant &&
      annual < K.permanentIceAnnualMeanC &&
      warmest < K.permanentIceWarmestMonthC
    ) {
      permanentIce[i] = 1;
    }
  }
  // 氷床の隣接拡張: 氷床は流動し周囲を冷やすため、核に隣接する冷涼な陸へ広げる
  // (無記憶モデルでは日射だけで沿岸氷床を自発形成できないことへの近似)
  for (let iter = 0; iter < 2; iter++) {
    let changed = false;
    for (let i = 0; i < N; i++) {
      if (permanentIce[i]) continue;
      if ((coarse[i]?.landFrac ?? 0) <= 0.5) continue;
      let warmest = -1e9;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = (pass1.monthAccum[m]?.[i] ?? 0) / Math.max(1, pass1.monthCount[m] ?? 1);
        if (v > warmest) warmest = v;
      }
      warmest -= gamma * (elevM[i] ?? 0);
      if (warmest >= 3) continue;
      const row = Math.floor(i / CW);
      const col = i % CW;
      const nbs = [
        row > 0 ? (row - 1) * CW + col : -1,
        row < CH - 1 ? (row + 1) * CW + col : -1,
        row * CW + ((col + 1) % CW),
        row * CW + ((col + CW - 1) % CW),
      ];
      if (nbs.some((nb) => nb >= 0 && permanentIce[nb])) {
        permanentIce[i] = 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // パス 2: 氷床アルベドを反映して確定
  const pass2 = await integrateAny(permanentIce, pass1.finalT, '確定パス (2/2)', 0.5, 1);

  return downscale(ctx, cg, pass2.monthAccum, pass2.monthCount, gamma);
}

function aggregateToCoarse(
  ctx: SimContext,
  refGrid: Grid,
  refTerrain: TerrainField,
  ocean: OceanCurrentResult,
  cg: Grid,
): CoarseCell[] {
  // 粗セルに入る細セルは**中心が範囲に入るか**で決める。
  // 旧実装は `row * round(比)` の添字ブロックで拾っていたため、比が整数で
  // ないと破綻した(1.5° 対 1° では比 = 2 となり、粗格子の南半球が参照格子の
  // 範囲外を読んで全部海になる。2026-08-02 実測で大分類 53.10 まで落ちる)。
  // 整数比のときは従来と同じブロックになる(中心 (fr+0.5)·refRes が
  // [row·cgRes, (row+1)·cgRes) に入る細行は row·f + 0..f-1 に一致)。
  const forEachFine = (
    row: number,
    col: number,
    fine: Grid,
    visit: (index: number) => void,
  ): void => {
    const rRatio = cg.resolutionDeg / fine.resolutionDeg;
    const frLo = Math.max(0, Math.floor(row * rRatio - 0.5));
    const frHi = Math.min(fine.heightCells - 1, Math.ceil((row + 1) * rRatio));
    const fcLo = Math.floor(col * rRatio - 0.5);
    const fcHi = Math.ceil((col + 1) * rRatio);
    for (let fr = frLo; fr <= frHi; fr++) {
      const centerDegN = (fr + 0.5) * fine.resolutionDeg;
      if (centerDegN < row * cg.resolutionDeg || centerDegN >= (row + 1) * cg.resolutionDeg) {
        continue;
      }
      for (let fc = fcLo; fc <= fcHi; fc++) {
        const centerDegE = (fc + 0.5) * fine.resolutionDeg;
        if (centerDegE < col * cg.resolutionDeg || centerDegE >= (col + 1) * cg.resolutionDeg) {
          continue;
        }
        const wrapped = ((fc % fine.widthCells) + fine.widthCells) % fine.widthCells;
        visit(fr * fine.widthCells + wrapped);
      }
    }
  };
  const out: CoarseCell[] = new Array(cg.cellCount);
  for (let row = 0; row < cg.heightCells; row++) {
    for (let col = 0; col < cg.widthCells; col++) {
      let n = 0;
      let landN = 0;
      let landElevSum = 0;
      forEachFine(row, col, refGrid, (i) => {
        n++;
        if (refTerrain.landMask[i]) {
          landN++;
          landElevSum += refTerrain.elevationMeters[i] ?? 0;
        }
      });
      // SST 偏差は表示格子(Step 3 の出力)から集約
      let sstSum = 0;
      let oceanN = 0;
      forEachFine(row, col, ctx.grid, (i) => {
        if (!ctx.terrain.landMask[i]) {
          oceanN++;
          sstSum += ocean.sstAnomalyC[i] ?? 0;
        }
      });
      out[row * cg.widthCells + col] = {
        landFrac: n > 0 ? landN / n : 0,
        meanLandElevM: landN > 0 ? landElevSum / landN : 0,
        sstAnomalyC: oceanN > 0 ? sstSum / oceanN : 0,
      };
    }
  }
  return out;
}

/**
 * 蒸発冷却の偏差フラックス(W/m²、月別・EBM 格子)。陸セルの降水(mm/日)の
 * 「陸面平均に対する偏差」× 係数。湿潤陸は正(冷却)、乾燥陸は負(乾熱)。
 * 偏差なので陸全体では中立(全球平均を動かさない)。海は 0。
 */
function buildEvapCoolingAnomaly(
  ctx: SimContext,
  monthlyPrecipMm: Float32Array[],
  cg: Grid,
  coarse: CoarseCell[],
): Float32Array[] {
  const src = ctx.grid;
  const out: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const p = monthlyPrecipMm[m];
    const field = new Float32Array(cg.cellCount);
    const n = new Float32Array(cg.cellCount);
    if (p) {
      for (let row = 0; row < src.heightCells; row++) {
        const cgRow = Math.min(
          cg.heightCells - 1,
          Math.floor((row * src.resolutionDeg) / cg.resolutionDeg),
        );
        for (let col = 0; col < src.widthCells; col++) {
          if (!ctx.terrain.landMask[row * src.widthCells + col]) continue;
          const cgCol = Math.min(
            cg.widthCells - 1,
            Math.floor((col * src.resolutionDeg) / cg.resolutionDeg),
          );
          const ci = cgRow * cg.widthCells + cgCol;
          field[ci] = (field[ci] ?? 0) + (p[row * src.widthCells + col] ?? 0);
          n[ci] = (n[ci] ?? 0) + 1;
        }
      }
    }
    // 陸面平均(面積重み近似: セル数)を引いて偏差化し、W/m² へ
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < cg.cellCount; i++) {
      if ((n[i] ?? 0) > 0) {
        field[i] = (field[i] ?? 0) / (n[i] ?? 1) / 30; // mm/月 → mm/日
        sum += field[i] ?? 0;
        cnt++;
      }
    }
    const meanMmDay = cnt > 0 ? sum / cnt : 0;
    for (let i = 0; i < cg.cellCount; i++) {
      const landFrac = coarse[i]?.landFrac ?? 0;
      if ((n[i] ?? 0) > 0 && landFrac > 0.2) {
        const anomMmDay = Math.max(-3, Math.min(5, (field[i] ?? 0) - meanMmDay));
        field[i] = K.evapCoolingWm2PerMmDay * anomMmDay * landFrac;
      } else {
        field[i] = 0;
      }
    }
    out.push(field);
  }
  return out;
}

/**
 * 月別 2D 風(表示格子)を EBM 格子へ平均集約する。
 * 移流結合の風上方向・強度に使う(旧・帯状移流の置換、2026-07-30)
 */
function aggregateWinds(
  ctx: SimContext,
  airflow: AirflowResult,
  cg: Grid,
): { u: Float32Array[]; v: Float32Array[] } {
  const src = ctx.grid;
  const uMonthly: Float32Array[] = [];
  const vMonthly: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const su = airflow.monthlyWindU[m];
    const sv = airflow.monthlyWindV[m];
    const u = new Float32Array(cg.cellCount);
    const v = new Float32Array(cg.cellCount);
    const n = new Float32Array(cg.cellCount);
    if (su && sv) {
      for (let row = 0; row < src.heightCells; row++) {
        const cgRow = Math.min(
          cg.heightCells - 1,
          Math.floor((row * src.resolutionDeg) / cg.resolutionDeg),
        );
        for (let col = 0; col < src.widthCells; col++) {
          const cgCol = Math.min(
            cg.widthCells - 1,
            Math.floor((col * src.resolutionDeg) / cg.resolutionDeg),
          );
          const ci = cgRow * cg.widthCells + cgCol;
          const i = row * src.widthCells + col;
          u[ci] = (u[ci] ?? 0) + (su[i] ?? 0);
          v[ci] = (v[ci] ?? 0) + (sv[i] ?? 0);
          n[ci] = (n[ci] ?? 0) + 1;
        }
      }
      for (let i = 0; i < cg.cellCount; i++) {
        const c = Math.max(1, n[i] ?? 1);
        u[i] = (u[i] ?? 0) / c;
        v[i] = (v[i] ?? 0) / c;
      }
    }
    uMonthly.push(u);
    vMonthly.push(v);
  }
  return { u: uMonthly, v: vMonthly };
}

/**
 * 極行の帯状平滑。**反復作用素の一部**であり、スイープの後に毎回掛かる。
 * したがって収束解では極行が経度方向に一様になる(relax(t*) = t* の条件)。
 * @returns この操作で動いた最大 |Δt|(°C)。残差基準に算入する
 */
function relaxPolarRows(cg: Grid, t: Float64Array): number {
  const CW = cg.widthCells;
  let maxDelta = 0;
  for (let row = 0; row < cg.heightCells; row++) {
    const lat = latDegOfRow(cg, row);
    if (Math.abs(lat) < 84) continue;
    let sum = 0;
    for (let col = 0; col < CW; col++) sum += t[row * CW + col] ?? 0;
    const mean = sum / CW;
    for (let col = 0; col < CW; col++) {
      const i = row * CW + col;
      const next = (t[i] ?? 0) * 0.5 + mean * 0.5;
      const d = Math.abs(next - (t[i] ?? 0));
      if (d > maxDelta) maxDelta = d;
      t[i] = next;
    }
  }
  return maxDelta;
}

function downscale(
  ctx: SimContext,
  cg: Grid,
  monthAccum: Float64Array[],
  monthCount: number[],
  gamma: number,
): TemperatureResult {
  const { grid, terrain } = ctx;
  const monthlyTemperatureC: Float32Array[] = [];
  const monthlyIceMask: Uint8Array[] = [];
  const annualMeanC = new Float32Array(grid.cellCount);
  const warmestMonthC = new Float32Array(grid.cellCount).fill(-1e9);
  const coldestMonthC = new Float32Array(grid.cellCount).fill(1e9);

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const acc = monthAccum[m];
    const count = Math.max(1, monthCount[m] ?? 1);
    const out = new Float32Array(grid.cellCount);
    const ice = new Uint8Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        const tSl = bilinearSample(cg, acc, lat, lon) / count;
        const elev = terrain.landMask[i] ? Math.max(0, terrain.elevationMeters[i] ?? 0) : 0;
        const tSurf = tSl - gamma * elev;
        out[i] = tSurf;
        const freeze = terrain.landMask[i] ? -1 : K.seaFreezeC;
        if (tSurf < freeze) ice[i] = 1;
        annualMeanC[i] = (annualMeanC[i] ?? 0) + tSurf / MONTHS_PER_YEAR;
        if (tSurf > (warmestMonthC[i] ?? -1e9)) warmestMonthC[i] = tSurf;
        if (tSurf < (coldestMonthC[i] ?? 1e9)) coldestMonthC[i] = tSurf;
      }
    }
    monthlyTemperatureC.push(out);
    monthlyIceMask.push(ice);
  }
  return { monthlyTemperatureC, annualMeanC, warmestMonthC, coldestMonthC, monthlyIceMask };
}

function bilinearSample(
  cg: Grid,
  field: Float64Array | undefined,
  latDeg: number,
  lonDeg: number,
): number {
  if (!field) return 0;
  const CW = cg.widthCells;
  const CH = cg.heightCells;
  const fy = (90 - latDeg) / cg.resolutionDeg - 0.5;
  const fx = (lonDeg + 180) / cg.resolutionDeg - 0.5;
  const y0 = Math.max(0, Math.min(CH - 1, Math.floor(fy)));
  const y1 = Math.max(0, Math.min(CH - 1, y0 + 1));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const x0f = Math.floor(fx);
  const tx = fx - x0f;
  const x0 = ((x0f % CW) + CW) % CW;
  const x1 = (x0 + 1) % CW;
  const v00 = field[y0 * CW + x0] ?? 0;
  const v10 = field[y0 * CW + x1] ?? 0;
  const v01 = field[y1 * CW + x0] ?? 0;
  const v11 = field[y1 * CW + x1] ?? 0;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}
