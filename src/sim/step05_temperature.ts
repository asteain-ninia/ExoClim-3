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
  LandSurfaceState,
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
  /**
   * 直近に周期定常へ達した全熱容量年数(0 = 記憶なし)。
   * **冷間と温間で別々に持つ**。ウォームスタートは前回の収束場から始めるので
   * 必要な年数が桁で違う。1 本にすると冷間の記憶(24 年)が温間の出発点(4 年)を
   * max で上書きしてしまい、**ウォームスタートが一切効かなくなる**
   * (2026-08-05 に実測。v3 は完全一致したのに所要時間が縮まなかった)。
   */
  fullYears: 0,
  fullYearsWarm: 0,
  /** 倍化せずに済んだ連続回数(半減の判定用) */
  easyIterations: 0,
  easyYears: 0,
  easyYearsWarm: 0,
};

/** 試験・診断から手掛かりを初期化する(較正ワーカーの再現性の検査用) */
export function resetEbmBudgetHint(): void {
  budgetHint.iterations = EBM_GPU_ITERATIONS;
  budgetHint.fullYears = 0;
  budgetHint.fullYearsWarm = 0;
  budgetHint.easyIterations = 0;
  budgetHint.easyYears = 0;
  budgetHint.easyYearsWarm = 0;
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
 * 加速期の熱容量倍率。**名前を持たない数として CPU と GPU に 2 か所
 * ベタ書きされていたものを 1 か所へ集めた**(2026-08-11)。
 *
 * この倍率は**2 つのものを同時に買っている**:
 *   - 緩和が速くなる(時定数 τ' = τ × 倍率。1/16 なら τ' = 0.2 年)
 *   - **反復が効かなくなる**(陰解法の対角項 C/dt が同じ比で小さくなり、
 *     対角優位が崩れる。加速期だけが反復 512 回を要求している —
 *     docs/実験記録_加速期だけが反復を要る_2026-08-10.md)
 *
 * 片方だけを見て 1/16 と決められた形跡があり、対で測られていない。
 * 事前登録: docs/事前登録_加速期の倍率と反復回数_2026-08-11.md
 *
 * 掃引のために可変にしてあるが、**較正つまみではない**(物理定数ではなく
 * 数値解法の設定で、答えは倍率に依らないことを判定 1 で確かめる)。
 */
export const EBM_SPINUP = {
  capacityFraction: 1 / 16,
};

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

/**
 * **ウォームスタート時**の全熱容量年数の出発点。
 *
 * 前の評価の収束温度場から始める場合、24 年ぶん空回しする必要はない。
 * 短いところから試し、年次ドリフトが許容差を満たさなければ従来どおり
 * 倍々に増やす — **判定は同じなので答えは変わらず、無駄な年数だけ減る**。
 *
 * 4 の根拠: 海洋混合層の時定数 τ ≈ 3.2 年に対し 1.25τ。近い初期値からなら
 * 残差はこの程度で落ちるという見積もりで、足りなければ 8 → 16 → 24 と自動で
 * 伸びる(損は回し直し 1 回ぶん)。**実測で詰める**。
 */
export const EBM_WARM_START_FULL_YEARS = 4;

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
  /**
   * 呼び出し 1 回ごとの内訳。**費用の 88% がここなので、どのパスが何年
   * 回したかを残さないと削りようがない。** 倍化の梯子は毎回ゼロから
   * 回し直すので、`years` は最後の 1 回ぶんではなく**積算**を入れる
   */
  calls: [] as Array<{ warm: boolean; years: number; iters: number }>,
  /** [step] 最後のパスのステップ別残差(GPU 経路のみ)。診断で使う */
  stepResidualsC: null as Float32Array | null,
};

/**
 * 検証専用の捕捉箱(scripts/diag_ebm_batch_equiv.ts が使う)。
 *
 * enabled のとき、GPU 経路が加速器の run() へ渡した**最後の**入力
 * (fields / constants)をそのまま控える。同値検証は「本物のパイプラインが
 * 実際に渡す入力」を単発版とバッチ版の両方へ与えたいが、fields の組み立ては
 * この段の閉包の奥にあり外から再現できない。そこで**入口で控える**。
 * 既定は無効で、パイプラインの挙動には一切影響しない。
 */
export const EBM_CAPTURE: {
  enabled: boolean;
  fields: EbmStaticFields | null;
  constants: EbmConstants | null;
} = { enabled: false, fields: null, constants: null };

