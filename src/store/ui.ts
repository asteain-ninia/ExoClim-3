// UI 状態のストア(表示中のオーバーレイ・月・ホバーセル・ビュー状態など)。永続化しない。

import { create } from 'zustand';
import type { PlanetParams } from '@/domain/planetParams';

export type OverlayKind =
  'terrain' | 'currents' | 'pressure' | 'temperature' | 'precipitation' | 'koppen' | 'koppenObs';

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
  /**
   * いま表示している地図を計算したときのパラメータ。
   * 自動実行をやめた(2026-08-03)ので、**パラメータと地図がずれた状態**が
   * 普通に起きる。黙っていると古い地図を最新だと誤読するので、
   * これと現在値を比べて UI に出す。null = まだ一度も計算していない。
   */
  computedParams: PlanetParams | null;
  setOverlay: (overlay: OverlayKind) => void;
  setMonth: (month: MonthSelection) => void;
  setHoveredCell: (cell: { row: number; col: number } | null) => void;
  toggleItczLine: () => void;
  toggleWindArrows: () => void;
  setViewMode: (mode: ViewMode) => void;
  setPanLonDeg: (deg: number) => void;
  setViewSpanDeg: (deg: number) => void;
  setGlobeRotation: (lon0: number, lat0: number) => void;
  /** 計算を開始したときに、その入力を控える */
  markComputed: (params: PlanetParams) => void;
}

/** 自分の列挙したキーだけを Object.is で比べる(決定性規約と同じ語義) */
function shallowEq(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  return ka.every((k) => Object.is(ra[k], rb[k]));
}

/**
 * 惑星パラメータが同じか。
 * 配列(取込地形の標高など)は**参照で比べる** — 中身の全比較は 1° で
 * 64,800 要素になり、スライダーを動かすたびに走らせる処理としては高すぎる。
 * 取込地形の配列は読み込み時にしか作り直されないので、参照比較で足りる。
 */
export function sameParams(a: PlanetParams, b: PlanetParams): boolean {
  if (a === b) return true;
  return (
    a.gridResolutionDeg === b.gridResolutionDeg &&
    shallowEq(a.orbital, b.orbital) &&
    shallowEq(a.body, b.body) &&
    shallowEq(a.atmosphere, b.atmosphere) &&
    shallowEq(a.terrain, b.terrain)
  );
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
  computedParams: null,
  markComputed: (computedParams) => set({ computedParams }),
  setOverlay: (overlay) => set({ overlay }),
  setMonth: (month) => set({ month }),
  setHoveredCell: (hoveredCell) => set({ hoveredCell }),
  toggleItczLine: () => set((s) => ({ showItczLine: !s.showItczLine })),
  toggleWindArrows: () => set((s) => ({ showWindArrows: !s.showWindArrows })),
  setViewMode: (viewMode) => set({ viewMode }),
  setPanLonDeg: (panLonDeg) => set({ panLonDeg }),
  setViewSpanDeg: (viewSpanDeg) => set({ viewSpanDeg: Math.min(1440, Math.max(360, viewSpanDeg)) }),
  setGlobeRotation: (globeLon0, globeLat0) =>
    set({ globeLon0, globeLat0: Math.min(85, Math.max(-85, globeLat0)) }),
}));
