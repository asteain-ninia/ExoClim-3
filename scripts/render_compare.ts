// 現行モデルと観測を**並べて**描く(目視確認用)。
//
// 対応 spec: なし(検証の可視化)。npm run validate の renderAll はモデル側しか
// 描かないので、観測と差分を同じ物差しで並べる係をここに置く。
//
// 物差しの合わせ方が要点:
//   - ケッペンは観測(Beck)が 1° なのでモデルも 1° のまま。
//   - 気温・降水の観測は 2°(earth_climate_2deg)。**採点は 2° の粗セルへ
//     モデルの陸セルを平均して比べている**(scripts/scoring.ts の fieldScore)
//     ので、画像も同じ集約で作る。ここを揃えないと「絵は合っているのに
//     点が悪い」「絵で見えない差が点に出る」が起きて、目視が判断に使えない。
//   - 観測に欠測(-9999)のあるセルは灰色。モデル側だけ描いて比べない。
//
// 実行: npx tsx scripts/render_compare.ts [パラメータJSON]
//   引数を省くと現在の constants.ts をそのまま使う。
//   例: npx tsx scripts/render_compare.ts out/optimize/best_v12desc.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { KOPPEN_COLORS, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs, getClimObs } from './scoring';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const OUT_DIR = path.join(process.cwd(), 'out', 'compare');
const PARAM_PATH = process.argv[2];

type RGB = readonly [number, number, number];
const SEA: RGB = [15, 30, 55];
const MISSING: RGB = [110, 110, 110];

// ---- 色 ----

/** 気温 −45〜45°C。青(寒) → 白 → 赤(暖) */
function tempColor(t: number): RGB {
  const x = Math.max(-45, Math.min(45, t)) / 45;
  const r = x > 0 ? 255 : Math.round(255 * (1 + x));
  const b = x < 0 ? 255 : Math.round(255 * (1 - x));
  const g = Math.round(200 * (1 - Math.abs(x)));
  return [r, g, b];
}

/** 年較差 0〜60°C。白 → 紫 */
function rangeColor(dt: number): RGB {
  const x = Math.max(0, Math.min(60, dt)) / 60;
  return [Math.round(250 - 90 * x), Math.round(248 - 200 * x), Math.round(252 - 60 * x)];
}

/** 降水 0〜4000mm(対数)。白 → 青緑 */
function precipColor(mm: number): RGB {
  const x = Math.min(1, Math.log1p(Math.max(0, mm)) / Math.log1p(4000));
  return [Math.round(250 - 210 * x), Math.round(245 - 120 * x), Math.round(220 - 60 * x)];
}

/** 差分。0 を白に、± を赤青で。half は「色が飽和する差」 */
function diffColor(d: number, half: number): RGB {
  const x = Math.max(-1, Math.min(1, d / half));
  if (x >= 0) return [255, Math.round(255 * (1 - x)), Math.round(255 * (1 - x))];
  return [Math.round(255 * (1 + x)), Math.round(255 * (1 + x)), 255];
}

// ---- PNG ----

function renderPng(name: string, W: number, H: number, scale: number, colorOf: (i: number) => RGB): void {
  const png = new PNG({ width: W * scale, height: H * scale });
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const [r, g, b] = colorOf(row * W + col);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const idx = ((row * scale + dy) * W * scale + col * scale + dx) * 4;
          png.data[idx] = r;
          png.data[idx + 1] = g;
          png.data[idx + 2] = b;
          png.data[idx + 3] = 255;
        }
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, name), PNG.sync.write(png));
}

// ---- 2° 粗セルへの集約(採点と同じ手順) ----

interface Coarse {
  W: number;
  H: number;
  /** 陸セルが 1 つも無い粗セルは null */
  model: (null | { annual: number; range: number; precip: number; driest: number })[];
  obs: (null | { annual: number; range: number; precip: number; driest: number })[];
}

function coarsen(result: PipelineResult): Coarse {
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const model: Coarse['model'] = new Array(clim.widthCells * clim.heightCells).fill(null);
  const obs: Coarse['obs'] = new Array(clim.widthCells * clim.heightCells).fill(null);

  for (let cr = 0; cr < clim.heightCells; cr++) {
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const tMon = new Array<number>(12).fill(0);
      const pMon = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            tMon[m] = (tMon[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
            pMon[m] = (pMon[m] ?? 0) + (result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
          }
        }
      }
      if (n > 0) {
        for (let m = 0; m < 12; m++) {
          tMon[m] = (tMon[m] ?? 0) / n;
          pMon[m] = (pMon[m] ?? 0) / n;
        }
        model[ci] = {
          annual: tMon.reduce((a, b) => a + b, 0) / 12,
          range: Math.max(...tMon) - Math.min(...tMon),
          precip: pMon.reduce((a, b) => a + b, 0),
          driest: Math.min(...pMon),
        };
      }
      // 観測(1 月でも欠測があればそのセルは比較しない)
      const tObs: number[] = [];
      const pObs: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (t === -9999 || p === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
        pObs.push(p);
      }
      if (ok) {
        obs[ci] = {
          annual: tObs.reduce((a, b) => a + b, 0) / 12,
          range: Math.max(...tObs) - Math.min(...tObs),
          precip: pObs.reduce((a, b) => a + b, 0),
          driest: Math.min(...pObs),
        };
      }
    }
  }
  return { W: clim.widthCells, H: clim.heightCells, model, obs };
}

