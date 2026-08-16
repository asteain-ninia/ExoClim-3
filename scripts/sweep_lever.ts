// 掃引: **任意の定数を任意の水準で振る**汎用版。
//
// なぜ要るか(2026-08-16):
//   レバーごとに専用スクリプトを作っていたが(exp_pressure_lever /
//   sweep_eddy_diffusivity …)、中身は水準の配列が違うだけである。
//   組で打つ実験に入って**掃引の回数が増えた**ので、汎用の入口を用意する。
//
// 使い方:
//   npx tsx scripts/sweep_lever.ts <定数名> <値1,値2,...> [--parallel N]
//
//   全水準に共通の上書きは環境変数で掛ける(組の実験用):
//   SWEEP_OVERRIDE='westerlyWindMs=12' npx tsx scripts/sweep_lever.ts \
//     zonalAdvectionCouplingWm2PerK 57.3,45.8,34.4,22.9 --parallel 4
//
// **事前登録を先に書くこと。** この道具は測るだけで、判定はしない。
// 何を予測していたかを結果の前に固定していない掃引は、
// 「良さそうな水準を後から選ぶ」ことしかできない(教訓 §9)。

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { formatHeader, resolveParallel, resolveTargets, runSweep, SWEEP_OVERRIDES } from './sweep_lib';

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const key = positional[0];
  const rawValues = positional[1];
  if (!key || !rawValues) {
    console.error(
      '使い方: npx tsx scripts/sweep_lever.ts <定数名> <値1,値2,...> [--parallel N]\n' +
        "  全水準共通の上書き: SWEEP_OVERRIDE='名前=値,名前=値'",
    );
    process.exit(2);
  }
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  // **知らない名前で静かに空回りさせない。** 綴り違いは実験ごと無駄になる
  if (!(key in K)) {
    console.error(`未知の定数: '${key}'`);
    process.exit(2);
  }
  const values = rawValues.split(',').map((s) => Number(s.trim()));
  if (values.some((v) => !Number.isFinite(v))) {
    console.error(`水準に数値でない値がある: ${rawValues}`);
    process.exit(2);
  }
  // 上書きで指定した定数を同時に掃引すると、どちらが効いたのか分からなくなる
  if (SWEEP_OVERRIDES.some(([k]) => k === key)) {
    console.error(`'${key}' は SWEEP_OVERRIDE と重複している。掃引対象は上書きしないこと`);
    process.exit(2);
  }

  const targets = resolveTargets();
  const parallel = resolveParallel(values.length);
  console.log(formatHeader(key, K[key] ?? 0, targets));
  console.log(`\n並列度 ${parallel}\n`);
  const reports = await runSweep(key, values, targets, parallel);

  console.log('\n===== まとめ =====');
  console.log('値          1%分位  50%分位  99%分位  分布誤差  連続部分  大分類  詳細   気温RMSE 健全');
  for (const p of reports) {
    const q = (pct: number): string => {
      const hit = p.quantiles.find((x) => x[0] === pct);
      return hit ? hit[1].toFixed(0).padStart(6) : '     —';
    };
    const sound =
      p.transportNonConverged + p.virgaNonConverged === 0 &&
      p.coupling.converged &&
      (p.soil?.converged ?? true) &&
      p.ebmCapHits === 0;
    console.log(
      `${p.value.toPrecision(4).padEnd(11)} ${q(1)} ${q(50)} ${q(99)}` +
        `  ${p.quantileLogErr.toFixed(3).padStart(7)}` +
        `  ${p.continuousV3.toFixed(3).padStart(8)}` +
        `  ${p.majorPct.toFixed(2).padStart(6)} ${p.detailPct.toFixed(2).padStart(6)}` +
        `  ${p.tempRmseC.toFixed(3).padStart(7)}  ${sound ? '○' : '**×**'}`,
    );
  }
  console.log('\n観測の分位: 1% 9 / 50% 596 / 99% 3393 mm/年');
  console.log('**比較は連続部分で行う**(fitness の絶対値は目的関数の版で意味が変わる)');
}

void main();
