// モデル定数の自動較正(地球を教師データにしたブラックボックス最適化)。
// 実行: npx tsx scripts/optimize.ts --minutes 50 --parallel 3
// 状態は out/optimize/state.json に常時保存され、再実行で続きから回る。
// --parallel N でワーカープロセス N 本の同時評価(既定 1 = 逐次 in-process)。
//
// 目的関数(2026-07-31 に事前凍結 — docs/較正記録.md 参照):
//   fitness = 大分類% + 1.1×地域ゲート数 + 0.25×詳細%
//             − 0.35×気温年RMSE − 0.004×降水年RMSE − 0.02×|陸平均降水−585|/10
// 最終採否は必ず scripts/validate.ts の標準レポートで確認する。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { runPipeline } from '../src/sim/pipeline';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { SPACE, evaluateResult, type Scores } from './optimize_lib';
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
  return v;
}

function loadState(): OptState {
  const existing = loadStateStrict<OptState>(STATE_PATH);
  if (existing) return existing;
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
  close(): void;
}

function sequentialBackend(state: OptState): Backend {
  return {
    async evalBatch(items) {
      const out: Scores[] = [];
      for (const it of items) {
        Object.assign(MODEL_CONSTANTS, it.vector);
        const t0 = Date.now();
        const result = runPipeline(EARTH_PARAMS);
        const s = evaluateResult(result, HOLDOUT_FOLD);
        logEval(state, it.tag, s, (Date.now() - t0) / 1000);
        out.push(s);
      }
      return out;
    },
    close() {},
  };
}

interface WorkerHandle {
  proc: ChildProcess;
  rl: readline.Interface;
  busy: boolean;
}

function poolBackend(state: OptState, n: number): Backend {
  const workers: WorkerHandle[] = [];
  for (let i = 0; i < n; i++) {
    const proc = spawn('npx', ['tsx', 'scripts/optimize_worker.ts'], {
      shell: true,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: process.cwd(),
    });
    const rl = readline.createInterface({ input: proc.stdout! });
    workers.push({ proc, rl, busy: false });
  }
  const runOne = (w: WorkerHandle, tag: string, vector: Record<string, number>): Promise<Scores> =>
    new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        w.rl.off('line', onLine);
        try {
          const msg = JSON.parse(line) as { scores?: Scores; sec?: number; error?: string };
          if (msg.error || !msg.scores) return reject(new Error(msg.error ?? 'no scores'));
          logEval(state, tag, msg.scores, msg.sec ?? 0);
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
    close() {
      for (const w of workers) w.proc.kill();
    },
  };
}

function logEval(state: OptState, tag: string, s: Scores, sec: number): void {
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
    if (!fs.existsSync(metaPath)) {
      let gitCommit = 'unknown';
      let gitDirty = true;
      try {
        gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
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
            gitCommit,
            gitDirty,
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
  const state = loadState();
  initEvalCounter(state);
  const rand = mulberry32(state.seed + state.sweep * 977 + state.evals);
  const backend = parallel > 1 ? poolBackend(state, parallel) : sequentialBackend(state);

  if (state.bestFit === -Infinity) {
    const [s] = await backend.evalBatch([{ tag: 'baseline', vector: state.best }]);
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

  backend.close();
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
