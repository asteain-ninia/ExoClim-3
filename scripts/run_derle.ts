// デーレ(出界)に ExoClim-3 のモデルを適用する。
// 地形: data/external/processed/shukkai_geography(scripts/build_derle_terrain.py で変換)
// 惑星諸元: derle-climate/docs/PROJECT_CONTEXT.md
//   主星光度 1.2879 / 軌道長半径 1.225 AU / 半径 1.0489 地球 /
//   自転 28.4698 h / 傾斜 19.505°
// 出力: out/derle/ に PNG と summary.json
//
// 2 通りを計算して比較する:
//   physical  — 大気は地球と同じ(温室 1.0)。諸元だけで決まる素の結果
//   canonical — デーレの正典「全球平均 8°C」に合わせて温室効果だけ調整
// 実行: npx tsx scripts/run_derle.ts

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { runPipelineTimed } from '../src/sim/pipeline';
import type { PlanetParams } from '../src/domain/planetParams';
import {
  KOPPEN_CLASSES,
  KOPPEN_COLORS,
  majorClassOf,
  MAJOR_CLASS_NAMES,
} from '../src/domain/koppen';
import { areaWeightOfRow, latDegOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';
import derleTerrain from '../src/domain/data/derle_terrain_1deg.json';

const OUT_DIR = path.join(process.cwd(), 'out', 'derle');
fs.mkdirSync(OUT_DIR, { recursive: true });

interface DerleTerrainJson {
  widthCells: number;
  heightCells: number;
  elevationMeters: number[];
  landMask: number[];
  crestMeters: number[];
}
const t = derleTerrain as DerleTerrainJson;

function derleParams(greenhouse: number): PlanetParams {
  return {
    orbital: {
      starLuminositySolar: 1.2879,
      semiMajorAxisAu: 1.225,
      // 離心率・近日点位相はデーレ側に記載が無いため地球値を仮置き(要確認)
      eccentricity: 0.0167,
      perihelionSeasonDeg: 283,
    },
    body: {
      radiusKm: 6371 * 1.0489,
      rotationPeriodHours: 28.4698,
      axialTiltDeg: 19.505,
      rotationDirection: 1,
    },
    atmosphere: {
      surfacePressureBar: 1.0,
      greenhouseStrength: greenhouse,
      cloudAlbedo: 0.2,
      oceanMixedLayerDepthM: 50,
      heatTransportStrength: 1.0,
    },
    terrain: {
      kind: 'custom',
      name: 'derle',
      widthCells: t.widthCells,
      heightCells: t.heightCells,
      elevationMeters: t.elevationMeters,
      landMask: t.landMask,
      crestMeters: t.crestMeters,
    },
    gridResolutionDeg: 1,
  };
}

// ---- derle-climate v11 と同じ地域枠(config/v11_shukkai.json より)----
// ウィル = 多角形、デーレ中核/ルティア/シャンテリャ = 楕円 [中心経度, 中心緯度, 半径経度, 半径緯度]
const WILL_VERTICES: Array<[number, number]> = [
  [-140, 31],
  [-133, 34],
  [-123, 33],
  [-113, 31],
  [-103, 28],
  [-102, 20],
  [-109, 13],
  [-121, 11],
  [-134, 14],
  [-141, 22],
];
const ELLIPSES: Record<string, [number, number, number, number]> = {
  デーレ中核: [-70.0, 17.0, 14.0, 10.0],
  ルティア暫定域: [-73.0, 2.5, 7.0, 5.0],
  シャンテリャ本体: [-32.0, 29.0, 9.0, 8.0],
};

function inPolygon(lon: number, lat: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 地域別の気候統計(derle-climate の consistency_audit と同じ枠で比較する) */
function regionStats(result: PipelineResult) {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const W = grid.widthCells;
  // デラドゥア狭海沿岸 = 海から 3 セル以内の陸(derle-climate の binary_dilation(sea, 3))
  const nearSea = new Uint8Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      let found = false;
      for (let dr = -3; dr <= 3 && !found; dr++) {
        const r = row + dr;
        if (r < 0 || r >= grid.heightCells) continue;
        for (let dc = -3; dc <= 3; dc++) {
          const c = (((col + dc) % W) + W) % W;
          if (!land[r * W + c]) {
            found = true;
            break;
          }
        }
      }
      if (found) nearSea[i] = 1;
    }
  }
  const regions: Record<string, (lon: number, lat: number, i: number) => boolean> = {
    全球陸域: (_lon, _lat, i) => land[i] === 1,
    ウィル地域ポリゴン: (lon, lat, i) => land[i] === 1 && inPolygon(lon, lat, WILL_VERTICES),
    デラドゥア狭海沿岸: (_lon, _lat, i) => nearSea[i] === 1,
  };
  for (const [name, e] of Object.entries(ELLIPSES)) {
    const [cx, cy, rx, ry] = e;
    regions[name] = (lon, lat, i) =>
      land[i] === 1 && ((lon - cx) / rx) ** 2 + ((lat - cy) / ry) ** 2 <= 1;
  }
  const out: Record<string, unknown> = {};
  for (const [name, test] of Object.entries(regions)) {
    let w = 0;
    let t = 0;
    let p = 0;
    const majorW = new Array<number>(5).fill(0);
    for (let row = 0; row < grid.heightCells; row++) {
      const wt = areaWeightOfRow(grid, row);
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < W; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        const i = row * W + col;
        if (!test(lon, lat, i)) continue;
        w += wt;
        t += wt * (result.temperature.annualMeanC[i] ?? 0);
        p += wt * (result.precipitation.annualPrecipMm[i] ?? 0);
        const mj = majorClassOf(result.koppen.classId[i] ?? 0);
        if (mj >= 0) majorW[mj] = (majorW[mj] ?? 0) + wt;
      }
    }
    if (w <= 0) continue;
    const pct = (x: number) => Math.round((x / w) * 1000) / 10;
    out[name] = {
      tempC: Math.round((t / w) * 100) / 100,
      precipMm: Math.round(p / w),
      dryPct: pct(majorW[1] ?? 0),
      tropicalPct: pct(majorW[0] ?? 0),
      temperatePct: pct((majorW[2] ?? 0) + (majorW[3] ?? 0)),
      majorPct: majorW.map(pct),
    };
  }
  return out;
}

