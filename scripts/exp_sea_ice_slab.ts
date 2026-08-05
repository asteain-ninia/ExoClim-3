// 実験: 海氷を潜熱と伝導の 0 層模型にすると、両極の固着が壊れるか。
//
// 対応 spec: docs/設計_海氷の潜熱と伝導_2026-08-04.md
// 診断:      docs/実験記録_高緯度の冬_2026-08-04.md
//
// **CPU 経路で回す**(EXOCLIM_GPU=0)。較正が GPU を占有している間も進められる。
// 0 層模型はまだ CPU 側にしか実装していないので、どのみち CPU で測る必要がある。
//
// 直す対象(現行の温度ランプ、2026-08-04 実測):
//   北極海 70〜90°N  … 7〜11 月に断熱ゼロ。9 月の海面が +6.9°C(実物はほぼ 0°C)
//   南大洋 60〜70°S  … 一年中 iceW = 1.00 で凍りっぱなし。セル温度 −32〜−40°C
//
// **事前に登録する判定**(結果を見る前に固定):
//   1. 北極海 70〜90°N の 9〜10 月の海面温度が **下がる**(+6.9 → 実物に近づく)
//   2. 南大洋 60〜70°S の夏(1〜2 月)の海面温度が **上がる**(−10 → 実物の −1 前後へ)
//      = 夏に氷が後退している証拠
//   3. どちらも「片方だけ」では不成立。**両極が同時に改善すること**が条件
//      (片方だけなら断熱の強さを動かしただけで、双安定は壊れていない)
//   加えて数値: 積分年数を 8 → 16 年に増やしても上の量が 0.5°C 以上動かないこと
//      (0 層模型は状態を持ち越すので、周期定常に達していないと判定できない)
//
// 実行: EXOCLIM_GPU=0 npx tsx scripts/exp_sea_ice_slab.ts [積分年数]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_FULL_CAPACITY_YEARS, EBM_SOLVER } from '../src/sim/step05_temperature';
import { latDegOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

const YEARS = Number(process.argv[2] ?? 8);
const MONTHS = 12;

/** 緯度帯の海の月別平均気温 */
function oceanBand(result: PipelineResult, lo: number, hi: number): number[] {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const out: number[] = [];
  for (let m = 0; m < MONTHS; m++) {
    const tm = result.temperature.monthlyTemperatureC[m]!;
    let s = 0;
    let w = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < lo || lat >= hi) continue;
      const cw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (land[i]) continue;
        s += cw * (tm[i] ?? 0);
        w += cw;
      }
    }
    out.push(w > 0 ? s / w : Number.NaN);
  }
  return out;
}

async function main(): Promise<void> {
  // CPU 経路は遅いので短縮する。**判定に使う量が年数に依らないことを別途確かめる**
  EBM_SOLVER.sweeps = 0;
  EBM_FULL_CAPACITY_YEARS.years = YEARS;
  const target = MODEL_CONSTANTS as unknown as Record<string, number>;
  console.log(`CPU 経路 / 全熱容量 ${YEARS} 年`);

  const rows: Array<[string, number[], number[]]> = [];
  for (const [label, model] of [
    ['現行(温度ランプ)', 0],
    ['0 層模型(潜熱+伝導)', 1],
  ] as const) {
    target.seaIceModel = model;
    const t0 = Date.now();
    const result = await runPipeline(EARTH_PARAMS);
    const north = oceanBand(result, 70, 90);
    const south = oceanBand(result, -70, -60);
    rows.push([label, north, south]);
    console.log(`  ${label}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  const hdr = '                        ' + Array.from({ length: MONTHS }, (_, m) => String(m + 1).padStart(6)).join('');
  console.log('\n北極海 70〜90°N の海面気温(°C)  ※実物は 9 月ほぼ 0°C、1 月 −25°C 前後');
  console.log(hdr);
  for (const [label, north] of rows) {
    console.log(`  ${label.padEnd(20)} ` + north.map((v) => v.toFixed(1).padStart(6)).join(''));
  }
  console.log('\n南大洋 60〜70°S の海面気温(°C)  ※実物は 1〜2 月 −1°C 前後、8 月 −15°C 前後');
  console.log(hdr);
  for (const [label, , south] of rows) {
    console.log(`  ${label.padEnd(20)} ` + south.map((v) => v.toFixed(1).padStart(6)).join(''));
  }

  const n0 = rows[0]?.[1] ?? [];
  const n1 = rows[1]?.[1] ?? [];
  const s0 = rows[0]?.[2] ?? [];
  const s1 = rows[1]?.[2] ?? [];
  const arcticAutumn = ((n1[8] ?? 0) + (n1[9] ?? 0)) / 2 - ((n0[8] ?? 0) + (n0[9] ?? 0)) / 2;
  const southSummer = ((s1[0] ?? 0) + (s1[1] ?? 0)) / 2 - ((s0[0] ?? 0) + (s0[1] ?? 0)) / 2;
  console.log(
    `\n判定用: 北極海の秋(9〜10月) ${arcticAutumn >= 0 ? '+' : ''}${arcticAutumn.toFixed(2)}°C(下がれば成立)` +
      `\n        南大洋の夏(1〜2月) ${southSummer >= 0 ? '+' : ''}${southSummer.toFixed(2)}°C(上がれば成立)` +
      `\n        両方が同時に成立しなければ双安定は壊れていない`,
  );
}

void main();
