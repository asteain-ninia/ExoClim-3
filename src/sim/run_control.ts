// 実行の制御(キャンセル・進捗・収束予算)の受け口。
//
// 対応 spec: なし(実行基盤)。
//
// **物理結果を変えてはならない**という制約が三者に共通してかかる:
//
//  - キャンセル: 中断は例外を投げるだけ。「途中まで計算した結果」を
//    答えとして返す経路は作らない(未収束の場を確定値と取り違える事故を
//    構造的に防ぐ)。
//  - 進捗: 書込のみの受け皿。降水診断 PrecipDiagBox と同じ扱いで、
//    渡しても渡さなくても結果はビット一致する(テストで担保する)。
//  - 収束予算: これは**物理結果を変える**。だからこそ利用者に見える形で
//    宣言し(プレビューは「未収束」と明示する)、既定値は確定品質にする。
//    隠しパラメータにしないこと(docs/方針.md、CLAUDE.md 禁止事項)。
//
// 計算層の純粋性について: src/sim/ は「純粋関数・副作用なし」が原則だが、
// 数分かかる計算を利用者が待つ以上、中断と進捗は避けられない。そこで
// **どちらも呼び出し側から明示的に渡す**形にし、渡されなければ従来どおり
// 素の純粋関数として走る。

import type { RunPartial } from './types';

/**
 * キャンセル要求の受け口。ポーリングで読む(AbortSignal を使わないのは、
 * Node のスクリプト・Worker・テストで同じ形にしたいのと、
 * イベントリスナの後始末を計算層に持ち込みたくないため)。
 */
export interface CancelToken {
  readonly cancelled: boolean;
}

/** キャンセルで中断したときに投げる。呼び出し側はこれをエラー扱いしないこと */
export class ComputeCancelledError extends Error {
  constructor(stage?: string) {
    super(stage ? `計算を中止しました(${stage})` : '計算を中止しました');
    this.name = 'ComputeCancelledError';
  }
}

export function isCancelled(e: unknown): e is ComputeCancelledError {
  return e instanceof ComputeCancelledError;
}

/** 中断要求が来ていれば投げる */
export function throwIfCancelled(signal: CancelToken | undefined, stage?: string): void {
  if (signal?.cancelled) throw new ComputeCancelledError(stage);
}

/**
 * イベントループへ制御を返す。**中断要求を受け取るために必要**。
 *
 * Worker の onmessage は JS が走っている間は発火しないので、長い計算ループが
 * 一度も yield しないと「キャンセル」を受け取れない(GPU 経路は最後の
 * 読み戻し 1 回まで await が無く、数分間まったく反応しなかった)。
 *
 * setTimeout(0) を使わないのは、ブラウザが入れ子の setTimeout を 5 段目から
 * 4ms にクランプするため。MessageChannel はクランプされない。
 * Node にも同名のグローバルがあるので、両環境で同じコードが動く。
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (): void => {
      ch.port1.close();
      ch.port2.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

// ---- 進捗 ----

/** パイプラインの段。進捗表示と費用モデルの見出しに使う */
export type RunStage =
  | 'context'
  | 'prepass'
  | 'itcz'
  | 'windbelt'
  | 'ocean'
  | 'airflow'
  | 'temperature'
  | 'precipitation'
  | 'koppen';

export const RUN_STAGE_LABELS: Record<RunStage, string> = {
  context: '地形・日射',
  prepass: '半球非対称の測定',
  itcz: 'ITCZ',
  windbelt: '風帯',
  ocean: '海流',
  airflow: '気流',
  temperature: '気温',
  precipitation: '降水',
  koppen: '気候区分',
};

