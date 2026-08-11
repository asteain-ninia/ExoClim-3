// 診断: **分類が悪化したセルで、場は良くなっているのか。**
//
// 段 9 の第 1 版・第 2 版で 2 回続けて「気温 RMSE と水の運ばれ方は改善するのに
// 大分類が落ちる」が起きた。理由の候補は 2 つある:
//
//   1. **物理の問題** — ケッペンの乾燥判定は気温の関数なので、気温が動くと
//      閾値も動く。場が良くなっても分類が変わりうる
//   2. **物差しの問題** — v3 は 大分類 1.0 + 詳細 0.25 + ゲート 1.1 に対し、
//      場の誤差は正規化された小さな項。場が良くなっても分類が落ちれば必ず負ける
//
// 切り分けるには、**分類が変わったセルだけを取り出して、そのセルの
// 気温と降水が観測に近づいたか遠ざかったか**を数えればよい。
//   分類が悪化 かつ 場が改善 が多い → 採点が場の改善を拾えていない(2 の証拠)
//   分類が悪化 かつ 場も悪化       → 機構が実際に悪い(1 でも 2 でもなく素直な悪化)
//
// 実行: npx tsx scripts/diag_class_vs_field.ts <定数名> <値A> <値B>
//   例: npx tsx scripts/diag_class_vs_field.ts thermalLowHpaPerK 0 1.3

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { getKoppenObs, getClimObs } from './scoring';
import { KOPPEN_CLASSES } from '../src/domain/koppen';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const KEY = process.argv[2] ?? 'thermalLowHpaPerK';
const VA = Number(process.argv[3] ?? 0);
const VB = Number(process.argv[4] ?? 1.3);

async function run(value: number): Promise<PipelineResult> {
  (MODEL_CONSTANTS as unknown as Record<string, number>)[KEY] = value;
  const accel = await openAccel(true);
  try {
    return await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
}

/** 大分類の頭文字(A/B/C/D/E) */
function major(code: string): string {
  return code.slice(0, 1);
}

async function main(): Promise<void> {
  const base = (MODEL_CONSTANTS as unknown as Record<string, number>)[KEY] ?? 0;
  const a = await run(VA);
  const b = await run(VB);
  (MODEL_CONSTANTS as unknown as Record<string, number>)[KEY] = base;

  const grid = a.context.grid;
  const W = grid.widthCells;
  const land = a.context.terrain.landMask;
  const ko = getKoppenObs();
  const clim = getClimObs();
  const classes = ko.classes ?? [];

  // 観測は 1°(ケッペン)と 2°(気候値)。モデル格子から最近傍で引く
  const obsMajorAt = (row: number, col: number): string | null => {
    const r = Math.min(ko.heightCells - 1, Math.round((row / grid.heightCells) * ko.heightCells));
    const c = Math.min(ko.widthCells - 1, Math.round((col / grid.widthCells) * ko.widthCells));
    const v = ko.classRaster[r * ko.widthCells + c];
    if (v === undefined || v < 0) return null;
    const name = classes[v];
    return name ? major(name) : null;
  };
  const obsClimAt = (row: number, col: number): { t: number; p: number } | null => {
    const r = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    const c = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
    const i = r * clim.widthCells + c;
    let t = 0;
    let p = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const tv = clim.monthlyTemperatureDeciC[m]?.[i];
      const pv = clim.monthlyPrecipitationMm[m]?.[i];
      if (tv === undefined || pv === undefined || tv <= -9000 || pv <= -9000) return null;
      t += tv / 10;
      p += pv;
    }
    return { t: t / MONTHS_PER_YEAR, p };
  };

  const modelAt = (r: PipelineResult, i: number): { t: number; p: number } => {
    let t = 0;
    let p = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      t += r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
      p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
    }
    return { t: t / MONTHS_PER_YEAR, p };
  };

  let changed = 0;
  let worse = 0;
  let better = 0;
  // 分類が悪化したセルで、場がどう動いたか
  let wFieldBetter = 0;
  let wFieldWorse = 0;
  let wTempBetter = 0;
  let wPrecipBetter = 0;
  let wArea = 0;
  let allArea = 0;

  for (let row = 0; row < grid.heightCells; row++) {
    const wgt = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const obsM = obsMajorAt(row, col);
      const obsC = obsClimAt(row, col);
      if (!obsM || !obsC) continue;
      allArea += wgt;
      const ca = major(KOPPEN_CLASSES[a.koppen.classId[i] ?? 0] ?? '');
      const cb = major(KOPPEN_CLASSES[b.koppen.classId[i] ?? 0] ?? '');
      if (ca === cb) continue;
      changed++;
      const hitA = ca === obsM;
      const hitB = cb === obsM;
      if (hitA && !hitB) {
        worse++;
        wArea += wgt;
        const ma = modelAt(a, i);
        const mb = modelAt(b, i);
        const dtA = Math.abs(ma.t - obsC.t);
        const dtB = Math.abs(mb.t - obsC.t);
        const dpA = Math.abs(ma.p - obsC.p);
        const dpB = Math.abs(mb.p - obsC.p);
        if (dtB < dtA) wTempBetter++;
        if (dpB < dpA) wPrecipBetter++;
        // 「場が改善」= 気温と降水を観測の標準偏差で規格化した合計誤差が減った
        const nA = dtA / 10 + dpA / 500;
        const nB = dtB / 10 + dpB / 500;
        if (nB < nA) wFieldBetter++;
        else wFieldWorse++;
      } else if (!hitA && hitB) {
        better++;
      }
    }
  }

  console.log(`\n${KEY}: ${VA} → ${VB}`);
  console.log(`大分類が変わった陸セル ${changed}(当たり→外れ ${worse} / 外れ→当たり ${better})`);
  console.log(`外れに転じたセルの面積割合: ${((wArea / allArea) * 100).toFixed(2)}%`);
  console.log('\n**外れに転じたセルで、場はどう動いたか**');
  console.log(`  気温が観測に近づいた   ${wTempBetter} / ${worse}  (${((wTempBetter / Math.max(1, worse)) * 100).toFixed(0)}%)`);
  console.log(`  降水が観測に近づいた   ${wPrecipBetter} / ${worse}  (${((wPrecipBetter / Math.max(1, worse)) * 100).toFixed(0)}%)`);
  console.log(`  規格化した場の誤差が減った ${wFieldBetter} / ${worse}  (${((wFieldBetter / Math.max(1, worse)) * 100).toFixed(0)}%)`);
  console.log(`  同・増えた                 ${wFieldWorse} / ${worse}`);
  console.log(
    '\n読み: 「外れに転じたのに場は改善」が多数なら、採点が場の改善を拾えていない' +
      '(物差しの問題)。少数なら機構が素直に悪い(物理の問題)。',
  );
}

void main();
