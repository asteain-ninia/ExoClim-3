// 診断: EBM の反復回数は**全ステップで同じだけ要るのか**。
//
// 費用の 88% は EBM で、その中身は「1 時間ステップあたり赤黒ガウス=ザイデル
// 512 回」を全ステップで固定して回すもの。512 の根拠は 2026-08-01 の実測
// (128 → 残差 3.6e-2 / 256 → 2.6e-3 / 512 → 1.7e-5、許容差 1e-3)だが、
// **あれは全ステップを通じた最大残差**である。
//
// もし大半のステップが 128 回で許容差を満たしているなら、全ステップが
// 「一番苦しい 1 ステップ」に引きずられて 4 倍払っていることになる。
// ステップごとの残差の分布を見れば分かる。
//
// 実行: npx tsx scripts/diag_ebm_step_residual.ts [反復回数] [年数]

import { EARTH_PARAMS } from '../src/domain/planetParams';
import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { computeWindBelt } from '../src/sim/step02_windbelt';
import { computeOceanCurrent } from '../src/sim/step03_ocean';
import { computeAirflow } from '../src/sim/step04_airflow';
import { computeTemperature, EBM_SOLVER_STATS, resetEbmSolverStats } from '../src/sim/step05_temperature';
import { EBM_SOLVE_TOLERANCE_C } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';

const ITERS = Number(process.argv[2] ?? 128);
const YEARS = Number(process.argv[3] ?? 6);

const ctx = buildSimContext(EARTH_PARAMS);
const itcz = computeItcz(ctx);
const wind = computeWindBelt(ctx, itcz);
const ocean = computeOceanCurrent(ctx, itcz, wind);
const air = computeAirflow(ctx, itcz, wind);

/** 温間開始で測るか(既定 0 = 冷間)。1 なら先に 1 回回して収束場を作る */
const WARM = process.argv[4] === 'warm';

const accel = await openAccel(true);
try {
  const box: { field: Float32Array | null } = { field: null };
  if (WARM) {
    // 先に 1 回回して箱を埋める(この回の残差は捨てる)
    await computeTemperature(ctx, itcz, wind, ocean, air, undefined, {
      ...accel.opts,
      ebmWarmStart: box,
      budget: {
        ebmIterations: 512,
        ebmMaxIterations: 512,
        ebmFullCapacityYears: YEARS,
        ebmMaxFullCapacityYears: YEARS,
      },
    });
  }
  resetEbmSolverStats();
  await computeTemperature(ctx, itcz, wind, ocean, air, undefined, {
    ...accel.opts,
    ...(WARM ? { ebmWarmStart: box } : {}),
    budget: {
      ebmIterations: ITERS,
      ebmMaxIterations: ITERS, // 倍化させない（この回数ちょうどで測る）
      ebmFullCapacityYears: YEARS,
      ebmMaxFullCapacityYears: YEARS,
    },
  });
  const res = EBM_SOLVER_STATS.stepResidualsC;
  if (!res || res.length === 0) {
    console.log('ステップ残差が取れなかった（GPU 経路でないか、記録されていない）');
  } else {
    const tol = EBM_SOLVE_TOLERANCE_C;
    let ok = 0;
    const buckets = [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, Infinity];
    const counts = new Array<number>(buckets.length).fill(0);
    for (const v of res) {
      if (v <= tol) ok++;
      for (let b = 0; b < buckets.length; b++) {
        if (v <= (buckets[b] ?? Infinity)) {
          counts[b] = (counts[b] ?? 0) + 1;
          break;
        }
      }
    }
    console.log(`\n反復 ${ITERS} 回・${YEARS} 年・${res.length} ステップ（許容差 ${tol}）`);
    const labels = ['≤1e-5', '≤1e-4', '≤1e-3', '≤1e-2', '≤1e-1', '>1e-1'];
    for (let b = 0; b < buckets.length; b++) {
      const c = counts[b] ?? 0;
      const pct = (c / res.length) * 100;
      console.log(`  残差 ${labels[b]?.padEnd(6)} ${String(c).padStart(6)} ステップ  ${pct.toFixed(1)}%`);
    }
    console.log(
      `\n**${ITERS} 回で許容差を満たしたステップ: ${((ok / res.length) * 100).toFixed(1)}%**`,
    );
    // どこが苦しいのか（時系列の位置）も出す
    const nBad: number[] = [];
    for (let s = 0; s < res.length; s++) if ((res[s] ?? 0) > tol) nBad.push(s);
    if (nBad.length > 0) {
      const first = nBad[0] ?? 0;
      const last = nBad[nBad.length - 1] ?? 0;
      console.log(
        `未達ステップの位置: 最初 ${first}（${((first / res.length) * 100).toFixed(0)}%地点）` +
          ` 最後 ${last}（${((last / res.length) * 100).toFixed(0)}%地点）`,
      );
    }
  }
} finally {
  accel.close();
}
