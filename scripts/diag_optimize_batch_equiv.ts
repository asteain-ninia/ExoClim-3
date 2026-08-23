// 同値検証: 較正の並列評価を worker_threads + EBM の GPU バッチへ載せ替えた
// 新経路(scripts/optimize_batch_lib.ts)が、旧経路(子プロセス
// scripts/optimize_worker.ts)と**同じ評価結果**を出すかを確かめる。
//
// 判定(結果を見る前に固定):
//   同じ SPACE・同じ目的関数・同じ出発ベクトル・同じ安い設定(2° 格子)で、
//   `--parallel 3 --max-evals 12` の較正を旧経路・新経路でそれぞれ 1 回ずつ走らせ、
//   `out/optimize/log_<run>.jsonl` の**全評価**の `fit` `major` `detail` `tRmse` が
//   **Object.is の意味で完全一致**すること。CPU 部は f64 の決定的計算、
//   GPU 部は「同じ入力に対する GPU 同士はビット一致」(src/sim/accel.ts の注記)
//   + バッチ版と単発版の同値(scripts/diag_ebm_batch_equiv.ts で受入済み)なので、
//   丸めの許容は置かない。
//
//   **突き合わせは tag ごとの多重集合で行う。** 較正は昔から「先に返った評価から
//   記録する」= 完了順で採番しており、その順序は並列実行のばらつきで変わる
//   (旧経路も走るたびに変わる)。順序は経路の性質ではないので、同じ tag の
//   評価どうしを値で並べ替えて 1 対 1 に突き合わせる。
//
//   種は無い(較正の摂動 rand はスイープの区切りでしか使わず、12 評価の範囲では
//   基準 1 件 + 感度スクリーニングだけ = **完全に決定的**)。
//
// 実行時間も測る(参考値。合否にしない):
//   **他の GPU 作業と並走していれば数字は汚染される。** 走らせる前に確認すること。
//
//   ログの数値は記録のときに丸められている(fit は 1e-3、他は 1e-2)ので、
//   **state_<run>.json の照合も併せて行う**。こちらは bestScores を丸めずに
//   持っており、探索が辿った位置(best ベクトル・感度・カーソル)まで含めて
//   全数値を Object.is で比べられる。ログだけだと丸めの陰に差が隠れる。
//
// 実行: npx tsx scripts/diag_optimize_batch_equiv.ts [--parallel 3] [--max-evals 12]
//   --keep で out/optimize の検証用成果物を消さずに残す。
//   --compare-only で較正を走らせず、残っている成果物の照合だけをやり直す。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const OUT_DIR = path.join(process.cwd(), 'out', 'optimize');

/**
 * **安い設定**(scripts/optimize_cheap.ts)。2° 格子だけを差し替え、EBM の
 * 収束予算は本番のまま(既定)にする。反復や年数まで削ると基準ベクトルが
 * 数値的健全性の関門を落ち、較正が「基準が失格」で即座に止まる(実測:
 * 反復 64・全熱容量 4 年では残差 1.0e-1°C・年次ドリフト 1.05°C で失格)。
 * 2° だけなら 1 評価 104 秒で健全に解ける(実測 2026-08-23)。
 */
const CHEAP_ENV: Record<string, string> = { OPTIMIZE_GRID_DEG: '2' };

interface EvalRec {
  i: number;
  tag: string;
  fit: number;
  major: number;
  detail: number;
  tRmse: number;
  sec: number;
}

/** 比較する列。**ここに挙げた 4 つが受入条件** */
const COLS = ['fit', 'major', 'detail', 'tRmse'] as const;

function argNum(flag: string, dflt: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1] ?? dflt) : dflt;
}

function cleanRun(run: string): void {
  for (const f of [
    `state_${run}.json`,
    `log_${run}.jsonl`,
    `best_${run}.json`,
    `run_${run}.meta.json`,
    `stop_${run}`,
  ]) {
    try {
      fs.unlinkSync(path.join(OUT_DIR, f));
    } catch {
      /* 無ければよい */
    }
  }
}

function readLog(run: string): EvalRec[] {
  const p = path.join(OUT_DIR, `log_${run}.jsonl`);
  const text = fs.readFileSync(p, 'utf8').trimEnd();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line) as EvalRec);
}

