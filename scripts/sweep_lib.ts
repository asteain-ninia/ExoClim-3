// 掃引(定数を 1 つ振って各水準を測る)の共通部。
//
// なぜ分けたか(2026-08-15):
//   `exp_pressure_lever.ts` は水準を**直列**に回しており、24 コアのうち
//   実測 0.99 コア(全体の 4%)しか使っていなかった。較正は `--parallel 6` で
//   回すのに掃引だけ直列で、1 水準 150〜1300 秒 × 水準数を素で待っていた。
//   利用者が「CPU と GPU の負荷が低い」と気づいて発覚
//   (docs/引き継ぎ_2026-08-14.md §5)。
//
//   水準どうしは**完全に独立**である(パイプラインは入口で
//   `resetEbmSolverStats` / `resetConservativeStats` を呼ぶので、
//   同一プロセスの直列実行でも水準間の漏れは無い)。
//   したがって別プロセスへ分けても答えは変わらない。むしろプロセスが
//   分かれるぶん、可変状態の漏れに対しては**直列より強い**。
//
// 測る側(`measureLevel`)と印字する側(`formatLevel`)を分けてあるのは、
// 測定がワーカープロセスで走り、印字が親プロセスで走るため。
// **両者のあいだを通るのは JSON にできる数値だけ**にしてある。

import { performance } from 'node:perf_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { openAccel } from './accel_cli';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs, REGION_GATES, scoreRegionGates } from './scoring';
import {
  COND_RATE_NORMALIZE,
  CONSERVATIVE_STATS,
  CONVERGENCE_SMOOTH,
  CRH_INNER,
  STORM_DIFFUSION,
} from '../src/sim/step06_precipitation';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import type { RunOptions } from '../src/sim/accel';
import type { PipelineResult } from '../src/sim/types';

// **CRH を輸送の内部で解くか(段 25)を環境変数で切り替える。**
// `CRH_INNER=1` で有効。ここに置くと `measureLevel` を使う全経路
// (ワーカーも直列も)に効く。既定は従来どおり外側で代入する。
// 鋭さ 0 では CRH が恒等的に 1 なので、どちらでも答えは同じ。
if (process.env['CRH_INNER'] === '1') CRH_INNER.enabled = true;
// 段 28: 地形性上昇を面積平均 1 へ正規化する
if (process.env['COND_RATE_NORMALIZE'] === '1') COND_RATE_NORMALIZE.enabled = true;
// 段 30: 収束を作るときの供給場の平滑幅（度）。0 = 既定 1.5
if (process.env['CONVERGENCE_SMOOTH_DEG']) {
  CONVERGENCE_SMOOTH.deg = Number(process.env['CONVERGENCE_SMOOTH_DEG']);
}
// 段 36: ストーム混合を拡散の場として繋ぐ強さ（0 = 無効）
if (process.env['STORM_DIFFUSION_BOOST']) {
  STORM_DIFFUSION.boost = Number(process.env['STORM_DIFFUSION_BOOST']);
}

/**
 * **掃引の全水準に共通で掛ける定数の上書き**(2026-08-16)。
 * `SWEEP_OVERRIDE='westerlyWindMs=12,tradeWindMs=7'` のように指定する。
 *
 * なぜ要るか: 2026-08-16 に「渦拡散は移流が担うべき輸送を代行していた」と
 * 分かった。単独の掃引では**組で打つ手**を測れない
 * (拡散を下げると内陸が乾くので、下げたぶんを移流で補えるかを見たい)。
 *
 * **ここはトップレベルなのでワーカー側でも実行される。**
 * 親だけに掛けると答えが変わる — 2026-08-15 に `EBM_SOLVER.adaptive` を
 * ワーカーへ写し間違えて v3 が 0.024〜0.057 ずれた前科がある。
 */
