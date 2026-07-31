import { useEffect } from 'react';
import { connectPipeline } from '@/store/connection';
import { WorkerBridge } from '@/worker/bridge';
import { useResultsStore } from '@/store/results';
import { useUiStore } from '@/store/ui';
import type { OverlayKind } from '@/store/ui';
import { MapCanvas } from './map/MapCanvas';
import { Legend } from './map/Legend';
import { ParamsPanel } from './parameters/ParamsPanel';

// 作図手順の順序(Cookbook/Artifexian/Pasta 共通の手描きレイヤー順)
const OVERLAYS: Array<{ id: OverlayKind; label: string; step: string }> = [
  { id: 'terrain', label: '地形', step: '0' },
  { id: 'currents', label: '海流', step: '3' },
  { id: 'pressure', label: '気圧・風帯', step: '2·4' },
  { id: 'temperature', label: '気温', step: '5' },
  { id: 'precipitation', label: '降水', step: '6' },
  { id: 'koppen', label: '気候区分', step: '7' },
  { id: 'koppenObs', label: '観測 (Beck)', step: '参' },
];

const MONTH_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

export function App() {
  const isComputing = useResultsStore((s) => s.isComputing);
  const lastError = useResultsStore((s) => s.lastError);
  const result = useResultsStore((s) => s.result);
  const outOfDomain = result?.diagnostics?.status === 'out_of_domain';
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
                title={`手順 ${o.step}`}
              >
                <span className="tab-step">{o.step}</span>
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

          {outOfDomain && (
            <div
              className="domain-banner"
              data-testid="domain-banner"
              style={{
                background: '#5a1f1f',
                color: '#ffd7d7',
                padding: '8px 12px',
                borderRadius: 6,
                margin: '6px 0',
                fontSize: 13,
              }}
            >
              <strong>適用範囲外 — このモデルでは判定不能。</strong>{' '}
              気候区分は有効な科学出力ではありません。
              <ul style={{ margin: '4px 0 0 18px' }}>
                {result?.diagnostics.issues
                  .filter((x) => x.severity === 'error')
                  .slice(0, 5)
                  .map((x) => (
                    <li key={x.code}>{x.message}</li>
                  ))}
              </ul>
            </div>
          )}
          {outOfDomain && overlay === 'koppen' ? (
            <div
              className="map-invalid"
              data-testid="koppen-invalid"
              style={{
                minHeight: 320,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#1a2233',
                color: '#8fa0b8',
                borderRadius: 6,
              }}
            >
              適用範囲外のため気候区分は表示しません(他レイヤーは生の場として閲覧可能)
            </div>
          ) : (
            <MapCanvas />
          )}

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