/** 診断を初期化する。パイプラインの入口で 1 回だけ呼ぶ */
export function resetEbmSolverStats(): void {
  EBM_SOLVER_STATS.totalSweeps = 0;
  EBM_SOLVER_STATS.steps = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  EBM_SOLVER_STATS.capHits = 0;
  EBM_SOLVER_STATS.maxResidualC = 0;
  EBM_SOLVER_STATS.maxYearDriftC = 0;
  EBM_SOLVER_STATS.meanYearDriftC = 0;
  EBM_SOLVER_STATS.fullCapacityYears = 0;
  EBM_SOLVER_STATS.calls.length = 0;
  EBM_SOLVER_STATS.stepResidualsC = null;
}

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
  /**
   * 前パスの陸面の状態(2 パス目でのみ渡る)。**降水ではなく蒸発散を読む** —
   * 理由は types.ts の LandSurfaceState を参照
   */
  priorSurface?: {
    land?: LandSurfaceState;
    /**
     * 前パスの月別気温(1° 格子)。蒸発帰還を線形化する基準点 T_ref。
     * **蒸発散を計算したときの気温**でなければ展開の意味が無いので、
     * land と同じパスのものを渡すこと
     */
    priorTemperatureC?: Float32Array[];
    /**
     * 前パスの月別降水(1° 格子、mm/月)。陸の対流雲の駆動量。
     * **飽和させて使う**ので降水の誤差が温度へ増幅されない
     */
    priorPrecipMm?: Float32Array[];
    /**
     * 前パスの月別可降水量 W(1° 格子、mm)。OLR の水蒸気構造
     * (olrWaterTrapWm2)が読む。2026-08-30
     */
    priorWaterMm?: Float32Array[];
  },
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
  // ---- ウォームスタート(較正の高速化。答えは変えない)----
  // セル数が合わないときは使わない(解像度を変えたときに前の場を使い回さない)
  const warmBox = opts?.ebmWarmStart;
  const warmField =
    warmBox?.field && warmBox.field.length === N ? warmBox.field : null;
  const warmT: Float64Array | undefined = warmField
    ? (() => {
        const a = new Float64Array(N);
        a.set(warmField);
        return a;
      })()
    : undefined;
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
  //
  // **二値では細い大陸を巻き込む**(2026-08-12)。南米南部が乗る行は陸割合
  // 1.7〜3.3% で閾値 4% を下回るため、パタゴニアが「遮られていない海峡」と
  // 判定されていた。海峡行は 南北拡散 0.48 倍・雲 +54%・混合層 3 倍を同時に
  // 受け、**3 つとも冷やす向き**。最暖月が 6°C 低い原因の第一候補である。
  // 遮蔽の物理は「流れが陸に当たる割合」なので、陸割合に連続に効くのが筋。
  // `channelnessLinear` が 0 のときは従来の階段(0/1)で厳密に一致する
  const rowIsChannel = new Float32Array(CH);
  for (let row = 0; row < CH; row++) {
    if (Math.abs(latDegOfRow(cg, row)) > K.channelMaxAbsLatDeg) continue;
    let landSum = 0;
    for (let col = 0; col < CW; col++) landSum += coarse[row * CW + col]?.landFrac ?? 0;
    const frac = landSum / CW;
    rowIsChannel[row] =
      K.channelnessLinear > 0
        ? Math.max(0, 1 - frac / Math.max(1e-9, K.channelLandFracMax))
        : frac < K.channelLandFracMax
          ? 1
          : 0;
  }

  // ---- セル定数 ----
  // 陸の熱容量に効く年平均の湿り具合(EBM 格子、0〜1。2 パス目でのみ入る)。
  // **年平均を使うのは意図的** — 熱容量を月ごとに変えると季節を通した
  // エネルギーの積算が保存しない(夏に容量を減らして冬に戻すと、その差分だけ
  // 熱が湧いて消える)。年平均なら時間積分の中で定数のままでいられる。
  const landWetnessAnnual: Float64Array | null = priorSurface?.land
    ? buildAnnualWetness(ctx, priorSurface.land.monthlyWetness01, cg)
    : null;
  const atm = params.atmosphere;
  const aBase =
    K.olrAWm2 - K.greenhouseDeltaAWm2 * Math.log2(Math.max(0.05, atm.greenhouseStrength));
  const gamma = K.lapseRateCPerKm / 1000;
  const heatCap = new Float64Array(N);
  const insCapFrac = new Float64Array(N);
  const aEff = new Float64Array(N);
  const surfAlbedoBase = new Float64Array(N);
  const iceOnset = new Float64Array(N);
  const qFlux = new Float64Array(N);
  const elevM = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = coarse[i];
    if (!c) continue;
    const row = Math.floor(i / CW);
    // 陸の実効熱容量は**土壌の湿り具合で変わる**。乾いた土は熱伝導率が落ちて
    // 熱が浅くしか染み込まず、動く質量が減るので日射に速く応答する
    // (だから砂漠の夏は暑く冬は冷える)。導出は constants.ts の
    // landDryCapacityFrac を参照 — 土壌水の熱容量そのものではなく、
    // 減衰深度 d = √(2k/ρcω) が効く。frac = 1 で従来と厳密に一致する。
    //
    // 根拠(2026-08-03、scripts/diag_range_vs_wetness.ts):
    //   砂漠(<100mm)の最暖月が −5.11°C(夏が寒すぎる)= 熱容量が過大。
    // 湿り具合はその惑星の土壌水分から出るので、地球固有の量は入らない。
    const wet = landWetnessAnnual ? (landWetnessAnnual[i] ?? 0) : 1;
    const dryFrac = Math.min(1, Math.max(0, K.landDryCapacityFrac));
    const landDepth = Math.max(
      0.05,
      K.landEffectiveWaterDepthM * (dryFrac + (1 - dryFrac) * wet) +
        0.5 * (atm.surfacePressureBar - 1),
    );
    let oceanDepth = atm.oceanMixedLayerDepthM + 2.4 * atm.surfacePressureBar;
    oceanDepth *= 1 + (K.channelMixedLayerBoost - 1) * (rowIsChannel[row] ?? 0);
    heatCap[i] = RHO_C_WATER * (c.landFrac * landDepth + (1 - c.landFrac) * oceanDepth);
    // 熱容量に占める海成分の割合(2026-08-25、海氷断熱の混合セル修正。
    // 純海 = 1(x/x)・純陸 = 0 が厳密に出る。
    // docs/事前登録_海氷断熱の混合セル修正_2026-08-25.md)
    insCapFrac[i] =
      heatCap[i]! > 0 ? (RHO_C_WATER * (1 - c.landFrac) * oceanDepth) / heatCap[i]! : 0;
    const h = c.landFrac * Math.max(0, c.meanLandElevM);
    elevM[i] = h;
    aEff[i] = aBase - K.olrBWm2PerC * gamma * h;
    surfAlbedoBase[i] = K.albedoLand * c.landFrac + K.albedoOcean * (1 - c.landFrac);
    iceOnset[i] = K.iceOnsetC * c.landFrac + K.seaFreezeC * (1 - c.landFrac);
    qFlux[i] = K.sstAnomalyCouplingWm2PerK * c.sstAnomalyC * (1 - c.landFrac);
  }
  // ---- OLR の水蒸気構造(2026-08-30、既定 0 ビット一致)----
  // 前パスの W 年平均を EBM 格子へ集約し、aEff へ −trap·ln(1+W/ref) を加える。
  // 面積平均は差し引く(構造だけを与え、全球平衡は olrA が持つ)
  if ((K.olrWaterTrapWm2 as number) > 0 && priorSurface?.priorWaterMm?.length === 12) {
    const fgrid = ctx.grid;
    const f = Math.max(1, Math.round(cg.resolutionDeg / fgrid.resolutionDeg));
    const wm = priorSurface.priorWaterMm;
    const trapTerm = new Float64Array(N);
    let tSum = 0;
    let tW = 0;
    for (let row = 0; row < CH; row++) {
      const aw = Math.cos((latDegOfRow(cg, row) * Math.PI) / 180);
      for (let col = 0; col < CW; col++) {
        const i = row * CW + col;
        let s = 0;
        let n = 0;
        for (let dr = 0; dr < f; dr++) {
          for (let dc = 0; dc < f; dc++) {
            const fr = row * f + dr;
            const fc = col * f + dc;
            if (fr >= fgrid.heightCells || fc >= fgrid.widthCells) continue;
            const fi = fr * fgrid.widthCells + fc;
            for (let m = 0; m < 12; m++) s += wm[m]?.[fi] ?? 0;
            n += 12;
          }
        }
        const wAnn = n > 0 ? s / n : 0;
        trapTerm[i] = K.olrWaterTrapWm2 * Math.log(1 + wAnn / Math.max(0.1, K.olrWaterRefMm));
        tSum += aw * (trapTerm[i] ?? 0);
        tW += aw;
      }
    }
    const tMean = tW > 0 ? tSum / tW : 0;
    for (let i = 0; i < N; i++) aEff[i] = (aEff[i] ?? 0) - ((trapTerm[i] ?? 0) - tMean);
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
  // 陸の対流・前線雲の駆動量(EBM 格子・月別の陸降水 mm/月)。
  // 無効(landCloudBoost = 0)なら作らない = 従来と厳密に一致する
  const landPrecipCg: Float32Array[] | null =
    priorSurface?.priorPrecipMm && K.landCloudBoost > 0
      ? coarsenLandField(ctx, priorSurface.priorPrecipMm, cg)
      : null;
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
        const chanCloud = K.channelCloudBoost * oceanFrac * (rowIsChannel[row] ?? 0);
        // 陸の対流・前線雲。**海側の項がすべて oceanFrac 倍で入っている**ため、
        // これが無いと中高緯度の夏の大陸は月 100mm 降っていても雲が基準値のまま。
        // 供給を飽和させるので、降水が過大な場所でも雲は上限で止まる
        const landCloud =
          landPrecipCg && K.landCloudBoost > 0
            ? K.landCloudBoost *
              landFrac *
              Math.min(1, (landPrecipCg[m]?.[i] ?? 0) / K.landCloudSupplyNormMm)
            : 0;
        const factor =
          1 -
          K.subsidenceCloudReduction * subsidenceWeight * ridgeProx * (1 - itczInf) +
          K.convectiveCloudBoost * itczInf +
          K.stormTrackCloudBoost * stormW * oceanFrac +
          scDeck +
          chanCloud +
          landCloud;
        const capMax = K.cloudAlbedoMax + 0.08 * (rowIsChannel[row] ?? 0);
        field[i] = Math.min(capMax, Math.max(0.04, atm.cloudAlbedo * factor));
      }
    }
    cloudAlbedoMonthly.push(field);
  }

  // ---- 拡散・移流係数 ----
  const dPhi = (cg.resolutionDeg * Math.PI) / 180;
  const radiusRatio = 6371 / params.body.radiusKm;
  // 大気質量への依存(段 40)。南北熱輸送は大気の質量流量に比例する成分を持つ。
  // **地球(1 bar)では厳密に 1 になるので、地球の結果は 1 ビットも動かない。**
  // これが無いと気圧を 4 倍にしても赤道-極差が 0.1°C しか動かなかった
  // (2026-08-16 の惑星応答の初測定)
  const pressureFactor = Math.pow(
    Math.max(0.05, atm.surfacePressureBar),
    K.heatTransportPressureExponent,
  );
  const dBase =
    K.diffusionWm2PerK *
    radiusRatio *
    radiusRatio *
    pressureFactor *
    Math.max(0.1, atm.heatTransportStrength);
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

  // 蒸発冷却フィードバック: 湿った陸は潜熱で冷え、乾いた陸は乾熱で暑い
  // (実在の砂漠の暑さ・雨林の冷涼)。前パスの**実蒸発散**の
  // 「陸平均に対する偏差」を月別フラックスにする(偏差なので全球中立)。
  //
  // 2026-08-03 の診断が繋ぎ替えの根拠(scripts/diag_range_vs_wetness.ts):
  //   中緯度半乾燥(30〜60°N, 250〜800mm) … 最暖月 +5.00°C(夏が暑すぎる)
  //   砂漠(<100mm)                       … 最暖月 −5.11°C(夏が寒すぎる)
  // 夏の誤差が湿り具合で符号を変える = 陸面の水の扱いが欠けている印。
  // 熱容量だけでは説明できない(熱容量は夏と冬を対称に効かせるため)。
  //
  // 2026-07-30 に**降水で代用して**実測破綻した経緯がある(係数 12 で
  // 気温 RMSE 4.85 → 6.76、「降水誤差が温度誤差へ増幅される正帰還」)。
  // 物理量が違ったのが原因という読み — 詳細は types.ts の LandSurfaceState。
  const evapAnomWm2: Float32Array[] | null =
    priorSurface?.land && K.evapCoolingWm2PerMmDay > 0
      ? buildEvapCoolingAnomaly(ctx, priorSurface.land.monthlyEtMm, cg, coarse)
      : null;
  // 蒸発帰還(∂LE/∂T)。陽的な冷却と独立に効かせられるよう、条件も独立に持つ
  const evapFb =
    priorSurface?.land && priorSurface.priorTemperatureC && K.evapFeedbackFrac > 0
      ? buildEvapFeedback(
          ctx,
          priorSurface.land.monthlyEtMm,
          priorSurface.priorTemperatureC,
          cg,
          coarse,
        )
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
    /**
     * 前パスの氷厚。**気温と同じく引き継ぐ**(2026-08-04)。
     * 0 層模型は氷厚を状態に持つので、パス 2 をゼロから始めると
     * 実効の緩和年数が半分になり、周期定常に届かない
     */
    initialIce?: Float64Array,
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
    /**
     * 海氷の厚さ(水等価 mm)。**0 層模型のときだけ使う状態**。
     * 時間ステップをまたいで持ち越すので、周期定常の判定にも効く。
     */
    const iceMm = new Float64Array(N);
    if (initialIce) iceMm.set(initialIce);
    /** 伝導コンダクタンス k/h(W/m²/K)。0 層模型のときだけ非零 */
    const iceCond = new Float64Array(N);
    /** 蒸発帰還 ∂LE/∂T(W/m²/K)。月の按分込み。無効なら全 0 のまま */
    const evapK = new Float64Array(N);
    const slabIce = K.seaIceModel > 0;
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
      const capScale = step < spinupSteps ? EBM_SPINUP.capacityFraction : 1;
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
          // **陸の季節雪と海氷は別の量**。混ぜると 0 層模型を入れた途端に
          // 陸の雪アルベドが消える(氷厚は海セルにしか育たないため)。
          //   陸 … 気温で決まる季節雪(実効値。融解・森林マスキング込み)
          //   海 … 0 層模型なら**氷量**で決まる。温度で決めると
          //         「冷たいほど断熱が強く、断熱が強いほど冷える」正帰還になり
          //         両極が固着する(2026-08-04 実測)
          const snowW = Math.min(
            1,
            Math.max(0, ((iceOnset[i] ?? 0) - tSurf) / K.iceRampWidthC),
          );
          // 氷量を被覆率の代理にして**連続**にする。二値だと融けた瞬間に
          // アルベドが 0.39 → 0.07 へ跳び、白夜の日射で夏が暴走する
          const seaW = slabIce
            ? Math.min(1, (iceMm[i] ?? 0) / K.seaIceCoverScaleMm)
            : snowW;
          const oceanFrac = 1 - (coarse[i]?.landFrac ?? 0);
          const landFrac = 1 - oceanFrac;
          // 0 層模型が無効なら混合式を通さない。landFrac*w + oceanFrac*w は
          // 数学的には w だが浮動小数では 1ulp ずれることがあり、
          // 「無効なら旧と完全一致」という来歴の保証が壊れる
          const iceW = slabIce ? landFrac * snowW + oceanFrac * seaW : snowW;
          let aSurf =
            (surfAlbedoBase[i] ?? 0.15) + (K.albedoIce - (surfAlbedoBase[i] ?? 0.15)) * iceW;
          if (permanentIce?.[i]) aSurf = Math.max(aSurf, K.permanentIceAlbedo);
          const cloud = (cloud0?.[i] ?? 0.2) * (1 - frac) + (cloud1?.[i] ?? 0.2) * frac;
          const albedo = cloud + (1 - cloud) * aSurf;
          // 海氷断熱: 氷結海面は混合層を切り離し実効熱容量が陸並みに落ちる
          // (極域の季節振幅の再現に必須 — constants.seaIceInsulationFactor 参照)。
          // **断熱は海の側だけ**の現象。旧式は seaW × oceanFrac(面積率)を
          // 混合後の全熱容量に掛けていたため、混合セルでは陸成分まで鈍らせ
          // 氷結時の実効熱容量が約 10 倍過大だった(2026-08-25 監査指摘・
          // 実測 振幅誤差 −6.6°C 対 純陸 −2.9)。掛け先を **容量に占める
          // 海成分の割合 insCapFrac = C_ocean成分 / C_全体** に直す。
          // 純海(=1)・純陸(=0)は旧式と厳密に同値。GPU カーネルも同式。
          // docs/事前登録_海氷断熱の混合セル修正_2026-08-25.md
          capEff[i] =
            (heatCap[i] ?? 1) *
            (1 - K.seaIceInsulationFactor * seaW * (insCapFrac[i] ?? oceanFrac)) *
            capScale;
          // 氷を通じた海からの伝導 F = k(T_freeze − T)/h。**T の関数なので陰的に**
          // 扱う(対角へ k/h、右辺へ k/h × T_freeze)。h の下限は数値のための
          // ものであって較正つまみではない
          iceCond[i] =
            slabIce && (iceMm[i] ?? 0) > 0
              ? (K.seaIceConductivityWmK * oceanFrac * 1000) /
                Math.max(K.seaIceMinThicknessMm, iceMm[i] ?? 0)
              : 0;
          // 蒸発帰還: LE(T) ≈ LE(T_ref) + k·(T − T_ref) の第 2 項を陰的に扱う。
          // 対角へ k、右辺へ k·T_ref。**k と T_ref は同じ月按分で読む**
          // (別々に按分すると展開の基準点がずれる)
          if (evapFb) {
            const k0 = evapFb.kWm2PerK[m0]?.[i] ?? 0;
            const k1 = evapFb.kWm2PerK[m1]?.[i] ?? 0;
            evapK[i] = k0 * (1 - frac) + k1 * frac;
          }
          const tRef = evapFb
            ? (evapFb.refTempC[m0]?.[i] ?? 0) * (1 - frac) + (evapFb.refTempC[m1]?.[i] ?? 0) * frac
            : 0;
          rhs[i] =
            ((capEff[i] ?? 1) / dt) * (t[i] ?? 0) +
            (iceCond[i] ?? 0) * K.seaFreezeC +
            (evapK[i] ?? 0) * tRef +
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
        let d = dBase * (1 + K.hadleyDiffusionBoost * hadleyW);
        // 冬の渦熱輸送(2026-08-31、既定 0 ビット一致): リッジ極側 × 冬の行の
        // 南北拡散を増強。行の量なので面平均(gN/gS)の作法にそのまま乗る
        if ((K.stormWinterHeatDiffBoost as number) > 0) {
          const stormW = Math.min(1, Math.max(0, (Math.abs(lat) - ridgeAbs) / 10));
          const winterW =
            (insolation.monthlyByRow[m0]?.[row] ?? 0) < (insolation.annualMeanByRow[row] ?? 0)
              ? 1
              : 0;
          d *= 1 + K.stormWinterHeatDiffBoost * stormW * winterW;
        }
        dMeridOfRow[row] = d;
      }
      // ---- 段 C-0: 保存的移流の前計算(2026-08-28、既定 0 では作らない)----
      // 旧式はセル固有係数 × (T_up − T_i) で面が相殺しない(偽熱源 0.675°C)。
      // 保存形 = 風で変調した面伝導度の**対交換**: 面係数は両側セルの
      // 「その面へ向かう外向き係数」の和で一意、南北は拡散項と同じ計量
      // (cos 面/cos 中心)で受けるので一様 T で厳密に相殺する。
      // docs/事前登録_熱移流の保存化_2026-08-28.md
      let advOutE: Float64Array | null = null;
      let advOutW: Float64Array | null = null;
      let advOutN: Float64Array | null = null;
      let advOutS: Float64Array | null = null;
      // 段 C-1(2026-08-31): 雪氷面の移流遮断。面には**両側の grip の積**を
      // 掛ける(片側だけだと風上=海の面が素通りし、i/j の面値も割れる)。
      // T^n で評価(半陰的 — 反復内では固定)。既定 1 = 全て 1 で不変
      let advGripW: Float64Array | null = null;
      if ((K.snowGripFactor as number) < 1) {
        advGripW = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const snowWA = Math.min(
            1,
            Math.max(0, ((iceOnset[i] ?? 0) - (t[i] ?? 0)) / K.iceRampWidthC),
          );
          advGripW[i] = 1 - (1 - K.snowGripFactor) * snowWA;
        }
      }
      if ((K.advectionConservative as number) !== 0) {
        advOutE = new Float64Array(N);
        advOutW = new Float64Array(N);
        advOutN = new Float64Array(N);
        advOutS = new Float64Array(N);
        for (let row = 0; row < CH; row++) {
          const lat = latDegOfRow(cg, row);
          const ridgeAbs = lat >= 0 ? ridgeAbsN : ridgeAbsS;
          const seasonFactor = (lat >= 0 ? summerN : summerS) ? K.summerAdvectionFactor : 1;
          const vBandW = Math.min(1, Math.max(0, (Math.abs(lat) - ridgeAbs) / 10));
          const isWinterRow =
            (insolation.monthlyByRow[m0]?.[row] ?? 0) < (insolation.annualMeanByRow[row] ?? 0);
          for (let col = 0; col < CW; col++) {
            const i = row * CW + col;
            const uMs = uField?.[i] ?? 0;
            const vMs = vField?.[i] ?? 0;
            const inv = isWinterRow
              ? 1 - (1 - K.winterInversionAdvectionFactor) * (interior01[i] ?? 0)
              : 1;
            const advScale = seasonFactor * inv * K.zonalAdvectionCouplingWm2PerK;
            const cu = advScale * (Math.min(9, Math.abs(uMs)) / 4);
            if (uMs > 0) advOutE[i] = cu;
            else if (uMs < 0) advOutW[i] = cu;
            const targetRow = vMs > 0 ? row - 1 : row + 1;
            if (vMs !== 0 && targetRow >= 0 && targetRow < CH) {
              const chanV =
                1 -
                (1 - K.circumpolarChannelFactor) *
                  Math.max(rowIsChannel[row] ?? 0, rowIsChannel[targetRow] ?? 0);
              const landGrip = 0.25 + 0.75 * (coarse[i]?.landFrac ?? 0);
              const cv = advScale * vBandW * chanV * landGrip * (Math.min(5, Math.abs(vMs)) / 4);
              if (vMs > 0) advOutN[i] = cv;
              else advOutS[i] = cv;
            }
          }
        }
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
          // 海峡らしさは 0〜1 の重み。二値のときは 0/1 なので従来と厳密に一致
          const chWN = Math.max(rowIsChannel[row] ?? 0, row > 0 ? (rowIsChannel[row - 1] ?? 0) : 0);
          const chWS = Math.max(
            rowIsChannel[row] ?? 0,
            row < CH - 1 ? (rowIsChannel[row + 1] ?? 0) : 0,
          );
          const chanN = 1 - (1 - K.circumpolarChannelFactor) * chWN;
          const chanS = 1 - (1 - K.circumpolarChannelFactor) * chWS;
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
            let inv = isWinterRow
              ? 1 - (1 - K.winterInversionAdvectionFactor) * (interior01[i] ?? 0)
              : 1;
            // 段 C-1: 雪氷面の移流遮断(旧経路は受け手中心なので i 側のみ)
            if (advGripW) inv *= advGripW[i] ?? 1;
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
              1 -
              (1 - K.circumpolarChannelFactor) *
                Math.max(rowIsChannel[row] ?? 0, rowIsChannel[upwindVRow] ?? 0);
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
            // 段 C-0: 保存形は面係数(両側の外向き係数の和)で対交換。
            // 南北は拡散項と同じ計量(cos 面 / cos 中心)。
            // **旧経路は原式そのまま**(加算順序を変えるとビット一致が壊れる)
            let diag: number;
            let off: number;
            if (!advOutE) {
              diag =
                cOverDt +
                K.olrBWm2PerC +
                (iceCond[i] ?? 0) +
                (evapK[i] ?? 0) +
                gzE +
                gzW +
                gNEff +
                gSEff +
                advCu +
                advCv;
              off =
                gzE * (t[east] ?? 0) +
                gzW * (t[west] ?? 0) +
                gNEff * (t[north] ?? 0) +
                gSEff * (t[south] ?? 0) +
                advCu * (t[upwindU] ?? 0) +
                advCv * (t[upwindV] ?? 0);
            } else {
              const gI = advGripW ? (advGripW[i] ?? 1) : 1;
              const cEf =
                ((advOutE[i] ?? 0) + (advOutW![east] ?? 0)) *
                (advGripW ? gI * (advGripW[east] ?? 1) : 1);
              const cWf =
                ((advOutW![i] ?? 0) + (advOutE[west] ?? 0)) *
                (advGripW ? gI * (advGripW[west] ?? 1) : 1);
              const cNf =
                row > 0
                  ? ((advOutN![i] ?? 0) + (advOutS![north] ?? 0)) *
                    Math.cos(phiEdgeN) *
                    (advGripW ? gI * (advGripW[north] ?? 1) : 1)
                  : 0;
              const cSf =
                row < CH - 1
                  ? ((advOutS![i] ?? 0) + (advOutN![south] ?? 0)) *
                    Math.cos(phiEdgeS) *
                    (advGripW ? gI * (advGripW[south] ?? 1) : 1)
                  : 0;
              diag =
                cOverDt +
                K.olrBWm2PerC +
                (iceCond[i] ?? 0) +
                (evapK[i] ?? 0) +
                gzE +
                gzW +
                gNEff +
                gSEff +
                cEf +
                cWf +
                (cNf + cSf) / cosC;
              off =
                gzE * (t[east] ?? 0) +
                gzW * (t[west] ?? 0) +
                gNEff * (t[north] ?? 0) +
                gSEff * (t[south] ?? 0) +
                cEf * (t[east] ?? 0) +
                cWf * (t[west] ?? 0) +
                (cNf * (t[north] ?? 0) + cSf * (t[south] ?? 0)) / cosC;
            }
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
      // ---- 海氷の厚さを更新する(0 層模型)----
      // **潜熱がこの模型の要**。氷を作るには熱を捨て、融かすには吸う必要があり、
      // その間だけ海が凍結点に留まる。ここが無いと温度が自由に落ちて断熱が
      // 固定され、両極が逆方向に固着する(2026-08-04 実測)。
      if (slabIce) {
        for (let i = 0; i < N; i++) {
          const oceanFrac = 1 - (coarse[i]?.landFrac ?? 0);
          if (oceanFrac <= 0) continue;
          const tNew = t[i] ?? 0;
          if ((iceMm[i] ?? 0) > 0) {
            // 氷あり: 海 → 表面の伝導ぶんだけ海が凍り、氷が厚くなる。
            const cond = (iceCond[i] ?? 0) * (K.seaFreezeC - tNew); // W/m²(正 = 海が熱を失う)
            // **潜熱も加速期には同じ比率で縮める**。熱容量だけ 1/16 にして
            // 潜熱を実寸のまま残すと、気温は速く落ち着くのに氷厚だけが実時間
            // ぶんしか進まず、周期定常への到達が氷に律速される
            // (2026-08-04 実測: 8 年と 16 年で判定量が 0.7〜0.8°C 動いた)
            const dIce = (cond * dt) / (K.seaIceLatentJPerMm * capScale);
            let h = (iceMm[i] ?? 0) + dIce;
            if (h < 0) {
              // 融け切った。余った熱は海の温度上昇へ回る(潜熱を使い切ってから)
              const leftoverJ = -h * K.seaIceLatentJPerMm * capScale;
              h = 0;
              const cFull = (heatCap[i] ?? 1) * capScale;
              if (cFull > 0) t[i] = K.seaFreezeC + leftoverJ / cFull;
            }
            // ---- 融解中の表面は凍結点に留まる ----
            // **これが無いと氷の上の空気が自由に暖まる**。実在の融解期の海氷面が
            // 0°C に張り付くのは、余分な熱が全部潜熱に食われるからで、
            // 白夜の日射をいくら受けても気温は上がらない。伝導 k/h だけでは
            // 引き戻しが足りず、北極の 7 月が +16.8°C まで走った(2026-08-04)。
            // 混合セルでは海の割合ぶんだけ引き戻す(oceanFrac=1 で厳密な固定)
            const tAfter = t[i] ?? 0;
            if (h > 0 && tAfter > K.seaFreezeC) {
              const excessJ = (capEff[i] ?? 0) * oceanFrac * (tAfter - K.seaFreezeC);
              const meltMm = excessJ / (K.seaIceLatentJPerMm * capScale);
              if (meltMm < h) {
                h -= meltMm;
                t[i] = tAfter - oceanFrac * (tAfter - K.seaFreezeC);
              } else {
                // 残りの氷を全部使っても足りない: 使った潜熱ぶんだけ下げて融け切る
                const usedJ = h * K.seaIceLatentJPerMm * capScale;
                h = 0;
                const cCell = capEff[i] ?? 0;
                if (cCell > 0) t[i] = tAfter - usedJ / cCell;
              }
            }
            iceMm[i] = h;
          } else if (tNew < K.seaFreezeC) {
            // 氷なしで凍結点を下回った: 超過分の熱を氷に変え、温度を凍結点へ戻す。
            //
            // **融解側と同じく海の割合ぶんだけ扱う。** 以前はセル全体を凍結点へ
            // 引き上げており、陸率 90% の沿岸セルでも海が少しでもあれば
            // −1.9°C を下回れず、**陸側の熱不足まで海氷に変換していた**
            // (2026-08-09 の外部レビューで発覚)。融解側だけ oceanFrac で
            // 按分して凍結側を全体のままにしていたのは、単純な書き漏らし。
            const cOcean = (capEff[i] ?? 1) * oceanFrac;
            const deficitJ = cOcean * (K.seaFreezeC - tNew);
            iceMm[i] = (iceMm[i] ?? 0) + deficitJ / (K.seaIceLatentJPerMm * capScale);
            t[i] = tNew + oceanFrac * (K.seaFreezeC - tNew);
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
    return { monthAccum, monthCount, finalT: t, finalIce: iceMm };
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
  // 段 C-0(2026-08-28): 保存的移流は GPU 2 カーネルにも移植済みだが、
  // 段 C-0 の GPU 移植は 2026-08-28 深夜に検収済み(酸性試験 ○・バッチ/単発
  // ビット一致)。EXOCLIM_ADV_GPU=0 で CPU 参照実装へ強制できる(切り分け用)
  const advGpuForced =
    typeof process !== 'undefined' && process.env?.['EXOCLIM_ADV_GPU'] === '0';
  const ebmAccel = advGpuForced ? null : (opts?.accel?.ebm(N) ?? null);
  const f32 = (a: ArrayLike<number>, n = a.length): Float32Array => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i] ?? 0;
    return out;
  };
  const buildEbmFields = (
    permanentIce: Uint8Array | null,
    initialT?: Float64Array,
    initialIce?: Float64Array,
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
      spinupCapacityFraction: EBM_SPINUP.capacityFraction,
      heatCap: f32(heatCap),
      aEff: f32(aEff),
      surfAlbedoBase: f32(surfAlbedoBase),
      iceOnset: f32(iceOnset),
      qFlux: f32(qFlux),
      elevM: f32(elevM),
      landFrac: landFracArr,
      insCapFrac: f32(insCapFrac),
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
      evapFeedback: evapFb ? { k: evapFb.kWm2PerK, refTempC: evapFb.refTempC } : null,
      ridgeLatN: f32(windBelt.monthlyRidgeLatNDeg),
      ridgeLatS: f32(windBelt.monthlyRidgeLatSDeg),
      meanRidgeN,
      meanRidgeS,
      initialT: initialT ? f32(initialT) : null,
      initialIce: initialIce ? f32(initialIce) : null,
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
    slabIce: K.seaIceModel > 0,
    seaFreezeC: K.seaFreezeC,
    seaIceConductivityWmK: K.seaIceConductivityWmK,
    seaIceLatentJPerMm: K.seaIceLatentJPerMm,
    seaIceMinThicknessMm: K.seaIceMinThicknessMm,
    seaIceCoverScaleMm: K.seaIceCoverScaleMm,
    advectionConservative: K.advectionConservative as number,
    stormWinterHeatDiffBoost: K.stormWinterHeatDiffBoost as number,
    snowGripFactor: K.snowGripFactor as number,
  };
  const integrateAny = async (
    permanentIce: Uint8Array | null,
    initialT: Float64Array | undefined,
    passLabel: string,
    /** この段の進捗のうち、このパスが占める区間 [passFrom, passTo] */
    passFrom: number,
    passTo: number,
    /** 前パスの氷厚(0 層模型のときだけ意味を持つ) */
    initialIce?: Float64Array,
  ): Promise<{
    monthAccum: Float64Array[];
    monthCount: number[];
    finalT: Float64Array;
    /** 氷厚(0 層模型のときだけ意味を持つ)。CPU・GPU の両経路が返す */
    finalIce?: Float64Array;
  }> => {
    if (!ebmAccel)
      return integrate(permanentIce, initialT, passLabel, passFrom, passTo, initialIce);
    const fields = buildEbmFields(permanentIce, initialT, initialIce);
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
    /**
     * このパスが**収束済みの場から始まるか**。
     *
     * 以前はここが外部のウォームスタートの箱(`warmT`)だけを見ていた。
     * だが**氷床判定パスの次のパスは、常に前パスの収束場から始まっている**
     * (`integrateAny(permanentIce, pass1.finalT, …)`)。それなのに年数の
     * 梯子は冷間の 24 年から始まっていた。2026-08-10 の内訳測定で、
     * 1 評価あたり EBM が 4 回・計 104 年回っていることが分かって発覚した。
     *
     * 判定に使うのは**実際の初期場の有無**であって、箱の出どころではない。
     */
    const warmFrom = initialT !== undefined;
    let fullYears =
      EBM_FULL_CAPACITY_YEARS.years > 0
        ? EBM_FULL_CAPACITY_YEARS.years
        : Math.max(
            // 手掛かりは**冷間・温間で別のものを引く**(宣言部の注記を参照)
            yearAdaptive && useHint
              ? warmFrom
                ? budgetHint.fullYearsWarm
                : budgetHint.fullYears
              : 0,
            // ウォームスタート時は短い出発点から試す。足りなければ従来どおり
            // 倍々に増える(判定は同じなので答えは変わらない)。
            //
            // **倍化できるときだけ短く始めてよい**(2026-08-11 に実害)。
            // 較正は `EBM_SOLVER.adaptive = false` で倍化を切っている
            // (収束しにくい定数領域は「高くつく」のではなく失格にする設計)。
            // そこで温間開始を 4 年から始めると、**倍化されないまま周期定常に
            // 届かず全評価が失格**になる。実際に較正 v19 の 7 評価が
            // 全部 fit = -1000000 で落ちた。短く始める最適化は、
            // 足りなかったときに救う経路とセットでなければ成立しない。
            warmFrom && yearAdaptive ? EBM_WARM_START_FULL_YEARS : bFullYearsStart,
          );
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
    /** 積算の積分年数。倍化の梯子は毎回ゼロから回し直すので、足し上げる */
    let yearsIntegrated = 0;
    const runOnce = async (): Promise<Awaited<ReturnType<typeof ebmAccel.run>>> => {
      yearsIntegrated += fullYears + bSpinupAccelYears;
      const runFields: EbmStaticFields = {
        ...fields,
        years: fullYears + bSpinupAccelYears,
        fullCapacityYears: fullYears,
      };
      const runConstants: EbmConstants = { ...ebmConstants, iterationsPerStep: iters };
      // 検証専用の捕捉(既定は無効)。加速器へ渡した入力をそのまま控えるだけで、
      // 実行そのものには一切影響しない(scripts/diag_ebm_batch_equiv.ts が読む)
      if (EBM_CAPTURE.enabled) {
        EBM_CAPTURE.fields = runFields;
        EBM_CAPTURE.constants = runConstants;
      }
      return ebmAccel.run(
        runFields,
        runConstants,
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
    };
    let r = await runOnce();
    while (adaptive && !r.converged && iters < bMaxIterations) {
      iters *= 2;
      extended = true;
      itersEscalated = true;
      r = await runOnce();
    }
    /**
     * 加速器が回せる年数の上限。**掲げた上限が下流の上限に収まるか**(教訓 §9)。
     * ここを見ずに倍増すると、上限を超えた時点で例外で死ぬ — 収束しにくい
     * 惑星でだけ起き、しかも「未収束」と診断される前に落ちるので最悪である
     * (2026-08-02 に前セッションが発見し、未修正のまま申し送られていた)。
     * 上限は**診断へ落とす**べきもので、例外にすべきものではない。
     */
    const yearCap = ebmAccel.maxSteps / K.ebmStepsPerYear - bSpinupAccelYears;
    while (
      yearAdaptive &&
      r.meanYearDriftC > EBM_PERIODIC_TOLERANCE_C &&
      fullYears < bMaxFullYears &&
      fullYears * 2 <= yearCap
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
      // 半減の下限も冷間・温間で別(温間は 4 年まで下げられる)
      const floorYears = warmFrom ? EBM_WARM_START_FULL_YEARS : EBM_FULL_CAPACITY_START_YEARS;
      const easyKey = warmFrom ? 'easyYearsWarm' : 'easyYears';
      const hintKey = warmFrom ? 'fullYearsWarm' : 'fullYears';
      budgetHint[hintKey] = fullYears;
      if (yearsEscalated) budgetHint[easyKey] = 0;
      else if (++budgetHint[easyKey] >= HINT_DECAY_AFTER) {
        budgetHint[hintKey] = Math.max(floorYears, Math.floor(fullYears / 2));
        budgetHint[easyKey] = 0;
      }
    }
    EBM_SOLVER_STATS.calls.push({ warm: warmFrom, years: yearsIntegrated, iters });
    EBM_SOLVER_STATS.maxYearDriftC = Math.max(EBM_SOLVER_STATS.maxYearDriftC, r.maxYearDriftC);
    EBM_SOLVER_STATS.meanYearDriftC = Math.max(EBM_SOLVER_STATS.meanYearDriftC, r.meanYearDriftC);
    EBM_SOLVER_STATS.fullCapacityYears = fullYears;
    EBM_SOLVER_STATS.maxResidualC = Math.max(EBM_SOLVER_STATS.maxResidualC, r.maxResidualC);
    // 最後のパスのステップ別残差を残す(反復回数を削れるかの判断材料)
    if ('stepResidualsC' in r && r.stepResidualsC) {
      EBM_SOLVER_STATS.stepResidualsC = r.stepResidualsC;
    }
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
      // 氷厚はパス 1 → パス 2 へ持ち越す(CPU 経路と同じ)
      ...(K.seaIceModel > 0 ? { finalIce: toF64(r.finalIce) } : {}),
    };
  };

  // パス 1: 恒常氷なしで積分 → 年平均と最暖月の複合条件で氷床を判定
  // (年平均だけではシベリア(夏 +19°C)を誤って氷床にしてしまう)
  const pass1 = await integrateAny(null, warmT, '氷床判定パス (1/2)', 0, 0.5);
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
  const pass2 = await integrateAny(
    permanentIce,
    pass1.finalT,
    '確定パス (2/2)',
    0.5,
    1,
    pass1.finalIce,
  );

  // ウォームスタートの箱へ**この実行の収束温度場**を書き戻す。
  // 次の評価はここから始まり、空回しの年数が減る(答えは変わらない —
  // 年次ドリフトの検査は同じなので)
  if (warmBox) {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = pass2.finalT[i] ?? 0;
    warmBox.field = out;
  }

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
 * 1° の月別の場を EBM 粗格子へ**陸セルだけ**平均する(海セルは 0)。
 * 陸の対流雲の駆動量を作るのに使う。
 */
function coarsenLandField(ctx: SimContext, monthly: Float32Array[], cg: Grid): Float32Array[] {
  const src = ctx.grid;
  const out: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const f = monthly[m];
    const field = new Float32Array(cg.cellCount);
    const n = new Float32Array(cg.cellCount);
    for (let row = 0; row < src.heightCells; row++) {
      const cgRow = Math.min(
        cg.heightCells - 1,
        Math.floor((row * src.resolutionDeg) / cg.resolutionDeg),
      );
      for (let col = 0; col < src.widthCells; col++) {
        const si = row * src.widthCells + col;
        if (!ctx.terrain.landMask[si]) continue;
        const cgCol = Math.min(
          cg.widthCells - 1,
          Math.floor((col * src.resolutionDeg) / cg.resolutionDeg),
        );
        const ci = cgRow * cg.widthCells + cgCol;
        field[ci] = (field[ci] ?? 0) + (f?.[si] ?? 0);
        n[ci] = (n[ci] ?? 0) + 1;
      }
    }
    for (let i = 0; i < cg.cellCount; i++) {
      if ((n[i] ?? 0) > 0) field[i] = (field[i] ?? 0) / (n[i] ?? 1);
    }
    out.push(field);
  }
  return out;
}

/**
 * 蒸発帰還 ∂LE/∂T(W/m²/K、月別・EBM 格子)と、その線形化の基準温度 T_ref(°C)。
 *
 * 対応: docs/事前登録_蒸発帰還_2026-08-07.md
 *
 * 気温が上がれば飽和水蒸気圧が上がって蒸発散が増え、潜熱の持ち出しが強まる。
 * これは**負帰還**なので行列の対角へ入る。前パスの気温 T_ref のまわりで
 * 線形化する(ニュートン法と同じ形):
 *
 *   LE(T) ≈ LE(T_ref) + k·(T − T_ref)
 *   k = frac · λ · α(T_ref) · (E − Ē)
 *   α(T) = L_v / (R_v·T²)   … クラウジウス・クラペイロン(288K で 0.064/K)
 *
 * **偏差 (E − Ē) を使う**のは陽的項と基準を揃えるため(平均は OLR に吸収済み)。
 * 乾いた陸では k が負になり減衰が弱まる — 砂漠の乾熱で、狙い通りの符号。
 * ただし対角優位を壊さないよう、負側は olrB の半分までに留める。
 */
function buildEvapFeedback(
  ctx: SimContext,
  monthlyEtMm: Float32Array[],
  priorTemperatureC: Float32Array[],
  cg: Grid,
  coarse: CoarseCell[],
): { kWm2PerK: Float32Array[]; refTempC: Float32Array[] } {
  const src = ctx.grid;
  const LV = 2.45e6; // 蒸発潜熱 J/kg
  const RV = 461.5; // 水蒸気の気体定数 J/(kg·K)
  const kOut: Float32Array[] = [];
  const tOut: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const et = monthlyEtMm[m];
    const tp = priorTemperatureC[m];
    const kField = new Float32Array(cg.cellCount);
    const tField = new Float32Array(cg.cellCount);
    const etAcc = new Float32Array(cg.cellCount);
    const n = new Float32Array(cg.cellCount);
    // T_ref は全セル(海も)必要。E は陸だけ
    const tAcc = new Float32Array(cg.cellCount);
    const tN = new Float32Array(cg.cellCount);
    for (let row = 0; row < src.heightCells; row++) {
      const cgRow = Math.min(
        cg.heightCells - 1,
        Math.floor((row * src.resolutionDeg) / cg.resolutionDeg),
      );
      for (let col = 0; col < src.widthCells; col++) {
        const si = row * src.widthCells + col;
        const cgCol = Math.min(
          cg.widthCells - 1,
          Math.floor((col * src.resolutionDeg) / cg.resolutionDeg),
        );
        const ci = cgRow * cg.widthCells + cgCol;
        tAcc[ci] = (tAcc[ci] ?? 0) + (tp?.[si] ?? 0);
        tN[ci] = (tN[ci] ?? 0) + 1;
        if (!ctx.terrain.landMask[si]) continue;
        etAcc[ci] = (etAcc[ci] ?? 0) + (et?.[si] ?? 0);
        n[ci] = (n[ci] ?? 0) + 1;
      }
    }
    // 陸面平均(セル数重みの近似 — 陽的項 buildEvapCoolingAnomaly と同じ基準)
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < cg.cellCount; i++) {
      if ((n[i] ?? 0) > 0) {
        etAcc[i] = (etAcc[i] ?? 0) / (n[i] ?? 1) / 30; // mm/月 → mm/日
        sum += etAcc[i] ?? 0;
        cnt++;
      }
      tField[i] = (tAcc[i] ?? 0) / Math.max(1, tN[i] ?? 1);
    }
    const meanMmDay = cnt > 0 ? sum / cnt : 0;
    const kFloor = -0.5 * K.olrBWm2PerC;
    for (let i = 0; i < cg.cellCount; i++) {
      const landFrac = coarse[i]?.landFrac ?? 0;
      if ((n[i] ?? 0) > 0 && landFrac > 0.2) {
        const anomMmDay = Math.max(-3, Math.min(5, (etAcc[i] ?? 0) - meanMmDay));
        const tK = Math.max(200, (tField[i] ?? 0) + 273.15);
        const alpha = LV / (RV * tK * tK);
        const k =
          K.evapFeedbackFrac * K.evapLatentWm2PerMmDay * alpha * anomMmDay * landFrac;
        kField[i] = Math.max(kFloor, k);
      } else {
        kField[i] = 0;
      }
    }
    kOut.push(kField);
    tOut.push(tField);
  }
  return { kWm2PerK: kOut, refTempC: tOut };
}

