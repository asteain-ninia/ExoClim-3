// モデル定数の自動較正(地球を教師データにしたブラックボックス最適化)。
// 実行: npx tsx scripts/optimize.ts --minutes 50 --parallel 3
// 状態は out/optimize/state.json に常時保存され、再実行で続きから回る。
// --parallel N で N 点の同時評価(既定 1 = 逐次 in-process)。
//
// **並列評価の実行機構(2026-08-23 に載せ替え)**:
//   既定は worker_threads + EBM の GPU バッチ束ね(scripts/optimize_batch_lib.ts)。
//   較正の 1 バッチ(同時 N 点)がそのまま EBM の L=N バッチになる。
//   探索の手順(座標降下・スクリーニング・停滞判定・state 保存・来歴指紋・
//   ログ形式)は一切変えていない — 変えたのは「N 点を評価する機構」だけで、
//   旧経路(子プロセス)との同値は scripts/diag_optimize_batch_equiv.ts で確認する。
//   環境変数 `EXOCLIM_OPT_BACKEND=proc` で旧経路(子プロセス)へ戻せる。
//   EXOCLIM_GPU=0(CPU 経路)のときは主スレッドに GPU が無いので自動で proc になる。
//
// 目的関数(2026-07-31 に事前凍結 — docs/較正記録.md 参照):
//   fitness = 大分類% + 1.1×地域ゲート数 + 0.25×詳細%
//             − 0.35×気温年RMSE − 0.004×降水年RMSE − 0.02×|陸平均降水−585|/10
// 最終採否は必ず scripts/validate.ts の標準レポートで確認する。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as readline from 'node:readline';
import { runPipeline } from '../src/sim/pipeline';
import { openAccel } from './accel_cli';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { releaseGpu } from '../src/sim/gpu/device_node';
import { optimizeCheapNote, optimizeRunParams } from './optimize_cheap';
import { createOptimizeEvalPool, type OptimizeEvalPool } from './optimize_batch_lib';
import {
  SPACE,
  UNSOLVED_FITNESS,
  disqualifyIfUnsound,
  evaluateResult,
  type Scores,
} from './optimize_lib';
import { loadStateStrict, nextEvalNumber, readEvalLog, saveStateAtomic } from './optimize_store';

const OUT_DIR = path.join(process.cwd(), 'out', 'optimize');
fs.mkdirSync(OUT_DIR, { recursive: true });

// P1-1: --holdout-fold N(0〜4)で空間保留検証区画を目的関数から除外する。
// 目的関数が変わるため、状態とログは区画別ファイルに分離し全球版と混ぜない。
const holdoutArgIdx = process.argv.indexOf('--holdout-fold');
const HOLDOUT_FOLD = holdoutArgIdx >= 0 ? Number(process.argv[holdoutArgIdx + 1]) : undefined;
if (
  HOLDOUT_FOLD !== undefined &&
  (!Number.isInteger(HOLDOUT_FOLD) || HOLDOUT_FOLD < 0 || HOLDOUT_FOLD > 4)
) {
  throw new Error(`--holdout-fold は 0〜4 の整数(指定値: ${String(HOLDOUT_FOLD)})`);
}
// --run <名前> で成果物を分離する(既存 v1/v2 の state/log を保護 — FB の
// 「凍結成果物を上書きしない」制約。構造変更後の再較正はこれを使う)
const runIdx = process.argv.indexOf('--run');
const RUN_NAME = runIdx >= 0 ? (process.argv[runIdx + 1] ?? '') : '';
if (RUN_NAME && !/^[a-z0-9][a-z0-9-_]*$/i.test(RUN_NAME)) {
  throw new Error('--run には英数字・ハイフン・下線の名前を指定する');
}
const FILE_SUFFIX =
  (RUN_NAME ? `_${RUN_NAME}` : '') + (HOLDOUT_FOLD === undefined ? '' : `_fold${HOLDOUT_FOLD}`);
const STATE_PATH = path.join(OUT_DIR, `state${FILE_SUFFIX}.json`);
const LOG_PATH = path.join(OUT_DIR, `log${FILE_SUFFIX}.jsonl`);

