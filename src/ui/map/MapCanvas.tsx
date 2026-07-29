// マップ描画。格子解像度の ImageData を作り、拡大描画する(最近傍)。
// ITCZ 線・風矢印は上層の別 canvas に描く(教訓 §4 F4: ホバーで全再描画しない)。
// オーバーレイ要素は 3 オフセット描画(教訓 §5: 経度循環)…v0.1 はパンなしのため単一。

import { useEffect, useMemo, useRef } from 'react';
import { latDegOfRow, lonDegOfCol } from '@/domain/grid';
import { KOPPEN_CLASSES } from '@/domain/koppen';
import type { PipelineResult } from '@/sim/types';
import { useResultsStore } from '@/store/results';
import { useUiStore } from '@/store/ui';
import { koppenColor, precipitationColor, temperatureColor, terrainColor, OCEAN_COLOR } from './colorScales';

const CANVAS_W = 1080;
const CANVAS_H = 540;

export function MapCanvas() {
  const result = useResultsStore((s) => s.result);
  const overlay = useUiStore((s) => s.overlay);
  const month = useUiStore((s) => s.month);
  const showItczLine = useUiStore((s) => s.showItczLine);
  const showWindArrows = useUiStore((s) => s.showWindArrows);
  const hoveredCell = useUiStore((s) => s.hoveredCell);
  const setHoveredCell = useUiStore((s) => s.setHoveredCell);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // ---- 基層ビットマップ ----
  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas || !result) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const { grid, terrain } = result.context;
    const W = grid.widthCells;
    const H = grid.heightCells;
    const img = new ImageData(W, H);
    for (let i = 0; i < grid.cellCount; i++) {
      const isLand = terrain.landMask[i] === 1;
      let rgb: readonly [number, number, number] = OCEAN_COLOR;
      switch (overlay) {
        case 'koppen':
          rgb = koppenColor(result.koppen.classId[i] ?? 0, isLand);
          break;
        case 'temperature': {
          const t =
            month < 0
              ? (result.temperature.annualMeanC[i] ?? 0)
              : (result.temperature.monthlyTemperatureC[month]?.[i] ?? 0);
          rgb = temperatureColor(t);
          break;
        }
        case 'precipitation': {
          const p =
            month < 0
              ? (result.precipitation.annualPrecipMm[i] ?? 0)
              : (result.precipitation.monthlyPrecipMm[month]?.[i] ?? 0) * 12;
          rgb = precipitationColor(p, isLand);
          break;
        }
        case 'terrain':
        case 'wind':
          rgb = terrainColor(terrain.elevationMeters[i] ?? 0, isLand);
          break;
      }
      img.data[i * 4] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    const off = new OffscreenCanvas(W, H);
    const offCtx = off.getContext('2d');
    if (!offCtx) return;
    offCtx.putImageData(img, 0, 0);
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx2d.drawImage(off, 0, 0, CANVAS_W, CANVAS_H);
  }, [result, overlay, month]);

  // ---- 上層(ITCZ 線・風矢印・ホバー枠) ----
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !result) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, CANVAS_W, CANVAS_H);
    const { grid } = result.context;
    const W = grid.widthCells;
    const H = grid.heightCells;
    const cellW = CANVAS_W / W;
    const cellH = CANVAS_H / H;
    const m = month < 0 ? 6 : month;

    if (showItczLine) {
      const centers = result.itcz.monthlyCenterLatDegByCol[m];
      if (centers) {
        ctx2d.strokeStyle = 'rgba(255, 90, 60, 0.9)';
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        for (let col = 0; col < W; col++) {
          const lat = centers[col] ?? 0;
          const x = (col + 0.5) * cellW;
          const y = ((90 - lat) / 180) * CANVAS_H;
          if (col === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
      }
    }

    if (showWindArrows) {
      const u = result.airflow.monthlyWindU[m];
      const v = result.airflow.monthlyWindV[m];
      if (u && v) {
        ctx2d.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx2d.lineWidth = 1;
        const step = Math.max(4, Math.round(W / 48));
        for (let row = Math.floor(step / 2); row < H; row += step) {
          for (let col = Math.floor(step / 2); col < W; col += step) {
            const i = row * W + col;
            const uu = u[i] ?? 0;
            const vv = v[i] ?? 0;
            const mag = Math.hypot(uu, vv);
            if (mag < 0.5) continue;
            const x = (col + 0.5) * cellW;
            const y = (row + 0.5) * cellH;
            const scale = Math.min(16, 3 + mag * 1.4);
            const dx = (uu / mag) * scale;
            const dy = (-vv / mag) * scale;
            ctx2d.beginPath();
            ctx2d.moveTo(x - dx / 2, y - dy / 2);
            ctx2d.lineTo(x + dx / 2, y + dy / 2);
            ctx2d.stroke();
            const ang = Math.atan2(dy, dx);
            ctx2d.beginPath();
            ctx2d.moveTo(x + dx / 2, y + dy / 2);
            ctx2d.lineTo(x + dx / 2 - 4 * Math.cos(ang - 0.4), y + dy / 2 - 4 * Math.sin(ang - 0.4));
            ctx2d.moveTo(x + dx / 2, y + dy / 2);
            ctx2d.lineTo(x + dx / 2 - 4 * Math.cos(ang + 0.4), y + dy / 2 - 4 * Math.sin(ang + 0.4));
            ctx2d.stroke();
          }
        }
      }
    }

    if (hoveredCell) {
      ctx2d.strokeStyle = 'rgba(255, 230, 0, 0.95)';
      ctx2d.lineWidth = 2;
      ctx2d.strokeRect(hoveredCell.col * cellW, hoveredCell.row * cellH, cellW, cellH);
    }
  }, [result, month, showItczLine, showWindArrows, hoveredCell]);

  const onMouseMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const { grid } = result.context;
    const col = Math.floor(((ev.clientX - rect.left) / rect.width) * grid.widthCells);
    const row = Math.floor(((ev.clientY - rect.top) / rect.height) * grid.heightCells);
    if (row >= 0 && row < grid.heightCells && col >= 0 && col < grid.widthCells) {
      if (hoveredCell?.row !== row || hoveredCell?.col !== col) setHoveredCell({ row, col });
    }
  };

  return (
    <div className="map-wrap">
      <canvas ref={baseRef} width={CANVAS_W} height={CANVAS_H} className="map-base" />
      <canvas
        ref={overlayRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="map-overlay"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoveredCell(null)}
        data-testid="map-canvas"
      />
      <CellTooltip result={result} />
    </div>
  );
}

