// パイプラインの負荷内訳を実測し、CPU 実装と GPU 加速の差を並べる。
//
// 対応 spec: なし(計測ツール)。
// 2026-08-01 の実測(GPU 化前): step6 降水 37.1s(75%)・step5 気温 11.5s(23%)。
// step6 の内訳は土壌 27% / 風上追跡と変換 73% で、当初「土壌が支配的」と
// 見立てたのは誤りだった。
//
// 実行: npx tsx scripts/prof_pipeline.ts

import { performance } from 'node:perf_hooks';
import { runPipelineTimed } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { openAccel } from './accel_cli';
import type { RunOptions } from '../src/sim/accel';

async function measure(label: string, opts: RunOptions): Promise<Record<string, number>> {
  const t0 = performance.now();
  const { stepTimingsMs } = await runPipelineTimed(EARTH_PARAMS, opts);
  const total = performance.now() - t0;
  console.log(`\n=== ${label}: 全体 ${(total / 1000).toFixed(2)}s ===`);
  const entries = Object.entries(stepTimingsMs).sort((a, b) => b[1] - a[1]);
  for (const [name, ms] of entries) {
    if (ms < 1) continue;
    console.log(
      `  ${name.padEnd(20)} ${ms.toFixed(0).padStart(7)}ms  ${((ms / total) * 100).toFixed(1)}%`,
    );
  }
  return { ...stepTimingsMs, __total: total };
}

const cpu = await measure('CPU 実装', {});

const accel = await openAccel();
if (accel.enabled) {
  const gpu = await measure('GPU 加速', accel.opts);
  accel.close();
  console.log('\n=== 高速化 ===');
  for (const key of Object.keys(cpu)) {
    const a = cpu[key] ?? 0;
    const b = gpu[key] ?? 0;
    if (a < 100) continue;
    console.log(
      `  ${key.padEnd(20)} ${(a / 1000).toFixed(2)}s → ${(b / 1000).toFixed(2)}s  ` +
        `(${b > 0 ? (a / b).toFixed(1) : '∞'} 倍)`,
    );
  }
} else {
  accel.close();
}