/**
 * 蒸発冷却の偏差フラックス(W/m²、月別・EBM 格子)。陸セルの降水(mm/日)の
 * 「陸面平均に対する偏差」× 係数。湿潤陸は正(冷却)、乾燥陸は負(乾熱)。
 * 偏差なので陸全体では中立(全球平均を動かさない)。海は 0。
 */
function buildEvapCoolingAnomaly(
  ctx: SimContext,
  monthlyEtMm: Float32Array[],
  cg: Grid,
  coarse: CoarseCell[],
): Float32Array[] {
  const src = ctx.grid;
  const out: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const p = monthlyEtMm[m];
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
    // 陸面平均(面積重み近似: セル数)を引いて偏差化し、W/m² へ。
    //
    // **偏差にするのは二重計上を避けるため**。EBM の OLR 切片 A は平均気候を
    // 再現するよう決めてあるので、平均的な潜熱損失は既にそこへ吸収されている。
    // 絶対値の λ·ET を足すと同じ冷却を二度引くことになる。
    // 陸面平均を基準にすれば「平均的に湿った陸」が 0 になり、
    // 湿った陸は冷やし、乾いた陸は相対的に暖める — 実在の砂漠の暑さがこれ。
    //
    // 基準を**その惑星の陸面平均**から取るので、地球固有の座標も定数も要らない。
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
        // クランプは残すが、実蒸発散は可能蒸発散で頭を押さえられているので
        // 降水を代用していた頃のような外れ値は原理的に出ない
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
 * 陸面の月別湿り具合(表示格子)から、EBM 格子の**年平均**湿り具合を組む。
 *
 * 海セルは 1(= 従来の熱容量そのまま)。陸が無い粗セルも 1 にして、
 * 陸率で混ぜている熱容量の海側に影響を出さない。
 */
function buildAnnualWetness(
  ctx: SimContext,
  monthlyWetness01: Float32Array[],
  cg: Grid,
): Float64Array {
  const src = ctx.grid;
  const out = new Float64Array(cg.cellCount).fill(1);
  const sum = new Float64Array(cg.cellCount);
  const n = new Float64Array(cg.cellCount);
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const w = monthlyWetness01[m];
    if (!w) continue;
    for (let row = 0; row < src.heightCells; row++) {
      const cgRow = Math.min(
        cg.heightCells - 1,
        Math.floor((row * src.resolutionDeg) / cg.resolutionDeg),
      );
      for (let col = 0; col < src.widthCells; col++) {
        const si = row * src.widthCells + col;
        if (!ctx.terrain.landMask[si]) continue;
        const cgCol = Math.min(
          cg.widthCells - 1,
          Math.floor((col * src.resolutionDeg) / cg.resolutionDeg),
        );
        const ci = cgRow * cg.widthCells + cgCol;
        sum[ci] = (sum[ci] ?? 0) + (w[si] ?? 0);
        n[ci] = (n[ci] ?? 0) + 1;
      }
    }
  }
  for (let i = 0; i < cg.cellCount; i++) {
    if ((n[i] ?? 0) > 0) out[i] = (sum[i] ?? 0) / (n[i] ?? 1);
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
