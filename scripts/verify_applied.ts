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
import { MODEL_CONSTANTS } from '../src/sim/constants';

const bestPath = process.argv[2];
if (!bestPath) {
  console.error('使い方: npx tsx scripts/verify_applied.ts <best.json>');
  process.exit(2);
}
const best = JSON.parse(fs.readFileSync(path.resolve(bestPath), 'utf8')) as Record<string, number>;

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
