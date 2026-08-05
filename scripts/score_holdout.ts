// 未見評価の採点。区画ごとに「訓練側」と「未見側」を分けて出す。
//
// 対応 spec: docs/FB_2026-07-31.md P1-1。
//
// 読み方:
//   訓練側 … 較正に使った区画での成績(良くて当たり前)
//   未見側 … **較正から外した区画**での成績。ここが落ちなければ、
//            パラメータは地球の特定の場所へ合わせ込んだのではなく、
//            手続きとして働いていることになる
//   その差が「過剰適合の大きさ」である。
//
// 比較のため、同じ区画で**別の定数の組**も採点できる(採用前後の比較用)。
//
// 実行: npx tsx scripts/score_holdout.ts [比較する定数JSON...]
//   例: npx tsx scripts/score_holdout.ts out/optimize/best_v12desc.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { koppenScore, fieldScore } from './scoring';
import { keepExcludingFold, keepOnlyFold } from './holdout';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const OUT_DIR = path.join('out', 'optimize');
const EXTRA = process.argv.slice(2);

interface Side {
  majorPct: number;
  detailPct: number;
  tempRmse: number;
  precipRmse: number;
}

function scoreSide(result: PipelineResult, keep: ((a: number, b: number) => boolean) | undefined): Side {
  const k = koppenScore(result, undefined, keep);
  const f = fieldScore(result, undefined, keep);
  return {
    majorPct: k.majorPct,
    detailPct: k.detailPct,
    tempRmse: f.tempRmseC,
    precipRmse: f.precipRmseMm,
  };
}

async function scoreVector(
  vec: Record<string, number>,
  fold: number,
): Promise<{ train: Side; unseen: Side }> {
  const target = MODEL_CONSTANTS as unknown as Record<string, number>;
  const saved: Record<string, number> = {};
  for (const [k, v] of Object.entries(vec)) {
    if (k in target) {
      saved[k] = target[k]!;
      target[k] = v;
    }
  }
  const accel = await openAccel();
  let result: PipelineResult;
  try {
    result = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  for (const [k, v] of Object.entries(saved)) target[k] = v;
  return {
    train: scoreSide(result, keepExcludingFold(fold)),
    unseen: scoreSide(result, keepOnlyFold(fold)),
  };
}

const fmt = (s: Side): string =>
  `大分類 ${s.majorPct.toFixed(2)} / 詳細 ${s.detailPct.toFixed(2)} / ` +
  `気温 ${s.tempRmse.toFixed(2)} / 降水 ${Math.round(s.precipRmse)}`;

async function main(): Promise<void> {
  const rows: Array<Record<string, number | string>> = [];
  for (let fold = 0; fold < 5; fold++) {
    const p = path.join(OUT_DIR, `state_hold${fold}_fold${fold}.json`);
    if (!fs.existsSync(p)) {
      console.log(`区画 ${fold}: 較正の状態が無い(${p})`);
      continue;
    }
    const st = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      best: Record<string, number>;
      evals: number;
    };
    const r = await scoreVector(st.best, fold);
    console.log(`\n区画 ${fold}(較正 ${st.evals} 評価)`);
    console.log(`  訓練側  ${fmt(r.train)}`);
    console.log(`  未見側  ${fmt(r.unseen)}`);
    console.log(
      `  差(未見 − 訓練)  大分類 ${(r.unseen.majorPct - r.train.majorPct).toFixed(2)} / ` +
        `詳細 ${(r.unseen.detailPct - r.train.detailPct).toFixed(2)}`,
    );
    rows.push({
      fold,
      evals: st.evals,
      trainMajor: r.train.majorPct,
      unseenMajor: r.unseen.majorPct,
      trainDetail: r.train.detailPct,
      unseenDetail: r.unseen.detailPct,
      trainTemp: r.train.tempRmse,
      unseenTemp: r.unseen.tempRmse,
    });

    for (const extra of EXTRA) {
      if (!fs.existsSync(extra)) continue;
      const vec = JSON.parse(fs.readFileSync(extra, 'utf8')) as Record<string, number>;
      const e = await scoreVector(vec, fold);
      console.log(`  [${path.basename(extra)}] 未見側  ${fmt(e.unseen)}`);
    }
  }
  if (rows.length > 0) {
    const mean = (k: string): number =>
      rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length;
    console.log(
      `\n5 区画の平均: 訓練 大分類 ${mean('trainMajor').toFixed(2)} / ` +
        `未見 大分類 ${mean('unseenMajor').toFixed(2)} ` +
        `(差 ${(mean('unseenMajor') - mean('trainMajor')).toFixed(2)})`,
    );
    fs.mkdirSync('out/exp', { recursive: true });
    fs.writeFileSync('out/exp/holdout.json', JSON.stringify(rows, null, 1));
  }
}

void main();
