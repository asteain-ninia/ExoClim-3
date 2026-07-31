// 利用者パラメータのストア。docs/要件.md §2 の全項目を保持する。

import { create } from 'zustand';
import type { PlanetParams, TerrainPresetName } from '@/domain/planetParams';
import { EARTH_PARAMS } from '@/domain/planetParams';

interface ParamsState {
  params: PlanetParams;
  setOrbital: (patch: Partial<PlanetParams['orbital']>) => void;
  setBody: (patch: Partial<PlanetParams['body']>) => void;
  setAtmosphere: (patch: Partial<PlanetParams['atmosphere']>) => void;
  setTerrainPreset: (preset: TerrainPresetName) => void;
  setTerrainProcedural: (seed: number, landFraction: number, reliefScale: number) => void;
  setGridResolution: (deg: number) => void;
  reset: () => void;
}

/** UI 既定は 1°(検証ハーネスと同じ)。0.5° は最高精細(数十秒)。 */
const DEFAULT_PARAMS: PlanetParams = { ...EARTH_PARAMS, gridResolutionDeg: 1 };

export const useParamsStore = create<ParamsState>((set) => ({
  params: DEFAULT_PARAMS,
  setOrbital: (patch) =>
    set((s) => ({ params: { ...s.params, orbital: { ...s.params.orbital, ...patch } } })),
  setBody: (patch) =>
    set((s) => ({ params: { ...s.params, body: { ...s.params.body, ...patch } } })),
  setAtmosphere: (patch) =>
    set((s) => ({ params: { ...s.params, atmosphere: { ...s.params.atmosphere, ...patch } } })),
  setTerrainPreset: (preset) =>
    set((s) => ({ params: { ...s.params, terrain: { kind: 'preset', preset } } })),
  setTerrainProcedural: (seed, landFraction, reliefScale) =>
    set((s) => ({
      params: { ...s.params, terrain: { kind: 'procedural', seed, landFraction, reliefScale } },
    })),
  setGridResolution: (deg) => set((s) => ({ params: { ...s.params, gridResolutionDeg: deg } })),
  reset: () => set({ params: DEFAULT_PARAMS }),
}));
