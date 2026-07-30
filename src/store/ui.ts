// UI 状態のストア(表示中のオーバーレイ・月・ホバーセル・ビュー状態など)。永続化しない。

import { create } from 'zustand';

export type OverlayKind =
  | 'terrain'
  | 'currents'
  | 'pressure'
  | 'temperature'
  | 'precipitation'
  | 'koppen'
  | 'koppenObs';

/** -1 = 年平均、0-11 = 月 */
export type MonthSelection = number;

export type ViewMode = 'flat' | 'globe';

interface UiState {
  overlay: OverlayKind;
  month: MonthSelection;
  hoveredCell: { row: number; col: number } | null;
  showItczLine: boolean;
  showWindArrows: boolean;
  /** 平面(円筒・無限スクロール)か球体(正射図法)か */
  viewMode: ViewMode;
  /** 平面: 画面中央の経度オフセット(度、無限に周回) */
  panLonDeg: number;
  /** 平面: 画面の横幅が示す経度スパン(度)。360 超で世界が繰り返して見える */
  viewSpanDeg: number;
  /** 球体: 視線中心の経度・緯度(度) */
  globeLon0: number;
  globeLat0: number;
  setOverlay: (overlay: OverlayKind) => void;
  setMonth: (month: MonthSelection) => void;
  setHoveredCell: (cell: { row: number; col: number } | null) => void;
  toggleItczLine: () => void;
  toggleWindArrows: () => void;
  setViewMode: (mode: ViewMode) => void;
  setPanLonDeg: (deg: number) => void;
  setViewSpanDeg: (deg: number) => void;
  setGlobeRotation: (lon0: number, lat0: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  overlay: 'koppen',
  month: -1,
  hoveredCell: null,
  showItczLine: true,
  showWindArrows: false,
  viewMode: 'flat',
  panLonDeg: 0,
  viewSpanDeg: 360,
  globeLon0: 0,
  globeLat0: 15,
  setOverlay: (overlay) => set({ overlay }),
  setMonth: (month) => set({ month }),
  setHoveredCell: (hoveredCell) => set({ hoveredCell }),
  toggleItczLine: () => set((s) => ({ showItczLine: !s.showItczLine })),
  toggleWindArrows: () => set((s) => ({ showWindArrows: !s.showWindArrows })),
  setViewMode: (viewMode) => set({ viewMode }),
  setPanLonDeg: (panLonDeg) => set({ panLonDeg }),
  setViewSpanDeg: (viewSpanDeg) =>
    set({ viewSpanDeg: Math.min(1440, Math.max(360, viewSpanDeg)) }),
  setGlobeRotation: (globeLon0, globeLat0) =>
    set({ globeLon0, globeLat0: Math.min(85, Math.max(-85, globeLat0)) }),
}));