// ---- 本体 ----

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let label = '現在の constants.ts';
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    let applied = 0;
    for (const [k, v] of Object.entries(patch)) {
      if (k in target) {
        target[k] = v;
        applied++;
      }
    }
    label = `${path.basename(PARAM_PATH)}(${applied} 定数を適用)`;
  }
  console.log(`パラメータ: ${label}`);

  const accel = await openAccel();
  let result: PipelineResult;
  try {
    result = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const s = evaluateResult(result);
  console.log(
    `v3=${s.fitness.toFixed(2)} v2=${s.fitnessV2.toFixed(2)} ` +
      `大分類=${s.majorPct.toFixed(2)} 詳細=${s.detailPct.toFixed(2)} ゲート=${s.gates}`,
  );

  // ---- ケッペン(1°)----
  const grid = result.context.grid;
  const W1 = grid.widthCells;
  const H1 = grid.heightCells;
  const land = result.context.terrain.landMask;
  const obsK = getKoppenObs();
  const S1 = 3;
  renderPng('koppen_model.png', W1, H1, S1, (i) =>
    land[i] ? ((KOPPEN_COLORS[result.koppen.classId[i] ?? 0] ?? [0, 0, 0]) as RGB) : SEA,
  );
  renderPng('koppen_obs.png', W1, H1, S1, (i) => {
    const id = obsK.classRaster[i] ?? 0;
    return id === 0 ? SEA : ((KOPPEN_COLORS[id] ?? [0, 0, 0]) as RGB);
  });
  // 一致マップ: 濃緑 = 詳細まで一致、黄 = 大分類のみ一致、赤 = 不一致
  let nBoth = 0;
  let nMajor = 0;
  let nMiss = 0;
  renderPng('koppen_agree.png', W1, H1, S1, (i) => {
    const o = obsK.classRaster[i] ?? 0;
    if (o === 0 || !land[i]) return SEA;
    const m = result.koppen.classId[i] ?? 0;
    if (m === o) {
      nBoth++;
      return [40, 130, 70];
    }
    const mo = majorClassOf(m);
    const oo = majorClassOf(o);
    if (mo >= 0 && mo === oo) {
      nMajor++;
      return [235, 205, 80];
    }
    nMiss++;
    return [200, 60, 55];
  });
  console.log(
    `一致マップ: 詳細一致 ${nBoth} / 大分類のみ ${nMajor} / 不一致 ${nMiss} セル`,
  );

  // ---- 場(2°)----
  const c = coarsen(result);
  const S2 = 6;
  const pick =
    (side: 'model' | 'obs', key: 'annual' | 'range' | 'precip' | 'driest', color: (v: number) => RGB) =>
    (i: number): RGB => {
      const cell = c[side][i];
      if (!cell) return c.model[i] || c.obs[i] ? MISSING : SEA;
      return color(cell[key]);
    };
  const diff =
    (key: 'annual' | 'range' | 'precip' | 'driest', half: number) =>
    (i: number): RGB => {
      const m = c.model[i];
      const o = c.obs[i];
      if (!m || !o) return m || o ? MISSING : SEA;
      return diffColor(m[key] - o[key], half);
    };

  const panels: Array<{
    key: 'annual' | 'range' | 'precip' | 'driest';
    color: (v: number) => RGB;
    half: number;
    tag: string;
  }> = [
    { key: 'annual', color: tempColor, half: 8, tag: 'temp' },
    { key: 'range', color: rangeColor, half: 12, tag: 'range' },
    { key: 'precip', color: precipColor, half: 800, tag: 'precip' },
    { key: 'driest', color: precipColor, half: 40, tag: 'driest' },
  ];
  for (const { key, color, half, tag } of panels) {
    renderPng(`${tag}_model.png`, c.W, c.H, S2, pick('model', key, color));
    renderPng(`${tag}_obs.png`, c.W, c.H, S2, pick('obs', key, color));
    renderPng(`${tag}_diff.png`, c.W, c.H, S2, diff(key, half));
  }

  const meta = {
    label,
    scores: s,
    koppenAgreement: { detail: nBoth, majorOnly: nMajor, miss: nMiss },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'compare.json'), JSON.stringify(meta, null, 2));
  console.log(`出力: ${OUT_DIR}`);
}

void main();
