// パイプライン: Step 1〜7 を順に実行する純粋関数。docs/要件.md §3
// 部分再計算のキャッシュはワーカー層の責務(この関数は常に全段を計算する)。
// P1-4 + 変更レビュー FB P2-1: 物理計算(runPipelineCore)は時計 API を一切
// 読まない。時刻を読むのは runPipelineTimed の計測側だけで、runPipeline の
// 呼出経路には performance.now() が存在しない(時計 API の無い環境でも動く)。

import type { PlanetParams } from '@/domain/planetParams';
import { buildSimContext } from './context';
import { computeItcz } from './step01_itcz';
import { computeWindBelt } from './step02_windbelt';
import { computeOceanCurrent } from './step03_ocean';
import { computeAirflow } from './step04_airflow';
import { computeTemperature, resetEbmSolverStats } from './step05_temperature';
import {
  computePrecipitation,
  resetConservativeStats,
  type PrecipDiagBox,
  type PrecipDiagnostics,
  type SoilWaterResult,
} from './step06_precipitation';
import { computeKoppen } from './step07_koppen';
import type { PipelineResult, RunPartial } from './types';
import { MODEL_CONSTANTS } from './constants';
import { assertComputableInputs, buildDiagnostics } from './diagnostics';
import type { RunOptions } from './accel';
import {
  RUN_STAGE_LABELS,
  throwIfCancelled,
  type RunStage,
  type StageProgressSink,
} from './run_control';

/**
 * 段ごとの相対費用(全体進捗の重み)。**実測値**であって推測ではない。
 *
 * 出典: scripts/prof_stage_cost.ts の GPU 経路の実測(2026-08-02、地球 1°):
 *
 *   step5_temperature  97.86%   ← EBM の時間積分がほぼ全部
 *   step6_precipitation 2.00%   ← 風上追跡と土壌は GPU 化済みで安い
 *   その他 7 段         0.14%   ← 合計しても 1 秒に満たない
 *
 * **この偏りが設計を決めている**。進捗バーは実質 EBM のバーであり、
 * 段キャッシュで上流を再利用しても節約は 0.2% に届かない
 * (src/worker/pipelineCache.ts の注記)。
 *
 * ここがずれても**壊れるのは進捗バーだけ**で物理は無傷だが、ずれたままだと
 * 「95% で 3 分止まる」ような嘘の進捗になるので、費用構造を変えたら測り直すこと。
 */
const STAGE_COST: Record<RunStage, number> = {
  context: 1,
  prepass: 1,
  itcz: 1,
  windbelt: 1,
  ocean: 1,
  airflow: 1,
  temperature: 979,
  precipitation: 20,
  koppen: 1,
};

/**
 * 区間計測フック。物理側は時計を読まず、計測側だけがこの中で時刻を扱う。
 *
 * 非同期なのは GPU 加速器のため(WebGPU の読み戻しは await を要する)。
 * 加速器を渡さなければ CPU 実装のみが走り、await は即座に解決する。
 */
type SectionTimer = <T>(label: string, fn: () => T | Promise<T>) => Promise<T>;

const noTimer: SectionTimer = async (_label, fn) => fn();

/** 物理結果のみ(決定的)。計測が要る場合は runPipelineTimed を使う */
export function runPipeline(params: PlanetParams, opts?: RunOptions): Promise<PipelineResult> {
  return runPipelineCore(params, noTimer, undefined, opts);
}

/**
 * R1 診断つき実行(地域降水 FB §5)。降水の内部要因(供給 3 種・倍率 6 種)を
 * 捕捉して返す。物理結果は runPipeline と同一(診断は書込のみの受け皿 —
 * テストでビット一致を担保)
 */
export async function runPipelineWithPrecipDiag(
  params: PlanetParams,
  opts?: RunOptions,
): Promise<{
  result: PipelineResult;
  precipDiag: PrecipDiagnostics;
  /** 土壌水分の周期定常解(無効時は null — ゼロ収支を成功に見せない) */
  soil: SoilWaterResult | null;
}> {
  const box: PrecipDiagBox = {};
  const result = await runPipelineCore(params, noTimer, box, opts);
  if (!box.fields) throw new Error('降水診断が生成されなかった(内部エラー)');
  return { result, precipDiag: box.fields, soil: box.soil ?? null };
}

