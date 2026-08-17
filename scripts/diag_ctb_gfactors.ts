// 診断: **C→B の凝結率 G の 2.3 倍欠損は、どの因子から来ているか。**
//
// なぜ要るか(2026-08-17):
//   規定風の路線(段 39〜43)が打ち切りになった審判の測定から、
//   もっと重要な分解が出た。C→B と健康な C の降水比 0.35 は
//     G の比 0.44 × W の比 0.87
//   であり、**主因は輸送(W)ではなく凝結率(G)**である。
//   一日 W 側を攻めていたが、0.44 の因子を放置して 0.87 と戦っていた。
//
//   G は 8 因子の積なので、**どの因子が 0.44 を作っているか**で処方が決まる。
//   (diag_middle_band は降水 3 分位で同じ分解をしたが、C→B 集合では未測定)
//
// 実行: npx tsx scripts/diag_ctb_gfactors.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

interface Cell {
  w: number;
  block: number; itcz: number; frontal: number; conv: number; oro: number;
  subs: number; other: number; crh: number; g: number;
  /** 夏半年だけの同上 */
  sItcz: number; sFrontal: number; sConv: number; sSubs: number; sOther: number; sG: number;
}

function wmean(cells: Cell[], f: (c: Cell) => number): number {
  const ws = cells.reduce((a, c) => a + c.w, 0);
  return cells.reduce((a, c) => a + c.w * f(c), 0) / Math.max(1e-9, ws);
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
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

  const ctb: Cell[] = [];
  const cok: Cell[] = [];

  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const north = lat >= 0;
    const cw = Math.cos((lat * Math.PI) / 180);
    const summer = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0 || majorClassOf(obsId) !== MAJOR.C) continue;
      const modMajor = majorClassOf(r.koppen.classId[i] ?? 0);
      let group: Cell[];
      if (modMajor === MAJOR.B) group = ctb;
      else if (modMajor === MAJOR.C) group = cok;
      else continue;

      const acc = {
        block: 0, itcz: 0, frontal: 0, conv: 0, oro: 0, subs: 0, other: 0, crh: 0, g: 0,
        sItcz: 0, sFrontal: 0, sConv: 0, sSubs: 0, sOther: 0, sG: 0,
      };
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        acc.block += d.upwindBlock[m]?.[i] ?? 1;
        acc.itcz += d.liftItcz[m]?.[i] ?? 1;
        acc.frontal += d.liftFrontal[m]?.[i] ?? 1;
        acc.conv += d.liftConvergence[m]?.[i] ?? 1;
        acc.oro += d.liftOrographic[m]?.[i] ?? 1;
        acc.subs += d.subsidenceResidual[m]?.[i] ?? 1;
        acc.other += d.liftOther[m]?.[i] ?? 1;
        acc.crh += d.crhSuppression[m]?.[i] ?? 1;
        acc.g += d.condRateG[m]?.[i] ?? 0;
        if (summer.includes(m)) {
          acc.sItcz += d.liftItcz[m]?.[i] ?? 1;
          acc.sFrontal += d.liftFrontal[m]?.[i] ?? 1;
          acc.sConv += d.liftConvergence[m]?.[i] ?? 1;
          acc.sSubs += d.subsidenceResidual[m]?.[i] ?? 1;
          acc.sOther += d.liftOther[m]?.[i] ?? 1;
          acc.sG += d.condRateG[m]?.[i] ?? 0;
        }
      }
      const M = MONTHS_PER_YEAR;
      group.push({
        w: cw,
        block: acc.block / M, itcz: acc.itcz / M, frontal: acc.frontal / M,
        conv: acc.conv / M, oro: acc.oro / M, subs: acc.subs / M,
        other: acc.other / M, crh: acc.crh / M, g: acc.g / M,
        sItcz: acc.sItcz / 6, sFrontal: acc.sFrontal / 6, sConv: acc.sConv / 6,
        sSubs: acc.sSubs / 6, sOther: acc.sOther / 6, sG: acc.sG / 6,
      });
    }
  }

  console.log(`C→B = ${ctb.length} セル / C→C(対照) = ${cok.length}\n`);
  console.log('【年平均】G の因子分解(面積重み)');
  console.log('因子                            C→B      C→C     比(C→B/C→C)');
  const rows: Array<[string, (c: Cell) => number]> = [
    ['風上遮蔽', (c) => c.block],
    ['ITCZ 持上げ', (c) => c.itcz],
    ['前線 持上げ', (c) => c.frontal],
    ['収束 持上げ', (c) => c.conv],
    ['地形性 持上げ', (c) => c.oro],
    ['沈降残存', (c) => c.subs],
    ['その他(ストーム/寒流/高温湿潤)', (c) => c.other],
    ['CRH 抑制', (c) => c.crh],
    ['—— 実効 G', (c) => c.g],
  ];
  for (const [name, f] of rows) {
    const a = wmean(ctb, f);
    const b = wmean(cok, f);
    console.log(`${name.padEnd(30)} ${a.toFixed(3).padStart(7)} ${b.toFixed(3).padStart(8)}  ${(a / Math.max(1e-9, b)).toFixed(2).padStart(8)}`);
  }
  console.log('\n【夏半年】同(降水の季節なので、こちらが本丸)');
  console.log('因子                            C→B      C→C     比');
  const srows: Array<[string, (c: Cell) => number]> = [
    ['ITCZ 持上げ', (c) => c.sItcz],
    ['前線 持上げ', (c) => c.sFrontal],
    ['収束 持上げ', (c) => c.sConv],
    ['沈降残存', (c) => c.sSubs],
    ['その他', (c) => c.sOther],
    ['—— 実効 G', (c) => c.sG],
  ];
  for (const [name, f] of srows) {
    const a = wmean(ctb, f);
    const b = wmean(cok, f);
    console.log(`${name.padEnd(30)} ${a.toFixed(3).padStart(7)} ${b.toFixed(3).padStart(8)}  ${(a / Math.max(1e-9, b)).toFixed(2).padStart(8)}`);
  }
  console.log('\n読み: 比が最も小さい因子が 0.44 の主因。そこが処方の場所。');
}

void main();
