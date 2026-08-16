// 仕様書に書いた定数名が、実装に本当に存在するかの照合(2026-08-16)。
//
// なぜ要るか(外部監査 = ファイル図鑑屋、2026-08-16):
//   「このプロジェクトの陳腐化は『書かなかった』型ではなく、
//     **『書いたが逆流させなかった』型**」と指摘された。
//   実際 spec/05 は 2026-07-30 から未更新で、**除去済みの隠しパラメータ
//   (GS_SWEEPS=8)の記述が残り、seaIce 系 5 定数が 1 つも載っていなかった**。
//
//   仕様書の役割は最新値の転記ではなく、**禁止事項「隠しパラメータ
//   (計算に効くのに UI にも仕様書にも無い量)」を防ぐこと**である。
//   その役割は「書いた名前が実在する」ことが前提になる。
//
// **この検査ができること / できないこと**:
//   ○ 定数を削除・改名したのに spec が古い名前を書き続けている、を検出する
//   × spec に載っていない定数がある(= 隠しパラメータ)は検出できない
//     — そちらは全定数の網羅が要り、機械化には spec の構造化が必要。
//     いまは人が書くときの規律に委ねる(将来の課題)。
//
// つまりこれは**片側の検査**である。それでも、今回のような
// 「実装が動いたのに文書が置き去り」の再発は捕まえられる。

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODEL_CONSTANTS } from '../../../src/sim/constants';

/** 仕様書のバッククォート内に現れる、定数名らしき識別子を拾う */
function backtickIdentifiers(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/`([A-Za-z][A-Za-z0-9_.]*)`/g)) {
    const name = m[1] ?? '';
    // ファイル名・パス・コマンドは対象外(定数名は英数字のみ)
    if (name.includes('.') || name.includes('/')) continue;
    // 短すぎる語は英単語の可能性が高いので除く
    if (name.length < 5) continue;
    out.add(name);
  }
  return [...out];
}

/**
 * 実装側に存在する名前。
 *
 * **`src/` 配下の全 .ts を対象にする。** 最初は constants.ts と step05 だけを
 * 見ていたが、仕様書は定数のほかに関数名(`itczInfluenceAt`)・診断フィールド名
 * (`condRateG`, `waterMm`)・オプション名(`holdingCapacityMm`)も引用しており、
 * **実在するのに「無い」と誤判定した**(2026-08-16、テストを書いた直後に踏んだ)。
 * 検査が厳しすぎて偽陽性を出すと、**通すために仕様書から正しい記述を削る**
 * という最悪の直し方を誘発する。
 */
function knownNames(): Set<string> {
  const known = new Set<string>(Object.keys(MODEL_CONSTANTS));
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        const text = fs.readFileSync(full, 'utf8');
        // 宣言に現れる識別子(定数・関数・型のフィールド)を広く拾う
        for (const m of text.matchAll(
          /(?:export const|function|const|let|readonly)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        )) {
          known.add(m[1] ?? '');
        }
        for (const m of text.matchAll(/^\s*([a-zA-Z_][A-Za-z0-9_]*)\??\s*:/gm)) {
          known.add(m[1] ?? '');
        }
      }
    }
  };
  walk(path.join(process.cwd(), 'src'));
  // 仕様書は検証側の関数(evaluateNumericalSoundness など)も引用するので
  // scripts/ も対象にする
  walk(path.join(process.cwd(), 'scripts'));
  return known;
}

/**
 * 定数名ではないが仕様書に現れる語(概念・型・外部語)。
 * **ここへ足すときは「本当に定数ではない」ことを確かめること** —
 * 安易に足すと検査が骨抜きになる。
 */
const NOT_CONSTANTS = new Set([
  'A_eff', // 支配方程式の数式記号(実装では aEff)
]);

describe('仕様書の定数名が実装に存在する', () => {
  const specDir = path.join(process.cwd(), 'docs', 'spec');
  const files = fs.readdirSync(specDir).filter((f) => f.endsWith('.md'));

  it('spec ディレクトリを読めている', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} に書かれた定数名がすべて実装にある`, () => {
      const md = fs.readFileSync(path.join(specDir, file), 'utf8');
      const known = knownNames();
      const missing = backtickIdentifiers(md).filter(
        (n) => !known.has(n) && !NOT_CONSTANTS.has(n),
      );
      // 既知の未改訂ファイルはここで除外せず、**落ちたまま**にする。
      // 落ちているという事実が「その spec は実装と乖離している」の印になる
      expect(
        missing,
        `${file} が実装に無い名前を書いている: ${missing.join(', ')}\n` +
          '定数を改名・削除したなら仕様書も直すこと(仕様書は隠しパラメータを防ぐための正本)。',
      ).toEqual([]);
    });
  }
});
