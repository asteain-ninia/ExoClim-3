// 診断: **C→B 誤分類のセル(亜熱帯の大陸東側)で、夏に「南からの湿潤流」は吹いているのか。**
//
// なぜ要るか(2026-08-16):
//   失点の 32% を占める C→B 誤分類は、米州東 39% + 亜州東 33% の
//   亜熱帯モンスーン域に集中している(diag_c_to_b)。実物でここを湿らせるのは
//   亜熱帯高気圧の西縁を回る**極向きの湿潤流**である。
//
//   配管を読むと: 気圧場は離散セル化されており(WL#29)、輸送は勾配風込みの
//   全風場(airflow.monthlyWindU/V)を使っている。つまり**西縁の極向き流は
//   自動的に出ているはず**である。出ていないのか、出ているのに水が乗っていないのか、
//   乗っているのに凝結しないのか — **どこで切れているかで処方がまるで違う**。
//
// 何を出すか(C→B 群と、対照として「当たっている C」群で並べる):
//   1. 夏半年の子午面風 v の極向き成分(m/s)。**吹いているか**
//   2. 可降水量 W(mm)。**水はあるか**
//   3. 極向き水蒸気フラックス v×W の面積平均。**運ばれているか**
//   4. 凝結率 G と実際の夏降水。**降っているか**
//
// 実行: npx tsx scripts/diag_monsoon_inflow.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';

import { latDegOfRow } from '../src/domain/grid';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';
import { MODEL_CONSTANTS } from '../src/sim/constants';

// 定数の上書き(組の実験用)。sweep_lib と同じ書式:
//   DIAG_OVERRIDE='subtropicalCellWestSummerBoost=0.6'
// **知らない名前は例外にする** — 綴り違いが「効かない実験」になるため
if (process.env['DIAG_OVERRIDE']) {
  const K0 = MODEL_CONSTANTS as unknown as Record<string, number>;
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K0)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: '${key}' の値が数値でない`);
    K0[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

interface Cell {
  w: number;
  lat: number;
  /** 夏半年平均の極向き風(北半球なら +v、南半球なら −v) */
  vPoleward: number;
  /** 夏半年平均の可降水量 mm */
  waterMm: number;
  /** 夏半年平均の極向き水蒸気フラックス v×W (m/s·mm) */
  fluxPoleward: number;
  /** 夏半年平均の凝結率 G */
  g: number;
  /** 夏半年の降水 mm */
  pSummer: number;
}

function wmean(cells: Cell[], f: (c: Cell) => number): number {
  const ws = cells.reduce((a, c) => a + c.w, 0);
  return cells.reduce((a, c) => a + c.w * f(c), 0) / Math.max(1e-9, ws);
}

async function main(): Promise<void> {
  const accel = await openAccel();
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const { result: r, precipDiag: d } = out;
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;
  const kobs = getKoppenObs();

  const cToB: Cell[] = [];
  const cOk: Cell[] = [];

  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const w = Math.cos((lat * Math.PI) / 180);
    const north = lat >= 0;
    // 夏半年(ケッペンの定義と同じ月): 北半球 3〜8、南半球 9〜2
    const summer = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const obsMajor = majorClassOf(obsId); // 0=A 1=B 2=C 3=D 4=E
      const modMajor = majorClassOf(r.koppen.classId[i] ?? 0);
      if (obsMajor !== MAJOR.C) continue; // 観測 C だけを見る
      let vSum = 0;
      let wSum = 0;
      let fSum = 0;
      let gSum = 0;
      let pSum = 0;
      for (const m of summer) {
        const v = r.airflow.monthlyWindV[m]?.[i] ?? 0;
        const wat = d.waterMm[m]?.[i] ?? 0;
        const vp = north ? v : -v; // 極向きを正に揃える
        vSum += vp;
        wSum += wat;
        fSum += vp * wat;
        gSum += d.condRateG[m]?.[i] ?? 0;
        pSum += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      }
      const n = summer.length;
      const cell: Cell = {
        w,
        lat,
        vPoleward: vSum / n,
        waterMm: wSum / n,
        fluxPoleward: fSum / n,
        g: gSum / n,
        pSummer: pSum,
      };
      if (modMajor === MAJOR.B) cToB.push(cell);
      else if (modMajor === MAJOR.C) cOk.push(cell);
    }
  }

  console.log(`観測 C・モデル B = ${cToB.length} セル / 観測 C・モデル C(対照) = ${cOk.length}\n`);
  console.log('量(夏半年平均、面積重み)          C→B(誤判定)   C→C(対照)   比');
  const rows: Array<[string, (c: Cell) => number]> = [
    ['極向き風 v (m/s)', (c) => c.vPoleward],
    ['可降水量 W (mm)', (c) => c.waterMm],
    ['極向き水蒸気フラックス v×W', (c) => c.fluxPoleward],
    ['凝結率 G', (c) => c.g],
    ['夏半年の降水 (mm)', (c) => c.pSummer],
  ];
  for (const [name, f] of rows) {
    const a = wmean(cToB, f);
    const b = wmean(cOk, f);
    console.log(
      `${name.padEnd(30)} ${a.toFixed(2).padStart(10)} ${b.toFixed(2).padStart(12)}` +
        `  ${(a / Math.max(1e-9, Math.abs(b)) * Math.sign(b)).toFixed(2).padStart(6)}`,
    );
  }
  console.log(
    '\n読み:\n' +
      '  v が負(赤道向き)なら、そもそも南風が吹いていない = **風の向きの問題**。\n' +
      '  v は正だが W が対照より小さいなら、風はあるが乾いた空気 = **源泉の問題**。\n' +
      '  v×W が対照並みなのに降水が少ないなら、運ばれているのに降らない = **凝結の問題**。',
  );
}

void main();
