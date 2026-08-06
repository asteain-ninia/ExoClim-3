// 計算結果のストア。ワーカーからの結果のみが書き込む。
//
// **確定結果と途中結果を型で分ける**(2026-08-03)。同じ場所に混ぜると、
// 未完成の場を確定値として読んでしまう経路ができる(教訓 §1)。
//  - result: 最後まで走りきった結果。これだけが「答え」。
//  - draft:  実行中に段ごとに届く途中結果。表示はこちらを優先して描く。
//
// 表示は `displayResult()` を通して取る。draft があればそちら、無ければ result。

import { create } from 'zustand';
import type { PartialPipelineResult, PipelineResult, RunPartial } from '@/sim/types';
import type { RunProgress } from '@/sim/run_control';
import type { PipelineRunOutput } from '@/worker/protocol';

interface ResultsState {
  /** 走りきった結果(= 答え)。中断・実行中は前回のものが残る */
  result: PipelineResult | null;
  /** 実行中に積み上がる途中結果。実行開始で捨て、完了で null に戻す */
  draft: PartialPipelineResult | null;
  /** 直近実行の計測(時刻依存 — 物理結果とは分離。P1-4) */
  stepTimingsMs: Record<string, number> | null;
  /** 加速器の説明(GPU 名 / CPU に落ちた理由) */
  accelInfo: string | null;
  cacheHits: string[];
  cacheMisses: string[];

  isComputing: boolean;
  progress: RunProgress | null;
  /**
   * 直近に進捗が届いた時刻(ミリ秒)。**停滞の検知に使う**。
   * 計算層は時計を読まない規約だが、これは UI 層が自分で打つ受信時刻なので
   * 物理結果には一切入らない(P1-4 の分離を壊さない)。
   */
  lastProgressAt: number | null;
  lastError: string | null;
  /** 直近の実行が中断で終わったか(エラーとは区別する) */
  wasCancelled: boolean;

  beginRun: () => void;
  setProgress: (progress: RunProgress, accelInfo?: string) => void;
  setResult: (output: PipelineRunOutput) => void;
  setCancelled: () => void;
  setError: (message: string | null) => void;
  endRun: () => void;
}

/** 差分を途中結果へ重ねる。context が来たら**それ以前の場は捨てる** */
function mergePartial(
  draft: PartialPipelineResult | null,
  partial: RunPartial,
): PartialPipelineResult | null {
  if (partial.context) {
    // 新しい文脈 = 新しい格子・地形。古い場は長さも意味も合わないので捨てる
    return { context: partial.context };
  }
  if (!draft) return null; // context 無しでは何も描けない
  return { ...draft, ...partial };
}

export const useResultsStore = create<ResultsState>((set) => ({
  result: null,
  draft: null,
  stepTimingsMs: null,
  accelInfo: null,
  cacheHits: [],
  cacheMisses: [],
  isComputing: false,
  progress: null,
  lastProgressAt: null,
  lastError: null,
  wasCancelled: false,

  beginRun: () =>
    set({
      isComputing: true,
      progress: null,
      draft: null,
      wasCancelled: false,
      accelInfo: null,
      lastProgressAt: Date.now(),
    }),
  setProgress: (progress, accelInfo) =>
    set((s) => ({
      progress,
      lastProgressAt: Date.now(),
      // 加速器の別は走り出しに 1 回だけ届く。以後は上書きしない
      ...(accelInfo ? { accelInfo } : {}),
      draft: progress.partial ? mergePartial(s.draft, progress.partial) : s.draft,
    })),
  setResult: (output) =>
    set({
      result: output.result,
      draft: null,
      stepTimingsMs: output.stepTimingsMs,
      accelInfo: output.accelInfo,
      cacheHits: output.cacheHits,
      cacheMisses: output.cacheMisses,
      lastError: null,
      wasCancelled: false,
    }),
  // 中断は失敗ではない。**途中結果はそのまま残す** — せっかく計算した場を
  // 捨てる理由が無いし、どこまで進んだかを見せたほうが親切
  setCancelled: () => set({ wasCancelled: true }),
  setError: (lastError) => set({ lastError }),
  endRun: () => set({ isComputing: false }),
}));

/**
 * 表示に使う結果。途中結果があればそれを、無ければ最後の確定結果を返す。
 * **どちらなのかは isComputing / draft の有無で UI 側が判断する**
 * (この関数は「今描けるもの」を返すだけ)。
 */
export function displayResult(s: ResultsState): PartialPipelineResult | null {
  return s.draft ?? s.result;
}