interface OptState {
  best: Record<string, number>;
  bestFit: number;
  bestScores: Scores | null;
  evals: number;
  sweep: number;
  cursor: number;
  stepFrac: number;
  sensitivity: Record<string, number>;
  phase: 'screen' | 'descent';
  screenCursor: number;
  seed: number;
}

function currentVector(): Record<string, number> {
  const v: Record<string, number> = {};
  for (const [name] of SPACE) v[name] = MODEL_CONSTANTS[name] as number;
  // --seed-file <json>: 新規 run の初期点を constants.ts 既定でなく JSON で与える
  // (2026-08-25、v34 の教訓: 掃引が既に見つけた良点 a=0.6 に較正の降下が
  //  到達できず停滞した。良点を種に再降下させるための入口。**再開時は無視**
  //  される — 初期化のときしか呼ばれない)。SPACE 外のキーは知らない名前として
  //  拒否し、値は範囲へ収める。
  const sfIdx = process.argv.indexOf('--seed-file');
  if (sfIdx >= 0) {
    const p = process.argv[sfIdx + 1];
    if (!p) throw new Error('--seed-file にパスが無い');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number>;
    const seedVec = (raw as { vector?: Record<string, number> }).vector ?? raw;
    for (const [k, val] of Object.entries(seedVec)) {
      if (typeof val !== 'number') continue;
      const spec = SPACE.find(([n]) => n === k);
      if (!spec) throw new Error(`--seed-file に SPACE 外の定数: ${k}`);
      v[k] = Math.min(spec[2], Math.max(spec[1], val));
      // 2026-09-02: 無言のクリップで v43 の両 L が旧下限に張り付いた。必ず告げる
      if (v[k] !== val)
        console.warn(`[較正] 種の ${k}=${val} は範囲 [${spec[1]}, ${spec[2]}] 外 → ${v[k]} へクリップ`);
    }
    console.log(`[較正] 種を --seed-file から読み込み: ${p}(${Object.keys(seedVec).length} 定数)`);
  }
  return v;
}

/**
 * **較正の来歴の指紋(2026-08-16、外部レビューの指摘を受けて)。**
 *
 * 監査(Codex)に「再開時に git commit・目的関数・探索空間・教師データの
 * 一致確認がなく、古い bestFit をそのまま比較基準にする。コード変更をまたいで
 * 再開した場合、**異なる目的関数の数値が同じログに混ざり得る**」と指摘された。
 *
 * 実害は既に近いところまで来ていた — 2026-08-15 に `westerlyWindMs` を
 * 探索空間から外したうえで v23 を回している。あのとき較正中に外していたら、
 * **61 定数の評価と 62 定数の評価が同じログに並んでいた**。
 *
 * 指紋に入れるもの:
 *   - 探索空間(名前・下限・上限の全体)
 *   - 目的関数と採点のソース(optimize_lib.ts / scoring.ts の中身)
 *   - git commit
 * **どれかが変われば別の較正**であり、続きから回してはならない。
 */
function calibrationFingerprint(): { space: string; objective: string; git: string } {
  const hash = (text: string): string =>
    createHash('sha256').update(text).digest('hex').slice(0, 16);
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  // **読めなかったら例外にする。** 空文字を返すと指紋が定数になり、
  // 目的関数が変わっても一致してしまう = 検査が黙って無効化される。
  // 「壊れたら通す」のが、この監査が指摘した型の事故そのものである
  const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
  let git = 'unknown';
  try {
    git = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    /* 架空の値を入れない */
  }
  return {
    space: hash(JSON.stringify(SPACE)),
    objective: hash(read('optimize_lib.ts') + read('scoring.ts')),
    git,
  };
}

function loadState(): OptState {
  const existing = loadStateStrict<OptState>(STATE_PATH);
  if (existing) {
    // **JSON は -Infinity を表せない**(JSON.stringify が null にする)。
    // 状態ファイルを外から作った場合、bestFit が null で読み込まれ、
    // 「基準線をまだ測っていない」判定(=== -Infinity)をすり抜けて
    // 降下へ直行してしまう(2026-08-04 に実際に踏んだ。実害は無かったが、
    // 「基準線を測ってから降下に入る」という設計が一度抜けていた)。
    // 読み込み時にここで戻す。
    if (existing.bestFit === null || existing.bestFit === undefined) {
      existing.bestFit = -Infinity;
      existing.bestScores = null;
    }
    return existing;
  }
  return {
    best: currentVector(),
    bestFit: -Infinity,
    bestScores: null,
    evals: 0,
    sweep: 0,
    cursor: 0,
    stepFrac: 0.18,
    sensitivity: {},
    phase: 'screen',
    screenCursor: 0,
    seed: 42,
  };
}

