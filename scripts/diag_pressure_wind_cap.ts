// 診断: **気圧勾配風はどこで頭打ちか — 段 39 が 2 桁弱かった犯人を特定する。**
//
// なぜ要るか(2026-08-17):
//   段 41・42 の追測で「反転」一族の限界が判明し、残る道は
//   **海上(水源)から陸へ繋がる経路のある流れ**に絞られた。
//   その最有力の配管は気圧場経由(段 39 の族 — 経路は正しく副作用ゼロだった)。
//   だが段 39 は効果が必要量の 8% しかなかった。犯人の候補は 2 つ:
//     (a) 気圧勾配風の合成上限 P_MAX = 8 m/s に既に張り付いていて、
//         気圧を強めても風が増えない
//     (b) 上限には余裕があるが、気圧の起伏(hPa)や減衰距離のせいで
//         沿岸での勾配そのものが小さい
//   どちらかで処方がまるで違う((a) なら上限の見直し、(b) なら気圧場の振幅)。
//
// 何を出すか:
//   step04 と同じ式で気圧勾配風 (pu, pv) を再計算し、
//   1. 夏半年・亜熱帯(15〜35°)で、上限に達したセルの割合(海/陸別)
//   2. C→B セルでの pv(極向き成分)と、上限前の「素の」大きさ
//   3. 気圧偏差の東西振幅(C→B セルの経度での海陸差)
//
// 実行: npx tsx scripts/diag_pressure_wind_cap.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';

import { latDegOfRow, cellWidthKm, cellHeightKm, wrapCol } from '../src/domain/grid';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const P_MAX = 8; // step04 の上限(定数化されていない値。変えたらここも直す)

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
  const land = r.context.terrain.landMask;
  const kobs = getKoppenObs();
  const dyKm = cellHeightKm(grid, r.context.params.body.radiusKm);
  const dirSign = r.context.params.body.rotationDirection >= 0 ? 1 : -1;
  const wb = r.windBelt;
  if (!wb) throw new Error('windBelt が結果に無い');

  // 集計: 夏半年・|lat| 15〜35°、海/陸/C→B の 3 群
  const acc = {
    ocean: { n: 0, capped: 0, pv: 0, pvRaw: 0, mag: 0 },
    land: { n: 0, capped: 0, pv: 0, pvRaw: 0, mag: 0 },
    ctb: { n: 0, capped: 0, pv: 0, pvRaw: 0, mag: 0 },
  };

  for (let row = 1; row < H - 1; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) < 15 || Math.abs(lat) > 35) continue;
    const north = lat >= 0;
    const dxKm = Math.max(20, cellWidthKm(grid, row, r.context.params.body.radiusKm));
    const summerMonths = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    const f = Math.sin((Math.abs(lat) * Math.PI) / 180);
    const rotRamp = Math.min(1, Math.max(0, (Math.abs(lat) - 10) / 20));
    const rotSign = (lat >= 0 ? 1 : -1) * dirSign;
    const rotW = (K['pressureGradientRotationalMsPerHpaPerMm'] ?? 0) * f * rotRamp;
    const crossW = (K['pressureGradientCrossMsPerHpaPerMm'] ?? 0) * (1 - 0.5 * f);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const obsId = kobs.classRaster[i] ?? 0;
      const isCtb =
        land[i] &&
        obsId !== 0 &&
        majorClassOf(obsId) === MAJOR.C &&
        majorClassOf(r.koppen.classId[i] ?? 0) === MAJOR.B;
      for (const m of summerMonths) {
        const p = wb.monthlyPressureAnomalyHpa[m];
        if (!p) continue;
        const east = row * W + wrapCol(grid, col + 1);
        const west = row * W + wrapCol(grid, col - 1);
        const north2 = (row - 1) * W + col;
        const south = (row + 1) * W + col;
        const dpdx = (((p[east] ?? 0) - (p[west] ?? 0)) / (2 * dxKm)) * 1000;
        const dpdy = (((p[north2] ?? 0) - (p[south] ?? 0)) / (2 * dyKm)) * 1000;
        let pu = rotSign * rotW * -dpdy - crossW * dpdx;
        let pv = rotSign * rotW * dpdx - crossW * dpdy;
        const pMag = Math.hypot(pu, pv);
        const pvRaw = pv;
        const capped = pMag > P_MAX;
        if (capped) {
          pu *= P_MAX / pMag;
          pv *= P_MAX / pMag;
        }
        // 極向き成分に揃える
        const pvPole = north ? pv : -pv;
        const pvRawPole = north ? pvRaw : -pvRaw;
        const g = isCtb ? acc.ctb : land[i] ? acc.land : acc.ocean;
        g.n++;
        if (capped) g.capped++;
        g.pv += pvPole;
        g.pvRaw += pvRawPole;
        g.mag += pMag;
      }
    }
  }

  console.log('夏半年・|lat| 15〜35° の気圧勾配風(step04 と同じ式で再計算)');
  console.log(`上限 P_MAX = ${P_MAX} m/s\n`);
  console.log('群         セル月数   上限到達率   極向き pv(上限後)  同(上限前)   |風| 平均');
  for (const [name, g] of Object.entries(acc)) {
    if (g.n === 0) continue;
    console.log(
      `${name.padEnd(8)} ${String(g.n).padStart(9)} ${((100 * g.capped) / g.n).toFixed(1).padStart(9)} %` +
        ` ${(g.pv / g.n).toFixed(2).padStart(12)} ${(g.pvRaw / g.n).toFixed(2).padStart(12)}` +
        ` ${(g.mag / g.n).toFixed(2).padStart(9)}`,
    );
  }
  console.log(
    '\n読み: 上限到達率が高ければ (a) P_MAX が犯人(気圧を強めても無駄)。\n' +
      '  低くて pv も小さければ (b) 勾配そのものが小さい(気圧場の振幅・形が犯人)。\n' +
      '  上限前と後の pv がほぼ同じなら、上限は効いていない。',
  );
}

void main();
