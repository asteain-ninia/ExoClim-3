// 計算結果のストア。ワーカーからの結果のみが書き込む。

import { create } from 'zustand';
import type { PipelineResult } from '@/sim/types';

interface ResultsState {
  result: PipelineResult | null;
  isComputing: boolean;
  lastError: string | null;
  setResult: (result: PipelineResult) => void;
  setComputing: (computing: boolean) => void;
  setError: (message: string | null) => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
  result: null,
  isComputing: false,
  lastError: null,
  setResult: (result) => set({ result, lastError: null }),
  setComputing: (isComputing) => set({ isComputing }),
  setError: (lastError) => set({ lastError }),
}));
