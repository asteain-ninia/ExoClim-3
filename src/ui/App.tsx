import { useEffect, useRef, useState } from 'react';
import { connectPipeline, type PipelineConnection } from '@/store/connection';
import { WorkerBridge } from '@/worker/bridge';
import { useParamsStore } from '@/store/params';
import { useResultsStore } from '@/store/results';
import { sameParams, useUiStore } from '@/store/ui';
import type { OverlayKind } from '@/store/ui';
import { MapCanvas } from './map/MapCanvas';
import { hasLayer, LAYER_WAIT_REASON } from './map/layers';
import { Legend } from './map/Legend';
import { ParamsPanel } from './parameters/ParamsPanel';
import { ComputeMonitor } from './ComputeMonitor';

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
  const draft = useResultsStore((s) => s.draft);
  const shown = draft ?? result;
  const stepTimingsMs = useResultsStore((s) => s.stepTimingsMs);
  const accelInfo = useResultsStore((s) => s.accelInfo);
  const cacheHits = useResultsStore((s) => s.cacheHits);
  const wasCancelled = useResultsStore((s) => s.wasCancelled);
  const outOfDomain = result?.diagnostics?.status === 'out_of_domain';
  const [showDetail, setShowDetail] = useState(false);
  // 自動実行しないので、パラメータと地図がずれた状態が普通に起きる。
  // 黙っていると古い地図を最新だと誤読するので必ず出す
  const params = useParamsStore((s) => s.params);
  const computedParams = useUiStore((s) => s.computedParams);
  const paramsDirty = computedParams !== null && !sameParams(params, computedParams);
  const neverComputed = computedParams === null;
  const {
    overlay,
    setOverlay,
    month,
    setMonth,
    showItczLine,
    toggleItczLine,
    showWindArrows,
    toggleWindArrows,
  } = useUiStore();
  // 月を変えて絵が変わるのは「月を持つ層」が実際に描かれているときだけ
  const monthMeaningful = overlay !== 'terrain' && hasLayer(shown, overlay);

  const connRef = useRef<PipelineConnection | null>(null);
  useEffect(() => {
    const conn = connectPipeline(new WorkerBridge());
    connRef.current = conn;
    return () => {
      connRef.current = null;
      conn.disconnect();
    };
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
        {!isComputing && !paramsDirty && result && (
          <span className="quality-badge quality-badge--final" data-testid="final-badge">
            計算済み
          </span>
        )}
        <button
          className={
            paramsDirty || neverComputed ? 'commit-button commit-button--dirty' : 'commit-button'
          }
          onClick={() => connRef.current?.run()}
          data-testid="commit-button"
          title="収束するまで回して気候を求めます(数分かかります)"
        >
          {isComputing ? '最新のパラメータで計算し直す' : '計算する'}
        </button>
        {isComputing && (
          <button
            className="cancel-button"
            onClick={() => connRef.current?.cancel()}
            data-testid="header-cancel-button"
          >
            中止
          </button>
        )}
        {lastError && <span className="error-badge">エラー: {lastError}</span>}
      </header>

      <ComputeMonitor onCancel={() => connRef.current?.cancel()} />

      <div className="app-body">
        <main className="map-column">
          <div className="overlay-tabs">
            {OVERLAYS.map((o) => {
              // その層がまだ無いことを**押す前に**見せる。無い層を押すと地形に
              // 退避する仕様なので、印が無いと「切り替えが効かない」と読める
              const pending = !hasLayer(shown, o.id);
              const cls = [
                'tab',
                overlay === o.id ? 'tab--active' : '',
                pending ? 'tab--pending' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={o.id}
                  className={cls}
                  onClick={() => setOverlay(o.id)}
                  data-testid={`overlay-${o.id}`}
                  title={
                    pending
                      ? `手順 ${o.step} — 未計算${LAYER_WAIT_REASON[o.id] ? `(${LAYER_WAIT_REASON[o.id]})` : ''}`
                      : `手順 ${o.step}`
                  }
                >
                  <span className="tab-step">{o.step}</span>
                  {o.label}
                  {pending && <span className="tab-pending-dot" aria-label="未計算" />}
                </button>
              );
            })}
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

          {/* いま描かれている層が月に依らないときは、月ボタンを押しても絵が
              変わらない。黙っていると「月の切替が効かない」と読めるので明示する
              (2026-08-03 の指摘。地形は月を持たず、未計算の層は地形へ退避する) */}
          <div className={monthMeaningful ? 'month-row' : 'month-row month-row--inert'}>
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
            {!monthMeaningful && (
              <span className="month-inert-note" data-testid="month-inert-note">
                {overlay === 'terrain'
                  ? '地形は月で変わりません'
                  : 'この層はまだ計算されていないので、月を変えても絵は変わりません'}
              </span>
            )}
          </div>

          <Legend />

          {isComputing && draft && (
            <div className="preview-note" data-testid="in-progress-note">
              <strong>計算中の途中経過を表示しています。</strong>{' '}
              段が終わるたびに埋まっていきます。気温は EBM のモデル内 1 年ごと、
              降水は結合反復ごとに更新されます。
              <strong>まだ確定値ではありません。</strong>
            </div>
          )}
          {!isComputing && paramsDirty && (
            <div className="preview-note" data-testid="dirty-note">
              <strong>パラメータが変わっています。</strong>{' '}
              この地図は変更前のパラメータで計算したものです。
              反映するには「計算する」を押してください。
            </div>
          )}
          {!isComputing && neverComputed && (
            <div className="preview-note" data-testid="never-computed-note">
              まだ計算していません。「計算する」を押すと気候の計算が始まります(数分かかります)。
            </div>
          )}
          {wasCancelled && !isComputing && (
            <div className="preview-note" data-testid="cancelled-note">
              計算を中止しました。表示は中止前の結果のままです。
            </div>
          )}

          {result && stepTimingsMs && (
            <div className="timing-note">
              計算時間: 全 7 段{' '}
              {Object.values(stepTimingsMs)
                .reduce((a, b) => a + b, 0)
                .toLocaleString()}{' '}
              ms(格子 {result.context.grid.resolutionDeg}°){accelInfo ? ` / ${accelInfo}` : ''}
              {cacheHits.length > 0 ? ` / 再利用 ${cacheHits.length} 段` : ''}{' '}
              <button className="link-button" onClick={() => setShowDetail((v) => !v)}>
                {showDetail ? '内訳を隠す' : '内訳'}
              </button>
              {showDetail && (
                <ul className="timing-list">
                  {Object.entries(stepTimingsMs)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, ms]) => (
                      <li key={name}>
                        {name}: {ms.toLocaleString()} ms
                        {cacheHits.includes(name) ? '(再利用)' : ''}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </main>

        <aside className="side-column">
          <ParamsPanel />
        </aside>
      </div>

      <footer className="app-footer">
        一次参照: Worldbuilding Pasta ・ 検証データ: Beck et al. 2023 (CC BY 4.0) / NOAA ETOPO 2022
        ・ 月 0 = 北半球の冬至から開始(「7 月」= 北半球の盛夏)
      </footer>
    </div>
  );
}
