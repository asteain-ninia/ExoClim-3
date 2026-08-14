// 実験(段 33): **偏西風と渦拡散を組み合わせる。**
//
// 事前登録: docs/事前登録_偏西風と拡散の組み合わせ_2026-08-15.md
//
// 単独で測った 2 つが互いの弱点を補う形をしている:
//   拡散を下げる（段 31）   中位 ↓438   乾いた端 ↓↓28
//   偏西風を強める（段 32） 中位 ↑501   乾いた端 ↑69
// **両立するか。**
//
// `westerlyWindMs` は 9.0（範囲内の上端。段 32 で主判定を満たした値）に固定し、
// 渦拡散だけを振る。5.0e5 は段 31 で輸送が未収束だったので測らない。
//
// 実行: npx tsx scripts/exp_westerly_diffusivity.ts [拡散,拡散,...]

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { formatLevel, measureLevel, resolveTargets } from './sweep_lib';
import { openAccel } from './accel_cli';

const DIFFS = (process.argv[2] ?? '2977275.937980041,2000000,1500000,1000000')
  .split(',')
  .map(Number);
const WESTERLY = Number(process.argv[3] ?? 9.0);
/** 段 34: 収束持上げも同時に固定する（0 = 触らない） */
const CONV = Number(process.argv[4] ?? 0);
const K = MODEL_CONSTANTS as unknown as Record<string, number>;

async function main(): Promise<void> {
  const targets = resolveTargets();
  const baseW = K['westerlyWindMs'] ?? 6.5;
  const baseC = K['convergenceLiftBoost'] ?? 0;
  K['westerlyWindMs'] = WESTERLY;
  if (CONV > 0) K['convergenceLiftBoost'] = CONV;
  console.log(
    `westerlyWindMs = ${WESTERLY}` +
      (CONV > 0 ? ` / convergenceLiftBoost = ${CONV}` : '') +
      ' に固定し、渦拡散を振る。',
  );
  console.log('**主判定: 中位 500 以上 かつ 1% が 64 以下。**\n');
  const accel = await openAccel(true);
  try {
    for (const dif of DIFFS) {
      const p = await measureLevel('moistureEddyDiffusivityM2PerS', dif, targets, accel.opts);
      console.log(`── 拡散 ${dif.toExponential(3)}（風 ${WESTERLY}）`);
      console.log(formatLevel(p));
      console.log('');
    }
  } finally {
    K['westerlyWindMs'] = baseW;
    K['convergenceLiftBoost'] = baseC;
    accel.close();
  }
  console.log(
    '判定(事前登録): 中位 500 以上 かつ 1% 分位 64 以下。\n' +
      '  番人: コンゴ 1.01〜1.61 / アマゾン 0.82〜1.12 /\n' +
      '  大分類が 74.49 から 2.0 以上落ちない / 5 系統すべて未収束 0 / 費用 900 秒。',
  );
}

void main();