function saveState(s: OptState): void {
  saveStateAtomic(STATE_PATH, s);
}

// 評価番号の正本はログ(P0-2)。起動時に照合し、必ず最大値 + 1 から採番する
let evalCounter = 0;
function initEvalCounter(state: OptState): void {
  const log = readEvalLog(LOG_PATH);
  for (const w of log.warnings) console.warn(`[optimize] ${w}`);
  evalCounter = nextEvalNumber(state.evals, log.maxEval) - 1;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 評価バックエンド(逐次 or ワーカープール)----
interface Backend {
  evalBatch(vectors: Array<{ tag: string; vector: Record<string, number> }>): Promise<Scores[]>;
  /** 常駐資源(子プロセス / スレッド / GPU)を畳む。**必ず await する**
   *  — スレッド経路はデバイスの破棄まで含むので、待たずに終えると exit 139 */
  close(): Promise<void>;
}

/**
 * 並列評価の実行機構の選択。既定は 'thread'(worker_threads + EBM バッチ)。
 * `EXOCLIM_OPT_BACKEND=proc` で旧経路(子プロセス)へ戻す。
 * EXOCLIM_GPU=0 のときは主スレッドに GPU が無いので thread は成立しない
 * (バッチの束ねは主スレッドの GPU が前提)ため、自動で proc に落とす。
 */
function chooseBackendKind(): 'thread' | 'proc' {
  const want = process.env['EXOCLIM_OPT_BACKEND'];
  if (want === 'proc') return 'proc';
  if (want && want !== 'thread') {
    throw new Error(`EXOCLIM_OPT_BACKEND は thread か proc(指定値: ${want})`);
  }
  if (process.env['EXOCLIM_GPU'] === '0') return 'proc';
  return 'thread';
}

function sequentialBackend(state: OptState): Backend {
  const accelReady = openAccel(true);
  return {
    async evalBatch(items) {
      const accel = await accelReady;
      const out: Scores[] = [];
      for (const it of items) {
        Object.assign(MODEL_CONSTANTS, it.vector);
        const t0 = Date.now();
        const result = await runPipeline(optimizeRunParams(), accel.opts);
        const s = evaluateResult(result, HOLDOUT_FOLD);
        // **逐次経路にも失格の判定を入れる(2026-08-14)。** ここには判定が
        // 1 つも無く、--parallel 1 の較正は数値的に無防備だった。
        if (EBM_SOLVER_STATS.capHits > 0) s.fitness = UNSOLVED_FITNESS;
        disqualifyIfUnsound(s);
        logEval(state, it.tag, s, (Date.now() - t0) / 1000);
        out.push(s);
      }
      return out;
    },
    async close() {
      (await accelReady).close();
    },
  };
}

interface WorkerHandle {
  proc: ChildProcess;
  rl: readline.Interface;
  busy: boolean;
}

/**
 * **旧経路**: 子プロセス N 本の同時評価(2026-08-23 まで既定)。
 * `EXOCLIM_OPT_BACKEND=proc` と EXOCLIM_GPU=0 のときだけ使う。
 * 新経路(threadPoolBackend)との同値は scripts/diag_optimize_batch_equiv.ts。
 */
function procPoolBackend(state: OptState, n: number): Backend {
  const workers: WorkerHandle[] = [];
  for (let i = 0; i < n; i++) {
    // 実行名を引数として渡す(ワーカー本体は使わない)。
    // これはコマンドラインに**目印**を残すためのもの:
    // 較正を止めるとき親だけ殺すと子が生き残って GPU を食い続ける
    // (2026-08-02 に 8 個の孤児が評価速度を 3 倍遅くしていた)。
    // 目印があれば `--run` 名で正確に狙い撃ちできる。
    const proc = spawn(
      'npx',
      ['tsx', 'scripts/optimize_worker.ts', `--marker=${RUN_NAME || 'anon'}`],
      {
        shell: true,
        stdio: ['pipe', 'pipe', 'inherit'],
        cwd: process.cwd(),
      },
    );
    const rl = readline.createInterface({ input: proc.stdout! });
    workers.push({ proc, rl, busy: false });
  }
  const runOne = (w: WorkerHandle, tag: string, vector: Record<string, number>): Promise<Scores> =>
    new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        w.rl.off('line', onLine);
        try {
          const msg = JSON.parse(line) as {
            scores?: Scores;
            sec?: number;
            ebmYears?: number;
            ebmIters?: number;
            error?: string;
          };
          if (msg.error || !msg.scores) return reject(new Error(msg.error ?? 'no scores'));
          logEval(state, tag, msg.scores, msg.sec ?? 0, msg.ebmYears, msg.ebmIters);
          resolve(msg.scores);
        } catch (e) {
          reject(e as Error);
        }
      };
      w.rl.on('line', onLine);
      w.proc.stdin!.write(JSON.stringify({ id: 0, vector, holdoutFold: HOLDOUT_FOLD }) + '\n');
    });
  return {
    async evalBatch(items) {
      const results: Scores[] = new Array(items.length);
      let next = 0;
      const lanes = workers.map(async (w) => {
        while (next < items.length) {
          const idx = next++;
          const it = items[idx];
          if (!it) break;
          results[idx] = await runOne(w, it.tag, it.vector);
        }
      });
      await Promise.all(lanes);
      return results;
    },
    async close() {
      for (const w of workers) w.proc.kill();
    },
  };
}

