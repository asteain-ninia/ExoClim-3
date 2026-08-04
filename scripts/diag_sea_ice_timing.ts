// 診断: モデルの高緯度の海は、いつ断熱を始めているか。
//
// 対応 spec: docs/spec/05_気温.md。診断は docs/実験記録_高緯度の冬_2026-08-04.md。
//
// 仮説(未検証): 高緯度の秋が +10〜+12°C 暖かすぎるのは、海氷の断熱が
// 遅れて効くため。iceW は**その時刻の気温だけ**の関数で氷厚の記憶が無いので、
// 海は「気温が seaFreezeC を下回ってから」しか混合層を切り離さない。
//
// **GPU を使う前にここで確かめる**。書き出した気温場から、モデルの海が
// 実際にいつ結氷温度を下回るかを月別に出せば、仮説が立つかどうかは決まる。
//   iceW = clamp((iceOnset − 気温) / iceRampWidthC, 0, 1)
//   capEff = heatCap × (1 − seaIceInsulationFactor × iceW × 海率)
// つまり iceW が月別にどう立ち上がるかが、そのまま断熱の時間発展である。
//
// **事前に登録する判定**:
//   仮説が立つ … モデルの北極海の iceW が 11〜12 月まで低いまま
//     (= 秋のあいだ混合層の熱容量を抱えたまま)。実物の北極海は 10 月には
//     広く結氷しているので、2 か月ほどの遅れがそのまま気温の遅れになる。
//   仮説が立たない … iceW が 9〜10 月には 1 に近く立ち上がっている。
//     その場合、秋の暖かさは断熱の時期ではなく別の原因(南北熱輸送・雲・
//     海洋熱輸送)なので、exp_sea_ice_lag.ts を回す前に仮説を組み直す。
//
// 実行: npx tsx scripts/diag_sea_ice_timing.ts

import * as fs from 'node:fs';
import { createGrid, latDegOfRow } from '../src/domain/grid';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';

const BIN = 'out/exp/transport_inputs.bin';
const META = 'out/exp/transport_inputs.json';
const MONTHS = 12;

interface Meta {
  widthCells: number;
  heightCells: number;
  cellCount: number;
  resolutionDeg: number;
  offsets: { monthly: number; landMask: number; precipMm: number; tempMonthly: number };
}

function main(): void {
  if (!fs.existsSync(BIN)) {
    console.log('入力がない。先に scripts/dump_transport_inputs.ts を実行');
    return;
  }
  const meta = JSON.parse(fs.readFileSync(META, 'utf8')) as Meta;
  const buf = fs.readFileSync(BIN);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const N = meta.cellCount;
  const grid = createGrid(meta.resolutionDeg);
  const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);
  const temp = (m: number): Float32Array =>
    all.subarray(meta.offsets.tempMonthly + m * N, meta.offsets.tempMonthly + (m + 1) * N);

  const bands: Array<[string, number, number]> = [
    ['70〜90°N の海', 70, 90],
    ['60〜70°N の海', 60, 70],
    ['50〜60°N の海', 50, 60],
    ['60〜70°S の海', -70, -60],
    ['70〜90°S の海', -90, -70],
  ];

  console.log(
    `結氷温度 ${K.seaFreezeC}°C / ランプ幅 ${K.iceRampWidthC}°C / 断熱係数 ${K.seaIceInsulationFactor}`,
  );
  console.log('\n海の気温(°C)');
  console.log('               ' + Array.from({ length: MONTHS }, (_, m) => String(m + 1).padStart(6)).join(''));
  const iceByBand: Array<[string, number[]]> = [];
  for (const [name, lo, hi] of bands) {
    const t: number[] = [];
    const ice: number[] = [];
    for (let m = 0; m < MONTHS; m++) {
      const tm = temp(m);
      let s = 0;
      let si = 0;
      let w = 0;
      for (let row = 0; row < meta.heightCells; row++) {
        const lat = latDegOfRow(grid, row);
        if (lat < lo || lat >= hi) continue;
        const cw = Math.cos((lat * Math.PI) / 180);
        for (let col = 0; col < meta.widthCells; col++) {
          const i = row * meta.widthCells + col;
          if (land[i]) continue;
          const tv = tm[i] ?? 0;
          s += cw * tv;
          // 海セルの iceOnset は seaFreezeC(陸率 0)
          si += cw * Math.min(1, Math.max(0, (K.seaFreezeC - tv) / K.iceRampWidthC));
          w += cw;
        }
      }
      if (w <= 0) {
        t.push(Number.NaN);
        ice.push(Number.NaN);
        continue;
      }
      t.push(s / w);
      ice.push(si / w);
    }
    console.log(
      `  ${name.padEnd(12)} ` +
        t.map((v) => (Number.isNaN(v) ? '   —' : v.toFixed(1)).padStart(6)).join(''),
    );
    iceByBand.push([name, ice]);
  }

  console.log('\n海氷の断熱の効き iceW(0 = 断熱なし、1 = 完全断熱)');
  console.log('               ' + Array.from({ length: MONTHS }, (_, m) => String(m + 1).padStart(6)).join(''));
  for (const [name, ice] of iceByBand) {
    console.log(
      `  ${name.padEnd(12)} ` +
        ice.map((v) => (Number.isNaN(v) ? '   —' : v.toFixed(2)).padStart(6)).join(''),
    );
  }

  console.log('\n実効熱容量の残り(1 − 断熱係数 × iceW。1 = 混合層まるごと)');
  console.log('               ' + Array.from({ length: MONTHS }, (_, m) => String(m + 1).padStart(6)).join(''));
  for (const [name, ice] of iceByBand) {
    console.log(
      `  ${name.padEnd(12)} ` +
        ice
          .map((v) =>
            Number.isNaN(v) ? '   —' : (1 - K.seaIceInsulationFactor * v).toFixed(2).padStart(6),
          )
          .join(''),
    );
  }
  console.log(
    '\n参考: 実物の北極海(70°N 以北)は 10 月には海氷面積が急増し、' +
      '\n      11 月にはほぼ全面が結氷する。地表気温も 10 月に −10°C を下回る。',
  );
}

main();
