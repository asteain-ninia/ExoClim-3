// 段ごとの費用を GPU 経路で実測し、進捗バーの重み(src/sim/pipeline.ts の
// STAGE_COST)を裏付ける。
//
// 対応 spec: なし(計測ツール)。prof_pipeline.ts との違いは
// **CPU 経路を回さない**こと — CPU は 1 実行に 1 時間近くかかり、
// 進捗の重みを決めるのに必要な情報は GPU 経路の内訳だけである。
//
// 実行: npx tsx scripts/prof_stage_cost.ts

import { runPipelineTimed } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { openAccel } from './accel_cli';

const accel = await openAccel();
try {
  const t0 = performance.now();
  const { stepTimingsMs } = await runPipelineTimed(EARTH_PARAMS, accel.opts);
  const total = performance.now() - t0;
  console.log(`\n=== 全体 ${(total / 1000).toFixed(1)}s (${accel.enabled ? 'GPU' : 'CPU'}) ===`);
  const entries = Object.entries(stepTimingsMs).sort((a, b) => b[1] - a[1]);
  const sum = entries.reduce((a, [, ms]) => a + ms, 0);
  for (const [name, ms] of entries) {
    const pct = (ms / sum) * 100;
    console.log(
      `  ${name.padEnd(22)} ${(ms / 1000).toFixed(2).padStart(8)}s  ${pct.toFixed(2).padStart(6)}%` +
        `   重み ${Math.max(1, Math.round((ms / sum) * 1000))}`,
    );
  }
  console.log(`\n  (重みは合計 1000 に正規化した値。STAGE_COST に入れる目安)`);
} finally {
  accel.close();
}
