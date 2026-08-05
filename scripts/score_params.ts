// 定数の組を適用して 1 回だけ採点する(較正の再開前の来歴確認・比較用)。
//
// 対応 spec: なし(検証の道具)。
//
// なぜ要るか: 較正を止めて再開すると、ワーカーは**そのときディスクにある
// コード**を読み直す。止めている間に計算層へ手を入れていれば、同じ実行名の
// 続きなのに違う物理を評価することになり、来歴が壊れる(2026-08-01 に実害)。
// 再開前にここで基準線を測り直し、log の 1 件目と一致することを確かめる。
//
// 実行: npx tsx scripts/score_params.ts <パラメータJSON>

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';

async function main(): Promise<void> {
  const p = process.argv[2];
  if (p) {
    const patch = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    let n = 0;
    for (const [k, v] of Object.entries(patch)) {
      if (k in target) {
        target[k] = v;
        n++;
      }
    }
    console.log(`パラメータ: ${p}(${n} 定数を適用)`);
  }
  const accel = await openAccel();
  try {
    const s = evaluateResult(await runPipeline(EARTH_PARAMS, accel.opts));
    console.log(
      `v3=${s.fitness.toFixed(3)} v2=${s.fitnessV2.toFixed(3)} ` +
        `大分類=${s.majorPct.toFixed(2)} 詳細=${s.detailPct.toFixed(2)} ゲート=${s.gates} ` +
        `気温=${s.tempRmse.toFixed(2)} 降水=${Math.round(s.precipRmse)}`,
    );
  } finally {
    accel.close();
  }
}

void main();
