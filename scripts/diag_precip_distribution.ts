// 診断: モデルの降水は**平されすぎていないか**。
//
// 2026-08-13(段 18)で、同じモデルの中に相反する 2 つの誤りがあると分かった:
//   サハラ    観測の 4.74 倍（水が来すぎている）
//   east_asia 観測の 0.17 倍（水が来ない）
// 陸平均は 722 対 観測 794 で、**全体量は足りている**。
// つまり量ではなく**配り方**の誤りで、しかも「乾いた所が湿り、湿った所が乾く」
// = **分布が圧縮されている**という 1 つの症状として書ける可能性がある。
//
// 分布そのものを見れば分かる。**平されているなら、モデルの分位が観測より
// 中央へ寄る**(下位分位が高く、上位分位が低い)。
//
// 実行: npx tsx scripts/diag_precip_distribution.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

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

  /** 陸セルの（モデル年降水, 観測年降水, 面積重み） */
  const rows: Array<[number, number, number]> = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!r.context.terrain.landMask[i]) continue;
      const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let o = 0;
      let bad = false;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) {
          bad = true;
          break;
        }
        o += v;
      }
      if (bad) continue;
      let p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      rows.push([p, o, cw]);
    }
  }

  const q = (vals: number[], p: number): number => {
    const a = [...vals].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] ?? 0;
  };
  const model = rows.map((x) => x[0]);
  const obs = rows.map((x) => x[1]);
  const wsum = rows.reduce((a, b) => a + b[2], 0);
  const wmean = (f: (x: [number, number, number]) => number): number =>
    rows.reduce((a, b) => a + b[2] * f(b), 0) / wsum;

  console.log(`陸セル ${rows.length}（観測が欠損でないもの）\n`);
  console.log(`面積重み平均   モデル ${wmean((x) => x[0]).toFixed(0)} / 観測 ${wmean((x) => x[1]).toFixed(0)} mm/年`);
  console.log('\n年降水の分位（mm/年）');
  console.log('分位     モデル    観測    モデル/観測');
  for (const p of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
    const mv = q(model, p);
    const ov = q(obs, p);
    console.log(
      `${(p * 100).toFixed(0).padStart(3)}%  ${mv.toFixed(0).padStart(8)} ${ov.toFixed(0).padStart(7)}` +
        `   ${(mv / Math.max(1, ov)).toFixed(2).padStart(8)}`,
    );
  }
  // ばらつきの比較（対数で見る。降水は桁で散る量）
  const lstd = (vals: number[]): number => {
    const l = vals.map((v) => Math.log10(Math.max(1, v)));
    const m = l.reduce((a, b) => a + b, 0) / l.length;
    return Math.sqrt(l.reduce((a, b) => a + (b - m) * (b - m), 0) / l.length);
  };
  console.log(`\n対数標準偏差   モデル ${lstd(model).toFixed(3)} / 観測 ${lstd(obs).toFixed(3)}`);
  console.log(
    '\n読み: 下位分位でモデル/観測が 1 を大きく超え、上位分位で 1 を下回るなら' +
      '**分布が中央へ圧縮されている**（乾いた所が湿り、湿った所が乾く）。' +
      '対数標準偏差が観測より小さければ同じことを 1 つの数で言える。',
  );
}

void main();
