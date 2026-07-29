// 全プリセットの海流流線をヘッドレス描画して目視検証する開発用スクリプト。
// 出力: out/preview/streamlines_<preset>.png(地形背景 + 流線)

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import type { PlanetParams, TerrainPresetName } from '../src/domain/planetParams';
import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { computeWindBelt } from '../src/sim/step02_windbelt';
import { computeOceanCurrent } from '../src/sim/step03_ocean';
import { smoothForDrawing } from '../src/domain/polyline';

const OUT_DIR = path.join(process.cwd(), 'out', 'preview');
fs.mkdirSync(OUT_DIR, { recursive: true });
const SCALE = 4;

const COLORS = {
  warm: [255, 106, 80],
  cold: [88, 176, 255],
  neutral: [235, 235, 235],
} as const;

function drawLine(
  png: PNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: readonly number[],
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    for (let ox = 0; ox < 2; ox++) {
      for (let oy = 0; oy < 2; oy++) {
        const px = x + ox;
        const py = y + oy;
        if (px >= 0 && px < png.width && py >= 0 && py < png.height) {
          const idx = (py * png.width + px) * 4;
          png.data[idx] = rgb[0] ?? 0;
          png.data[idx + 1] = rgb[1] ?? 0;
          png.data[idx + 2] = rgb[2] ?? 0;
          png.data[idx + 3] = 255;
        }
      }
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function preview(name: string, params: PlanetParams, month = -1): void {
  const ctx = buildSimContext(params);
  const itcz = computeItcz(ctx);
  const wind = computeWindBelt(ctx, itcz);
  const ocean = computeOceanCurrent(ctx, itcz, wind);
  const lines = month >= 0 ? (ocean.monthlyStreamlines[month] ?? []) : ocean.streamlines;
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const png = new PNG({ width: W * SCALE, height: H * SCALE });
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const isLand = terrain.landMask[i] === 1;
      const [r, g, b] = isLand ? [70, 84, 66] : [18, 32, 58];
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const idx = ((row * SCALE + dy) * png.width + col * SCALE + dx) * 4;
          png.data[idx] = r;
          png.data[idx + 1] = g;
          png.data[idx + 2] = b;
          png.data[idx + 3] = 255;
        }
      }
    }
  }
  const xOf = (lon: number) => Math.round(((lon + 180) / 360) * png.width);
  const yOf = (lat: number) => Math.round(((90 - lat) / 180) * png.height);
  let landHits = 0;
  for (const sl of lines) {
    const rgb = COLORS[sl.kind];
    for (const pts of smoothForDrawing(sl.points, 2)) {
    for (let k = 2; k + 1 < pts.length; k += 2) {
      const x0 = xOf(pts[k - 1] ?? 0);
      const y0 = yOf(pts[k - 2] ?? 0);
      const x1 = xOf(pts[k + 1] ?? 0);
      const y1 = yOf(pts[k] ?? 0);
      if (Math.abs(x1 - x0) > png.width / 2) continue; // 経度ラップは分割
      drawLine(png, x0, y0, x1, y1, rgb);
      // 陸横断の自動検査(セル単位)
      const c0 = Math.floor(x0 / SCALE);
      const r0 = Math.floor(y0 / SCALE);
      const c1 = Math.floor(x1 / SCALE);
      const r1 = Math.floor(y1 / SCALE);
      const steps = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0), 1);
      for (let s = 1; s < steps; s++) {
        const rr = Math.round(r0 + ((r1 - r0) * s) / steps);
        const cc = Math.round(c0 + ((c1 - c0) * s) / steps);
        if (rr >= 0 && rr < H && terrain.landMask[rr * W + ((cc + W) % W)]) landHits++;
      }
    }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, `streamlines_${name}.png`), PNG.sync.write(png));
  console.log(`${name}: 流線 ${lines.length} 本, 陸横断サンプル ${landHits} 件`);
}

const presets: TerrainPresetName[] = ['idealized_continent', 'two_continents', 'aquaplanet'];
for (const p of presets) {
  preview(p, { ...EARTH_PARAMS, gridResolutionDeg: 2, terrain: { kind: 'preset', preset: p } });
}
// 実在地球は 1° で年平均 + 夏(7月) + 冬(1月)
preview('earth', { ...EARTH_PARAMS, gridResolutionDeg: 1 });
preview('earth_jul', { ...EARTH_PARAMS, gridResolutionDeg: 1 }, 6);
preview('earth_jan', { ...EARTH_PARAMS, gridResolutionDeg: 1 }, 0);
preview('procedural42', {
  ...EARTH_PARAMS,
  gridResolutionDeg: 2,
  terrain: { kind: 'procedural', seed: 42, landFraction: 0.3, reliefScale: 1 },
});
preview('retrograde_earth', {
  ...EARTH_PARAMS,
  gridResolutionDeg: 2,
  body: { ...EARTH_PARAMS.body, rotationDirection: -1 },
});
