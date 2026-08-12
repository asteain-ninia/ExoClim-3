// 保留検証の判定(事前登録_保存型モデルの再較正 の条件 4)。
//
// 較正のログには**訓練側の点しか無い**。区画 f を除いて学習した定数ベクトルを、
// **除いた区画そのもの(未見)** で採点し直して初めて過学習を測れる。
//
//   訓練側 = その区画を除いた全球の大分類一致率
//   未見側 = その区画だけの大分類一致率
//
// 事前登録の条件: 5 区画の平均が学習側と 1.0 以内。
//
// 実行: npx tsx scripts/judge_holdout.ts [走行名]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { koppenScore } from './scoring';
import { getKoppenObs } from './scoring';
import { keepExcludingFold, keepOnlyFold, HOLDOUT_FOLDS } from './holdout';
import { openAccel } from './accel_cli';

const RUN = process.argv[2] ?? 'v21';
const DIR = path.join(process.cwd(), 'out', 'optimize');

async function main(): Promise<void> {
  const base = { ...(MODEL_CONSTANTS as unknown as Record<string, number>) };
  const rows: Array<{ fold: number; trained: number; unseen: number }> = [];
  console.log(`保留検証の判定(${RUN})\n`);
  console.log('区画  訓練側の大分類  未見側の大分類   差');
  for (let f = 0; f < HOLDOUT_FOLDS; f++) {
    const p = path.join(DIR, `best_${RUN}_fold${f}.json`);
    if (!fs.existsSync(p)) {
      console.log(`${f}     （${path.basename(p)} が無い）`);
      continue;
    }
    const vec = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, number>;
    Object.assign(MODEL_CONSTANTS, base, vec);
    const accel = await openAccel(true);
    let r;
    try {
      r = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const obs = getKoppenObs();
    const trained = koppenScore(r, obs, keepExcludingFold(f)).majorPct;
    const unseen = koppenScore(r, obs, keepOnlyFold(f)).majorPct;
    rows.push({ fold: f, trained, unseen });
    console.log(
      `${f}     ${trained.toFixed(2).padStart(12)}  ${unseen.toFixed(2).padStart(12)}  ` +
        `${(unseen - trained).toFixed(2).padStart(6)}`,
    );
  }
  Object.assign(MODEL_CONSTANTS, base);
  if (rows.length === 0) return;
  const mt = rows.reduce((a, b) => a + b.trained, 0) / rows.length;
  const mu = rows.reduce((a, b) => a + b.unseen, 0) / rows.length;
  console.log(`\n平均  ${mt.toFixed(2).padStart(12)}  ${mu.toFixed(2).padStart(12)}  ${(mu - mt).toFixed(2).padStart(6)}`);
  console.log(
    `\n判定(事前登録の条件 4): 平均の差が 1.0 以内なら過学習していない → ` +
      `${Math.abs(mu - mt) <= 1.0 ? '✅ 満たす' : '❌ 満たさない'}`,
  );
  console.log(
    '注: 区画ごとの陸面積も気候の種類も違うので、区画単位の差は大きく出る。' +
      '**平均で見る**のが事前登録の約束。',
  );
}

void main();
