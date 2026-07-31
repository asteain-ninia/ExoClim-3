// 現在の constants.ts のリーン採点を 1 回だけ出す(モデル比較・回帰確認用)
// 実行: npx tsx scripts/score_once.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';

const result = runPipeline(EARTH_PARAMS);
const s = evaluateResult(result);
console.log(
  `fit=${s.fitness.toFixed(2)} 大分類=${s.majorPct.toFixed(2)} 詳細=${s.detailPct.toFixed(2)} ` +
    `ゲート=${s.gates} 気温RMSE=${s.tempRmse.toFixed(2)} 降水RMSE=${Math.round(s.precipRmse)} ` +
    `ITCZ線RMSE(雨量重み)=${s.itczRmse.toFixed(2)} 陸平均=${Math.round(s.landMeanMm)}`,
);