interface RunOutcome {
  sec: number;
  /** stderr に出た「[EBMバッチ] N 件…を束ねて実行」の N の内訳 */
  bundles: Map<number, number>;
  code: number;
}

async function runOptimize(
  run: string,
  backend: 'proc' | 'thread',
  parallel: number,
  maxEvals: number,
): Promise<RunOutcome> {
  cleanRun(run);
  const bundles = new Map<number, number>();
  const t0 = performance.now();
  const code = await new Promise<number>((resolve, reject) => {
    const proc = spawn(
      'npx',
      [
        'tsx',
        'scripts/optimize.ts',
        '--run',
        run,
        '--parallel',
        String(parallel),
        '--max-evals',
        String(maxEvals),
        '--minutes',
        '600',
        // 停滞判定は 12 評価では効かないが、明示して差を無くしておく
        '--stall',
        '0',
      ],
      {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: process.cwd(),
        env: { ...process.env, ...CHEAP_ENV, EXOCLIM_OPT_BACKEND: backend },
      },
    );
    const onChunk = (buf: Buffer): void => {
      const text = buf.toString();
      for (const m of text.matchAll(/\[EBMバッチ\] (\d+) 件/g)) {
        const n = Number(m[1]);
        bundles.set(n, (bundles.get(n) ?? 0) + 1);
      }
      process.stderr.write(text);
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('error', reject);
    proc.on('exit', (c) => resolve(c ?? -1));
  });
  return { sec: (performance.now() - t0) / 1000, bundles, code };
}

/**
 * state_<run>.json を丸めなしで比べる(sec のような時間の量は入っていない)。
 * 戻り値は差分の説明。空なら完全一致。
 */
function diffState(a: unknown, b: unknown): string[] {
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, p: string): void => {
    if (typeof x === 'number' && typeof y === 'number') {
      if (!Object.is(x, y)) diffs.push(`${p}: ${x} ≠ ${y}`);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) {
        diffs.push(`${p}: 長さ ${x.length} ≠ ${y.length}`);
        return;
      }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          p ? `${p}.${k}` : k,
        );
      }
      return;
    }
    if (x !== y) diffs.push(`${p}: ${String(x)} ≠ ${String(y)}`);
  };
  walk(a, b, 'state');
  return diffs;
}

function readState(run: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, `state_${run}.json`), 'utf8'));
}

/** tag ごとに、値で並べ替えてから 1 対 1 に突き合わせる */
function groupByTag(recs: EvalRec[]): Map<string, EvalRec[]> {
  const g = new Map<string, EvalRec[]>();
  for (const r of recs) {
    const list = g.get(r.tag);
    if (list) list.push(r);
    else g.set(r.tag, [r]);
  }
  for (const list of g.values()) {
    list.sort((a, b) => {
      for (const c of COLS) {
        if (!Object.is(a[c], b[c])) return a[c] - b[c];
      }
      return 0;
    });
  }
  return g;
}