/**
 * **新経路**: worker_threads N 本 + EBM の GPU バッチ束ね(既定)。
 *
 * 較正の 1 バッチ(同時 N 点)がそのまま EBM の L=N バッチになる。
 * 評価そのものの手順は子プロセス版(optimize_worker.ts)と 1 対 1 で同じ
 * (scripts/optimize_batch_worker.ts)。ログの採番も従来どおり**完了順**。
 *
 * 中断まわりが良くなる副産物: 子プロセスが無いので**孤児が出ない**
 * (2026-08-02 に 8 個の孤児が評価速度を 3 倍遅くした件。stop_optimize.ps1 は
 * 親の `--run <名前>` で狙い撃ちできるので、従来どおり効く)。
 */
function threadPoolBackend(state: OptState, n: number): Backend {
  // プールは**最初の評価のときに立てる**(GPU の取得と tsx のスレッド起動を
  // 較正の準備段階に前倒ししない。来歴の照合で終わる走行があるため)
  let poolReady: Promise<OptimizeEvalPool> | null = null;
  const ensure = (): Promise<OptimizeEvalPool> => (poolReady ??= createOptimizeEvalPool(n));
  return {
    async evalBatch(items) {
      const pool = await ensure();
      const outcomes = await pool.run(
        items.map((it) => ({ tag: it.tag, vector: it.vector, holdoutFold: HOLDOUT_FOLD })),
        // **完了順に記録する**(旧経路は先に返した子から logEval していた)
        (idx, o) => logEval(state, items[idx]!.tag, o.scores, o.sec, o.ebmYears, o.ebmIters),
      );
      return outcomes.map((o) => o.scores);
    },
    async close() {
      // スレッドと GPU 常駐資源を畳んでからデバイスを破棄する(でないと exit 139)
      try {
        if (poolReady) await (await poolReady).close();
      } finally {
        releaseGpu();
      }
    },
  };
}

