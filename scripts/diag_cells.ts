// 代表地点の月別診断(較正デバッグ用)。気温・降水・風・ケッペン判定を並べる。

import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipeline } from '../src/sim/pipeline';
import { KOPPEN_CLASSES } from '../src/domain/koppen';
import { rowOfLatDeg, colOfLonDeg } from '../src/domain/grid';

const result = runPipeline(EARTH_PARAMS);
const grid = result.context.grid;

const SITES: Array<[string, number, number]> = [
  ['サヘル(15N 10E)', 15, 10],
  ['サハラ中央(25N 10E)', 25, 10],
  ['デリー付近(28N 77E)', 28, 77],
  ['ムンバイ付近(19N 73E)', 19, 73],
  ['米南東部(33N -85)', 33, -85],
  ['西欧(50N 5E)', 50, 5],
  ['東シベリア(62N 130E)', 62, 130],
  ['地中海(38N 15E)', 38, 15],
  ['豪州内陸(-25 135)', -25, 135],
  ['パタゴニア東(-45 -68)', -45, -68],
];

for (const [name, lat, lon] of SITES) {
  const row = rowOfLatDeg(grid, lat);
  const col = colOfLonDeg(grid, lon);
  const i = row * grid.widthCells + col;
  const t: number[] = [];
  const p: number[] = [];
  const u: number[] = [];
  const v: number[] = [];
  for (let m = 0; m < 12; m++) {
    t.push(Math.round((result.temperature.monthlyTemperatureC[m]?.[i] ?? 0) * 10) / 10);
    p.push(Math.round(result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0));
    u.push(Math.round((result.airflow.monthlyWindU[m]?.[i] ?? 0) * 10) / 10);
    v.push(Math.round((result.airflow.monthlyWindV[m]?.[i] ?? 0) * 10) / 10);
  }
  const cls = KOPPEN_CLASSES[result.koppen.classId[i] ?? 0];
  console.log(`\n== ${name} → ${cls} (陸=${result.context.terrain.landMask[i]}, 標高=${Math.round(result.context.terrain.elevationMeters[i] ?? 0)}m)`);
  console.log('  T:', t.join(' '));
  console.log('  P:', p.join(' '));
  console.log('  u(1月/7月):', u[0], u[6], ' v(1月/7月):', v[0], v[6]);
  console.log('  年P:', Math.round(result.precipitation.annualPrecipMm[i] ?? 0), 'mm');
}

// ITCZ 中心の確認(インド・アフリカ・豪州の経度)
console.log('\n== ITCZ 中心緯度(7月 = m6 / 1月 = m0)');
for (const [label, lon] of [['アフリカ 10E', 10], ['インド 77E', 77], ['豪州 135E', 135]] as Array<[string, number]>) {
  const col = colOfLonDeg(grid, lon);
  const jul = result.itcz.monthlyCenterLatDegByCol[6]?.[col];
  const jan = result.itcz.monthlyCenterLatDegByCol[0]?.[col];
  console.log(`  ${label}: 7月 ${jul?.toFixed(1)}°, 1月 ${jan?.toFixed(1)}°`);
}
