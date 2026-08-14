// 診断: **風の場はどれだけ経度に依存しているか。収束の何割を ∂u/∂x が担うか。**
//
// なぜ要るか(2026-08-15):
//   中位の陸(面積 50%)には水が来ていない(正味流入 49mm/年、必要 212)。
//   収束持上げ(段 29)は「中位を守りつつ端を改善する」今日唯一の形を見せたが、
//   強さが足りなかった。収束指数の分布を見ると**二極分布**で
//   (中緯度で中央 0.17 / 90% 分位 55.8)、大部分では立っていない。
//
//   収束は `−(∂u/∂x + ∂v/∂y)` である。**帯状一様な風では ∂u/∂x = 0** なので、
//   収束は ∂v/∂y だけで決まる。実物の温帯低気圧は両方で収束を作るので、
//   帯状一様だと収束の作れる範囲が原理的に狭くなる。
//
//   ただしこのモデルの風は「帯状卓越風 + 気圧勾配風」の合成で、
//   **気圧勾配風は経度依存を持っている**(気圧異常場が経度で変わるため)。
//   したがって「帯状一様だから収束が立たない」は**確かめないと言えない**。
//   検証待ち §2 は帯状卓越風の側だけを見ている。
//
// 何を出すか:
//   1. 緯度帯ごとの u・v の**経度方向のばらつき**(標準偏差 / |平均|)。
//      0 に近ければ帯状一様、大きければ経度依存がある。
//   2. 発散の内訳 ∂u/∂x と ∂v/∂y の大きさを緯度帯ごとに比べる。
//      ∂u/∂x が桁で小さければ「経度依存が足りない」ことの直接の証拠になる。
//
// 実行: npx tsx scripts/diag_wind_zonality.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '../src/domain/grid';
import { openAccel } from './accel_cli';

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const dyKm = cellHeightKm(grid, r.context.params.body.radiusKm);

  const bands: Array<[string, number, number]> = [
    ['熱帯 0〜15°', 0, 15],
    ['亜熱帯 15〜30°', 15, 30],
    ['**中緯度 30〜50°**', 30, 50],
    ['高緯度 50〜70°', 50, 70],
  ];

  console.log('【1】風の経度方向のばらつき(年平均、|lat| の帯)');
  console.log('帯                    |u|平均  u の経度σ  σ/|u|   |v|平均  v の経度σ  σ/|v|');
  for (const [name, lo, hi] of bands) {
    let su = 0, sv = 0, sdu = 0, sdv = 0, n = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const u = r.airflow.monthlyWindU[m];
      const v = r.airflow.monthlyWindV[m];
      if (!u || !v) continue;
      for (let row = 0; row < H; row++) {
        const alat = Math.abs(latDegOfRow(grid, row));
        if (alat < lo || alat >= hi) continue;
        // その行(緯度円)での経度方向の平均と標準偏差
        let mu = 0, mv = 0;
        for (let col = 0; col < W; col++) {
          mu += u[row * W + col] ?? 0;
          mv += v[row * W + col] ?? 0;
        }
        mu /= W; mv /= W;
        let vu = 0, vv = 0;
        for (let col = 0; col < W; col++) {
          const du = (u[row * W + col] ?? 0) - mu;
          const dv = (v[row * W + col] ?? 0) - mv;
          vu += du * du; vv += dv * dv;
        }
        su += Math.abs(mu); sv += Math.abs(mv);
        sdu += Math.sqrt(vu / W); sdv += Math.sqrt(vv / W);
        n++;
      }
    }
    const au = su / n, av = sv / n, du = sdu / n, dv = sdv / n;
    console.log(
      `${name.padEnd(22)} ${au.toFixed(2).padStart(6)} ${du.toFixed(2).padStart(9)} ${(du / Math.max(1e-6, au)).toFixed(2).padStart(7)}` +
        `  ${av.toFixed(2).padStart(6)} ${dv.toFixed(2).padStart(9)} ${(dv / Math.max(1e-6, av)).toFixed(2).padStart(7)}`,
    );
  }

  console.log('\n【2】発散の内訳（|∂u/∂x| と |∂v/∂y| の平均、1e-6 /s）');
  console.log('  収束 = −(∂u/∂x + ∂v/∂y)。**帯状一様なら ∂u/∂x = 0** になる');
  console.log('帯                    |∂u/∂x|  |∂v/∂y|   x の割合');
  for (const [name, lo, hi] of bands) {
    let sx = 0, sy = 0, n = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const u = r.airflow.monthlyWindU[m];
      const v = r.airflow.monthlyWindV[m];
      if (!u || !v) continue;
      for (let row = 1; row < H - 1; row++) {
        const alat = Math.abs(latDegOfRow(grid, row));
        if (alat < lo || alat >= hi) continue;
        const dxKm = Math.max(20, cellWidthKm(grid, row, r.context.params.body.radiusKm));
        for (let col = 0; col < W; col++) {
          const e = row * W + wrapCol(grid, col + 1);
          const w = row * W + wrapCol(grid, col - 1);
          const nn = (row - 1) * W + col;
          const ss = (row + 1) * W + col;
          sx += Math.abs(((u[e] ?? 0) - (u[w] ?? 0)) / (2 * dxKm * 1000));
          sy += Math.abs(((v[nn] ?? 0) - (v[ss] ?? 0)) / (2 * dyKm * 1000));
          n++;
        }
      }
    }
    const ax = (sx / n) * 1e6, ay = (sy / n) * 1e6;
    console.log(
      `${name.padEnd(22)} ${ax.toFixed(3).padStart(7)} ${ay.toFixed(3).padStart(8)}` +
        `  ${(ax / Math.max(1e-9, ax + ay)).toFixed(2).padStart(8)}`,
    );
  }
  console.log(
    '\n読み: σ/|u| が 0 に近ければ帯状一様。|∂u/∂x| が |∂v/∂y| に対し桁で\n' +
      '  小さければ、収束は緯度方向の変化だけで作られており、\n' +
      '  **経度方向の構造(実物の温帯低気圧)が作れていない**ことになる。',
  );
}

void main();
