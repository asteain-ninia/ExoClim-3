// 診断: 較正中に 1 評価の所要時間が 3.6 倍(307s → 1110s)に増えた原因を突き止める。
//
// 対応 spec: なし(数値・費用の診断)。
//
// 仮説: step05 の「手掛かり」(fullCapacityHint / gpuIterationHint)が
// **上がりっぱなしのラチェット**になっている。収束に失敗すると倍化し、
// 成功しても下がらないため、一度でも重いパラメータ組が 48 年 / 1024 反復を
// 要求すると、そのワーカーの以後の全評価が永久にその費用を払う。
//
// 事前に登録する判定:
//   ラチェットが原因  … 最良パラメータを**新しいプロセスで冷間から**回すと
//                      基準線と同程度(300s 前後)で終わり、要した年数・反復も
//                      既定の 24 年 / 512 反復に収まる。
//   パラメータが原因  … 冷間でも 1000s 前後かかり、年数か反復が既定を超える。
//
// 続けて同一プロセスで 2 回目(基準線のパラメータ)を回し、
// **1 回目の履歴が 2 回目の費用を押し上げるか**を直接見る。これがラチェットの
// 実体そのもので、較正ワーカーで起きていることと同じ形である。
//
// 実行: npx tsx scripts/diag_hint_ratchet.ts

import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';

const BEST_PATH = 'out/optimize/best_v11obj3.json';

type Consts = Record<string, number>;

/** 定数を差し替えて元に戻せるようにする(較正ワーカーと同じやり方) */
function applyConstants(patch: Consts): Consts {
  const prev: Consts = {};
  const target = MODEL_CONSTANTS as unknown as Consts;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in target)) continue;
    prev[k] = target[k]!;
    target[k] = v;
  }
  return prev;
}

function resetStats(): void {
  EBM_SOLVER_STATS.totalSweeps = 0;
  EBM_SOLVER_STATS.steps = 0;
  EBM_SOLVER_STATS.maxSweeps = 0;
  EBM_SOLVER_STATS.capHits = 0;
  EBM_SOLVER_STATS.maxResidualC = 0;
  EBM_SOLVER_STATS.maxYearDriftC = 0;
  EBM_SOLVER_STATS.meanYearDriftC = 0;
  EBM_SOLVER_STATS.fullCapacityYears = 0;
}

async function once(label: string, patch: Consts | null): Promise<void> {
  const prev = patch ? applyConstants(patch) : null;
  resetStats();
  const t0 = performance.now();
  const accel = await openAccel();
  let line: string;
  try {
    const result = await runPipeline(EARTH_PARAMS, accel.opts);
    const s = evaluateResult(result);
    line =
      `v3=${s.fitness.toFixed(2)} v2=${s.fitnessV2.toFixed(2)} ` +
      `大分類=${s.majorPct.toFixed(2)} 詳細=${s.detailPct.toFixed(2)}`;
  } finally {
    accel.close();
  }
  const sec = (performance.now() - t0) / 1000;
  console.log(
    `[${label}] ${sec.toFixed(0)}s ${line}\n` +
      `    全熱容量年数=${EBM_SOLVER_STATS.fullCapacityYears} ` +
      `最大反復=${EBM_SOLVER_STATS.maxSweeps} ` +
      `年ドリフト平均=${EBM_SOLVER_STATS.meanYearDriftC.toFixed(4)}°C ` +
      `残差=${EBM_SOLVER_STATS.maxResidualC.toExponential(2)}°C ` +
      `未収束=${EBM_SOLVER_STATS.capHits}`,
  );
  if (prev) applyConstants(prev);
}

async function main(): Promise<void> {
  const best = JSON.parse(fs.readFileSync(BEST_PATH, 'utf8')) as Consts;
  // 1 回目: 最良パラメータを冷間から
  await once('最良・冷間', best);
  // 2 回目: 同一プロセスで基準線へ戻す。手掛かりが下がらないなら、
  // 基準線なのに 1 回目と同じ費用を払うはず
  await once('基準線・1回目の直後', null);
}

void main();