function logEval(
  state: OptState,
  tag: string,
  s: Scores,
  sec: number,
  ebmYears?: number,
  ebmIters?: number,
): void {
  evalCounter++;
  state.evals = evalCounter;
  fs.appendFileSync(
    LOG_PATH,
    JSON.stringify({
      i: evalCounter,
      ...(HOLDOUT_FOLD !== undefined ? { fold: HOLDOUT_FOLD } : {}),
      tag,
      fit: Math.round(s.fitness * 1000) / 1000,
      major: Math.round(s.majorPct * 100) / 100,
      detail: Math.round(s.detailPct * 100) / 100,
      gates: s.gates,
      tRmse: Math.round(s.tempRmse * 100) / 100,
      pRmse: Math.round(s.precipRmse),
      iRmse: Math.round(s.itczRmse * 100) / 100,
      sec: Math.round(sec * 10) / 10,
      // **失格の理由を必ず残す(2026-08-14)。** 判定条件には、それを機械的に
      // 読み出す出力を対にする。段 20 は「未収束 0」を事前登録しながら、
      // 掃引がその数字を出さないまま判定が素通りした。同じことを繰り返さない。
      // 健全なときは何も足さない(ログを膨らませない)。
      ...(s.numericallySound ? {} : { unsound: s.numericalFailures }),
      // 収束予算(費用の内訳を後から読むため。optimize_worker.ts の注記)
      ...(ebmYears !== undefined ? { ebmYears } : {}),
      ...(ebmIters !== undefined ? { ebmIters } : {}),
    }) + '\n',
  );
}

function clampTo(name: string, v: number): number {
  const spec = SPACE.find(([n]) => n === name);
  if (!spec) return v;
  return Math.min(spec[2], Math.max(spec[1], v));
}

