// 実験: EBM のウォームスタートは、答えを変えずにどれだけ速いか。
//
// 対応 spec: docs/spec/05_気温.md。
//
// なぜやるか: 1 評価 500 秒のうち **97.9% が EBM の時間積分**
// (scripts/prof_stage_cost.ts の実測)。較正が数百評価を要する以上、
// ここが全部を律速している。既に外挿・線緩和・熱容量の付け替えは実測で棄却済みで、
// **残っている大きなレバーはウォームスタートと多重格子の 2 つだけ**。
//
// 前提は実証済み: 同じパラメータを別プロセス・別予算(24年/512反復 と
// 48年/1024反復)で回して v3=85.666 が完全一致した(2026-08-04、
// scripts/diag_hint_ratchet.ts)。**答えは収束条件で決まり、出発点に依らない。**
//
// 何を測るか: 較正と同じ形 — **近いパラメータを次々に評価**する列を作り、
// ウォームスタートあり/なしで所要時間と成績を比べる。
//
// **事前に登録する判定**:
//   正しさ … 各評価の v3 の差が **0.01 以下**、大分類・詳細の差が **0.05pt 以下**。
//     (厳密一致が理想だが、周期定常の許容差 0.05°C ぶんの揺れは許す。
//      これを超えるなら収束条件が甘いということなので、速度より先にそこを直す)
//   速さ  … 2 件目以降の平均所要時間が **有意に短い**(2 割以上)。
//     1 件目は前の場が無いので同じはず — そこが縮んでいたら計測が壊れている。
//   棄却 … 差が上の範囲を超える / 速くならない。
//
// 実行: npx tsx scripts/exp_warm_start.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { SPACE, evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';

const PARAM_PATH = process.argv[2];
/** 較正の降下と同じ幅で動かす(実運用に近い列を作る) */
const STEP_FRAC = 0.12;
const N_EVALS = 5;

async function main(): Promise<void> {
  const target = MODEL_CONSTANTS as unknown as Record<string, number>;
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`出発点: ${PARAM_PATH}`);
  }
  const base: Record<string, number> = {};
  for (const [name] of SPACE) base[name] = target[name] ?? 0;

  // 較正の降下と同じ形の列: 感度の高そうな定数を 1 つずつ少し動かす
  const moves = SPACE.slice(0, N_EVALS).map(([name, lo, hi]) => ({
    name,
    value: Math.min(hi, Math.max(lo, (base[name] ?? 0) + (hi - lo) * STEP_FRAC)),
  }));

  for (const warm of [false, true] as const) {
    console.log(`\n===== ウォームスタート ${warm ? 'あり' : 'なし'} =====`);
    const box: { field: Float32Array | null } = { field: null };
    const accel = await openAccel();
    try {
      for (let i = 0; i < moves.length; i++) {
        const mv = moves[i]!;
        for (const [k, v] of Object.entries(base)) target[k] = v;
        target[mv.name] = mv.value;
        EBM_SOLVER_STATS.fullCapacityYears = 0;
        EBM_SOLVER_STATS.maxSweeps = 0;
        const t0 = Date.now();
        const result = await runPipeline(EARTH_PARAMS, {
          ...accel.opts,
          ...(warm ? { ebmWarmStart: box } : {}),
        });
        const s = evaluateResult(result);
        const sec = (Date.now() - t0) / 1000;
        console.log(
          `  ${String(i + 1).padStart(2)} ${mv.name.padEnd(24)} ` +
            `v3=${s.fitness.toFixed(4)} 大分類=${s.majorPct.toFixed(3)} 詳細=${s.detailPct.toFixed(3)} ` +
            `年数=${EBM_SOLVER_STATS.fullCapacityYears} 反復=${EBM_SOLVER_STATS.maxSweeps} ` +
            `${sec.toFixed(0)}s`,
        );
      }
    } finally {
      accel.close();
    }
  }
  console.log(
    '\n判定: v3 の差 ≤ 0.01 かつ 大分類/詳細の差 ≤ 0.05pt で「答えは同じ」。' +
      '\n      2 件目以降が 2 割以上速ければ採用。1 件目が縮んでいたら計測が壊れている。',
  );
}

void main();
