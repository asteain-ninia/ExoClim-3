// 実験(段 36): ストーム混合を拡散の場として保存型へ繋ぐ。
//
// 事前登録: docs/事前登録_ストーム混合を拡散で繋ぐ_2026-08-15.md
//
// D(i) = D₀ × (1 + boost × supplyW × exp(−coastKm/decayKm))
// **源泉には触らない。拡散は保存的なので水が湧かない。**
//
// 実行: npx tsx scripts/exp_storm_diffusion.ts [boost,boost,...]

import { STORM_DIFFUSION } from '../src/sim/step06_precipitation';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { formatLevel, measureLevel, resolveTargets } from './sweep_lib';
import { openAccel } from './accel_cli';

const BOOSTS = (process.argv[2] ?? '0,1,2,4,8').split(',').map(Number);
const K = MODEL_CONSTANTS as unknown as Record<string, number>;

async function main(): Promise<void> {
  const targets = resolveTargets();
  console.log('ストーム混合を拡散の場として繋ぐ。**源泉には触らない。**');
  console.log('**主判定: 中位 500 以上。番人: 1% が 64 から増えない。**\n');
  const accel = await openAccel(true);
  try {
    for (const b of BOOSTS) {
      STORM_DIFFUSION.boost = b;
      const p = await measureLevel(
        'moistureEddyDiffusivityM2PerS',
        K['moistureEddyDiffusivityM2PerS'] ?? 0,
        targets,
        accel.opts,
      );
      console.log(`── boost ${b}（拡散は海岸のストーム帯で最大 ${1 + b} 倍）`);
      console.log(formatLevel(p));
      console.log('');
    }
  } finally {
    STORM_DIFFUSION.boost = 0;
    accel.close();
  }
  console.log(
    '判定(事前登録): 中位 500 以上 / 1% が 64 から増えない /\n' +
      '  コンゴ 1.01〜1.61 / アマゾン 0.82〜1.12 / 大分類が 1.0 以上落ちない /\n' +
      '  5 系統すべて未収束 0 / 費用 900 秒。\n' +
      '  **水収支の閉包は npm run validate で別途確認する(1e-9 級)。**',
  );
}

void main();