async function main(): Promise<void> {
  const parallel = Math.max(2, Math.round(argNum('--parallel', 3)));
  const maxEvals = Math.max(1, Math.round(argNum('--max-evals', 12)));
  const keep = process.argv.includes('--keep');
  const compareOnly = process.argv.includes('--compare-only');
  const PROC_RUN = 'equivproc';
  const THREAD_RUN = 'equivthread';

  console.log(
    `同値検証(較正の並列評価): --parallel ${parallel} --max-evals ${maxEvals} / ` +
      `安い設定 ${JSON.stringify(CHEAP_ENV)}`,
  );
  console.log('**他の GPU 作業と並走していれば壁時間の数字は汚染される。**\n');

  let oldRun: RunOutcome = { sec: NaN, bundles: new Map(), code: 0 };
  let newRun: RunOutcome = { sec: NaN, bundles: new Map(), code: 0 };
  if (compareOnly) {
    console.log('(--compare-only: 較正は走らせず、残っている成果物の照合だけをやり直す)\n');
  } else {
    console.log('== 旧経路(子プロセス EXOCLIM_OPT_BACKEND=proc)==');
    oldRun = await runOptimize(PROC_RUN, 'proc', parallel, maxEvals);
    console.log(`壁時間 ${oldRun.sec.toFixed(1)} 秒(終了コード ${oldRun.code})\n`);

    console.log('== 新経路(worker_threads + EBM バッチ)==');
    newRun = await runOptimize(THREAD_RUN, 'thread', parallel, maxEvals);
    console.log(`壁時間 ${newRun.sec.toFixed(1)} 秒(終了コード ${newRun.code})\n`);

    if (oldRun.code !== 0 || newRun.code !== 0) {
      console.log('❌ 較正が正常終了していない。ログを見ること');
      process.exitCode = 1;
      return;
    }
  }

  const oldRecs = readLog(PROC_RUN);
  const newRecs = readLog(THREAD_RUN);
  console.log('== 照合 ==');
  console.log(`評価数: 旧 ${oldRecs.length} / 新 ${newRecs.length}`);
  let ok = oldRecs.length === newRecs.length;
  if (!ok) console.log('❌ 評価数が違う(同じ探索を辿っていない)');

  const oldG = groupByTag(oldRecs);
  const newG = groupByTag(newRecs);
  const tags = [...new Set([...oldG.keys(), ...newG.keys()])].sort();
  let matched = 0;
  for (const tag of tags) {
    const a = oldG.get(tag) ?? [];
    const b = newG.get(tag) ?? [];
    if (a.length !== b.length) {
      ok = false;
      console.log(`  ❌ ${tag}: 件数 ${a.length} ≠ ${b.length}`);
      continue;
    }
    for (let k = 0; k < a.length; k++) {
      const x = a[k]!;
      const y = b[k]!;
      const diffs = COLS.filter((c) => !Object.is(x[c], y[c]));
      const head = `  ${diffs.length === 0 ? '✅' : '❌'} ${tag}[${k}]`;
      console.log(
        `${head} fit=${x.fit} major=${x.major} detail=${x.detail} tRmse=${x.tRmse}` +
          (diffs.length === 0
            ? ` (旧 #${x.i} ${x.sec}s / 新 #${y.i} ${y.sec}s)`
            : ` ≠ ${diffs.map((c) => `${c} ${x[c]} vs ${y[c]}`).join(', ')}`),
      );
      if (diffs.length === 0) matched++;
      else ok = false;
    }
  }

  // ---- state_<run>.json の照合(丸め無しの全数値)----
  console.log('\n== state の照合(丸め無し。bestScores・best ベクトル・感度・カーソル)==');
  const stateDiffs = diffState(readState(PROC_RUN), readState(THREAD_RUN));
  if (stateDiffs.length === 0) {
    console.log('  ✅ 完全一致(bestFit も倍精度のまま同値)');
  } else {
    ok = false;
    console.log(`  ❌ 不一致 ${stateDiffs.length} 件:`);
    for (const d of stateDiffs.slice(0, 20)) console.log(`     ${d}`);
    if (stateDiffs.length > 20) console.log(`     …ほか ${stateDiffs.length - 20} 件`);
  }

  console.log('\n===== まとめ =====');
  console.log(
    `同値: ${ok ? `✅ 全 ${matched} 評価が完全一致` : '❌ 不一致あり — 新経路を直すこと'}`,
  );
  const fmtBundles = (m: Map<number, number>): string =>
    m.size === 0 ? '(EBM バッチの記録なし)' : [...m].map(([n, c]) => `L=${n} が ${c} 回`).join(' / ');
  if (!compareOnly) {
    console.log(`EBM の束ね(新経路): ${fmtBundles(newRun.bundles)}`);
    console.log('壁時間(参考値):');
    console.log(`  旧経路(子プロセス ${parallel} 本) ${oldRun.sec.toFixed(1)} 秒`);
    console.log(
      `  新経路(スレッド ${parallel} + EBMバッチ) ${newRun.sec.toFixed(1)} 秒` +
        `(旧の ${(oldRun.sec / newRun.sec).toFixed(2)} 倍速)`,
    );
  }

  if (!keep) {
    cleanRun(PROC_RUN);
    cleanRun(THREAD_RUN);
  }
  if (!ok) process.exitCode = 1;
}

void main();
