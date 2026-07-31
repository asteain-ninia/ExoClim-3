// 0.5° の実走確認と所要時間計測(製品の「最高精細・数十秒」の裏取り)
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipelineTimed } from '../src/sim/pipeline';

const t0 = Date.now();
const { result: r, stepTimingsMs } = runPipelineTimed({ ...EARTH_PARAMS, gridResolutionDeg: 0.5 });
const total = (Date.now() - t0) / 1000;
console.log('0.5° 合計', total.toFixed(1), 's', stepTimingsMs);
console.log('格子', r.context.grid.widthCells, 'x', r.context.grid.heightCells);
let landN = 0;
let sum = 0;
for (let i = 0; i < r.context.grid.cellCount; i++) {
  if (r.context.terrain.landMask[i]) {
    landN++;
    sum += r.precipitation.annualPrecipMm[i] ?? 0;
  }
}
console.log('陸セル', landN, '陸平均年降水', Math.round(sum / Math.max(1, landN)), 'mm');
console.log(
  '流線(年平均)',
  r.ocean.streamlines.length,
  '本, 月別',
  r.ocean.monthlyStreamlines.length,
  'か月分',
);
