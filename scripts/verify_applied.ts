// 較正結果の適用を「全キー突合」で検証する。
//
// なぜ必要か(2026-07-31 の事故):
//   古い適用スクリプトが引数を無視して別の run の最良値を書き込み、
//   「適用 60 件」と報告しながら 11 定数が未適用のままだった。
//   ワーカーの採点(74.07)とプロセス内の採点(73.60)が食い違って初めて発覚した。
//   「適用したと報告されたか」ではなく「実際に読み込まれる値が一致するか」で
//   確かめる必要がある。適用の直後に必ずこれを通すこと。
//
// 実行: npx tsx scripts/verify_applied.ts out/optimize/best_v6ebm.json

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { MODEL_CONSTANTS } from '../src/sim/constants';

const bestPath = process.argv[2];
if (!bestPath) {
  console.error('使い方: npx tsx scripts/verify_applied.ts <best.json>');
  process.exit(2);
}
const best = JSON.parse(fs.readFileSync(path.resolve(bestPath), 'utf8')) as Record<string, number>;

// ---- 来歴の検証(2026-08-01 の事故) ----
// v6ebm の較正は ad1d190 で開始したが、走行中に別作業の 2 コミットが入り、
// ワーカーは途中から違うコードを評価していた。較正の自己採点(ゲート 14)は
// 完走後の HEAD で再現せず(13)、9 時間ぶんの探索が無効になった。
// 「較正が見ていたコード」と「これから検証するコード」の一致を機械で確かめる。
{
  const metaPath = bestPath.replace(/best_(.+)\.json$/, 'run_$1.meta.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      gitCommit?: string;
      gitDirty?: boolean;
      runName?: string;
    };
    let head = '';
    try {
      head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      head = '';
    }
    if (meta.gitCommit && head && meta.gitCommit !== head) {
      console.error(
        `来歴の不一致: 較正 ${meta.runName ?? '?'} は ${meta.gitCommit.slice(0, 7)} で開始したが、` +
          `現在の HEAD は ${head.slice(0, 7)}。`,
      );
      console.error('較正の走行中にコードが変わっている。この結果の自己採点は現在のコードで');
      console.error('再現しない。採用してはならない(較正をやり直すこと)。');
      process.exit(3);
    }
    if (meta.gitDirty) {
      console.error('来歴の不一致: 較正開始時点で作業ツリーが dirty だった。採用してはならない。');
      process.exit(3);
    }
    if (meta.gitCommit && head) {
      console.log(`来歴 OK: 較正開始と現在の HEAD が一致(${head.slice(0, 7)})`);
    }
  }
}

const constants = MODEL_CONSTANTS as unknown as Record<string, number>;
let matched = 0;
const mismatched: string[] = [];
for (const [key, expected] of Object.entries(best)) {
  const actual = constants[key];
  if (actual === undefined) {
    mismatched.push(`${key}: 定数表に存在しない`);
  } else if (Math.abs(actual - expected) > 1e-12) {
    mismatched.push(`${key}: 期待 ${expected} / 実際 ${actual}`);
  } else {
    matched++;
  }
}

console.log(
  `全キー突合(${path.basename(bestPath)}): 一致 ${matched} / 不一致 ${mismatched.length} ` +
    `/ 全 ${Object.keys(best).length}`,
);
for (const m of mismatched) console.log('  ✗ ' + m);
if (mismatched.length > 0) {
  console.error('\n適用が不完全。コミットしてはならない。');
  process.exit(1);
}
console.log('適用は完全に一致している。');
