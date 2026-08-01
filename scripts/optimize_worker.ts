// 較正の評価ワーカー: stdin から JSON 行 {vector} を受け、パイプライン実行 +
// リーン採点して stdout に JSON 行 {scores} を返す。親は scripts/optimize.ts。
//
// パイプラインが非同期になったため、行の処理は**直列**に繋ぐ。
// 並行に走らせると同じ MODEL_CONSTANTS を複数の評価が同時に書き換えてしまい、
// どの定数ベクトルの成績なのか分からなくなる(親は 1 行 1 応答を前提にしている)。

import * as readline from 'node:readline';
import { runPipeline } from '../src/sim/pipeline';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';

const accelReady = openAccel(true);

const rl = readline.createInterface({ input: process.stdin });
let chain: Promise<void> = Promise.resolve();

rl.on('line', (line) => {
  chain = chain.then(async () => {
    try {
      const msg = JSON.parse(line) as {
        id: number;
        vector: Record<string, number>;
        holdoutFold?: number;
      };
      Object.assign(MODEL_CONSTANTS, msg.vector);
      const accel = await accelReady;
      const t0 = Date.now();
      const result = await runPipeline(EARTH_PARAMS, accel.opts);
      const scores = evaluateResult(result, msg.holdoutFold);
      process.stdout.write(
        JSON.stringify({ id: msg.id, scores, sec: Math.round((Date.now() - t0) / 100) / 10 }) +
          '\n',
      );
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String(e) }) + '\n');
    }
  });
});

// GPU デバイスは必ず破棄する(でないと exit 139)
rl.on('close', () => {
  chain = chain.then(async () => {
    (await accelReady).close();
  });
});
