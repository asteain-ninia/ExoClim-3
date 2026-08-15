// 診断: **62 定数のうち、保存型で実際に答えを動かすのはどれか。**
//
// なぜ要るか(2026-08-15):
//   `stormMoistureSupply` を掃引したら全水準ビット一致した。実装を読むと
//   **非保存の降水式にしか入っておらず、保存型では完全に死んでいた**。
//   しかも較正の探索空間に入っており、**答えに 1 ビットも影響しない定数を
//   82% まで上げていた**。virga と同じく段 6 の移行で落ちたもので、
//   **2 例目**である。
//
//   同じものが他にもあるはずで、**1 つずつ振ってビット一致を見れば
//   機械的に分かる**。掃引が並列化されたので現実的な時間で回る。
//
//   これは教訓 §9 の「ビット一致は『頑健』ではなく『独立変数が動いていない』
//   の徴候」を、**探索空間の全体に対して一括で適用する**道具である。
//
// 何をするか:
//   各定数を ±20%（0 のものは 0.1 へ）動かし、2° 格子・EBM 短縮で
//   パイプラインを回して**降水がビット一致するか**を見る。
//   一致したら「保存型では効いていない」候補として報告する。
//
//   **2° と短縮 EBM を使うのは、効き/効かずの判定に精度は要らないため。**
//   ただし「2° では効かないが 1° では効く」機構(格子依存)は見逃すので、
//   **候補が出たら 1° で確かめること。**
//
// 実行: npx tsx scripts/diag_dead_constants.ts [開始index] [件数]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { EBM_SOLVER, EBM_FULL_CAPACITY_YEARS } from '../src/sim/step05_temperature';
import { SPACE } from './optimize_lib';

// **効き/効かずの判定に精度は要らない。** 安い条件で回す
EBM_SOLVER.sweeps = 8;
EBM_FULL_CAPACITY_YEARS.years = 2;

const P = { ...EARTH_PARAMS, gridResolutionDeg: 2 };
const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const START = Number(process.argv[2] ?? 0);
const COUNT = Number(process.argv[3] ?? SPACE.length);

/**
 * 基準との差を**空間の再配分まで見える形**で測る(2026-08-15 訂正)。
 *
 * **初版は「合計と最大値を小数 6 桁に丸めた文字列」を比べていた。**
 * 外部レビュー(Codex)に「空間再配分が起きても合計と最大が同じなら
 * 『死んでいる』と誤判定できる。ビット一致という呼称は過大」と指摘され、
 * **そのとおりだったので直した**。
 *
 * いまは全セル全月について
 *   - 最大絶対差(mm/月)
 *   - 差が 1e-6 を超えたセル月の割合(= 影響範囲)
 * を返す。**合計が保たれたまま場所だけ入れ替わっても捕まえられる。**
 */
function diffAgainst(base: Float32Array[], cur: Float32Array[]): { maxAbs: number; frac: number } {
  let maxAbs = 0;
  let hit = 0;
  let n = 0;
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const a = base[m];
    const b = cur[m];
    if (!a || !b) continue;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs((b[i] ?? 0) - (a[i] ?? 0));
      if (d > maxAbs) maxAbs = d;
      if (d > 1e-6) hit++;
      n++;
    }
  }
  return { maxAbs, frac: hit / Math.max(1, n) };
}

/** 月別配列を複製する(基準を保持するため) */
function clone(monthly: Float32Array[]): Float32Array[] {
  return monthly.map((a) => a.slice());
}

async function main(): Promise<void> {
  const base = await runPipeline(P);
  const baseP = clone(base.precipitation.monthlyPrecipMm);
  console.log('基準を採った。以降は**全セル全月の差**で判定する');
  console.log(`2° 格子・EBM 短縮。${SPACE.length} 定数のうち ${START}〜${START + COUNT - 1} を見る\n`);
  console.log('定数                                  変更        最大差mm  影響%   判定');

  const dead: string[] = [];
  for (let k = START; k < Math.min(SPACE.length, START + COUNT); k++) {
    const entry = SPACE[k];
    if (!entry) continue;
    const [name, lo, hi] = entry;
    const cur = K[name] ?? 0;
    // ±20%。0 のものは範囲の 10% 分だけ動かす
    const next = cur === 0 ? lo + 0.1 * (hi - lo) : cur * 1.2 > hi ? cur * 0.8 : cur * 1.2;
    K[name] = next;
    const r = await runPipeline(P);
    const { maxAbs, frac } = diffAgainst(baseP, r.precipitation.monthlyPrecipMm);
    K[name] = cur;
    // **完全に 0 のときだけ「効いていない」と言う。** 丸めた要約では言わない
    const same = maxAbs === 0;
    if (same) dead.push(String(name));
    console.log(
      `${String(name).padEnd(36)} ${cur.toPrecision(3)}→${next.toPrecision(3)}` +
        `  ${maxAbs.toExponential(2).padStart(9)} ${(100 * frac).toFixed(2).padStart(7)}` +
        `  ${same ? '**まったく効いていない**' : '効いている'}`,
    );
  }

  console.log(`\n効いていない候補: ${dead.length} 件`);
  for (const n of dead) console.log(`  ${n}`);
  console.log(
    '\n注意: 2° で判定しているので、**格子依存で 2° だけ効かない機構**は\n' +
      '  見逃す。候補が出たら 1° で確かめること。\n' +
      '  また降水だけを見ているので、**気温にしか効かない定数**も候補に出る。',
  );
}

void main();
