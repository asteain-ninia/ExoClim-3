// 較正の評価ワーカー: stdin から JSON 行 {vector} を受け、パイプライン実行 +
// リーン採点して stdout に JSON 行 {scores} を返す。親は scripts/optimize.ts。

import * as readline from 'node:readline';
import { runPipeline } from '../src/sim/pipeline';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line) as { id: number; vector: Record<string, number> };
    Object.assign(MODEL_CONSTANTS, msg.vector);
    const t0 = Date.now();
    const result = runPipeline(EARTH_PARAMS);
    const scores = evaluateResult(result);
    process.stdout.write(
      JSON.stringify({ id: msg.id, scores, sec: Math.round((Date.now() - t0) / 100) / 10 }) + '\n',
    );
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e) }) + '\n');
  }
});
