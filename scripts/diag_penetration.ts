// 診断: **モンスーンの「浸透距離」は何で測れるか — C→B と豪州型 B→C を分ける軸探し。**
//
// なぜ要るか(2026-08-17):
//   段 44(R-H 位相の沈降置換)は東アジアを初めて動かしたが、
//   「自分が加熱源の砂漠」(豪州内陸・サヘル縁)を湿らせて B→C を増やした。
//   実物のモンスーンは加熱源から離れるほど・海から離れるほど雨が尽きる。
//   その「浸透距離」の物差し候補 2 つの判別力を、壊した相手そのもので測る。
//
//   群: 段 44(κ=0.6)の場で、救えた側と壊した側を直接比べる
//     残る C→B(まだ救えていない華中型)
//     B→C(壊した豪州型 — 湿らせすぎ)
//   軸: |緯度 − ITCZ 緯度|(加熱源からの距離)/ 海岸距離 / R-H 位相
//
// 実行: DIAG_OVERRIDE='monsoonTroughSubsRelief=0.6' npx tsx scripts/diag_penetration.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow } from '../src/domain/grid';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: 値が数値でない '${key}'`);
    K[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

interface Cell {
  w: number; dItcz: number; coastKm: number; lat: number;
  /** 東(自転方向)の海までの距離と、その海の SST 偏差(暖流なら正) */
  eastOceanKm: number; eastSst: number;
}

function stats(cells: Cell[], f: (c: Cell) => number): string {
  const a = [...cells].sort((x, y) => f(x) - f(y));
  const tot = a.reduce((s, c) => s + c.w, 0);
  const q = (p: number): number => {
    let acc = 0;
    for (const c of a) {
      acc += c.w;
      if (acc >= p * tot) return f(c);
    }
    return a.length ? f(a[a.length - 1] as Cell) : 0;
  };
  return `中央 ${q(0.5).toFixed(0).padStart(5)}  (25% ${q(0.25).toFixed(0)} / 75% ${q(0.75).toFixed(0)})`;
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;
  const coast = r.context.landDistToCoastKm;
  const kobs = getKoppenObs();

  // 夏の ITCZ 位置(夏半年平均、列ごと)
  const summerItcz = new Float64Array(WC);
  {
    const cnt = new Float64Array(WC);
    for (let m = 0; m < 12; m++) {
      const centers = r.itcz.monthlyCenterLatDegByCol[m];
      for (let col = 0; col < WC; col++) {
        const c = centers?.[col] ?? 0;
        // 変位の大きい月を夏として拾う(単純化: |c| で重み)
        summerItcz[col] = (summerItcz[col] ?? 0) + c * Math.abs(c);
        cnt[col] = (cnt[col] ?? 0) + Math.abs(c);
      }
    }
    for (let col = 0; col < WC; col++) summerItcz[col] = (summerItcz[col] ?? 0) / Math.max(1e-9, cnt[col] ?? 0);
  }

  // 東海洋の走査(step06 と同じ規則: 順行 = 東、行内・距離 4400km まで)
  const dirE = r.context.params.body.rotationDirection >= 0 ? 1 : -1;
  const eastKm = new Float32Array(grid.cellCount).fill(9e9);
  const eastSst = new Float32Array(grid.cellCount);
  {
    const { cellWidthKm, wrapCol } = await import('../src/domain/grid');
    for (let row = 0; row < grid.heightCells; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, r.context.params.body.radiusKm));
      const maxScan = Math.max(10, Math.round(4400 / dxKm));
      for (let col = 0; col < WC; col++) {
        const i = row * WC + col;
        if (!land[i]) continue;
        for (let d2 = 1; d2 <= maxScan; d2++) {
          const j = row * WC + wrapCol(grid, col + dirE * d2);
          if (!land[j]) {
            eastKm[i] = d2 * dxKm;
            eastSst[i] = r.ocean.sstAnomalyC[j] ?? 0;
            break;
          }
        }
      }
    }
  }

  const ctb: Cell[] = [];
  const btc: Cell[] = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) > 45) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const om = majorClassOf(obsId);
      const mm = majorClassOf(r.koppen.classId[i] ?? 0);
      const cell: Cell = {
        w: cw,
        dItcz: Math.abs(lat - (summerItcz[col] ?? 0)),
        coastKm: coast[i] ?? 0,
        lat,
        eastOceanKm: eastKm[i] ?? 9e9,
        eastSst: eastSst[i] ?? 0,
      };
      if (om === MAJOR.C && mm === MAJOR.B) ctb.push(cell);
      else if (om === MAJOR.B && mm === MAJOR.C) btc.push(cell);
    }
  }

  console.log(`\n残る C→B(救う対象) ${ctb.length} セル / B→C(壊した豪州型) ${btc.length} セル\n`);
  console.log('軸                          C→B(救う)                     B→C(守るべきだった)');
  console.log(`|緯度 − 夏ITCZ| (度)      ${stats(ctb, (c) => c.dItcz)}   ${stats(btc, (c) => c.dItcz)}`);
  console.log(`海岸距離 (km)             ${stats(ctb, (c) => c.coastKm)}   ${stats(btc, (c) => c.coastKm)}`);
  console.log(`東海洋までの距離 (km)     ${stats(ctb, (c) => Math.min(9999, c.eastOceanKm))}   ${stats(btc, (c) => Math.min(9999, c.eastOceanKm))}`);
  console.log(`東海洋の SST 偏差 (x100)  ${stats(ctb, (c) => 100 * c.eastSst)}   ${stats(btc, (c) => 100 * c.eastSst)}`);
  console.log(
    '\n読み: 2 群の分位が重ならない軸が浸透ゲートに使える。\n' +
      '  どちらも重なるなら、幾何だけでは豪州型を守れない(供給系の再生が必要)。',
  );
}

void main();