/** 物理結果 + ステップ別所要時間(計測は時刻依存 — 物理結果には含めない) */
export async function runPipelineTimed(
  params: PlanetParams,
  opts?: RunOptions,
): Promise<{
  result: PipelineResult;
  stepTimingsMs: Record<string, number>;
}> {
  const timings: Record<string, number> = {};
  const timer: SectionTimer = async (label, fn) => {
    const t0 = performance.now();
    const out = await fn();
    timings[label] = Math.round(performance.now() - t0);
    return out;
  };
  return { result: await runPipelineCore(params, timer, undefined, opts), stepTimingsMs: timings };
}

/**
 * 全体進捗の集計。段の内側は「その段の中で何割か」しか知らず、
 * 全体比への換算はここが持つ(段が全体の重みを知る必要はない)。
 *
 * **進捗は単調ではない**: EBM が収束しなければ予算を倍にして回し直すので、
 * 同じ段の中で fraction が 1 に近づいてから 0 に戻る。嘘をつかないために、
 * その場合は budgetExtended を立てて上へ伝える。
 */
class ProgressPlanner {
  private readonly total: number;
  private doneCost = 0;
  private currentCost = 0;
  private currentStage: RunStage = 'context';

  constructor(
    units: Array<{ stage: RunStage; cost: number }>,
    private readonly sink: RunOptions['onProgress'],
  ) {
    this.total = units.reduce((a, u) => a + u.cost, 0) || 1;
  }

  /** 段の開始。戻り値をその段の opts.progress に渡す */
  begin(stage: RunStage): StageProgressSink {
    this.currentStage = stage;
    this.currentCost = STAGE_COST[stage];
    this.emit(0, RUN_STAGE_LABELS[stage]);
    return (p): void => {
      this.emit(p.fraction ?? 0, p.detail, p.budgetExtended, p.partial);
    };
  }

  /** 段の完了時に、その段の出力を表示へ流す */
  emitPartial(partial: RunPartial): void {
    this.emit(1, `${RUN_STAGE_LABELS[this.currentStage]} 完了`, undefined, partial);
  }

  /** 段の完了 */
  end(): void {
    this.doneCost += this.currentCost;
    this.currentCost = 0;
  }

  private emit(
    fraction: number,
    detail: string,
    budgetExtended?: boolean,
    partial?: RunPartial,
  ): void {
    if (!this.sink) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    this.sink({
      stage: this.currentStage,
      stageFraction: fraction,
      overall: Math.min(1, (this.doneCost + this.currentCost * clamped) / this.total),
      detail,
      ...(budgetExtended ? { budgetExtended: true } : {}),
      ...(partial ? { partial } : {}),
    });
  }
}

