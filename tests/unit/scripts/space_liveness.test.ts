// 探索空間の生存性の照合(2026-08-16、外部監査の推奨への対処)。
//
// 監査(Codex 2026-08-15)は「**SPACE 全定数の動的生存性を CI で検査せよ**」と
// 言った。実際に 61 定数のうち 4 件が**答えに 1 ビットも影響していなかった**
// (保存型で経路が切れている 3 件と、親が 0 になった 1 件)。
// 較正はその 4 件を振り続け、評価の約 6.5% を空振りに使っていた。
// **2026-08-17 に 4 件を外し、57 定数で dead 0 件を確認した。**
//
// **だが動的検査そのものは CI に載る重さではない。**
// 全定数 × 2 方向のパイプライン実行で実測 40〜60 分かかる。
//
// そこで役割を分ける:
//   - 測るのは `scripts/diag_dead_constants.ts --write`(手で走らせる、重い)
//   - **ここで照合するのは「いまの探索空間が、測ったときのものと同じか」だけ**
//
// 定数を足す・範囲を変える・削ると指紋が変わってこのテストが落ちる。
// **測っていない探索空間のまま較正を始められなくなる**のが目的である。
// 落ちたときの直し方はテストの失敗メッセージに書いてある。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SPACE } from '../../../scripts/optimize_lib';

interface LivenessRecord {
  measuredAt: string;
  spaceFingerprint: string;
  constantCount: number;
  dead: string[];
}

const RECORD_PATH = path.join(process.cwd(), 'docs', '探索空間の生存性.json');

const HOWTO =
  '\n直し方: `npx tsx scripts/diag_dead_constants.ts --write` を走らせて記録を更新する' +
  '(2° 格子・EBM 短縮で 30〜60 分)。**結果を見てから記録を書き換えるのではなく、' +
  '測ってから探索空間を決めること。**';

describe('探索空間の生存性', () => {
  const record = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')) as LivenessRecord;

  it('いまの探索空間は、生存性を測ったときのものと同じ', () => {
    const now = createHash('sha256').update(JSON.stringify(SPACE)).digest('hex').slice(0, 16);
    expect(
      now,
      `探索空間が測定時から変わっている(記録 ${record.spaceFingerprint} → いま ${now})。${HOWTO}`,
    ).toBe(record.spaceFingerprint);
    expect(SPACE.length).toBe(record.constantCount);
  });

  /**
   * **既知の負債。2026-08-17 に解消して空になった。**
   *
   * 経緯: 2026-08-16 の全数測定で 4 件(ストーム供給の 3 定数と
   * `warmHumidSupplyNorm`)が答えに 1 ビットも影響しないと分かったが、
   * 較正 v24 が走行中で探索空間を変えられず、いったんここへ載せた。
   * v24 の終了後に 4 件を外し、57 定数で測り直して **dead が 0 件**になった。
   *
   * **以後ここは空のまま保つこと。** 名前を足すのは
   * 「外せない死に定数がある」ことを認める意味になる。
   * 死に定数が出たら、外すか配線を直すのが先である。
   */
  const KNOWN_DEAD: string[] = [];

  it('**新しく死んだ定数が探索空間に増えていない**', () => {
    const unexpected = record.dead.filter((n) => !KNOWN_DEAD.includes(n));
    expect(
      unexpected,
      `既知の負債に無い死に定数が出た: ${unexpected.join(', ')}。` +
        '保存則への移行や機構の入れ替えで経路が切れた疑いがある。' +
        '外すか、配線を直して生き返らせること。' +
        HOWTO,
    ).toEqual([]);
  });

  it('既知の負債が解消されたら、このリストを空にすること', () => {
    // 負債リストが実態より大きいまま放置されると、
    // **本当に死んでいる定数を見落とす穴**になる。
    // 記録に無い名前が KNOWN_DEAD に残っていたら、それは片付いた証拠なので消す
    const stale = KNOWN_DEAD.filter((n) => !record.dead.includes(n));
    expect(
      stale,
      `既に生き返った(または外された)定数が負債リストに残っている: ${stale.join(', ')}。` +
        'tests/unit/scripts/space_liveness.test.ts の KNOWN_DEAD から消すこと。',
    ).toEqual([]);
  });

  it('記録が探索空間の全定数を対象にしている', () => {
    // 部分実行(--write を付けても START≠0 なら書かない)の結果が
    // 紛れ込んでいないことの確認。診断側でも弾いているが、二重に見る
    expect(record.constantCount).toBe(SPACE.length);
    expect(record.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
