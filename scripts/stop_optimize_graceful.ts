// 較正を**バッチの切れ目で**止める(実行中の評価を捨てない)。
//
// 対応 spec: なし(運用の道具)。
//
// なぜ要るか:
//   scripts/stop_optimize.ps1 は即座に殺すので、実行中のバッチ(評価 2 件、
//   実時間 10 分ぶん)が失われる。較正は 1 評価 500 秒かかるので、
//   待てるなら待ったほうがよい。
//
// どう見分けるか:
//   optimize.ts はバッチが終わるたびに state_<run>.json を書く。
//   **その更新時刻が変わった瞬間 = バッチが終わって状態が保存された瞬間**
//   なので、そこで殺せば失う仕事はほぼゼロになる。
//   (次のバッチは即座に始まるので、厳密には数秒ぶんだけ捨てる)
//
// 実行: npx tsx scripts/stop_optimize_graceful.ts <実行名> [待つ上限の分]
//   例: npx tsx scripts/stop_optimize_graceful.ts v13evap 20

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const RUN = process.argv[2];
const MAX_WAIT_MIN = Number(process.argv[3] ?? 20);

if (!RUN) {
  console.log('使い方: npx tsx scripts/stop_optimize_graceful.ts <実行名> [待つ上限の分]');
  process.exit(1);
}

const statePath = path.join('out', 'optimize', `state_${RUN}.json`);
const logPath = path.join('out', 'optimize', `log_${RUN}.jsonl`);

function stopNow(reason: string): never {
  console.log(`停止します(${reason})`);
  try {
    execFileSync('pwsh', ['-File', 'scripts/stop_optimize.ps1', '-Run', RUN!], {
      stdio: 'inherit',
    });
  } catch {
    // pwsh が無い環境では powershell へ落とす
    execFileSync('powershell', ['-File', 'scripts/stop_optimize.ps1', '-Run', RUN!], {
      stdio: 'inherit',
    });
  }
  process.exit(0);
}

function evalCount(): number {
  try {
    return fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').length;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(statePath)) {
    console.log(`状態ファイルが無い: ${statePath}`);
    process.exit(1);
  }
  const t0 = fs.statSync(statePath).mtimeMs;
  const n0 = evalCount();
  console.log(
    `バッチの切れ目を待ちます(実行名 ${RUN}、現在 ${n0} 評価、上限 ${MAX_WAIT_MIN} 分)`,
  );
  const deadline = Date.now() + MAX_WAIT_MIN * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    if (!fs.existsSync(statePath)) stopNow('状態ファイルが消えた');
    const t = fs.statSync(statePath).mtimeMs;
    if (t !== t0) {
      console.log(`バッチ完了を検知(${evalCount()} 評価まで保存済み)`);
      stopNow('バッチ境界');
    }
    if (Date.now() > deadline) {
      console.log(
        `上限 ${MAX_WAIT_MIN} 分を超えました。切れ目を待たずに止めます` +
          `(実行中のバッチぶんは失われます)`,
      );
      stopNow('待ち時間切れ');
    }
  }
}

void main();
