// 2° 格子の診断(解像度依存バグの調査用)
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipeline } from '../src/sim/pipeline';
import { KOPPEN_CLASSES } from '../src/domain/koppen';
import { rowOfLatDeg, colOfLonDeg } from '../src/domain/grid';

const params = { ...EARTH_PARAMS, gridResolutionDeg: 2 };
const r = runPipeline(params);
const g = r.context.grid;
console.log('grid', g.widthCells, 'x', g.heightCells);

const sites: Array<[string, number, number]> = [
  ['西欧(48N 2E)', 48, 2],
  ['ウクライナ(49N 32E)', 49, 32],
  ['サハラ(25N 10E)', 25, 10],
  ['シベリア(60N 100E)', 60, 100],
];
for (const [name, lat, lon] of sites) {
  const row = rowOfLatDeg(g, lat);
  const col = colOfLonDeg(g, lon);
  const i = row * g.widthCells + col;
  const t: string[] = [];
  const p: string[] = [];
  for (let m = 0; m < 12; m++) {
    t.push((r.temperature.monthlyTemperatureC[m]?.[i] ?? 0).toFixed(0));
    p.push((r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0).toFixed(0));
  }
  console.log(
    name,
    '→',
    KOPPEN_CLASSES[r.koppen.classId[i] ?? 0],
    '陸',
    r.context.terrain.landMask[i],
  );
  console.log('  T:', t.join(' '), ' 年平均', (r.temperature.annualMeanC[i] ?? 0).toFixed(1));
  console.log('  P:', p.join(' '), ' 年', (r.precipitation.annualPrecipMm[i] ?? 0).toFixed(0));
}
