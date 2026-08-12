// 診断: パタゴニアの最暖月が 6°C 低いのはなぜか。
//
// ゲートの内訳: ET 49%, Cfb 34% [降水 134% / 年平均 −3.5°C / **最暖月 −6.0°C**]
// ケッペンの ET は「最暖月 < 10°C」で決まるので、**降水を完璧にしても
// この気温誤差だけで ET になる**(2026-08-12 の取り違えの記録を参照)。
//
// 最初に疑うのはセル平均標高である。1° セルにアンデスの斜面が混ざると
// 平均標高が上がり、気温減率(5.8°C/km)でセル全体が冷える。
// 平均 718m なら −4.2°C 相当で、観測誤差 −3.5°C とほぼ同じ桁。
//
// 観測(気候値)は低地の観測所に寄るので、**同じセルでもモデルより低い標高を
// 代表している**可能性がある。標高と誤差の相関を見れば分かる。
//
// 実行: npx tsx scripts/diag_patagonia_temp.ts [ゲートid]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { REGION_GATES, getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const GATE = process.argv[2] ?? 'patagonia_rainshadow';
// 定数を 1 つだけ上書きして測れるようにする（例: CONST=channelnessLinear VAL=1）
{
  const key = process.env['CONST'];
  const val = process.env['VAL'];
  if (key && val !== undefined) {
    (K as unknown as Record<string, number>)[key] = Number(val);
    console.log(`上書き: ${key} = ${val}`);
  }
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r: PipelineResult;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const W = grid.widthCells;
  const clim = getClimObs();
  const gate = REGION_GATES.find((g) => g.id === GATE);
  if (!gate) {
    console.log('ゲートが無い');
    return;
  }

  type Row = { lat: number; lon: number; elev: number; dAnn: number; dWarm: number };
  const rows: Row[] = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < gate.latMin || lat > gate.latMax) continue;
    for (let col = 0; col < W; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      const i = row * W + col;
      if (!r.context.terrain.landMask[i]) continue;
      const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let mAnn = 0;
      let oAnn = 0;
      let mWarm = -1e9;
      let oWarm = -1e9;
      let bad = false;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const ov = clim.monthlyTemperatureDeciC[m]?.[ci];
        if (ov === undefined || ov <= -9000) {
          bad = true;
          break;
        }
        const o = ov / 10;
        const mv = r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
        mAnn += mv;
        oAnn += o;
        if (mv > mWarm) mWarm = mv;
        if (o > oWarm) oWarm = o;
      }
      if (bad) continue;
      rows.push({
        lat,
        lon,
        elev: Math.max(0, r.context.terrain.elevationMeters[i] ?? 0),
        dAnn: mAnn / MONTHS_PER_YEAR - oAnn / MONTHS_PER_YEAR,
        dWarm: mWarm - oWarm,
      });
    }
  }
  if (rows.length === 0) {
    console.log('セルが無い');
    return;
  }

  const mean = (f: (x: Row) => number): number => rows.reduce((a, b) => a + f(b), 0) / rows.length;
  const mElev = mean((x) => x.elev);
  const mAnn = mean((x) => x.dAnn);
  const mWarm = mean((x) => x.dWarm);
  // 標高と誤差の相関
  const cov = (f: (x: Row) => number, g: (x: Row) => number): number => {
    const mf = mean(f);
    const mg = mean(g);
    return rows.reduce((a, b) => a + (f(b) - mf) * (g(b) - mg), 0) / rows.length;
  };
  const corr = (f: (x: Row) => number, g: (x: Row) => number): number =>
    cov(f, g) / Math.sqrt(Math.max(1e-12, cov(f, f) * cov(g, g)));

  console.log(`${GATE}  陸セル ${rows.length}\n`);
  console.log(`平均標高            ${mElev.toFixed(0)} m`);
  console.log(`気温減率が奪う分     ${((-K.lapseRateCPerKm * mElev) / 1000).toFixed(2)} °C（減率 ${K.lapseRateCPerKm}°C/km）`);
  console.log(`年平均気温の誤差     ${mAnn.toFixed(2)} °C`);
  console.log(`最暖月の誤差         ${mWarm.toFixed(2)} °C`);
  console.log(`\n標高と年平均誤差の相関   ${corr((x) => x.elev, (x) => x.dAnn).toFixed(3)}`);
  console.log(`標高と最暖月誤差の相関   ${corr((x) => x.elev, (x) => x.dWarm).toFixed(3)}`);

  // 標高帯別
  console.log('\n標高帯      セル数  年平均誤差  最暖月誤差');
  for (const [lo, hi] of [[0, 200], [200, 500], [500, 1000], [1000, 9999]] as Array<[number, number]>) {
    const sub = rows.filter((x) => x.elev >= lo && x.elev < hi);
    if (sub.length === 0) continue;
    const a = sub.reduce((s, b) => s + b.dAnn, 0) / sub.length;
    const w = sub.reduce((s, b) => s + b.dWarm, 0) / sub.length;
    console.log(
      `${String(lo).padStart(4)}–${String(hi === 9999 ? '' : hi).padEnd(4)} ${String(sub.length).padStart(6)} ` +
        `${a.toFixed(2).padStart(10)} ${w.toFixed(2).padStart(11)}`,
    );
  }
  console.log(
    '\n読み: 相関が強く高標高ほど誤差が大きいなら、セル平均標高 × 気温減率が犯人。' +
      '低標高帯でも誤差が同じなら、標高ではなく雲・海流・移流を疑う。',
  );
}

void main();
