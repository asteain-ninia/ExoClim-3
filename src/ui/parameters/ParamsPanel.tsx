// パラメータパネル。docs/要件.md §2 の利用者パラメータを全て露出する。

import { useState } from 'react';
import { orbitalPeriodYears, stellarConstantWm2 } from '@/domain/planetParams';
import type { TerrainPresetName } from '@/domain/planetParams';
import { useParamsStore } from '@/store/params';
import { Slider } from './Slider';

const TERRAIN_PRESETS: Array<{ id: TerrainPresetName; label: string }> = [
  { id: 'earth', label: '実在地球' },
  { id: 'idealized_continent', label: '理想化大陸(単一)' },
  { id: 'two_continents', label: '南北分断大陸' },
  { id: 'aquaplanet', label: '全海惑星' },
  { id: 'all_land', label: '全陸惑星' },
];

export function ParamsPanel() {
  const { params, setOrbital, setBody, setAtmosphere, setTerrainPreset, setTerrainProcedural, setGridResolution, reset } =
    useParamsStore();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const terrain = params.terrain;

  return (
    <div className="params-panel" data-testid="params-panel">
      <details open>
        <summary>地形</summary>
        <div className="preset-row">
          {TERRAIN_PRESETS.map((p) => (
            <button
              key={p.id}
              className={
                terrain.kind === 'preset' && terrain.preset === p.id ? 'preset preset--active' : 'preset'
              }
              onClick={() => setTerrainPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          <button
            className={terrain.kind === 'procedural' ? 'preset preset--active' : 'preset'}
            onClick={() => setTerrainProcedural(42, 0.3, 1)}
          >
            手続き生成
          </button>
        </div>
        {terrain.kind === 'procedural' && (
          <>
            <Slider
              label="乱数種子"
              value={terrain.seed}
              min={1}
              max={9999}
              step={1}
              onChange={(v) => setTerrainProcedural(v, terrain.landFraction, terrain.reliefScale)}
            />
            <Slider
              label="陸面積率"
              value={terrain.landFraction}
              min={0.05}
              max={0.9}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => setTerrainProcedural(terrain.seed, v, terrain.reliefScale)}
            />
            <Slider
              label="起伏の強さ"
              value={terrain.reliefScale}
              min={0.3}
              max={2}
              step={0.1}
              onChange={(v) => setTerrainProcedural(terrain.seed, terrain.landFraction, v)}
            />
          </>
        )}
      </details>

      <details open>
        <summary>主星と軌道</summary>
        <Slider
          label="主星光度"
          value={params.orbital.starLuminositySolar}
          min={0.1}
          max={4}
          step={0.05}
          unit=" 太陽"
          onChange={(v) => setOrbital({ starLuminositySolar: v })}
        />
        <Slider
          label="軌道長半径"
          value={params.orbital.semiMajorAxisAu}
          min={0.3}
          max={3}
          step={0.01}
          unit=" AU"
          onChange={(v) => setOrbital({ semiMajorAxisAu: v })}
        />
        <Slider
          label="軌道離心率"
          value={params.orbital.eccentricity}
          min={0}
          max={0.6}
          step={0.005}
          onChange={(v) => setOrbital({ eccentricity: v })}
        />
        <Slider
          label="近日点の季節位相"
          value={params.orbital.perihelionSeasonDeg}
          min={0}
          max={359}
          step={1}
          unit="°"
          onChange={(v) => setOrbital({ perihelionSeasonDeg: v })}
        />
        <div className="derived-note">
          放射照度 {Math.round(stellarConstantWm2(params.orbital))} W/m² ・ 公転周期{' '}
          {orbitalPeriodYears(params.orbital).toFixed(2)} 年
        </div>
      </details>

      <details open>
        <summary>惑星本体</summary>
        <Slider
          label="地軸傾斜"
          value={params.body.axialTiltDeg}
          min={0}
          max={80}
          step={0.5}
          unit="°"
          onChange={(v) => setBody({ axialTiltDeg: v })}
        />
        <Slider
          label="自転周期"
          value={params.body.rotationPeriodHours}
          min={6}
          max={120}
          step={1}
          unit=" 時間"
          onChange={(v) => setBody({ rotationPeriodHours: v })}
        />
        <Slider
          label="半径"
          value={params.body.radiusKm}
          min={2000}
          max={12000}
          step={100}
          unit=" km"
          onChange={(v) => setBody({ radiusKm: v })}
        />
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={params.body.rotationDirection === -1}
            onChange={(e) => setBody({ rotationDirection: e.target.checked ? -1 : 1 })}
          />
          逆行自転
        </label>
      </details>

      <details open>
        <summary>大気と海洋</summary>
        <Slider
          label="表面気圧"
          value={params.atmosphere.surfacePressureBar}
          min={0.2}
          max={5}
          step={0.1}
          unit=" bar"
          onChange={(v) => setAtmosphere({ surfacePressureBar: v })}
        />
        <Slider
          label="温室効果強度"
          value={params.atmosphere.greenhouseStrength}
          min={0.3}
          max={3}
          step={0.05}
          unit="×"
          onChange={(v) => setAtmosphere({ greenhouseStrength: v })}
        />
        <Slider
          label="雲アルベド"
          value={params.atmosphere.cloudAlbedo}
          min={0.05}
          max={0.4}
          step={0.01}
          onChange={(v) => setAtmosphere({ cloudAlbedo: v })}
        />
        <Slider
          label="海洋混合層の深さ"
          value={params.atmosphere.oceanMixedLayerDepthM}
          min={10}
          max={200}
          step={5}
          unit=" m"
          onChange={(v) => setAtmosphere({ oceanMixedLayerDepthM: v })}
        />
        <Slider
          label="熱輸送強度"
          value={params.atmosphere.heatTransportStrength}
          min={0.3}
          max={2.5}
          step={0.05}
          unit="×"
          onChange={(v) => setAtmosphere({ heatTransportStrength: v })}
        />
      </details>

      <details>
        <summary>計算設定</summary>
        <div className="preset-row">
          {[2, 1].map((deg) => (
            <button
              key={deg}
              className={params.gridResolutionDeg === deg ? 'preset preset--active' : 'preset'}
              onClick={() => setGridResolution(deg)}
            >
              {deg}°(
              {deg === 2 ? '高速' : '高精細'})
            </button>
          ))}
        </div>
      </details>

      <button
        className={confirmingReset ? 'reset-button reset-button--confirm' : 'reset-button'}
        onClick={() => {
          if (confirmingReset) {
            reset();
            setConfirmingReset(false);
          } else {
            setConfirmingReset(true);
            setTimeout(() => setConfirmingReset(false), 3000);
          }
        }}
      >
        {confirmingReset ? 'もう一度押すと初期化' : '全パラメータを地球初期値へ'}
      </button>
    </div>
  );
}
