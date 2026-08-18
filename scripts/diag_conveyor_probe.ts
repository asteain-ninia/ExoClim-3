// 診断: **コンベア(段 45b)の移送量の計器読み。** 掃引で流入が不動だったのは
// 「移送が起きていない」のか「起きたのに効かない」のかを切り分ける。
// 実行: DIAG_OVERRIDE='conveyorStrength=2' npx tsx scripts/diag_conveyor_probe.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { CONVEYOR_STATS } from '../src/sim/step06_precipitation';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: 値が数値でない '${key}'`);
    K[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  try {
    await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  console.log(`applyConveyor 呼び出し: ${CONVEYOR_STATS.calls} 回`);
  console.log(`  うち warmStart 不在で不発: ${CONVEYOR_STATS.skippedNoWarm} 回`);
  console.log(`  Σ 取水(mm/月 × cos重み): ${CONVEYOR_STATS.takeMmArea.toFixed(2)}`);
  console.log(
    '\n読み: 呼び出し 0 → conveyorPrep が立っていない(定数の伝搬)。\n' +
      '  取水 0 → 錨か上限が切っている。取水が大きいのに流入不動 → 給水先か\n' +
      '  凝結が海岸で即消費(ソルバ側の綱引き)。',
  );
}

void main();
