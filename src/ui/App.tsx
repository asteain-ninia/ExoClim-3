import { useEffect } from 'react';
import { connectPipeline } from '@/store/connection';
import { WorkerBridge } from '@/worker/bridge';
import { useResultsStore } from '@/store/results';
import { useUiStore } from '@/store/ui';
import type { OverlayKind } from '@/store/ui';
import { MapCanvas } from './map/MapCanvas';
import { Legend } from './map/Legend';
import { ParamsPanel } from './parameters/ParamsPanel';

const OVERLAYS: Array<{ id: OverlayKind; label: string }> = [
  { id: 'koppen', label: '気候区分' },
  { id: 'temperature', label: '気温' },
  { id: 'precipitation', label: '降水' },
  { id: 'terrain', label: '地形' },
];

const MONTH_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

export function App() {
  const isComputing = useResultsStore((s) => s.isComputing);
  const lastError = useResultsStore((s) => s.lastError);
  const result = useResultsStore((s) => s.result);
  const { overlay, setOverlay, month, setMonth, showItczLine, toggleItczLine, showWindArrows, toggleWindArrows } =
    useUiStore();

  useEffect(() => {
    const disconnect = connectPipeline(new WorkerBridge());
    return disconnect;
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>ExoClim-3</h1>
        <span className="app-subtitle">惑星気候設計 — ITCZ→風帯→海流→気流→気温→降水→気候区分</span>
        {isComputing && (
          <span className="computing" data-testid="computing-indicator">
            <span className="spinner" /> 計算中…
          </span>
        )}
        {lastError && <span className="error-badge">エラー: {lastError}</span>}
      </header>

      <div className="app-body">
        <main className="map-column">
          <div className="overlay-tabs">
            {OVERLAYS.map((o) => (
              <button
                key={o.id}
                className={overlay === o.id ? 'tab tab--active' : 'tab'}
                onClick={() => setOverlay(o.id)}
                data-testid={`overlay-${o.id}`}
              >
                {o.label}
              </button>
            ))}
            <span className="tab-sep" />
            <label className="toggle-inline">
              <input type="checkbox" checked={showItczLine} onChange={toggleItczLine} /> ITCZ 線
            </label>
            <label className="toggle-inline">
              <input type="checkbox" checked={showWindArrows} onChange={toggleWindArrows} /> 風
            </label>
          </div>

          <MapCanvas />

          <div className="month-row">
            <button
              className={month === -1 ? 'month month--active' : 'month'}
              onClick={() => setMonth(-1)}
            >
              年平均
            </button>
            {MONTH_LABELS.map((label, m) => (
              <button
                key={m}
                className={month === m ? 'month month--active' : 'month'}
                onClick={() => setMonth(m)}
                data-testid={`month-${m}`}
              >
                {label}月
              </button>
            ))}
          </div>

          <Legend />

          {result && (
            <div className="timing-note">
              計算時間: 全 7 段{' '}
              {Object.values(result.stepTimingsMs)
                .reduce((a, b) => a + b, 0)
                .toLocaleString()}{' '}
              ms(格子 {result.context.grid.resolutionDeg}°)
            </div>
          )}
        </main>

        <aside className="side-column">
          <ParamsPanel />
        </aside>
      </div>

      <footer className="app-footer">
        一次参照: Worldbuilding Pasta ・ 検証データ: Beck et al. 2023 (CC BY 4.0) / NOAA ETOPO 2022 ・
        月 0 = 北半球の冬至から開始(「7 月」= 北半球の盛夏)
      </footer>
    </div>
  );
}