function summarize(result: PipelineResult) {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  let wAll = 0;
  let tAll = 0;
  let wLand = 0;
  let tLand = 0;
  let pLand = 0;
  const majorW = new Array<number>(5).fill(0);
  const classW = new Array<number>(31).fill(0);
  const zonal: Array<{ lat: number; t: number; p: number; n: number }> = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    const lat = latDegOfRow(grid, row);
    const band = Math.round(lat / 10) * 10;
    let z = zonal.find((x) => x.lat === band);
    if (!z) {
      z = { lat: band, t: 0, p: 0, n: 0 };
      zonal.push(z);
    }
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const temp = result.temperature.annualMeanC[i] ?? 0;
      wAll += w;
      tAll += w * temp;
      z.t += temp;
      z.n++;
      if (!land[i]) continue;
      wLand += w;
      tLand += w * temp;
      pLand += w * (result.precipitation.annualPrecipMm[i] ?? 0);
      z.p += result.precipitation.annualPrecipMm[i] ?? 0;
      const id = result.koppen.classId[i] ?? 0;
      classW[id] = (classW[id] ?? 0) + w;
      const mj = majorClassOf(id);
      if (mj >= 0) majorW[mj] = (majorW[mj] ?? 0) + w;
    }
  }
  const pct = (x: number) => Math.round((x / Math.max(1e-9, wLand)) * 1000) / 10;
  return {
    globalMeanC: Math.round((tAll / wAll) * 100) / 100,
    landMeanC: Math.round((tLand / wLand) * 100) / 100,
    landPrecipMmPerYear: Math.round(pLand / wLand),
    majorSharePct: majorW.map(pct),
    topClasses: classW
      .map((w, id) => ({ cls: KOPPEN_CLASSES[id] ?? '?', pct: pct(w) }))
      .filter((e) => e.pct > 0.5)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 12),
    zonal: zonal
      .sort((a, b) => b.lat - a.lat)
      .map((z) => ({ lat: z.lat, tempC: Math.round((z.t / z.n) * 10) / 10 })),
  };
}

