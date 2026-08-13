// 診断: モデルの大気は水をどれだけ持っているか。
//
// P = λ·G·W なので λ と G の平均は互いに縮退している(αG と λ/α は同じ)。
// **滞留時間 1/(λG) を独立に検証できる唯一の量が W の絶対値**である。
// 実物の全球平均可降水量は約 25mm。
//
// 実行: npx tsx scripts/diag_water_vapor.ts
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { openAccel } from './accel_cli';

const accel = await openAccel(true);
try {
  CONSERVATIVE_STATS.meanWaterMm = 0;
  CONSERVATIVE_STATS.waterSamples = 0;
  const r = await runPipeline(EARTH_PARAMS, accel.opts);
  const w = CONSERVATIVE_STATS.meanWaterMm / Math.max(1, CONSERVATIVE_STATS.waterSamples);
  let p = 0;
  const g = r.context.grid;
  let ww = 0;
  for (let row = 0; row < g.heightCells; row++) {
    const cw = Math.cos((((row + 0.5) * 180) / g.heightCells - 90) * (Math.PI / 180));
    for (let col = 0; col < g.widthCells; col++) {
      p += cw * (r.precipitation.annualPrecipMm[row * g.widthCells + col] ?? 0);
      ww += cw;
    }
  }
  const pAnn = p / ww;
  console.log(`\n全球平均の可降水量 W   ${w.toFixed(2)} mm   （実物 約 25mm）`);
  console.log(`全球平均の年降水 P     ${pAnn.toFixed(0)} mm/年（実物 約 1000mm/年）`);
  console.log(`滞留時間 W/P           ${((w / (pAnn / 365)) ).toFixed(1)} 日   （実物 約 9 日）`);
  console.log(`\n読み: W が実物より小さければ λ·G の全球平均が大きすぎる。`);
} finally {
  accel.close();
}