async function main(): Promise<void> {
  const arg = (flag: string, dflt: number) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? Number(process.argv[i + 1] ?? dflt) : dflt;
  };
  // run メタ(第四 FB P1): チャートが系列を自動認識できるようにする。
  // run ごとにチャートのコードへ系列を足し続けない
  if (RUN_NAME) {
    const metaPath = path.join(OUT_DIR, `run_${RUN_NAME}.meta.json`);
    const fp = calibrationFingerprint();
    // **続きから回すなら、来歴が一致していなければならない(2026-08-16)。**
    // 探索空間か目的関数が変わっていれば、それは**別の較正**である。
    // 混ぜると「異なる目的関数の数値が同じログに並ぶ」(外部レビューの指摘)
    if (fs.existsSync(metaPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
          fingerprint?: { space?: string; objective?: string };
        };
        const p = prev.fingerprint;
        if (p && (p.space !== fp.space || p.objective !== fp.objective)) {
          console.error(
            [
              `[較正] **来歴が一致しないので再開を拒否する**(run=${RUN_NAME})`,
              `  探索空間 ${p.space} → ${fp.space}`,
              `  目的関数 ${p.objective} → ${fp.objective}`,
              '  探索空間か目的関数が変わっている。これは別の較正である。',
              '  続けたいなら --run に新しい名前を付けること。',
            ].join('\n'),
          );
          process.exit(2);
        }
        if (!p) {
          console.warn(
            `[較正] 警告: run_${RUN_NAME}.meta.json に来歴の指紋が無い` +
              '(2026-08-16 より前に始めた較正)。一致は確かめられない。',
          );
        }
      } catch {
        /* メタが壊れているときは黙って進めない — 下で上書きしない */
      }
    }
    if (!fs.existsSync(metaPath)) {
      let gitDirty = true;
      try {
        gitDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
      } catch {
        /* 架空の値を入れない */
      }
      fs.writeFileSync(
        metaPath,
        JSON.stringify(
          {
            runName: RUN_NAME,
            label: RUN_NAME,
            objectiveBasis: 'v2_itcz',
            gitCommit: fp.git,
            gitDirty,
            /** 探索空間・目的関数・git の指紋。再開時に照合する */
            fingerprint: fp,
            startedAt: new Date().toISOString(),
            holdoutFold: HOLDOUT_FOLD ?? null,
          },
          null,
          2,
        ),
      );
    }
  }
  const budgetMin = arg('--minutes', 45);
  const parallel = Math.max(1, Math.round(arg('--parallel', 1)));
  const deadline = Date.now() + budgetMin * 60_000;
  /**
   * **停滞での自動終了**(2026-08-13 追加)。最良が この回数だけ連続で
   * 更新されなければ、時間が残っていても終わる。
   *
   * なぜ要るか: 終了条件が時間だけだったので、頭打ちになった探索に GPU を
   * 使い続けていた。2026-08-13 の v22 は 421 評価で最良に達したあと
   * 618 評価まで 1 度も更新せずに回り続けた。
   *
   * **124 の根拠は過去のログの再生**(新しい実験はしていない):
   *   v22（618 評価、最終 85.259）
   *     N=60  → 評価 248 で停止、最良 85.048（**0.211 損**。攻めすぎ）
   *     N=124 → 評価 543 で停止、最良 85.259（**損失ゼロ**、75 評価を節約）
   *     N=200 → 停止せず
   *   v20（586 評価、最終 84.437）
   *     N=60〜300 いずれも停止せず（**最後まで伸びていたので止めないのが正解**）
   *
   * 124 = 探索空間 62 定数 × 2 方向 = 座標降下のスイープ 1 周。
   * **これより短くしてはいけない**: 座標降下は谷を渡れないので、
   * 停滞してから摂動で抜けることがある(教訓 §9)。スイープ 1 周ぶんは
   * 待たないと、抜けられたはずの谷を捨てる。N=60 の 0.211 損はまさにこれ。
   */
  const stallLimit = Math.max(0, Math.round(arg('--stall', 124)));
  /**
   * **評価数の上限**(既定 0 = 無制限。2026-08-23 追加)。
   * 探索の中身には一切効かない — 停止ファイルと同じ「バッチの切れ目で抜ける」
   * 判定をもう一つ足しただけである。旧経路と新経路を**同じ評価数で**比べる
   * (scripts/diag_optimize_batch_equiv.ts)ために要る。時間で切ると経路の
   * 速さの差がそのまま評価数の差になり、ログを突き合わせられない。
   */
  const maxEvals = Math.max(0, Math.round(arg('--max-evals', 0)));
  /** 最良を最後に更新した評価番号。**再開時はその時点から数え直す**
   *  (前回の走行での停滞をこの走行へ持ち込まない) */
  let lastBestEvalNo = 0;
  let lastBestFit = -Infinity;
  const state = loadState();
  initEvalCounter(state);
  const rand = mulberry32(state.seed + state.sweep * 977 + state.evals);
  // 検証専用の安い設定が効いていたら**必ず表に出す**(本番の較正と取り違えない)
  const cheap = optimizeCheapNote();
  if (cheap) console.log(`[較正] **検証専用の安い設定が効いている**: ${cheap}`);
  const backendKind = chooseBackendKind();
  if (parallel > 1) console.log(`[較正] 並列評価の機構: ${backendKind}(並列 ${parallel})`);
  const backend =
    parallel > 1
      ? backendKind === 'thread'
        ? threadPoolBackend(state, parallel)
        : procPoolBackend(state, parallel)
      : sequentialBackend(state);

  if (state.bestFit === -Infinity) {
    const [s] = await backend.evalBatch([{ tag: 'baseline', vector: state.best }]);
    // **出発点が解けないなら、そこから先は全部無駄**(2026-08-11 に実害)。
    // 温間開始の年数を短くした変更が較正の「倍化しない」設定と噛み合わず、
    // 周期定常に届かず全評価が失格になった。それに気づいたのは 7 評価
    // (35 分)後で、放っておけば 10 時間まるごと捨てていた。
    // 基準が失格なら**即座に止める**。較正の失格は定数ベクトルの問題だが、
    // 基準ベクトルの失格は**実装か設定の問題**なので、探索を続けても直らない。
    if (s && s.fitness <= UNSOLVED_FITNESS) {
      throw new Error(
        '基準ベクトルが失格した(予算内で収束していない)。' +
          '定数ではなく実装か収束予算の設定を疑うこと。' +
          `大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} まで出ているので、` +
          '計算そのものは走っている。out/optimize/log の ebmYears・ebmIters を見ること',
      );
    }
    if (s) {
      state.bestFit = s.fitness;
      state.bestScores = s;
    }
    saveState(state);
  }

  const accept = (cand: Record<string, number>, s: Scores): boolean => {
    if (s.fitness > state.bestFit) {
      state.best = cand;
      state.bestFit = s.fitness;
      state.bestScores = s;
      return true;
    }
    return false;
  };

  while (Date.now() < deadline) {
    // 停止ファイルによる**行儀のよい停止**(2026-08-04 追加)。
    // out/optimize/stop_<run> を置くと、次のバッチへ入らずに抜ける。
    // プロセスを殺すと実行中のバッチ(評価 2 件、実時間 10 分ぶん)が失われるので、
    // 待てるときはこちらを使う。**この判定はバッチの切れ目にしか無い**ので、
    // 置いてから実際に止まるまで最大 1 バッチぶんかかる
    if (RUN_NAME && fs.existsSync(path.join(OUT_DIR, `stop_${RUN_NAME}`))) {
      console.log(`停止ファイルを検知したので、バッチの切れ目で終了します`);
      try {
        fs.unlinkSync(path.join(OUT_DIR, `stop_${RUN_NAME}`));
      } catch {
        /* 消せなくても止まることを優先する */
      }
      break;
    }

    // 評価数の上限(--max-evals)。停止ファイルと同じくバッチの切れ目でだけ見る
    if (maxEvals > 0 && state.evals >= maxEvals) {
      console.log(`評価数の上限に達したので終了します(${state.evals} 評価 / 上限 ${maxEvals})`);
      break;
    }

    // 停滞での自動終了。**感度スクリーニングの間は数えない** — あの段階は
    // 最良を更新するのが目的ではなく、感度を測るために全定数を 1 度ずつ
    // 振る工程だからである(更新しないのが正常)
    if (stallLimit > 0 && state.phase === 'descent') {
      if (state.bestFit > lastBestFit) {
        lastBestFit = state.bestFit;
        lastBestEvalNo = state.evals;
      }
      const evalsSinceBest = state.evals - lastBestEvalNo;
      if (evalsSinceBest >= stallLimit) {
        console.log(
          `停滞で終了: 最良 ${state.bestFit.toFixed(3)} が ${evalsSinceBest} 評価` +
            `連続で更新されていない(上限 ${stallLimit})。時間は ` +
            `${Math.round((deadline - Date.now()) / 60_000)} 分残っている`,
        );
        break;
      }
    }

    if (state.phase === 'screen') {
      if (state.screenCursor >= SPACE.length) {
        state.phase = 'descent';
        saveState(state);
        continue;
      }
      // 並列幅ぶんの定数をまとめて ± スクリーニング(基準は固定 → 完全並列可)
      const batchParams = SPACE.slice(
        state.screenCursor,
        state.screenCursor + Math.max(1, Math.ceil(parallel / 2)),
      );
      const items: Array<{ tag: string; vector: Record<string, number>; name: string }> = [];
      for (const [name, lo, hi] of batchParams) {
        const base = state.best[name] ?? 0;
        const span = hi - lo;
        for (const dir of [-1, 1]) {
          const v = clampTo(name, base + dir * span * 0.08);
          if (v === base) continue;
          items.push({ tag: `screen:${name}`, vector: { ...state.best, [name]: v }, name });
        }
      }
      const scores = await backend.evalBatch(items);
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        const s = scores[k];
        if (!it || !s) continue;
        state.sensitivity[it.name] = Math.max(
          state.sensitivity[it.name] ?? 0,
          Math.abs(s.fitness - state.bestFit),
        );
        accept(it.vector, s);
      }
      state.screenCursor += batchParams.length;
      saveState(state);
      continue;
    }

    // 座標降下: 感度順。並列時は複数座標の ± を同時評価し、最良の 1 改善を採用
    const order = [...SPACE].sort(
      (a, b) => (state.sensitivity[b[0]] ?? 0) - (state.sensitivity[a[0]] ?? 0),
    );
    if (state.cursor >= order.length) {
      state.cursor = 0;
      state.sweep++;
      state.stepFrac = Math.max(0.04, state.stepFrac * 0.6);
      const top = order.slice(0, 4);
      const jitter = { ...state.best };
      for (const [name, lo, hi] of top) {
        const span = hi - lo;
        jitter[name] = Math.min(
          hi,
          Math.max(lo, (jitter[name] ?? 0) + (rand() - 0.5) * span * 0.1),
        );
      }
      const [s] = await backend.evalBatch([{ tag: `jitter:sweep${state.sweep}`, vector: jitter }]);
      if (s) accept(jitter, s);

      // ---- 対の探索(2026-08-04 追加)----
      // **座標降下は谷を渡れない**。2 つの定数が互いに補償し合う関係にあると、
      // 片方だけ動かすと必ず悪化するので、両方が動かないところで止まる。
      // 実例: 陸の熱容量と東西移流結合。移流結合が実効減衰を支配しているため
      // 熱容量は単独ではほぼ効かず(ωτ ≈ 0.009)、較正は熱容量を探索下限に
      // 張り付かせたまま年較差 RMSE を 9.8 で固着させていた
      // (docs/実験記録_年較差の季節分解_2026-08-03.md)。
      //
      // そこでスイープの区切りごとに、感度上位の定数の**対角方向**を試す。
      // 逆対角(片方を上げ片方を下げる)を先に見るのは、補償関係の谷が
      // そこに走るため。同符号の対角は単独の連続移動でも部分的に届く。
      const pairTop = order.slice(0, 3);
      const pairItems: Array<{ tag: string; vector: Record<string, number> }> = [];
      for (let a = 0; a < pairTop.length; a++) {
        for (let b = a + 1; b < pairTop.length; b++) {
          const pa = pairTop[a];
          const pb = pairTop[b];
          if (!pa || !pb) continue;
          const [na, loA, hiA] = pa;
          const [nb, loB, hiB] = pb;
          const stepA = (hiA - loA) * state.stepFrac;
          const stepB = (hiB - loB) * state.stepFrac;
          for (const [da, db] of [
            [1, -1],
            [-1, 1],
          ] as const) {
            const va = clampTo(na, (state.best[na] ?? 0) + da * stepA);
            const vb = clampTo(nb, (state.best[nb] ?? 0) + db * stepB);
            if (va === state.best[na] && vb === state.best[nb]) continue;
            pairItems.push({
              tag: `pair:s${state.sweep}:${na}+${nb}`,
              vector: { ...state.best, [na]: va, [nb]: vb },
            });
          }
        }
      }
      if (pairItems.length > 0) {
        const pairScores = await backend.evalBatch(pairItems);
        let bi = -1;
        let bv = state.bestFit;
        for (let k = 0; k < pairItems.length; k++) {
          const ps = pairScores[k];
          if (ps && ps.fitness > bv) {
            bv = ps.fitness;
            bi = k;
          }
        }
        if (bi >= 0) {
          const it = pairItems[bi];
          const ps = pairScores[bi];
          if (it && ps) accept(it.vector, ps);
        }
      }
      saveState(state);
      continue;
    }
    const width = Math.max(1, Math.ceil(parallel / 2));
    const coords = order.slice(state.cursor, state.cursor + width);
    const items: Array<{ tag: string; vector: Record<string, number> }> = [];
    for (const [name, lo, hi] of coords) {
      const base = state.best[name] ?? 0;
      const span = hi - lo;
      for (const dir of [1, -1]) {
        const v = clampTo(name, base + dir * span * state.stepFrac);
        if (v === base) continue;
        items.push({
          tag: `descent:s${state.sweep}:${name}`,
          vector: { ...state.best, [name]: v },
        });
      }
    }
    const scores = await backend.evalBatch(items);
    // 最良の 1 件だけ採用(同時採用は相互作用未検証のため)
    let bestIdx = -1;
    let bestVal = state.bestFit;
    for (let k = 0; k < items.length; k++) {
      const s = scores[k];
      if (s && s.fitness > bestVal) {
        bestVal = s.fitness;
        bestIdx = k;
      }
    }
    if (bestIdx >= 0) {
      const it = items[bestIdx];
      const s = scores[bestIdx];
      if (it && s) accept(it.vector, s);
    }
    state.cursor += coords.length;
    saveState(state);
  }

  await backend.close();
  saveState(state);
  const b = state.bestScores;
  console.log(
    `終了: evals=${state.evals} sweep=${state.sweep} phase=${state.phase} ` +
      `best fit=${state.bestFit.toFixed(2)}` +
      (b
        ? ` 大分類=${b.majorPct.toFixed(2)} 詳細=${b.detailPct.toFixed(2)} ゲート=${b.gates} 気温RMSE=${b.tempRmse.toFixed(2)}`
        : ''),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, `best${FILE_SUFFIX}.json`),
    JSON.stringify(state.best, null, 2),
  );
}

void main();