function renderPng(name: string, result: PipelineResult, kind: 'koppen' | 'temp' | 'precip'): void {
  const grid = result.context.grid;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = result.context.terrain.landMask;
  const scale = 3;
  const png = new PNG({ width: W * scale, height: H * scale });
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      let rgb: readonly [number, number, number];
      if (kind === 'koppen') {
        rgb = land[i]
          ? ((KOPPEN_COLORS[result.koppen.classId[i] ?? 0] ?? [0, 0, 0]) as unknown as [
              number,
              number,
              number,
            ])
          : [15, 30, 55];
      } else if (kind === 'temp') {
        const x = Math.max(-45, Math.min(45, result.temperature.annualMeanC[i] ?? 0)) / 45;
        rgb = [
          x > 0 ? 255 : Math.round(255 * (1 + x)),
          Math.round(200 * (1 - Math.abs(x)) + (land[i] ? 30 : 0)),
          x < 0 ? 255 : Math.round(255 * (1 - x)),
        ];
      } else {
        if (!land[i]) rgb = [15, 30, 55];
        else {
          const v = Math.min(
            1,
            Math.log1p(result.precipitation.annualPrecipMm[i] ?? 0) / Math.log1p(4000),
          );
          rgb = [Math.round(250 - 210 * v), Math.round(245 - 120 * v), Math.round(220 - 60 * v)];
        }
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((row * scale + dy) * W * scale + col * scale + dx) * 4;
          png.data[idx] = rgb[0];
          png.data[idx + 1] = rgb[1];
          png.data[idx + 2] = rgb[2];
          png.data[idx + 3] = 255;
        }
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, name), PNG.sync.write(png));
}

const runs: Array<{ label: string; greenhouse: number }> = [{ label: 'physical', greenhouse: 1.0 }];
// 正典の全球平均 8°C に合わせる温室効果を二分探索で求める
{
  // 事前探索(2026-08-01)で 1.375 → 3.68°C、2.25 → 15.36°C を確認済み
  let lo = 1.375;
  let hi = 2.25;
  let best = 1.8;
  for (let it = 0; it < 5; it++) {
    const mid = (lo + hi) / 2;
    const { result } = await runPipelineTimed(derleParams(mid));
    const s = summarize(result);
    console.log(`  探索 ${it + 1}: 温室 ${mid.toFixed(3)} → 全球平均 ${s.globalMeanC}°C`);
    best = mid;
    if (s.globalMeanC < 8) lo = mid;
    else hi = mid;
    if (Math.abs(s.globalMeanC - 8) < 0.15) break;
  }
  runs.push({ label: 'canonical8C', greenhouse: Math.round(best * 1000) / 1000 });
}

const summaries: Record<string, unknown> = {};
for (const run of runs) {
  const t0 = Date.now();
  const { result } = await runPipelineTimed(derleParams(run.greenhouse));
  const s = summarize(result);
  const regions = regionStats(result);
  summaries[run.label] = {
    greenhouse: run.greenhouse,
    ...s,
    regions,
    diagnostics: result.diagnostics.status,
  };
  renderPng(`derle_${run.label}_koppen.png`, result, 'koppen');
  renderPng(`derle_${run.label}_temp.png`, result, 'temp');
  renderPng(`derle_${run.label}_precip.png`, result, 'precip');
  console.log(
    `[${run.label}] 温室 ${run.greenhouse} (${((Date.now() - t0) / 1000).toFixed(0)}s): ` +
      `全球平均 ${s.globalMeanC}°C / 陸平均気温 ${s.landMeanC}°C / 陸平均降水 ${s.landPrecipMmPerYear}mm`,
  );
  console.log(
    `  大分類: ` + s.majorSharePct.map((p, k) => `${MAJOR_CLASS_NAMES[k]} ${p}%`).join(' / '),
  );
  console.log(`  上位: ${s.topClasses.map((c) => `${c.cls} ${c.pct}%`).join(', ')}`);
  for (const [name, r] of Object.entries(regions)) {
    const v = r as {
      tempC: number;
      precipMm: number;
      dryPct: number;
      tropicalPct: number;
      temperatePct: number;
    };
    console.log(
      `    ${name}: ${v.tempC}°C / ${v.precipMm}mm / 乾燥B ${v.dryPct}% / 熱帯A ${v.tropicalPct}% / 温帯+冷帯 ${v.temperatePct}%`,
    );
  }
}

let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* 架空の値を入れない */
}
fs.writeFileSync(
  path.join(OUT_DIR, 'summary.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      gitCommit,
      note:
        'デーレ(出界)に ExoClim-3 を適用。地形は derle-climate 由来、惑星諸元は ' +
        'PROJECT_CONTEXT.md。離心率・近日点位相は記載が無いため地球値を仮置き。' +
        'physical = 大気を地球と同一にした素の結果、canonical8C = 正典の全球平均 8°C に ' +
        '温室効果だけを合わせた結果',
      runs: summaries,
    },
    null,
    2,
  ),
);
console.log(`出力: ${OUT_DIR}`);
