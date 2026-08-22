// 診断: 目的関数 v7 の中間場 2 項の基準値(事前登録 予測 49 の判定)。
// 実行: npx tsx scripts/diag_v7_baseline.ts
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { intermediateFieldScore } from './scoring';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { MODEL_CONSTANTS } from '../src/sim/constants';
const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    if (name && name.trim() in K) { K[name.trim()] = Number(raw); console.log(`[上書き] ${name.trim()} = ${raw}`); }
  }
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r;
  try { r = await runPipeline(EARTH_PARAMS, accel.opts); } finally { accel.close(); }
  const im = intermediateFieldScore(r);
  console.log(`SST 偏差 RMSE ${im.sstAnomRmseC.toFixed(3)}°C / 観測 SD ${im.obsSdSstAnomC.toFixed(3)} → 正規化 ${(im.sstAnomRmseC / im.obsSdSstAnomC).toFixed(3)}`);
  console.log(`陸上風速 RMSE ${im.landWindRmseMs.toFixed(3)} m/s / 観測 SD ${im.obsSdLandWindMs.toFixed(3)} → 正規化 ${(im.landWindRmseMs / im.obsSdLandWindMs).toFixed(3)}`);
  const s = evaluateResult(r);
  console.log(`fitness v7 ${s.fitness.toFixed(3)} / v6 ${s.fitnessV6.toFixed(3)} / 大分類 ${s.majorPct.toFixed(2)}`);
}
void main();
