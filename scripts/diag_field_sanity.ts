// GPU へ渡す場に NaN や異常値が無いかを調べる。
//
// 動機: 風上追跡の GPU 版が実データでのみ 3 回目に segfault する
// (合成データでは 60 回完走)。NaN があると speed < 0.5 の打ち切りが
// 効かず、座標が NaN のまま添字計算に入る。
//
// 実行: npx tsx scripts/diag_field_sanity.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { buildCrestElev, buildSmallWaterMask } from '../src/sim/step06_precipitation';

const result = runPipeline(EARTH_PARAMS);
const ctx = result.context;
const N = ctx.grid.cellCount;

const check = (name: string, a: ArrayLike<number>): void => {
  let nan = 0;
  let inf = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] ?? 0;
    if (Number.isNaN(v)) nan++;
    else if (!Number.isFinite(v)) inf++;
    else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const flag = nan > 0 || inf > 0 ? '  ← 異常' : '';
  console.log(
    `${name.padEnd(22, '　')} NaN ${String(nan).padStart(6)} / Inf ${String(inf).padStart(6)} / ` +
      `範囲 ${min.toFixed(2)} 〜 ${max.toFixed(2)}${flag}`,
  );
};

check('標高', ctx.terrain.elevationMeters);
check('稜線標高', buildCrestElev(ctx));
check('陸マスク', ctx.terrain.landMask);
check('内海マスク', buildSmallWaterMask(ctx));
for (let m = 0; m < 12; m++) {
  if (m > 0 && m < 11) continue;
  check(`気温 ${m + 1} 月`, result.temperature.monthlyTemperatureC[m]!);
  check(`東西風 ${m + 1} 月`, result.airflow.monthlyWindU[m]!);
  check(`南北風 ${m + 1} 月`, result.airflow.monthlyWindV[m]!);
}

// 風速が 0.5 未満のセルの割合(打ち切りの効き具合)
let slow = 0;
let total = 0;
for (let m = 0; m < 12; m++) {
  const u = result.airflow.monthlyWindU[m]!;
  const v = result.airflow.monthlyWindV[m]!;
  for (let i = 0; i < N; i++) {
    total++;
    if (Math.hypot(u[i] ?? 0, v[i] ?? 0) < 0.5) slow++;
  }
}
console.log(`\n風速 < 0.5 m/s のセル月: ${((slow / total) * 100).toFixed(2)}%`);
