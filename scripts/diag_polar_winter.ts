// 診断: 高緯度の冬が暖かすぎる(+5.64°C)のはどこで起きているか。
//
// 対応 spec: docs/spec/05_気温.md(EBM)。
//
// 経緯(2026-08-03 の季節分解 scripts/diag_range_vs_wetness.ts):
//   高緯度(50〜90°N)  最暖月 +2.35°C / **最寒月 +5.64°C**
//   陸面の水では説明できない別系統として切り分けたまま未着手だった。
//
// 切り分けたいこと:
//   (a) 陸か海か … 海が暖かいなら海氷の断熱・混合層深さ、陸なら逆転層の絶縁
//   (b) 内陸度 … 沿岸だけなら移流、内陸まで一様なら放射か拡散
//   (c) 緯度依存 … 極ほど強いなら南北熱輸送が強すぎる(勾配が緩い)
//   (d) 月依存 … 真冬に集中するのか、秋冬を通じてか(熱容量なら位相がずれる)
//   (e) 南半球との対比 … 南半球高緯度は海が支配的なので、陸海の効きを分離できる
//
// **GPU を使わない**。scripts/dump_transport_inputs.ts が書き出した気温場を読む。
// 較正が GPU を占有している間でも回せる。
//
// 実行: npx tsx scripts/diag_polar_winter.ts

import * as fs from 'node:fs';

import { getClimObs } from './scoring';

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

interface Cell {
  lat: number;
  isLand: boolean;
  /** 最寄りの海までのセル距離(陸のみ。海は 0)。内陸度の代理 */
  inland: number;
  /** モデル − 観測 の月別バイアス */
  bias: number[];
  w: number;
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
  const W = meta.widthCells;
  const H = meta.heightCells;
  const land = all.subarray(meta.offsets.landMask, meta.offsets.landMask + N);
  const temp = (m: number): Float32Array =>
    all.subarray(meta.offsets.tempMonthly + m * N, meta.offsets.tempMonthly + (m + 1) * N);

  // 内陸度: 海からの BFS(セル数)。経度は周期
  const inland = new Int32Array(N).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!land[i]) {
      inland[i] = 0;
      queue.push(i);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi]!;
    const row = Math.floor(i / W);
    const col = i % W;
    const nb = [
      row * W + ((col + 1) % W),
      row * W + ((col - 1 + W) % W),
      row > 0 ? (row - 1) * W + col : -1,
      row < H - 1 ? (row + 1) * W + col : -1,
    ];
    for (const j of nb) {
      if (j < 0) continue;
      if (inland[j] === -1) {
        inland[j] = (inland[i] ?? 0) + 1;
        queue.push(j);
      }
    }
  }

  // 観測(2°)へ集約して比較する — 採点と同じ物差し
  const clim = getClimObs();
  const f = Math.round(2 / meta.resolutionDeg);
  const cells: Cell[] = [];
  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const obs: number[] = [];
      let ok = true;
      for (let m = 0; m < MONTHS; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (t === -9999) {
          ok = false;
          break;
        }
        obs.push(t / 10);
      }
      if (!ok) continue;
      // 粗セル内の陸セルを平均(観測は陸の値なので陸で揃える)
      const model = new Array<number>(MONTHS).fill(0);
      let n = 0;
      let inlandSum = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= H || gc >= W) continue;
          const gi = gr * W + gc;
          if (!land[gi]) continue;
          n++;
          inlandSum += inland[gi] ?? 0;
          for (let m = 0; m < MONTHS; m++) model[m] = (model[m] ?? 0) + (temp(m)[gi] ?? 0);
        }
      }
      if (n === 0) continue;
      const bias = model.map((v, m) => v / n - obs[m]!);
      cells.push({ lat, isLand: true, inland: inlandSum / n, bias, w });
    }
  }
  console.log(`比較できた 2° 陸セル: ${cells.length}`);

  const wmean = (g: Cell[], pick: (c: Cell) => number): number => {
    let s = 0;
    let w = 0;
    for (const c of g) {
      s += c.w * pick(c);
      w += c.w;
    }
    return w > 0 ? s / w : Number.NaN;
  };
  /** その半球の冬(北: 12-2月、南: 6-8月)と夏のバイアス */
  const winter = (c: Cell): number =>
    c.lat >= 0
      ? (c.bias[11]! + c.bias[0]! + c.bias[1]!) / 3
      : (c.bias[5]! + c.bias[6]! + c.bias[7]!) / 3;
  const summer = (c: Cell): number =>
    c.lat >= 0
      ? (c.bias[5]! + c.bias[6]! + c.bias[7]!) / 3
      : (c.bias[11]! + c.bias[0]! + c.bias[1]!) / 3;

  const table = (title: string, groups: Array<[string, Cell[]]>): void => {
    console.log(`\n${title}`);
    console.log('                     n      冬のバイアス   夏のバイアス     差');
    for (const [name, g] of groups) {
      if (g.length < 10) continue;
      const wi = wmean(g, winter);
      const su = wmean(g, summer);
      const f2 = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`.padStart(8);
      console.log(
        `  ${name.padEnd(16)} ${String(g.length).padStart(5)}   ${f2(wi)} °C   ${f2(su)} °C  ${f2(wi - su)} °C`,
      );
    }
  };

  table(
    '緯度帯ごと(北半球)',
    ([
      [30, 45],
      [45, 55],
      [55, 65],
      [65, 75],
      [75, 90],
    ] as const).map(([lo, hi]) => [
      `${lo}〜${hi}°N`,
      cells.filter((c) => c.lat >= lo && c.lat < hi),
    ]),
  );
  table(
    '緯度帯ごと(南半球)',
    ([
      [-45, -30],
      [-60, -45],
      [-90, -60],
    ] as const).map(([lo, hi]) => [
      `${lo}〜${hi}°`,
      cells.filter((c) => c.lat >= lo && c.lat < hi),
    ]),
  );
  table(
    '内陸度ごと(50°N 以北の陸)',
    ([
      [0, 3],
      [3, 8],
      [8, 15],
      [15, 999],
    ] as const).map(([lo, hi]) => [
      `海から ${lo}〜${hi} セル`,
      cells.filter((c) => c.lat >= 50 && c.inland >= lo && c.inland < hi),
    ]),
  );

  // 月別の推移(50°N 以北の陸)。真冬に集中するのか、秋から続くのか
  const north = cells.filter((c) => c.lat >= 50);
  console.log('\n50°N 以北の陸: 月別バイアス(モデル − 観測)');
  console.log(
    '    ' +
      Array.from({ length: MONTHS }, (_, m) => {
        const v = wmean(north, (c) => c.bias[m]!);
        return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`.padStart(6);
      }).join(''),
  );
  console.log('    ' + Array.from({ length: MONTHS }, (_, m) => String(m + 1).padStart(6)).join(''));

}

main();
