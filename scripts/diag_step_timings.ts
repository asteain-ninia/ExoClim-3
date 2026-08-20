// 診断: パイプライン 1 周の段別時間内訳(GPU バッチ化の Amdahl 上限の実測)。
// 実行: npx tsx scripts/diag_step_timings.ts
import { runPipelineTimed } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { openAccel } from './accel_cli';

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try {
    out = await runPipelineTimed(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const t = out.stepTimingsMs;
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  console.log(`合計 ${(total / 1000).toFixed(1)} 秒`);
  for (const [k, v] of Object.entries(t).sort((a, b) => b[1] - a[1])) {
    console.log(`${k.padEnd(24)} ${(v / 1000).toFixed(1).padStart(7)} 秒  ${((100 * v) / total).toFixed(1).padStart(5)}%`);
  }
}
void main();
