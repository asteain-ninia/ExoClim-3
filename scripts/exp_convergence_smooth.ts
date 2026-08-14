// 実験(段 30): **収束を作るときの供給場の平滑幅が、収束の空間スケールを決めている。**
//
// 事前登録: docs/事前登録_収束の平滑幅_2026-08-15.md
//
// 収束指数の空間相関長は 100〜170km しかなく(1 セル 0.571、2 セル 0.066)、
// 実物の温帯低気圧の収束帯 1000km 級に 1 桁足りない。
// `DIVERGENCE_SMOOTH_DEG = 1.5`(40° 付近で約 130km)が測った相関長と一致する。
//
// `convergenceLiftBoost` は段 29 で測った **0.5 に固定**する
// (0 のままだと収束が降水に効かず、平滑幅を変えても何も起きない)。
//
// 実行: npx tsx scripts/exp_convergence_smooth.ts [幅,幅,...]

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { CONVERGENCE_SMOOTH } from '../src/sim/step06_precipitation';
import { formatLevel, measureLevel, resolveTargets } from './sweep_lib';
import { openAccel } from './accel_cli';

const DEGS = (process.argv[2] ?? '1.5,3,6,9,12').split(',').map(Number);
const K = MODEL_CONSTANTS as unknown as Record<string, number>;

async function main(): Promise<void> {
  const targets = resolveTargets();
  console.log('収束の平滑幅を振る。convergenceLiftBoost = 0.5 に固定。');
  console.log('**見るのは中位(50% 分位)が上がるか。**\n');
  const accel = await openAccel(true);
  try {
    for (const deg of DEGS) {
      // 既定と厳密に一致することを確かめるため、1.5 のときは上書きを外す
      CONVERGENCE_SMOOTH.deg = deg === 1.5 ? 0 : deg;
      const p = await measureLevel('convergenceLiftBoost', 0.5, targets, accel.opts);
      console.log(`── 平滑幅 ${deg}°（40° 付近で約 ${(deg * 86).toFixed(0)} km）`);
      console.log(formatLevel(p));
      console.log('');
    }
  } finally {
    CONVERGENCE_SMOOTH.deg = 0;
    K['convergenceLiftBoost'] = 0;
    accel.close();
  }
  console.log(
    '判定(事前登録): 中位の 50% 分位が幅 1.5 の値から **+30mm 以上**。\n' +
      '  番人: コンゴ 1.01〜1.61 / アマゾン 0.82〜1.12 / 1% 分位が増えない /\n' +
      '  大分類が 74.49 から 1.0 以上落ちない / 5 系統すべて未収束 0 / 費用 900 秒。',
  );
}

void main();
