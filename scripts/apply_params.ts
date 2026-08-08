// 較正結果を src/sim/constants.ts へ書き戻す。
//
// なぜ要るか(2026-07-31 の事故、verify_applied.ts の冒頭に記録):
//   古い適用スクリプトが引数を無視して別の run の最良値を書き込み、
//   「適用 60 件」と報告しながら 11 定数が未適用のままだった。
//   **報告を信じず、書いた後に必ず verify_applied.ts を通すこと。**
//   このスクリプトは書くだけで、検証はしない(役割を分ける)。
//
// 書き換えは行単位の厳密一致で行う:
//   `  <キー>: <値>,`  の値の部分だけを差し替える。
//   1 行に 1 定数という constants.ts の書式に依存しているので、
//   書式を変えたらここも直すこと(**当たらなかったキーは必ず報告する**)。
//
// 実行: npx tsx scripts/apply_params.ts out/optimize/best_v15.json

import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.join('src', 'sim', 'constants.ts');
const p = process.argv[2];
if (!p) {
  console.error('使い方: npx tsx scripts/apply_params.ts <best.json>');
  process.exit(2);
}
const best = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')) as Record<string, number>;
let text = fs.readFileSync(SRC, 'utf8');

const applied: string[] = [];
const missed: string[] = [];
for (const [key, value] of Object.entries(best)) {
  // 行頭の空白 + キー + コロン + 値 + カンマ。コメント行やキー名の部分一致は拾わない。
  //
  // **行末の \r を必ず許すこと。** この作業ツリーは CRLF なので、`,$` だけだと
  // 行末の \r に阻まれて **1 件も当たらない**(2026-08-08 の事前検証で発覚)。
  // しかも「当たらなかった」という報告が出るだけで書き込み自体は成功するので、
  // 検算を通さないと「適用したつもりで何も変わっていない」状態になる。
  //
  // 行末の \r は**捨てずに書き戻す**。落とすと差し替えた行だけ LF になり、
  // 改行コードの混ざったファイルができて全行差分に化ける。
  const re = new RegExp(`^([ \\t]*)${key}: [^,\\r\\n]+,(\\r?)$`, 'm');
  if (!re.test(text)) {
    missed.push(key);
    continue;
  }
  text = text.replace(re, `$1${key}: ${value},$2`);
  applied.push(key);
}

fs.writeFileSync(SRC, text, 'utf8');
console.log(`${path.basename(p)} を適用: ${applied.length} 件`);
if (missed.length > 0) {
  console.log(`**当たらなかったキー ${missed.length} 件**: ${missed.join(', ')}`);
  console.log('constants.ts の書式が想定と違うか、キー名が存在しない。手で確かめること。');
}
console.log('\n次に必ず: npx tsx scripts/verify_applied.ts ' + p);
