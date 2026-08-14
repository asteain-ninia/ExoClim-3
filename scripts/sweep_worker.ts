// 掃引の測定ワーカー: stdin から JSON 行 {id, key, value, targets} を受け、
// 1 水準を測って stdout に JSON 行 {id, report} を返す。親は掃引スクリプト。
//
// 較正のワーカー(optimize_worker.ts)と同じ作りにしてある。行の処理は**直列**に
// 繋ぐ — 同じ MODEL_CONSTANTS を複数の測定が同時に書き換えると、どの水準の
// 成績なのか分からなくなる(親は 1 行 1 応答を前提にしている)。
//
// 並列度は**プロセス数**で稼ぐ(親が本ワーカーを N 本立てる)。

import * as readline from 'node:readline';
import { measureLevel } from './sweep_lib';
import { openAccel } from './accel_cli';

// **`EBM_SOLVER.adaptive` は触らない。**
// 較正のワーカーはここで `false` にしている(収束しにくい定数領域は
// 「高くつく」のではなく失格にする、という較正の設計)。
// 掃引は設計が違う — その水準の**本当の答え**を出して表に載せる道具なので、
// 反復が足りなければ倍化して収束させるほうが正しい。収束しなかったことは
// 「EBM 上限到達」として印字されるので黙って通ることはない。
//
// 実際、最初にここへ較正から `adaptive = false` を写したところ、
// 直列で測った既存の記録と v3 が 0.02〜0.06 ずれた(2026-08-15)。
// **並列化とは無関係の、写し間違いによる挙動変更だった。**

const accelReady = openAccel(true).then((a) => {
  if (!a.enabled) {
    process.stderr.write(
      '[掃引ワーカー] GPU を取得できなかった。収束させた EBM を CPU で回すと ' +
        '1 水準に数分かかる。EXOCLIM_GPU=0 を外すか、GPU の状態を確認すること。\n',
    );
  }
  return a;
});

const rl = readline.createInterface({ input: process.stdin });
let chain: Promise<void> = Promise.resolve();

rl.on('line', (line) => {
  chain = chain.then(async () => {
    try {
      const msg = JSON.parse(line) as {
        id: number;
        key: string;
        value: number;
        targets: string[];
      };
      const accel = await accelReady;
      const report = await measureLevel(msg.key, msg.value, msg.targets, accel.opts);
      process.stdout.write(JSON.stringify({ id: msg.id, report }) + '\n');
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ id: -1, error: String(e instanceof Error ? e.stack : e) }) + '\n',
      );
    }
  });
});

// GPU デバイスは必ず破棄する(でないと exit 139)
rl.on('close', () => {
  chain = chain.then(async () => {
    (await accelReady).close();
  });
});