export interface RunProgress {
  stage: RunStage;
  /** 段の中の進み具合 0〜1。不明なら null */
  stageFraction: number | null;
  /**
   * 実行全体の進み具合 0〜1。**単調とは限らない**:
   * 収束しなければ予算を倍にして回し直すため、見積もり総量が途中で増える。
   * UI はそれを隠さずに出すこと(嘘の進捗バーを作らない)。
   */
  overall: number;
  /** 人が読む一行(例:「EBM 8/24 年目・反復 512」) */
  detail: string;
  /** 見積もりが伸びた(予算を増やして回し直した)ことを示す */
  budgetExtended?: boolean;
  /**
   * この通知で新しく計算できた場。**表示はこれを重ねていく**。
   * 確定結果とは型が別(PartialPipelineResult の注記を読むこと)。
   */
  partial?: RunPartial;
}

export type ProgressSink = (p: RunProgress) => void;

/** 段の内側から呼ぶ進捗通知(全体比への換算はパイプライン側が持つ) */
export type StageProgressSink = (p: {
  fraction: number | null;
  detail: string;
  budgetExtended?: boolean;
  partial?: RunPartial;
}) => void;

// ---- 収束予算 ----

/**
 * 収束予算。**物理結果を変える**ので、既定(= 未指定)は必ず本計算になる。
 *
 * 各項目は省略可で、省略された項目は**各段が持つ既定の定数**に落ちる
 * (値をここに複製しない — 複製すると定数の根拠コメントと値が離れ、
 * 片方だけ動かす事故が起きる。実際 2026-08-02 に EBM の年数で踏んでいる)。
 *
 * **UI からは使わない**(2026-08-03 の利用者判断: 軽量プレビューは廃止し、
 * 常に本計算を回してその途中経過を表示する)。残してあるのは
 * 数値の実験(scripts/exp_*.ts)が予算を振って測るため。
 */
export interface ConvergenceBudget {
  /** 全熱容量で積分する年数の出発点(既定 EBM_FULL_CAPACITY_START_YEARS = 24) */
  ebmFullCapacityYears?: number | undefined;
  /** 年数を倍にする上限(既定 EBM_MAX_FULL_CAPACITY_YEARS = 64)。
   *  出発点と同じにすると 1 回で止まり、未収束のまま返る */
  ebmMaxFullCapacityYears?: number | undefined;
  /** 1 時間ステップあたりの線形解の反復回数(既定 EBM_GPU_ITERATIONS = 512) */
  ebmIterations?: number | undefined;
  /** 反復を倍にする上限(既定 EBM_GPU_MAX_ITERATIONS = 8192) */
  ebmMaxIterations?: number | undefined;
  /** 加速期(熱容量 1/16)の年数(既定 SPINUP_ACCEL_YEARS = 2) */
  ebmSpinupAccelYears?: number | undefined;
  /** 土壌水分の空回し年数の上限(既定 MODEL_CONSTANTS.soilSpinupYears = 2000) */
  soilSpinupYears?: number | undefined;
  /** 降水の結合反復の上限(既定 COUPLING_MAX_ITERATIONS = 8) */
  precipCouplingIterations?: number | undefined;
}

// ---- 段キャッシュ ----

/**
 * 段ごとの計算結果を覚えておく受け口(実装はワーカー層 —
 * 計算層は「渡されたら使う」だけで、キャッシュの寿命は知らない)。
 *
 * 鍵は **上流の出力そのものへの参照** + その段が読むパラメータ片。
 * 上流が不変なら参照が同一 → 下流のヒットが連鎖する(教訓 §3、
 * ExoClim-2 で実証済みの設計)。
 *
 * **どれだけ効くかは正直に言っておく**(2026-08-02 の依存関係の実測):
 * 費用の 99% は気温(EBM)と降水にあり、この 2 段は上流 1〜4 段すべてに
 * 依存する。つまり**どのパラメータを動かしても節約できるのは 1% 未満**で、
 * 効くのは「何も変わっていない再実行」を丸ごと省ける場合だけ。
 * 気温の再計算そのものを省くにはウォームスタート(前回の収束温度場を
 * 初期値に使う)が要るが、これは決定性規約に触れるので別途判断が要る。
 */
export interface StageCache {
  getOrCompute<T>(key: string, deps: readonly unknown[], compute: () => T | Promise<T>): Promise<T>;
}