async function runPipelineCore(
  params: PlanetParams,
  time: SectionTimer,
  precipDiagBox?: PrecipDiagBox,
  opts?: RunOptions,
): Promise<PipelineResult> {
  // 事前検査(変更レビュー FB): 計算不能な入力は配列確保・反復の前に明示エラー
  assertComputableInputs(params);
  // **EBM の診断を毎回初期化する。** モジュール全体の可変状態なので、ここで
  // 揃えないと同一プロセスの前の実行の値が漏れる。以前は呼び出し側が各自
  // 一部の項目だけ手で 0 にしており、validate.ts は一度もリセットしていなかった
  // (2026-08-09 の外部レビューで発覚)
  resetEbmSolverStats();
  // 保存型の水収支の診断も同じ理由で毎回初期化する
  resetConservativeStats();

  // 2 パス目(陸面の水 → 気温の帰還)が走るかは定数で決まるので、進捗の総量は
  // 事前に確定する。**帰還の口は 2 つあり、どちらか一方でも有効なら 2 パス**:
  //   蒸発冷却(潜熱)      … evapCoolingWm2PerMmDay > 0
  //   熱容量の土壌水分依存 … landDryCapacityFrac < 1
  //   蒸発帰還(∂LE/∂T)    … evapFeedbackFrac > 0
  //   陸の対流雲          … landCloudBoost > 0
  // どちらも前パスの土壌水分を読むので、必要な 2 パス目は同じ 1 回で足りる
  // 温度 → 気圧 → 風 の帰還(段 9)。パス 1 の気温で気圧場と風を作り直し、
  // パス 2 をその風で回す。**反復はしない**(正帰還の暴走を避けるため —
  // 2026-08-01 の蒸発冷却フィードバックが同じ型で大破している)
  const thermalFeedback = MODEL_CONSTANTS.thermalLowHpaPerK > 0;
  const twoPass =
    MODEL_CONSTANTS.evapCoolingWm2PerMmDay > 0 ||
    MODEL_CONSTANTS.landDryCapacityFrac < 1 ||
    MODEL_CONSTANTS.evapFeedbackFrac > 0 ||
    MODEL_CONSTANTS.landCloudBoost > 0 ||
    thermalFeedback;
  const units: Array<{ stage: RunStage; cost: number }> = [
    { stage: 'context', cost: STAGE_COST.context },
    { stage: 'prepass', cost: STAGE_COST.prepass },
    { stage: 'itcz', cost: STAGE_COST.itcz },
    { stage: 'windbelt', cost: STAGE_COST.windbelt },
    { stage: 'ocean', cost: STAGE_COST.ocean },
    { stage: 'airflow', cost: STAGE_COST.airflow },
    { stage: 'temperature', cost: STAGE_COST.temperature },
    { stage: 'precipitation', cost: STAGE_COST.precipitation },
    ...(thermalFeedback
      ? [
          { stage: 'windbelt' as const, cost: STAGE_COST.windbelt },
          { stage: 'airflow' as const, cost: STAGE_COST.airflow },
        ]
      : []),
    ...(twoPass
      ? [
          { stage: 'temperature' as const, cost: STAGE_COST.temperature },
          { stage: 'precipitation' as const, cost: STAGE_COST.precipitation },
        ]
      : []),
    { stage: 'koppen', cost: STAGE_COST.koppen },
  ];
  const planner = new ProgressPlanner(units, opts?.onProgress);

  /**
   * EBM の温間開始の箱。呼び出し側が渡さなければ**この実行の中だけで使う箱**を
   * 作る。気温はパス 1 とパス 2 の 2 回解いており、パス 2 は陸面結合が付くだけで
   * **ほぼ同じ問題**なので、パス 1 の収束場から始めれば空回しの年数が減る。
   *
   * 較正をまたぐ温間開始は 2026-08-06 に棄却済みだが、あれは
   * 「定数が変われば平衡も変わるので緩和時間は戻る」という理由だった
   * (docs/実験記録_ウォームスタート_2026-08-06.md)。**同じ実行の中のパス 2 は
   * 事情が違う** — 平衡はほとんど動かない。
   *
   * 答えが初期値に依らないことは同記録の §1 で実証済み(小数 4 桁まで一致)。
   */
  const runWarmBox = opts?.ebmWarmStart ?? { field: null };

  /**
   * 段を 1 つ走らせる。中断の確認・進捗の受け渡し・計測・キャッシュ引きを
   * ここでまとめる。段に渡す opts は **onProgress と cache を外し、その段用の
   * progress を差した**もの(段が全体進捗やキャッシュを直接触れないようにする)。
   *
   * deps は**その段が読むもの全部**を並べる: 上流の出力への参照 +
   * その段が読むパラメータ片。並べ漏れは「変えたのに結果が変わらない」という
   * 最悪の形の不具合になるので、依存は多めに取ること(取りすぎても
   * 損するのはキャッシュのヒット率だけで、答えは正しいまま)。
   *
   * deps に **null** を渡すとその段はキャッシュしない。段が結果以外の副産物
   * (診断の受け皿など)を書く場合に使う — キャッシュに当たると副産物が
   * 書かれず、呼び出し側が「診断が生成されなかった」で落ちる。
   */
  const stage = async <T>(
    runStage: RunStage,
    label: string,
    deps: readonly unknown[] | null,
    fn: (stageOpts: RunOptions | undefined) => T | Promise<T>,
    /** 段の出力を表示用の差分に載せる(載せない段は省略) */
    toPartial?: (out: T) => RunPartial,
  ): Promise<T> => {
    throwIfCancelled(opts?.signal, RUN_STAGE_LABELS[runStage]);
    const progress = planner.begin(runStage);
    const stageOpts: RunOptions = {
      accel: opts?.accel,
      signal: opts?.signal,
      budget: opts?.budget,
      progress,
      // ウォームスタートの箱は**参照のまま**渡す(段が書き戻すため)。
      // 呼び出し側が箱を渡さなくても runWarmBox を渡す — 気温のパス 2 が
      // パス 1 の収束場から始められるようにするため(下の宣言を参照)
      ebmWarmStart: runWarmBox,
    };
    const compute = (): Promise<T> => time(label, () => fn(stageOpts));
    const out =
      opts?.cache && deps !== null
        ? await opts.cache.getOrCompute<T>(label, deps, compute)
        : await compute();
    // 段が終わった時点の出力を表示へ流す。キャッシュに当たった段も流す
    // (表示は「この実行で何が使えるか」を知りたいのであって、
    //  計算し直したかどうかは関係ない)
    if (toPartial) planner.emitPartial(toPartial(out));
    planner.end();
    return out;
  };

  // 各段が読むパラメータは実測で洗い出した(grep で params.* を列挙、2026-08-02)。
  // params の各部分オブジェクトはストアが変更時に作り直すので、参照の同一性が
  // そのまま「変わっていない」の判定になる。
  const P = params;
  const context = await stage(
    'context',
    'context',
    [P.gridResolutionDeg, P.terrain, P.orbital, P.body],
    () => buildSimContext(params),
    (c) => ({ context: c }),
  );

  // ---- プレパス: 半球間 SST 非対称 → ITCZ の北偏オフセット ----
  // 実物の ITCZ は暖かい半球へ寄る(~3°/K)。海流場(周極海峡で切られる
  // 南半球 vs 暖流ドリフトの北半球)が持つ非対称を測り、線に恒常オフセットを
  // 与える。ステップ 1-3 のプレパスは計 ~150ms(ストリームライン含む)
  const hemisOffsetDeg = await stage('prepass', 'step0_hemis', [context], () => {
    if (MODEL_CONSTANTS.itczHemisOffsetPerC <= 0) return 0;
    const itcz0 = computeItcz(context);
    const wb0 = computeWindBelt(context, itcz0);
    const ocean0 = computeOceanCurrent(context, itcz0, wb0);
    const grid = context.grid;
    let nSum = 0;
    let nW = 0;
    let sSum = 0;
    let sW = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5) * grid.resolutionDeg;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (context.terrain.landMask[i]) continue;
        const a = ocean0.sstAnomalyC[i] ?? 0;
        if (lat >= 0) {
          nSum += w * a;
          nW += w;
        } else {
          sSum += w * a;
          sW += w;
        }
      }
    }
    const deltaC = (nW > 0 ? nSum / nW : 0) - (sW > 0 ? sSum / sW : 0);
    return Math.max(-6, Math.min(6, MODEL_CONSTANTS.itczHemisOffsetPerC * deltaC));
  });

  const itcz = await stage(
    'itcz',
    'step1_itcz',
    [context, hemisOffsetDeg],
    () => computeItcz(context, hemisOffsetDeg),
    (r) => ({ itcz: r }),
  );
  const windBelt = await stage(
    'windbelt',
    'step2_windbelt',
    [context, itcz, P.body],
    () => computeWindBelt(context, itcz),
    (r) => ({ windBelt: r }),
  );
  const ocean = await stage(
    'ocean',
    'step3_ocean',
    [context, itcz, windBelt, P.body],
    () => computeOceanCurrent(context, itcz, windBelt),
    (r) => ({ ocean: r }),
  );
  const airflow = await stage(
    'airflow',
    'step4_airflow',
    [context, itcz, windBelt, P.body],
    () => computeAirflow(context, itcz, windBelt),
    (r) => ({ airflow: r }),
  );
  // 気温と降水は**収束予算と加速器の別**も鍵に入れる。プレビュー(未収束)の
  // 結果を確定計算で使い回したら、確定が確定でなくなる。加速器を入れるのは
  // GPU と CPU で丸めが違うため(GPU を正とする — src/sim/accel.ts の注記)
  const solverKey = [opts?.budget, opts?.accel];
  // 降水診断を採る実行はキャッシュしない(当たると診断が書かれないため)
  const precipDeps = <T extends readonly unknown[]>(d: T): T | null => (precipDiagBox ? null : d);
  const temperature1 = await stage(
    'temperature',
    'step5_temperature',
    [context, itcz, windBelt, ocean, airflow, P.atmosphere, ...solverKey],
    (o) => computeTemperature(context, itcz, windBelt, ocean, airflow, undefined, o),
    (r) => ({ temperature: r }),
  );
  const precipitation1 = await stage(
    'precipitation',
    'step6_precipitation',
    precipDeps([context, itcz, windBelt, ocean, airflow, temperature1, P.atmosphere, ...solverKey]),
    (o) =>
      computePrecipitation(context, itcz, windBelt, ocean, airflow, temperature1, precipDiagBox, o),
    (r) => ({ precipitation: r }),
  );

  // ---- 蒸発冷却フィードバック(降水 → 気温 → 降水の 2 パス目)----
  // 湿った陸は潜熱で冷え、乾いた陸は乾熱で暑い(実在の砂漠の暑さ)。
  // 注(2026-08-01): 係数 12/6 とも実測否定 — 現状はモデル自身の降水誤差が
  // 温度誤差へ増幅される(誤差の正帰還)。降水場の成熟後に再訪(較正記録)。
  // 係数 0 のときは 2 パス目を丸ごとスキップする
  let temperature = temperature1;
  let precipitation = precipitation1;

  // ---- 温度 → 気圧 → 風 の帰還(段 9)----
  // 気圧場はここまで日射と幾何だけで作られており、モデル自身の気温を見て
  // いなかった。パス 1 の気温で作り直す。EBM を回し直すわけではないので、
  // 増える費用は windBelt + airflow の 1 回分だけ(全体の 1% 未満)
  let windBelt2 = windBelt;
  let airflow2 = airflow;
  if (thermalFeedback) {
    windBelt2 = await stage(
      'windbelt',
      'step2b_windbelt',
      [context, itcz, temperature1, P.body],
      () => computeWindBelt(context, itcz, temperature1.monthlyTemperatureC),
      (r) => ({ windBelt: r }),
    );
    airflow2 = await stage(
      'airflow',
      'step4b_airflow',
      [context, itcz, windBelt2, P.body],
      () => computeAirflow(context, itcz, windBelt2),
      (r) => ({ airflow: r }),
    );
  }

  if (twoPass) {
    temperature = await stage(
      'temperature',
      'step5b_temperature',
      [
        context,
        itcz,
        windBelt2,
        ocean,
        airflow2,
        precipitation1,
        temperature1,
        P.atmosphere,
        ...solverKey,
      ],
      // 蒸発帰還は前パスの**気温**のまわりで線形化するので、蒸発散を出したときの
      // 気温(= temperature1)を一緒に渡す。片方だけでは展開の基準点にならない
      (o) =>
        computeTemperature(
          context,
          itcz,
          windBelt2,
          ocean,
          airflow2,
          {
            ...(precipitation1.land ? { land: precipitation1.land } : {}),
            priorTemperatureC: temperature1.monthlyTemperatureC,
            priorPrecipMm: precipitation1.monthlyPrecipMm,
          },
          o,
        ),
      (r) => ({ temperature: r }),
    );
    // 2 パス目が最終場になるため、診断も 2 パス目のもので上書きする
    precipitation = await stage(
      'precipitation',
      'step6b_precipitation',
      precipDeps([
        context,
        itcz,
        windBelt2,
        ocean,
        airflow2,
        temperature,
        P.atmosphere,
        ...solverKey,
      ]),
      (o) =>
        computePrecipitation(
          context,
          itcz,
          windBelt2,
          ocean,
          airflow2,
          temperature,
          precipDiagBox,
          o,
        ),
      (r) => ({ precipitation: r }),
    );
  }

  const koppen = await stage(
    'koppen',
    'step7_koppen',
    [context, temperature, precipitation],
    () => computeKoppen(context, temperature, precipitation),
    (r) => ({ koppen: r }),
  );

  // P1-3: 適用範囲診断。範囲外は値を切り詰めず「判定不能」を宣言する
  const diagnostics = buildDiagnostics(params, temperature, precipitation);

  return {
    context,
    itcz,
    // 帰還が入っているときは**最終場を作った側**(パス 2 の気圧場と風)を返す。
    // 診断・描画・水収支がパス 1 の風を見ていたら、閉じない収支を数えてしまう
    windBelt: windBelt2,
    ocean,
    airflow: airflow2,
    temperature,
    precipitation,
    koppen,
    diagnostics,
  };
}
