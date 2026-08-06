// マップ描画。世界全体(円筒 equirect)を 1 枚のオフスクリーン canvas に描き、
// コンポジタが表示モードに応じて可視 canvas へ写す:
//  - 平面: 世界をタイル状に並べて描く(ドラッグで無限周回、ホイールで 360° 超を一望)
//  - 球体: 正射図法の逆写像で世界画像をサンプリング(ドラッグで回転)
// ホバー枠は最上層の別 canvas(教訓 §4 F4: ホバーで世界を再描画しない)。

import { useEffect, useMemo, useRef, useState } from 'react';
import { latDegOfRow, lonDegOfCol } from '@/domain/grid';
import { KOPPEN_CLASSES } from '@/domain/koppen';
import type { PartialPipelineResult } from '@/sim/types';
import { smoothForDrawing } from '@/domain/polyline';
import { displayResult, useResultsStore } from '@/store/results';
import { useUiStore, type OverlayKind } from '@/store/ui';
import { hasLayer, LAYER_WAIT_REASON } from './layers';
import earthKoppenObs from '@/domain/data/earth_koppen_1deg.json';
import {
  currentColor,
  koppenColor,
  precipitationColor,
  pressureColor,
  temperatureColor,
  terrainColor,
  OCEAN_COLOR,
} from './colorScales';

/** 断り書きに出す層の名前(タブの表記と合わせる) */
const OVERLAY_LABEL: Partial<Record<OverlayKind, string>> = {
  terrain: '地形',
  currents: '海流',
  pressure: '気圧・風帯',
  temperature: '気温',
  precipitation: '降水',
  koppen: '気候区分',
};

const CANVAS_W = 1080;
const CANVAS_H = 540;
const SPACE_BG = '#0a0e18';