export const SWEEP_OVERRIDES: Array<[string, number]> = [];
if (process.env['SWEEP_OVERRIDE']) {
  const K0 = MODEL_CONSTANTS as unknown as Record<string, number>;
  for (const part of process.env['SWEEP_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    // **知らない名前を黙って無視しない。** 綴り違いが「効かない実験」になる
    if (!key || !(key in K0)) throw new Error(`SWEEP_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`SWEEP_OVERRIDE: '${key}' の値が数値でない`);
    K0[key] = v;
    SWEEP_OVERRIDES.push([key, v]);
  }
}

/** 既定で見る地域。未達 3 件 + 対照 2 件 */
export const DEFAULT_TARGETS = [
  'india_tropical',
  'us_southeast_humid',
  'east_asia_humid',
  'congo_tropical',
  'europe_russia_continental',
];

/**
 * 見る地域を決める。**判定に要る地域は、測る前に足しておくこと。**
 * 段 10 で「降らせる側の機構を運ぶ側の物差しだけで判定して、何が起きたか
 * 分からなくなった」失敗をした。環境変数 `LEVER_TARGETS`(カンマ区切りの
 * ゲート id)で差し替えられる。
 */
export function resolveTargets(): string[] {
  const t = (process.env['LEVER_TARGETS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return t.length > 0 ? t : DEFAULT_TARGETS.slice();
}

/** 1 水準の測定結果。**JSON にできる値だけ**(ワーカーとの境界を通る) */
export interface LevelReport {
  key: string;
  value: number;
  sec: number;
  /** 全球の可降水量 W(mm)。実物は約 25mm */
  waterMm: number;
  fitness: number;
  majorPct: number;
  detailPct: number;
  gates: number;
  precipPhaseRmseDays: number;
  tempRmseC: number;
  targets: Array<{
    id: string;
    /** 夏の正味流入 P − E(mm/年) */
    netInflowMm: number;
    /** 年降水／観測。観測が引けない地域は null */
    obsRatio: number | null;
  }>;
  /**
   * **乾いた端の分位**(南極 60S 以南を除く陸、面積重みつき、mm/年)。
   *
   * 2026-08-15 に、モデルは「本当に乾いた場所」を作れないと分かった
   * (docs/診断_乾いた端が作れない_2026-08-15.md)。1% 分位はモデル 64mm に対し
   * 観測 9mm、5% は 88 対 47。一方で中位は乾かしすぎ(50% で 468 対 593)。
   * **降水を配り直す機構は、この 3 点を見ないと効いたかどうか分からない。**
   * 事前登録の条件には、それを機械的に読み出す出力を対にすること(教訓 §9)。
   */
  dryTail: { p01: number; p05: number; p50: number; obsP01: number; obsP05: number; obsP50: number };
  /**
   * **分布形の誤差**(2026-08-16 に目的関数 v4 へ入った量)。
   * 年降水の分位 8 点 {1,5,10,25,50,75,90,99}% の平均対数誤差。
   * `dryTail` は 3 点しか見ないが、こちらは**湿った端まで含めて**測る。
   * 2026-08-16 に、分布は乾いた端が過剰(7.11 倍)で湿った端が不足(0.89 倍)、
   * つまり**両端が潰れている**と分かった。片側だけ見ると読み違える。
   */
  quantileLogErr: number;
  /** 分位の内訳 [分位%, モデル mm, 観測 mm] */
  quantiles: Array<[number, number, number]>;
  /**
   * ゲート項を除いた連続部分。**目的関数の版をまたいで比べられる唯一の量**。
   * 掃引は目的関数の外側で機構を理解するための測定なので、
   * fitness の絶対値ではなくこちらで比べる。
   */
  continuousV3: number;
  /** 期待する気候帯の面積割合の和(0〜17、連続版ゲート) */
  gateShare: number;
  /** 輸送の未収束月数 */
  transportNonConverged: number;
  virgaNonConverged: number;
  worstResidual: number;
  transportIterations: number;
  coupling: {
    converged: boolean;
    iterations: number;
    maxIterations: number;
    finalResidualMmPerMonth: number;
    toleranceMmPerMonth: number;
  };
  soil: { converged: boolean; meanAnnualDriftMm: number; maxAnnualDriftMm: number } | null;
  ebmCapHits: number;
  ebmMaxResidualC: number;
}

/** 地域の陸セル(格子番号) */
function regionCells(r: PipelineResult, id: string): number[] {
  const gate = REGION_GATES.find((g) => g.id === id);
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  const out: number[] = [];
  if (!gate) return out;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < gate.latMin || lat > gate.latMax) continue;
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      const i = row * grid.widthCells + col;
      if (land[i]) out.push(i);
    }
  }
  return out;
}

/** 月群の面積重み平均(mm/年 換算) */
function meanRate(
  r: PipelineResult,
  monthly: Float32Array[] | undefined,
  cells: number[],
  months: number[],
): number {
  if (!monthly) return 0;
  const grid = r.context.grid;
  let s = 0;
  let w = 0;
  for (const i of cells) {
    const cw = Math.cos((latDegOfRow(grid, Math.floor(i / grid.widthCells)) * Math.PI) / 180);
    let sum = 0;
    for (const m of months) sum += monthly[m]?.[i] ?? 0;
    s += cw * sum * (MONTHS_PER_YEAR / months.length);
    w += cw;
  }
  return s / Math.max(1e-9, w);
}

/**
 * 地域の年降水を観測比で返す(1.00 = 観測どおり)。
 * **運ぶ機構は正味流入、降らせる機構は降水そのもので判定する。**
 * 観測は 2° の気候値なので最近傍で引く
 */
function regionPrecipRatio(r: PipelineResult, cells: number[]): number | null {
  const grid = r.context.grid;
  const clim = getClimObs();
  let mp = 0;
  let op = 0;
  let w = 0;
  for (const i of cells) {
    const row = Math.floor(i / grid.widthCells);
    const col = i % grid.widthCells;
    const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
    const ci = cr * clim.widthCells + cc;
    let o = 0;
    let bad = false;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const v = clim.monthlyPrecipitationMm[m]?.[ci];
      if (v === undefined || v <= -9000) {
        bad = true;
        break;
      }
      o += v;
    }
    if (bad) continue;
    let p = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
    mp += cw * p;
    op += cw * o;
    w += cw;
  }
  if (w <= 0 || op <= 0) return null;
  return mp / op;
}

/**
 * 乾いた端の分位を採る(南極 60S 以南を除く陸、面積重みつき)。
 *
 * **重みと南極の扱いを外さないこと。** 1° 格子では南極が陸セルの 28.3% を
 * 占めるが面積では 9.5% で、重み無しだと極が分位を買い占める。
 * 南極は観測もモデルも一律 EF なので、降水が 30 倍外れても成績に出ない
 * (2026-08-15 に自分で踏んだ。docs/教訓.md §9)。
 */
function dryTailOf(r: PipelineResult): LevelReport['dryTail'] {
  const grid = r.context.grid;
  const clim = getClimObs();
  const land = r.context.terrain.landMask;
  const model: Array<[number, number]> = [];
  const obs: Array<[number, number]> = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat <= -60) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!land[i]) continue;
      const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
      const ci = cr * clim.widthCells + cc;
      let o = 0;
      let bad = false;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci];
        if (v === undefined || v <= -9000) {
          bad = true;
          break;
        }
        o += v;
      }
      if (bad) continue;
      let p = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
      model.push([p, cw]);
      obs.push([o, cw]);
    }
  }
  const q = (pairs: Array<[number, number]>, p: number): number => {
    const a = [...pairs].sort((x, y) => x[0] - y[0]);
    const total = a.reduce((s, [, w]) => s + w, 0);
    let acc = 0;
    for (const [v, w] of a) {
      acc += w;
      if (acc >= p * total) return v;
    }
    return a[a.length - 1]?.[0] ?? 0;
  };
  return {
    p01: q(model, 0.01),
    p05: q(model, 0.05),
    p50: q(model, 0.5),
    obsP01: q(obs, 0.01),
    obsP05: q(obs, 0.05),
    obsP50: q(obs, 0.5),
  };
}

/**
 * 1 水準を測る。**呼ぶ側は定数を戻す責任を持つ**(ワーカーは 1 プロセス
 * 1 水準なので戻す必要がない。同一プロセスで続けて呼ぶ側は戻すこと)。
 */
export async function measureLevel(
  key: string,
  value: number,
  targets: string[],
  opts: RunOptions,
): Promise<LevelReport> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  K[key] = value;
  const t0 = performance.now();
  const r = await runPipeline(EARTH_PARAMS, opts);
  const sec = (performance.now() - t0) / 1000;

  const s = evaluateResult(r);
  const f = fieldScore(r, getClimObs());
  const gates = scoreRegionGates(r).filter((g) => g.pass).length;

  const rows: LevelReport['targets'] = [];
  for (const id of targets) {
    const cells = regionCells(r, id);
    const gate = REGION_GATES.find((g) => g.id === id);
    const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
    const summer = north ? [5, 6, 7] : [11, 0, 1];
    const p = meanRate(r, r.precipitation.monthlyPrecipMm, cells, summer);
    const e = meanRate(r, r.precipitation.land?.monthlyEtMm, cells, summer);
    // **降水そのものも観測比で出す**(2026-08-11)。段 10 で「降らせる側の機構を
    // 運ぶ側の物差し(正味流入)だけで判定して、何が起きたか分からなくなった」反省。
    rows.push({ id, netInflowMm: p - e, obsRatio: regionPrecipRatio(r, cells) });
  }

  const cp = r.precipitation.coupling;
  const soil = r.precipitation.soil;
  return {
    key,
    value,
    sec,
    waterMm: CONSERVATIVE_STATS.meanWaterMm / Math.max(1, CONSERVATIVE_STATS.waterSamples),
    fitness: s.fitness,
    majorPct: s.majorPct,
    detailPct: s.detailPct,
    gates,
    precipPhaseRmseDays: f.precipPhaseRmseDays,
    tempRmseC: f.tempRmseC,
    targets: rows,
    dryTail: dryTailOf(r),
    quantileLogErr: f.precipQuantileLogErr,
    quantiles: f.precipQuantiles,
    continuousV3: s.continuousV3,
    gateShare: s.gateShare,
    transportNonConverged: CONSERVATIVE_STATS.nonConverged,
    virgaNonConverged: CONSERVATIVE_STATS.virgaNonConverged,
    worstResidual: CONSERVATIVE_STATS.worstResidual,
    transportIterations: CONSERVATIVE_STATS.iterations,
    coupling: {
      converged: cp.converged,
      iterations: cp.iterations,
      maxIterations: cp.maxIterations,
      finalResidualMmPerMonth: cp.finalResidualMmPerMonth,
      toleranceMmPerMonth: cp.toleranceMmPerMonth,
    },
    soil: soil
      ? {
          converged: soil.converged,
          meanAnnualDriftMm: soil.meanAnnualStorageDriftMm,
          maxAnnualDriftMm: soil.maxAnnualStorageDriftMm,
        }
      : null,
    ebmCapHits: EBM_SOLVER_STATS.capHits,
    ebmMaxResidualC: EBM_SOLVER_STATS.maxResidualC,
  };
}

/**
 * 掃引の並列度を決める。`--parallel N` が最優先、次に環境変数
 * `SWEEP_PARALLEL`、既定は**水準数と 4 の小さいほう**。
 *
 * **4 という数と、期待していい速さ(2026-08-15 の実測)**:
 *
 * ```
 * 1 水準を単独で       146〜149 秒
 * 2 水準を並列度 2 で  208〜222 秒/水準  → 全体 222 秒（直列 295 秒の 1.33 倍速）
 * 4 水準を並列度 4 で  365〜382 秒/水準  → 全体 382 秒（直列 592 秒の 1.55 倍速）
 *                                          ※この行は別のテストと GPU を
 *                                            取り合っていたので下限値
 * ```
 *
 * **「水準数ぶん速くなる」は成り立たない。**
 * 引き継ぎ(docs/引き継ぎ_2026-08-14.md §5)にはそう書かれていたが、
 * 1 評価の費用は 88% が EBM = GPU 側にある
 * (docs/実験記録_評価費用の内訳_2026-08-10.md)。CPU が 24 コア空いていても
 * 律速は GPU なので、利得は 1.3〜1.6 倍で頭打ちになる。
 * 「CPU の負荷が低い」という観察は正しかったが、**空いている資源が
 * ボトルネックとは限らない**。
 *
 * それでも 1.3〜1.6 倍は素で効くうえ、水準ごとにプロセスが分かれるので
 * モジュールの可変状態の漏れに対しては直列より強い。
 * 1 を指定すると同一プロセスの直列(= 2026-08-14 までの挙動)になる。
 */
export function resolveParallel(levels: number, argv: string[] = process.argv): number {
  const flag = argv.find((a) => a.startsWith('--parallel'));
  let n = NaN;
  if (flag) {
    const eq = flag.indexOf('=');
    n = Number(eq >= 0 ? flag.slice(eq + 1) : argv[argv.indexOf(flag) + 1]);
  } else if (process.env['SWEEP_PARALLEL']) {
    n = Number(process.env['SWEEP_PARALLEL']);
  }
  if (!Number.isFinite(n) || n < 1) n = 4;
  return Math.max(1, Math.min(Math.round(n), levels));
}

/**
 * 掃引を回して**水準の順に**印字する(完了順ではない)。
 *
 * 並列でも印字が入れ替わらないのは、表を読むのは人間で、行が飛ぶと
 * どの水準の話か追えなくなるため。終わった水準は先頭から詰めて出す。
 * 進捗は stderr へ流すので、リダイレクトした表には混ざらない。
 *
 * 戻り値は水準の順に並んだ測定結果。
 */
export async function runSweep(
  key: string,
  values: number[],
  targets: string[],
  parallel: number,
): Promise<LevelReport[]> {
  const done: Array<LevelReport | null> = values.map(() => null);
  let printed = 0;
  const flush = (): void => {
    while (printed < values.length) {
      const p = done[printed];
      if (!p) break;
      console.log(formatLevel(p));
      printed++;
    }
  };
  const finish = (idx: number, p: LevelReport): void => {
    done[idx] = p;
    process.stderr.write(
      `[掃引] ${key}=${values[idx]} 完了 ${p.sec.toFixed(0)}s ` +
        `(${done.filter(Boolean).length}/${values.length})\n`,
    );
    flush();
  };

  if (parallel <= 1) {
    // 直列(同一プロセス)。パイプラインは入口で診断を初期化するので
    // 水準間の漏れは無いが、**定数は自分で戻す**
    const K = MODEL_CONSTANTS as unknown as Record<string, number>;
    const base = K[key] ?? 0;
    const accel = await openAccel(true);
    try {
      for (let i = 0; i < values.length; i++) {
        finish(i, await measureLevel(key, values[i] ?? 0, targets, accel.opts));
      }
    } finally {
      accel.close();
      K[key] = base;
    }
    return done as LevelReport[];
  }

  // 並列(ワーカープロセス)。1 プロセス 1 水準ずつ順に食わせる。
  // **親は定数を触らない** — 触っても子には伝わらないし、伝わると
  // どの水準の値か分からなくなる。
  interface Lane {
    proc: ChildProcess;
    rl: readline.Interface;
  }
  const lanes: Lane[] = [];
  for (let i = 0; i < parallel; i++) {
    // 実行名を引数として残すのは較正と同じ理由。親だけ殺したときに
    // 子が GPU を掴んだまま生き残るので、目印があれば狙い撃ちできる
    const proc = spawn('npx', ['tsx', 'scripts/sweep_worker.ts', `--marker=sweep:${key}`], {
      shell: true,
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd: process.cwd(),
      env: { ...process.env, LEVER_TARGETS: targets.join(',') },  // CRH_INNER も引き継がれる
    });
    lanes.push({ proc, rl: readline.createInterface({ input: proc.stdout! }) });
  }
  const runOne = (lane: Lane, idx: number): Promise<LevelReport> =>
    new Promise((resolve, reject) => {
      const onLine = (line: string): void => {
        lane.rl.off('line', onLine);
        try {
          const msg = JSON.parse(line) as { report?: LevelReport; error?: string };
          if (msg.error || !msg.report) return reject(new Error(msg.error ?? 'no report'));
          resolve(msg.report);
        } catch (e) {
          reject(e as Error);
        }
      };
      lane.rl.on('line', onLine);
      lane.proc.stdin!.write(
        JSON.stringify({ id: idx, key, value: values[idx], targets }) + '\n',
      );
    });
  let next = 0;
  try {
    await Promise.all(
      lanes.map(async (lane) => {
        while (next < values.length) {
          const idx = next++;
          finish(idx, await runOne(lane, idx));
        }
      }),
    );
  } finally {
    for (const lane of lanes) lane.proc.kill();
  }
  flush();
  return done as LevelReport[];
}

/** 表の見出し(水準を印字する前に 1 回) */
export function formatHeader(key: string, base: number, targets: string[]): string {
  // 上書きがあるなら**必ず表に出す**。どの条件で測った表かが後から分からないと、
  // 別条件の記録どうしを取り違える(2026-08-16 に古い出力を読んで報告した前科)
  const ov =
    SWEEP_OVERRIDES.length > 0
      ? `\n**全水準に共通の上書き**: ${SWEEP_OVERRIDES.map(([k, v]) => `${k}=${v}`).join(', ')}`
      : '';
  return (
    `レバー: ${key}（現在値 ${base}）${ov}\n` +
    '\n値      v3      大分類  詳細   ゲート 位相  気温RMSE ' +
    targets.map((t) => t.split('_')[0]?.padStart(7) ?? '').join(' ') +
    '\n                                                     ' +
    targets.map(() => '  流入').join('  ') +
    '   ← 夏の正味流入 mm/年'
  );
}

/**
 * 1 水準を印字用の文字列にする。
 *
 * **収束の状態を必ず並べる(2026-08-14)。** 段 20 の掃引は未収束の件数を
 * 出しておらず、鋭さ 8 以上で W が 328mm・462mm という物理的にありえない値を
 * 「解」として表に載せてしまった。「反復の打ち切りが答えを決める」型の欠陥は
 * EBM で 3 件踏んでいる(docs/教訓.md)。未収束の解は黙って採用しない。
 *
 * **収束を要する反復は 5 系統ある**(2026-08-14 に数え上げた):
 * 輸送 / virga の外側反復 / 結合反復 / 土壌の周期定常 / EBM の周期定常。
 * 3 系統しか見ていなかったため、結合反復が発散している解を健全と読んだ。
 * 1 つ通ったことは他が通ったことを意味しない。
 */
export function formatLevel(p: LevelReport): string {
  const cols = p.targets.map((t) => t.netInflowMm.toFixed(0).padStart(7));
  const obsRatio = p.targets.map((t) =>
    t.obsRatio === null ? '  —  ' : t.obsRatio.toFixed(2).padStart(5),
  );
  const cp = p.coupling;
  const soil = p.soil;
  const anyBad =
    p.transportNonConverged + p.virgaNonConverged > 0 ||
    !cp.converged ||
    (soil ? !soil.converged : false) ||
    p.ebmCapHits > 0;
  return (
    `${p.value.toString().padEnd(6)} ${p.sec.toFixed(0).padStart(4)}s W${p.waterMm.toFixed(1).padStart(5)} ` +
    `${p.fitness.toFixed(3)}  ${p.majorPct.toFixed(2)}  ${p.detailPct.toFixed(2)}  ` +
    `${String(p.gates).padStart(4)}  ${p.precipPhaseRmseDays.toFixed(1)}  ` +
    `${p.tempRmseC.toFixed(3).padStart(7)}  ${cols.join(' ')}\n` +
    `       年降水／観測: ${obsRatio.join('  ')}\n` +
    `       乾いた端(南極を除く陸・面積重み mm/年): ` +
    ` 1% ${p.dryTail.p01.toFixed(0).padStart(5)}(観測 ${p.dryTail.obsP01.toFixed(0)})` +
    `  5% ${p.dryTail.p05.toFixed(0).padStart(5)}(観測 ${p.dryTail.obsP05.toFixed(0)})` +
    `  50% ${p.dryTail.p50.toFixed(0).padStart(5)}(観測 ${p.dryTail.obsP50.toFixed(0)})\n` +
    `       分布形: 平均対数誤差 ${p.quantileLogErr.toFixed(3)}` +
    `  連続部分 ${p.continuousV3.toFixed(3)}  被覆の和 ${p.gateShare.toFixed(2)}/17\n` +
    `       分位(モデル/観測): ` +
    p.quantiles.map(([q, m, o]) => `${q}% ${m.toFixed(0)}/${o.toFixed(0)}`).join('  ') +
    '\n' +
    `       収束: 輸送 未収束 ${String(p.transportNonConverged).padStart(3)} 件` +
    ` / virga 未収束 ${String(p.virgaNonConverged).padStart(3)} 件` +
    ` / 最悪残差 ${p.worstResidual.toExponential(2)}` +
    ` / 反復 ${p.transportIterations}\n` +
    `             結合反復 ${cp.converged ? '収束' : '**未収束**'}` +
    ` ${cp.iterations}/${cp.maxIterations} 回` +
    ` / 残差 ${cp.finalResidualMmPerMonth.toFixed(3)} mm/月` +
    `(許容 ${cp.toleranceMmPerMonth})\n` +
    `             土壌 ${soil ? (soil.converged ? '収束' : '**未収束**') : '—'}` +
    `${soil ? `（年貯水ドリフト 平均 ${soil.meanAnnualDriftMm.toFixed(2)} / 最大 ${soil.maxAnnualDriftMm.toFixed(2)} mm）` : ''}` +
    ` / EBM 上限到達 ${p.ebmCapHits} 回` +
    ` / 最大残差 ${p.ebmMaxResidualC.toFixed(4)}°C` +
    `${anyBad ? '   ← **この行は適用範囲外。解として読まない**' : ''}`
  );
}