function CellTooltip({ result }: { result: PipelineResult | null }) {
  const hoveredCell = useUiStore((s) => s.hoveredCell);
  const month = useUiStore((s) => s.month);
  const info = useMemo(() => {
    if (!result || !hoveredCell) return null;
    const { grid, terrain } = result.context;
    const { row, col } = hoveredCell;
    const i = row * grid.widthCells + col;
    const isLand = terrain.landMask[i] === 1;
    const cls = KOPPEN_CLASSES[result.koppen.classId[i] ?? 0] ?? '';
    const tAnnual = result.temperature.annualMeanC[i] ?? 0;
    const pAnnual = result.precipitation.annualPrecipMm[i] ?? 0;
    const tMonth = month >= 0 ? (result.temperature.monthlyTemperatureC[month]?.[i] ?? 0) : null;
    const pMonth = month >= 0 ? (result.precipitation.monthlyPrecipMm[month]?.[i] ?? 0) : null;
    return {
      lat: latDegOfRow(grid, row),
      lon: lonDegOfCol(grid, col),
      elev: Math.round(terrain.elevationMeters[i] ?? 0),
      isLand,
      cls,
      tAnnual,
      pAnnual,
      tMonth,
      pMonth,
    };
  }, [result, hoveredCell, month]);

  if (!info) return null;
  return (
    <div className="cell-tooltip" data-testid="cell-tooltip">
      <div>
        {info.lat.toFixed(1)}°, {info.lon.toFixed(1)}° {info.isLand ? `標高 ${info.elev}m` : '海'}
      </div>
      {info.isLand && info.cls && (
        <div>
          気候区分 <strong>{info.cls}</strong>
        </div>
      )}
      <div>
        年平均 {info.tAnnual.toFixed(1)}°C / 年降水 {Math.round(info.pAnnual)}mm
      </div>
      {info.tMonth !== null && (
        <div>
          この月 {info.tMonth.toFixed(1)}°C / {Math.round(info.pMonth ?? 0)}mm
        </div>
      )}
    </div>
  );
}
