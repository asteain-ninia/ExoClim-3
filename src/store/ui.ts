// UI 状態のストア(表示中のオーバーレイ・月・ホバーセルなど)。永続化しない。

import { create } from 'zustand';

export type OverlayKind = 'koppen' | 'temperature' | 'precipitation' | 'terrain' | 'wind';

/** -1 = 年平均、0-11 = 月 */
export type MonthSelection = number;

interface UiState {
  overlay: OverlayKind;
  month: MonthSelection;
  hoveredCell: { row: number; col: number } | null;
  showItczLine: boolean;
  showWindArrows: boolean;
  setOverlay: (overlay: OverlayKind) => void;
  setMonth: (month: MonthSelection) => void;
  setHoveredCell: (cell: { row: number; col: number } | null) => void;
  toggleItczLine: () => void;
  toggleWindArrows: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  overlay: 'koppen',
  month: -1,
  hoveredCell: null,
  showItczLine: true,
  showWindArrows: false,
  setOverlay: (overlay) => set({ overlay }),
  setMonth: (month) => set({ month }),
  setHoveredCell: (hoveredCell) => set({ hoveredCell }),
  toggleItczLine: () => set((s) => ({ showItczLine: !s.showItczLine })),
  toggleWindArrows: () => set((s) => ({ showWindArrows: !s.showWindArrows })),
}));
