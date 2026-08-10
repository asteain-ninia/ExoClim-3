// 診断: 高傾斜(自転軸 80°)で降水の結合反復が収束しない件。
//
// tests/unit/sim/water_budget.test.ts の「退化条件で有限かつ収束する」が
// 高傾斜だけ落ちる。反復上限が足りないのか、振動しているのかを分ける。
//
// 実行: npx tsx scripts/diag_hightilt_coupling.ts [傾斜度] [反復上限]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import type { PlanetParams } from '../src/domain/planetParams';
import { EBM_SOLVER, EBM_FULL_CAPACITY_YEARS } from '../src/sim/step05_temperature';

// **テストと同じ条件で測る。** tests/setup.ts は CPU 経路の EBM を短縮している
// (掃引 8 回・全熱容量 2 年)。本計算の EBM で回すと 1 実行が数十分かかり、
// しかも「テストが落ちる条件」とは別のものを測ることになる
EBM_SOLVER.sweeps = 8;
EBM_FULL_CAPACITY_YEARS.years = 2;

const TILT = Number(process.argv[2] ?? 80);
const MAX_IT = Number(process.argv[3] ?? 24);
const RES = Number(process.argv[4] ?? 4);

async function main(): Promise<void> {
  const p: PlanetParams = {
    ...EARTH_PARAMS,
    gridResolutionDeg: RES,
    body: { ...EARTH_PARAMS.body, axialTiltDeg: TILT },
  };
  // 反復ごとの残差は progress の detail に出るので、そこから拾う
  const trail: string[] = [];
  const r = await runPipeline(p, {
    budget: { precipCouplingIterations: MAX_IT },
    onProgress: (u) => {
      const d = u.detail ?? '';
      if (d.includes('残差')) trail.push(d);
    },
  });
  const c = r.precipitation.coupling;
  console.log(`傾斜 ${TILT}°、反復上限 ${MAX_IT}、格子 ${RES}°`);
  for (const t of trail) console.log('  ' + t);
  console.log(
    `\n反復 ${c.iterations}/${c.maxIterations}  残差 ${c.finalResidualMmPerMonth.toFixed(4)} ` +
      `(許容 ${c.toleranceMmPerMonth})  収束 ${c.converged}`,
  );
}

void main();
