// 計算結果のストア。ワーカーからの結果のみが書き込む。

import { create } from 'zustand';
import type { PipelineResult } from '@/sim/types';

interface ResultsState {
  result: PipelineResult | null;
  /** 直近実行の計測(時刻依存 — 物理結果とは分離。P1-4) */
  stepTimingsMs: Record<string, number> | null;
  isComputing: boolean;
  lastError: string | null;
  setResult: (result: PipelineResult, stepTimingsMs: Record<string, number>) => void;
  setComputing: (computing: boolean) => void;
  setError: (message: string | null) => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
  result: null,
  stepTimingsMs: null,
  isComputing: false,
  lastError: null,
  setResult: (result, stepTimingsMs) => set({ result, stepTimingsMs, lastError: null }),
  setComputing: (isComputing) => set({ isComputing }),
  setError: (lastError) => set({ lastError }),
}));