export function MapCanvas() {
  const result = useResultsStore(displayResult);
  const overlay = useUiStore((s) => s.overlay);
  const month = useUiStore((s) => s.month);
  const showItczLine = useUiStore((s) => s.showItczLine);
  const showWindArrows = useUiStore((s) => s.showWindArrows);
  const hoveredCell = useUiStore((s) => s.hoveredCell);
  const setHoveredCell = useUiStore((s) => s.setHoveredCell);
  const viewMode = useUiStore((s) => s.viewMode);
  const panLonDeg = useUiStore((s) => s.panLonDeg);
  const viewSpanDeg = useUiStore((s) => s.viewSpanDeg);
  const globeLon0 = useUiStore((s) => s.globeLon0);
  const globeLat0 = useUiStore((s) => s.globeLat0);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const setPanLonDeg = useUiStore((s) => s.setPanLonDeg);
  const setViewSpanDeg = useUiStore((s) => s.setViewSpanDeg);
  const setGlobeRotation = useUiStore((s) => s.setGlobeRotation);

  const baseRef = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<OffscreenCanvas | null>(null);
  const worldDataRef = useRef<ImageData | null>(null);
  const [worldVersion, setWorldVersion] = useState(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panStart: number;
    lonStart: number;
    latStart: number;
    moved: boolean;
  } | null>(null);

  // ---- 世界キャンバス(基層ビットマップ + 線オーバーレイを 1 枚に描く) ----
  useEffect(() => {
    if (!result) return;
    if (!worldRef.current) worldRef.current = new OffscreenCanvas(CANVAS_W, CANVAS_H);
    const world = worldRef.current;
    const ctx2d = world.getContext('2d');
    if (!ctx2d) return;
    const { grid, terrain } = result.context;
    const W = grid.widthCells;
    const H = grid.heightCells;

    // 観測地球(Beck 2023)の参照レイヤー: モデルとは独立の 1° ラスタを
    // そのまま描く(どのプリセットでも同じ「お手本」— 目視比較用)
    if (overlay === 'koppenObs') {
      const obs = earthKoppenObs as {
        widthCells: number;
        heightCells: number;
        classRaster: number[];
      };
      const imgObs = new ImageData(obs.widthCells, obs.heightCells);
      for (let i = 0; i < obs.widthCells * obs.heightCells; i++) {
        const id = obs.classRaster[i] ?? 0;
        const rgb = id === 0 ? OCEAN_COLOR : koppenColor(id, true);
        imgObs.data[i * 4] = rgb[0];
        imgObs.data[i * 4 + 1] = rgb[1];
        imgObs.data[i * 4 + 2] = rgb[2];
        imgObs.data[i * 4 + 3] = 255;
      }
      const offObs = new OffscreenCanvas(obs.widthCells, obs.heightCells);
      const offObsCtx = offObs.getContext('2d');
      if (offObsCtx) {
        offObsCtx.putImageData(imgObs, 0, 0);
        ctx2d.imageSmoothingEnabled = false;
        ctx2d.clearRect(0, 0, CANVAS_W, CANVAS_H);
        ctx2d.drawImage(offObs, 0, 0, CANVAS_W, CANVAS_H);
        worldDataRef.current = ctx2d.getImageData(0, 0, CANVAS_W, CANVAS_H);
        compositeView();
        setWorldVersion((v) => v + 1);
      }
      return;
    }

    // -- 基層ビットマップ --
    // 途中結果ではまだ計算されていない層がある。その場合は**地形へ退避**して
    // 「計算中」を別途出す。空白にすると地図の位置関係が分からなくなるので、
    // 常に何かしら見えている状態を保つ(2026-08-03)
    const layerReadyNow = hasLayer(result, overlay);
    const koppenField = result.koppen;
    const tempField = result.temperature;
    const precipField = result.precipitation;
    const oceanField = result.ocean;
    const windBeltField = result.windBelt;
    const airflowField = result.airflow;
    const itczField = result.itcz;
    const drawnOverlay: OverlayKind = layerReadyNow ? overlay : 'terrain';

    const img = new ImageData(W, H);
    for (let i = 0; i < grid.cellCount; i++) {
      const isLand = terrain.landMask[i] === 1;
      let rgb: readonly [number, number, number] = OCEAN_COLOR;
      switch (drawnOverlay) {
        case 'koppen':
          rgb = koppenColor(koppenField?.classId[i] ?? 0, isLand);
          break;
        case 'temperature': {
          const t =
            month < 0
              ? (tempField?.annualMeanC[i] ?? 0)
              : (tempField?.monthlyTemperatureC[month]?.[i] ?? 0);
          rgb = temperatureColor(t);
          break;
        }
        case 'precipitation': {
          const p =
            month < 0
              ? (precipField?.annualPrecipMm[i] ?? 0)
              : (precipField?.monthlyPrecipMm[month]?.[i] ?? 0) * 12;
          rgb = precipitationColor(p, isLand);
          break;
        }
        case 'terrain':
          rgb = terrainColor(terrain.elevationMeters[i] ?? 0, isLand);
          break;
        case 'currents':
          rgb = currentColor(oceanField?.sstAnomalyC[i] ?? 0, isLand);
          break;
        case 'pressure': {
          let p: number;
          if (month < 0) {
            let sum = 0;
            for (let m = 0; m < 12; m++)
              sum += windBeltField?.monthlyPressureAnomalyHpa[m]?.[i] ?? 0;
            p = sum / 12;
          } else {
            p = windBeltField?.monthlyPressureAnomalyHpa[month]?.[i] ?? 0;
          }
          rgb = pressureColor(p, isLand);
          break;
        }
      }
      img.data[i * 4] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    const cellCanvas = new OffscreenCanvas(W, H);
    const cellCtx = cellCanvas.getContext('2d');
    if (!cellCtx) return;
    cellCtx.putImageData(img, 0, 0);
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx2d.drawImage(cellCanvas, 0, 0, CANVAS_W, CANVAS_H);

    // -- 線オーバーレイ --
    const cellW = CANVAS_W / W;
    const cellH = CANVAS_H / H;
    const m = month < 0 ? 6 : month;

    if (showItczLine && itczField) {
      const centers = itczField.monthlyCenterLatDegByCol[m];
      if (centers) {
        const hw = itczField.halfWidthDeg;
        const yOf = (lat: number) => ((90 - lat) / 180) * CANVAS_H;
        ctx2d.fillStyle = 'rgba(255, 120, 60, 0.14)';
        ctx2d.beginPath();
        for (let col = 0; col < W; col++) {
          const x = (col + 0.5) * cellW;
          const y = yOf((centers[col] ?? 0) + hw);
          if (col === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        for (let col = W - 1; col >= 0; col--) {
          ctx2d.lineTo((col + 0.5) * cellW, yOf((centers[col] ?? 0) - hw));
        }
        ctx2d.closePath();
        ctx2d.fill();
        // 中心線(破線 — 海流の流線と見分けるため)
        ctx2d.strokeStyle = 'rgba(255, 150, 40, 0.9)';
        ctx2d.lineWidth = 2;
        ctx2d.setLineDash([8, 6]);
        ctx2d.beginPath();
        for (let col = 0; col < W; col++) {
          const x = (col + 0.5) * cellW;
          const y = yOf(centers[col] ?? 0);
          if (col === 0) ctx2d.moveTo(x, y);
          else ctx2d.lineTo(x, y);
        }
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      }
    }

    // 海流オーバーレイ: 環流の流線(赤 = 暖、青 = 寒、白 = 中立。矢印 = 流向)
    if (overlay === 'currents') {
      const colors = { warm: '#ff6a50', cold: '#58b0ff', neutral: '#e8e8e8' } as const;
      const xOf = (lon: number) => ((lon + 180) / 360) * CANVAS_W;
      const yOf = (lat: number) => ((90 - lat) / 180) * CANVAS_H;
      for (let row = 0; row < H; row++) {
        for (let col = 0; col < W; col++) {
          const i = row * W + col;
          if (oceanField?.upwellingMask[i]) {
            ctx2d.fillStyle = 'rgba(90, 240, 255, 0.75)';
            ctx2d.fillRect(
              col * cellW + cellW * 0.3,
              row * cellH + cellH * 0.3,
              cellW * 0.4,
              cellH * 0.4,
            );
          } else if (oceanField?.coralReefMask[i]) {
            ctx2d.fillStyle = 'rgba(120, 255, 150, 0.7)';
            ctx2d.beginPath();
            ctx2d.arc(
              col * cellW + cellW / 2,
              row * cellH + cellH / 2,
              Math.max(1.2, cellW * 0.22),
              0,
              Math.PI * 2,
            );
            ctx2d.fill();
          }
        }
      }

      const lines =
        month >= 0
          ? (oceanField?.monthlyStreamlines[month] ?? oceanField?.streamlines ?? [])
          : (oceanField?.streamlines ?? []);
      for (const sl of lines) {
        ctx2d.strokeStyle = colors[sl.kind];
        ctx2d.fillStyle = colors[sl.kind];
        ctx2d.lineWidth = 2.2;
        ctx2d.lineJoin = 'round';
        for (const pts of smoothForDrawing(sl.points, 3)) {
          ctx2d.beginPath();
          for (let k = 0; k + 1 < pts.length; k += 2) {
            const x = xOf(pts[k + 1] ?? 0);
            const y = yOf(pts[k] ?? 0);
            if (k === 0) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          }
          ctx2d.stroke();
          // 矢印(点列の並び = 流向)。ピクセル弧長 ~60px ごとに配置
          const nPts = pts.length / 2;
          let arcAcc = 30;
          for (let k = 1; k < nPts; k++) {
            const x1 = xOf(pts[k * 2 + 1] ?? 0);
            const y1 = yOf(pts[k * 2] ?? 0);
            const x0 = xOf(pts[(k - 1) * 2 + 1] ?? 0);
            const y0 = yOf(pts[(k - 1) * 2] ?? 0);
            arcAcc += Math.hypot(x1 - x0, y1 - y0);
            if (arcAcc < 60) continue;
            arcAcc = 0;
            const ang = Math.atan2(y1 - y0, x1 - x0);
            ctx2d.beginPath();
            ctx2d.moveTo(x1, y1);
            ctx2d.lineTo(x1 - 7 * Math.cos(ang - 0.42), y1 - 7 * Math.sin(ang - 0.42));
            ctx2d.lineTo(x1 - 7 * Math.cos(ang + 0.42), y1 - 7 * Math.sin(ang + 0.42));
            ctx2d.closePath();
            ctx2d.fill();
          }
        }
      }
    }

    // 気温オーバーレイ: 等温線(6°C 刻み — WL#34/35 の作図表現)
    if (overlay === 'temperature') {
      const field = month < 0 ? tempField?.annualMeanC : tempField?.monthlyTemperatureC[month];
      if (field) {
        const cw = CANVAS_W / W;
        const ch = CANVAS_H / H;
        ctx2d.lineWidth = 1;
        for (let level = -42; level <= 36; level += 6) {
          ctx2d.strokeStyle = level === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(30,30,40,0.45)';
          ctx2d.beginPath();
          for (let row = 0; row < H - 1; row++) {
            for (let col = 0; col < W; col++) {
              const colE = (col + 1) % W;
              if (colE === 0) continue; // ラップセグメントは省略(端 1 列のみ)
              const v00 = (field[row * W + col] ?? 0) - level;
              const v10 = (field[row * W + colE] ?? 0) - level;
              const v01 = (field[(row + 1) * W + col] ?? 0) - level;
              const v11 = (field[(row + 1) * W + colE] ?? 0) - level;
              const caseId =
                (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
              if (caseId === 0 || caseId === 15) continue;
              const x0 = (col + 0.5) * cw;
              const y0 = (row + 0.5) * ch;
              const top: [number, number] = [x0 + (v00 / (v00 - v10)) * cw, y0];
              const bottom: [number, number] = [x0 + (v01 / (v01 - v11)) * cw, y0 + ch];
              const left: [number, number] = [x0, y0 + (v00 / (v00 - v01)) * ch];
              const right: [number, number] = [x0 + cw, y0 + (v10 / (v10 - v11)) * ch];
              const seg = (a: [number, number], b: [number, number]) => {
                ctx2d.moveTo(a[0], a[1]);
                ctx2d.lineTo(b[0], b[1]);
              };
              switch (caseId) {
                case 1:
                case 14:
                  seg(left, top);
                  break;
                case 2:
                case 13:
                  seg(top, right);
                  break;
                case 3:
                case 12:
                  seg(left, right);
                  break;
                case 4:
                case 11:
                  seg(right, bottom);
                  break;
                case 6:
                case 9:
                  seg(top, bottom);
                  break;
                case 7:
                case 8:
                  seg(left, bottom);
                  break;
                case 5:
                  seg(left, top);
                  seg(right, bottom);
                  break;
                case 10:
                  seg(top, right);
                  seg(left, bottom);
                  break;
              }
            }
          }
          ctx2d.stroke();
        }
      }
    }

    // 気圧オーバーレイ: 風帯境界(リッジ・極前線)の破線と高低気圧マーカー
    if (overlay === 'pressure') {
      const yOfLat = (lat: number) => ((90 - lat) / 180) * CANVAS_H;
      const beltLines: Array<[number, string]> = [
        [windBeltField?.monthlyRidgeLatNDeg[m] ?? 31, 'rgba(120,200,255,0.8)'],
        [windBeltField?.monthlyRidgeLatSDeg[m] ?? -31, 'rgba(120,200,255,0.8)'],
        [windBeltField?.monthlyPolarFrontLatNDeg[m] ?? 60, 'rgba(190,160,255,0.8)'],
        [windBeltField?.monthlyPolarFrontLatSDeg[m] ?? -60, 'rgba(190,160,255,0.8)'],
      ];
      ctx2d.setLineDash([7, 5]);
      ctx2d.lineWidth = 1.5;
      for (const [lat, color] of beltLines) {
        ctx2d.strokeStyle = color;
        ctx2d.beginPath();
        ctx2d.moveTo(0, yOfLat(lat));
        ctx2d.lineTo(CANVAS_W, yOfLat(lat));
        ctx2d.stroke();
      }
      ctx2d.setLineDash([]);

      // 高低気圧の中心マーカー(近傍 6 セルで極値 かつ |偏差| > 2.5 hPa)
      const field = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        if (month < 0) {
          let sum = 0;
          for (let mm = 0; mm < 12; mm++)
            sum += windBeltField?.monthlyPressureAnomalyHpa[mm]?.[i] ?? 0;
          field[i] = sum / 12;
        } else {
          field[i] = windBeltField?.monthlyPressureAnomalyHpa[m]?.[i] ?? 0;
        }
      }
      const R = 6;
      const markers: Array<{ row: number; col: number; high: boolean }> = [];
      for (let row = R; row < H - R; row += 2) {
        for (let col = 0; col < W; col += 2) {
          const v = field[row * W + col] ?? 0;
          if (Math.abs(v) < 2.5) continue;
          let isMax = true;
          let isMin = true;
          for (let dr = -R; dr <= R && (isMax || isMin); dr += 2) {
            for (let dc = -R; dc <= R; dc += 2) {
              const nb = field[(row + dr) * W + ((col + dc + W) % W)] ?? 0;
              if (nb > v) isMax = false;
              if (nb < v) isMin = false;
            }
          }
          if ((isMax && v > 0) || (isMin && v < 0)) {
            if (!markers.some((k) => Math.abs(k.row - row) < 10 && Math.abs(k.col - col) < 14)) {
              markers.push({ row, col, high: v > 0 });
            }
          }
        }
      }
      ctx2d.font = 'bold 17px sans-serif';
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      for (const k of markers) {
        ctx2d.fillStyle = k.high ? '#7ec4ff' : '#ff8a66';
        ctx2d.fillText(k.high ? 'H' : 'L', (k.col + 0.5) * cellW, (k.row + 0.5) * cellH);
      }
    }

    if (showWindArrows) {
      const u = airflowField?.monthlyWindU[m];
      const v = airflowField?.monthlyWindV[m];
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
            ctx2d.lineTo(
              x + dx / 2 - 4 * Math.cos(ang - 0.4),
              y + dy / 2 - 4 * Math.sin(ang - 0.4),
            );
            ctx2d.moveTo(x + dx / 2, y + dy / 2);
            ctx2d.lineTo(
              x + dx / 2 - 4 * Math.cos(ang + 0.4),
              y + dy / 2 - 4 * Math.sin(ang + 0.4),
            );
            ctx2d.stroke();
          }
        }
      }
    }

    // 球体サンプリング用のピクセルを退避 → 同一コミット内で即時コンポジット
    // (バージョン state 経由の 2 コミット構成は、クリック直後の E2E 読取りと
    // 競合してフレーク化する)
    worldDataRef.current = ctx2d.getImageData(0, 0, CANVAS_W, CANVAS_H);
    compositeView();
    setWorldVersion((v) => v + 1); // 最上層(ホバー枠)の再描画通知のみに使う
  }, [result, overlay, month, showItczLine, showWindArrows]);

  // ---- コンポジタ(平面タイル / 球体)。世界描画直後とビュー状態変更時に呼ぶ ----
  const compositeView = () => {
    const canvas = baseRef.current;
    const world = worldRef.current;
    if (!canvas || !world) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const { viewMode, panLonDeg, viewSpanDeg, globeLon0, globeLat0 } = useUiStore.getState();
    if (viewMode === 'flat') {
      const scale = 360 / viewSpanDeg;
      const tileW = CANVAS_W * scale;
      const tileH = CANVAS_H * scale;
      const y0 = (CANVAS_H - tileH) / 2;
      ctx2d.imageSmoothingEnabled = scale !== 1;
      ctx2d.fillStyle = SPACE_BG;
      ctx2d.fillRect(0, 0, CANVAS_W, CANVAS_H);
      let offsetPx = ((panLonDeg / 360) * tileW) % tileW;
      if (offsetPx < 0) offsetPx += tileW;
      for (let x = -offsetPx - tileW; x < CANVAS_W; x += tileW) {
        ctx2d.drawImage(world, x, y0, tileW, tileH);
      }
    } else {
      const data = worldDataRef.current;
      if (!data) return;
      const img = ctx2d.createImageData(CANVAS_W, CANVAS_H);
      // 背景
      const bg = [10, 14, 24];
      for (let i = 0; i < CANVAS_W * CANVAS_H; i++) {
        img.data[i * 4] = bg[0] ?? 0;
        img.data[i * 4 + 1] = bg[1] ?? 0;
        img.data[i * 4 + 2] = bg[2] ?? 0;
        img.data[i * 4 + 3] = 255;
      }
      const R = CANVAS_H * 0.48;
      const cx = CANVAS_W / 2;
      const cy = CANVAS_H / 2;
      const φ0 = (globeLat0 * Math.PI) / 180;
      const λ0 = (globeLon0 * Math.PI) / 180;
      // カメラ基底(東・北・視線)
      const Xh = [-Math.sin(λ0), Math.cos(λ0), 0];
      const Yh = [-Math.sin(φ0) * Math.cos(λ0), -Math.sin(φ0) * Math.sin(λ0), Math.cos(φ0)];
      const Zh = [Math.cos(φ0) * Math.cos(λ0), Math.cos(φ0) * Math.sin(λ0), Math.sin(φ0)];
      const x0i = Math.max(0, Math.floor(cx - R));
      const x1i = Math.min(CANVAS_W - 1, Math.ceil(cx + R));
      const y0i = Math.max(0, Math.floor(cy - R));
      const y1i = Math.min(CANVAS_H - 1, Math.ceil(cy + R));
      for (let py = y0i; py <= y1i; py++) {
        const ny = -(py - cy) / R;
        for (let px = x0i; px <= x1i; px++) {
          const nx = (px - cx) / R;
          const ρ2 = nx * nx + ny * ny;
          if (ρ2 > 1) continue;
          const nz = Math.sqrt(1 - ρ2);
          const wx = nx * (Xh[0] ?? 0) + ny * (Yh[0] ?? 0) + nz * (Zh[0] ?? 0);
          const wy = nx * (Xh[1] ?? 0) + ny * (Yh[1] ?? 0) + nz * (Zh[1] ?? 0);
          const wz = nx * (Xh[2] ?? 0) + ny * (Yh[2] ?? 0) + nz * (Zh[2] ?? 0);
          const lat = Math.asin(Math.min(1, Math.max(-1, wz)));
          const lon = Math.atan2(wy, wx);
          let u = Math.floor(((lon / Math.PI + 1) / 2) * CANVAS_W);
          let v = Math.floor((0.5 - lat / Math.PI) * CANVAS_H);
          u = Math.min(CANVAS_W - 1, Math.max(0, u));
          v = Math.min(CANVAS_H - 1, Math.max(0, v));
          const si = (v * CANVAS_W + u) * 4;
          const di = (py * CANVAS_W + px) * 4;
          // 縁の簡易シェーディング(周辺減光)で球らしく
          const shade = 0.72 + 0.28 * nz;
          img.data[di] = (data.data[si] ?? 0) * shade;
          img.data[di + 1] = (data.data[si + 1] ?? 0) * shade;
          img.data[di + 2] = (data.data[si + 2] ?? 0) * shade;
          img.data[di + 3] = 255;
        }
      }
      ctx2d.putImageData(img, 0, 0);
    }
  };

  useEffect(() => {
    compositeView();
  }, [viewMode, panLonDeg, viewSpanDeg, globeLon0, globeLat0]);

  // ---- 最上層(ホバー枠のみ) ----
  useEffect(() => {
    const canvas = topRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!hoveredCell || !result) return;
    const { grid } = result.context;
    const W = grid.widthCells;
    const H = grid.heightCells;
    ctx2d.strokeStyle = 'rgba(255, 230, 0, 0.95)';
    ctx2d.lineWidth = 2;
    if (viewMode === 'flat') {
      const scale = 360 / viewSpanDeg;
      const tileW = CANVAS_W * scale;
      const tileH = CANVAS_H * scale;
      const y0 = (CANVAS_H - tileH) / 2;
      let offsetPx = ((panLonDeg / 360) * tileW) % tileW;
      if (offsetPx < 0) offsetPx += tileW;
      const cw = tileW / W;
      const ch = tileH / H;
      const xCell = (hoveredCell.col / W) * tileW;
      const y = y0 + (hoveredCell.row / H) * tileH;
      for (let x = xCell - offsetPx - tileW; x < CANVAS_W; x += tileW) {
        if (x + cw < 0) continue;
        ctx2d.strokeRect(x, y, cw, ch);
      }
    } else {
      const lat = (latDegOfRow(grid, hoveredCell.row) * Math.PI) / 180;
      const lon = (lonDegOfCol(grid, hoveredCell.col) * Math.PI) / 180;
      const φ0 = (globeLat0 * Math.PI) / 180;
      const λ0 = (globeLon0 * Math.PI) / 180;
      const p = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      const e = (p[0] ?? 0) * -Math.sin(λ0) + (p[1] ?? 0) * Math.cos(λ0);
      const n =
        (p[0] ?? 0) * -Math.sin(φ0) * Math.cos(λ0) +
        (p[1] ?? 0) * -Math.sin(φ0) * Math.sin(λ0) +
        (p[2] ?? 0) * Math.cos(φ0);
      const z =
        (p[0] ?? 0) * Math.cos(φ0) * Math.cos(λ0) +
        (p[1] ?? 0) * Math.cos(φ0) * Math.sin(λ0) +
        (p[2] ?? 0) * Math.sin(φ0);
      if (z > 0) {
        const R = CANVAS_H * 0.48;
        ctx2d.beginPath();
        ctx2d.arc(CANVAS_W / 2 + e * R, CANVAS_H / 2 - n * R, 4, 0, Math.PI * 2);
        ctx2d.stroke();
      }
    }
  }, [result, hoveredCell, viewMode, panLonDeg, viewSpanDeg, globeLon0, globeLat0, worldVersion]);

  // ---- ポインタ操作(ドラッグ = 周回/回転、それ以外はホバー) ----
  const toCanvasXY = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * CANVAS_W,
      y: ((ev.clientY - rect.top) / rect.height) * CANVAS_H,
    };
  };

  const cellAt = (x: number, y: number): { row: number; col: number } | null => {
    if (!result) return null;
    const { grid } = result.context;
    const W = grid.widthCells;
    const H = grid.heightCells;
    if (viewMode === 'flat') {
      const scale = 360 / viewSpanDeg;
      const tileW = CANVAS_W * scale;
      const tileH = CANVAS_H * scale;
      const y0 = (CANVAS_H - tileH) / 2;
      if (y < y0 || y >= y0 + tileH) return null;
      let offsetPx = ((panLonDeg / 360) * tileW) % tileW;
      if (offsetPx < 0) offsetPx += tileW;
      let wx = (x + offsetPx) / tileW;
      wx -= Math.floor(wx);
      const col = Math.min(W - 1, Math.floor(wx * W));
      const row = Math.min(H - 1, Math.floor(((y - y0) / tileH) * H));
      return { row, col };
    }
    const R = CANVAS_H * 0.48;
    const nx = (x - CANVAS_W / 2) / R;
    const ny = -(y - CANVAS_H / 2) / R;
    const ρ2 = nx * nx + ny * ny;
    if (ρ2 > 1) return null;
    const nz = Math.sqrt(1 - ρ2);
    const φ0 = (globeLat0 * Math.PI) / 180;
    const λ0 = (globeLon0 * Math.PI) / 180;
    const wx3 =
      nx * -Math.sin(λ0) + ny * -Math.sin(φ0) * Math.cos(λ0) + nz * Math.cos(φ0) * Math.cos(λ0);
    const wy3 =
      nx * Math.cos(λ0) + ny * -Math.sin(φ0) * Math.sin(λ0) + nz * Math.cos(φ0) * Math.sin(λ0);
    const wz3 = ny * Math.cos(φ0) + nz * Math.sin(φ0);
    const lat = (Math.asin(Math.min(1, Math.max(-1, wz3))) * 180) / Math.PI;
    const lon = (Math.atan2(wy3, wx3) * 180) / Math.PI;
    const row = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / grid.resolutionDeg)));
    const col = Math.min(W - 1, Math.max(0, Math.floor((lon + 180) / grid.resolutionDeg)));
    return { row, col };
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvasXY(ev);
    dragRef.current = {
      pointerId: ev.pointerId,
      startX: x,
      startY: y,
      panStart: panLonDeg,
      lonStart: globeLon0,
      latStart: globeLat0,
      moved: false,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = toCanvasXY(ev);
    const drag = dragRef.current;
    if (drag && ev.buttons > 0) {
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        if (viewMode === 'flat') {
          setPanLonDeg(drag.panStart - dx * (viewSpanDeg / CANVAS_W));
        } else {
          const k = 180 / (2 * CANVAS_H * 0.48);
          setGlobeRotation(drag.lonStart - dx * k, drag.latStart + dy * k);
        }
        if (hoveredCell) setHoveredCell(null);
        return;
      }
    }
    const cell = cellAt(x, y);
    if (!cell) {
      if (hoveredCell) setHoveredCell(null);
      return;
    }
    if (hoveredCell?.row !== cell.row || hoveredCell?.col !== cell.col) setHoveredCell(cell);
  };

  const onPointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    ev.currentTarget.releasePointerCapture(ev.pointerId);
  };

  // ホイール = 平面の経度スパン(360°〜1440°。360 超で世界が繰り返して見える)
  useEffect(() => {
    const canvas = topRef.current;
    if (!canvas) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const s = useUiStore.getState();
      if (s.viewMode !== 'flat') return;
      const factor = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
      s.setViewSpanDeg(s.viewSpanDeg * factor);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const layerPending = !!result && !hasLayer(result, overlay);
  const readyLayers = (
    ['terrain', 'currents', 'pressure', 'temperature', 'precipitation', 'koppen'] as const
  )
    .filter((k) => k !== overlay && hasLayer(result, k))
    .map((k) => OVERLAY_LABEL[k] ?? k);

  return (
    <div className="map-wrap">
      {layerPending && (
        <div className="layer-pending" data-testid="layer-pending">
          <strong>{OVERLAY_LABEL[overlay] ?? 'この層'}はまだ計算されていません</strong>
          <span>
            下は地形です
            {LAYER_WAIT_REASON[overlay] ? ` — ${LAYER_WAIT_REASON[overlay]}` : ''}
          </span>
          {/* **いま見られる層を挙げる**。既定のタブ(気候区分)は EBM のあいだ
              ずっと出てこないので、これが無いと「何も進んでいない」に見える */}
          {readyLayers.length > 0 && (
            <span data-testid="ready-layers">いま見られるのは {readyLayers.join('・')}</span>
          )}
        </div>
      )}
      <canvas ref={baseRef} width={CANVAS_W} height={CANVAS_H} className="map-base" />
      <canvas
        ref={topRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="map-overlay"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseLeave={() => setHoveredCell(null)}
        data-testid="map-canvas"
      />
      <div className="view-toggle" data-testid="view-toggle">
        <button
          className={viewMode === 'flat' ? 'active' : ''}
          onClick={() => setViewMode('flat')}
          data-testid="view-flat"
        >
          平面
        </button>
        <button
          className={viewMode === 'globe' ? 'active' : ''}
          onClick={() => setViewMode('globe')}
          data-testid="view-globe"
        >
          球体
        </button>
        {viewMode === 'flat' && viewSpanDeg > 361 && (
          <button onClick={() => setViewSpanDeg(360)} title="スパンを 360° に戻す">
            {Math.round(viewSpanDeg)}°
          </button>
        )}
      </div>
      <CellTooltip result={result} />
    </div>
  );
}

function CellTooltip({ result }: { result: PartialPipelineResult | null }) {
  const hoveredCell = useUiStore((s) => s.hoveredCell);
  const month = useUiStore((s) => s.month);
  const info = useMemo(() => {
    if (!result || !hoveredCell) return null;
    const { grid, terrain } = result.context;
    const { row, col } = hoveredCell;
    const i = row * grid.widthCells + col;
    const isLand = terrain.landMask[i] === 1;
    // 途中結果では未計算の場がある。数字が無いことを「0」と偽らず null にする
    const cls = result.koppen ? (KOPPEN_CLASSES[result.koppen.classId[i] ?? 0] ?? '') : '—';
    const tAnnual = result.temperature?.annualMeanC[i] ?? null;
    const pAnnual = result.precipitation?.annualPrecipMm[i] ?? null;
    const tMonth =
      month >= 0 ? (result.temperature?.monthlyTemperatureC[month]?.[i] ?? null) : null;
    const pMonth = month >= 0 ? (result.precipitation?.monthlyPrecipMm[month]?.[i] ?? null) : null;
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
      {/* 未計算の量は「—」で出す。0 と書くと計算済みの 0 と区別できない */}
      <div>
        年平均 {info.tAnnual === null ? '—' : `${info.tAnnual.toFixed(1)}°C`} / 年降水{' '}
        {info.pAnnual === null ? '—' : `${Math.round(info.pAnnual)}mm`}
      </div>
      {(info.tMonth !== null || info.pMonth !== null) && (
        <div>
          この月 {info.tMonth === null ? '—' : `${info.tMonth.toFixed(1)}°C`} /{' '}
          {info.pMonth === null ? '—' : `${Math.round(info.pMonth)}mm`}
        </div>
      )}
    </div>
  );
}
