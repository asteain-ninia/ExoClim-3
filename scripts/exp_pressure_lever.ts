// 実験(段 8): 気圧側のレバーを振って、**水が運ばれてくるようになるか**を見る。
//
// 事前登録: docs/事前登録_保存則で無効化された過去の棄却_2026-08-10.md
//
// なぜ要るか:
//   未達 3 ゲート(india / us_southeast / east_asia)は、境界の流束を数え切った
//   結果「夏の南からの流入がゼロ近傍」だった(docs/診断_地域の水蒸気収支)。
//   打つ手は風の側にある。
//
//   風を動かす手は過去に何度も棄却されているが、**棄却理由がいずれも
//   「供給場が水の量ではない」ことに由来している**:
//     モンスーントラフ増深 → 「豪州・アラビアが湿る割にインドは動かず」
//     赤道越えモンスーン風 → 「風上が海から陸へ切り替わるため逆効果」
//   保存型ではこの経路が無いので、結論が変わりうる。
//
// **判定は v3 ではなく「正味流入」を主にする**(事前登録)。
//   いまの定数は非保存向けで、しかも較正の途中である。成績で判定すると
//   風の改善が定数の古さに埋もれる。
//
//   正味流入 = P − E は、定常なら「外から運ばれてきた量」に等しい。
//   パイプラインの出力(月別降水と陸面蒸発散)だけで計算できる。
//
// 測定と印字の中身は scripts/sweep_lib.ts にある(他の掃引と共有する)。
//
// 実行: npx tsx scripts/exp_pressure_lever.ts <定数名> <値1,値2,...> [--parallel N]
//   例: npx tsx scripts/exp_pressure_lever.ts monsoonTroughDeepening 0,0.5,1,1.5
//       npx tsx scripts/exp_pressure_lever.ts continentalThermalHpa 9,14,20 --parallel 3
//
//   **既定で水準を並列に測る**(2026-08-15)。水準どうしは独立なので答えは
//   変わらない。直列だった頃は 24 コアのうち 0.99 コアしか使っておらず、
//   5 水準の掃引で素の 5 倍待っていた(docs/引き継ぎ_2026-08-14.md §5)。
//   `--parallel 1` で以前の直列に戻せる。

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { formatHeader, resolveParallel, resolveTargets, runSweep } from './sweep_lib';

const KEY = process.argv[2] ?? 'monsoonTroughDeepening';
const VALUES = (process.argv[3] ?? '0,0.5,1,1.5').split(',').map(Number);

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  if (!(KEY in K)) {
    console.log(`定数 ${KEY} が無い`);
    return;
  }
  const targets = resolveTargets();
  const parallel = resolveParallel(VALUES.length);
  console.log(formatHeader(KEY, K[KEY] ?? 0, targets));
  process.stderr.write(`[掃引] ${VALUES.length} 水準を並列度 ${parallel} で測る\n`);

  await runSweep(KEY, VALUES, targets, parallel);

  console.log(
    '\n判定(事前登録): 未達 3 地域(india / us_southeast / east_asia)の夏の\n' +
      '  **正味流入が有意に正へ動き**、対照 2 地域(congo / europe_russia)の\n' +
      '  流入が半減しないこと。そのうえで v3 が段 3 の 80.688 から 1.0 以上\n' +
      '  落ちないこと。1・2 を満たし 3 を満たさないなら保留にして原因を特定する。',
  );
}

void main();
