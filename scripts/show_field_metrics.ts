// 現行モデルの全指標(季節を含む)と、観測側の空間ばらつきを表示する。
//
// 目的関数 v3 の重みを決めるための下見。**割る量は観測のばらつき**にする
// (モデルの誤差で無次元化すると、成績が変わるたびに重みが動いてしまう)。
//
// 実行: npx tsx scripts/show_field_metrics.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { fieldScore, koppenScore, itczLineRmse, scoreRegionGates } from './scoring';
import { openAccel } from './accel_cli';

const accel = await openAccel();
const r = await runPipeline(EARTH_PARAMS, accel.opts);
accel.close();

const f = fieldScore(r);
const k = koppenScore(r);
const gates = scoreRegionGates(r).filter((g) => g.pass).length;
const itcz = itczLineRmse(r);

const row = (label: string, value: number, unit: string, scale?: number): void => {
  const norm =
    scale !== undefined
      ? `  / 観測ばらつき ${scale.toFixed(1)} → ${(value / scale).toFixed(3)}`
      : '';
  console.log(`${label.padEnd(26, '　')}${value.toFixed(2).padStart(9)} ${unit}${norm}`);
};

console.log('=== ケッペン・ゲート ===');
row('大分類一致率', k.majorPct, '%');
row('詳細一致率', k.detailPct, '%');
console.log(`地域ゲート　　　　　　　　　　　　　　${String(gates).padStart(9)} / 17`);
console.log('\n=== 気温 ===');
row('年平均 RMSE', f.tempRmseC, '°C', f.obsSdTempC);
row('年較差 RMSE', f.tempRangeRmseC, '°C', f.obsSdTempRangeC);
row('季節位相 RMS', f.tempPhaseRmseDays, '日');
row('1月 RMSE(参考)', f.tempJanRmseC, '°C');
row('7月 RMSE(参考)', f.tempJulRmseC, '°C');
console.log('\n=== 降水 ===');
row('年降水 RMSE', f.precipRmseMm, 'mm', f.obsSdPrecipMm);
row('最少月 RMSE', f.precipDriestRmseMm, 'mm/月', f.obsSdPrecipDriestMm);
row('最多月 RMSE', f.precipWettestRmseMm, 'mm/月', f.obsSdPrecipWettestMm);
row('陸平均(モデル)', f.landMeanModelMm, 'mm');
row('陸平均(観測)', f.landMeanObsMm, 'mm');
row('log 相関', f.logCorrelation, '');
console.log('\n=== 循環 ===');
row('ITCZ 線 RMSE', itcz, '°');
