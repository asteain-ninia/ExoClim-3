// 掃引のバッチ実行器の入口。**引数は scripts/sweep_lever.ts と同じ**。
//
// 使い方:
//   npx tsx scripts/sweep_lever_batch.ts <定数名> <値1,値2,...> [--parallel N]
//
//   全水準に共通の上書きも同じ(SWEEP_OVERRIDE='名前=値,...')。環境変数は
//   worker_threads に継承されるので、sweep_lever.ts と同じ掛かり方をする。
//
// 既存の sweep_lever.ts との違いは実行器だけ:
//   - 水準をプロセスでなく worker_threads に割る(scripts/sweep_batch_lib.ts)
//   - EBM の GPU 実行を水準間で束ねる(src/sim/gpu/ebm_gpu_batch.ts)
//   答えは変わらない(同値検証: scripts/diag_sweep_batch_equiv.ts)。
//
// **事前登録を先に書くこと。** この道具は測るだけで、判定はしない
// (sweep_lever.ts の注記と同じ。教訓 §9)。

import { MODEL_CONSTANTS } from '../src/sim/constants';
import { releaseGpu } from '../src/sim/gpu/device_node';
import {
  formatHeader,
  formatLevel,
  resolveTargets,
  SWEEP_OVERRIDES,
  type LevelReport,
} from './sweep_lib';
import { runSweepBatch } from './sweep_batch_lib';

/**
 * スレッド数を決める。`--parallel N` が最優先、次に環境変数 SWEEP_PARALLEL、
 * **既定は水準数と 8 の小さいほう**。
 *
 * 既定が sweep_lever.ts(4)より大きいのは、こちらは GPU コマンドキューを
 * 頭数で割らない(束ねる)ので、水準を同時に走らせるほど EBM バッチの
 * 実効スループットが上がるため(L=8 で 4.95 倍 — bench_gpu_batch.ts 実測)。
 * 上限 8 は CPU 側(輸送 SOR など)のメモリと物理コアの控えめな折衷。
 */
function resolveThreads(levels: number): number {
  const argv = process.argv;
  const flag = argv.find((a) => a.startsWith('--parallel'));
  let n = NaN;
  if (flag) {
    const eq = flag.indexOf('=');
    n = Number(eq >= 0 ? flag.slice(eq + 1) : argv[argv.indexOf(flag) + 1]);
  } else if (process.env['SWEEP_PARALLEL']) {
    n = Number(process.env['SWEEP_PARALLEL']);
  }
  if (!Number.isFinite(n) || n < 1) n = Math.min(levels, 8);
  return Math.max(1, Math.min(Math.round(n), levels));
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const key = positional[0];
  const rawValues = positional[1];
  if (!key || !rawValues) {
    console.error(
      '使い方: npx tsx scripts/sweep_lever_batch.ts <定数名> <値1,値2,...> [--parallel N]\n' +
        "  全水準共通の上書き: SWEEP_OVERRIDE='名前=値,名前=値'",
    );
    process.exit(2);
  }
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  // **知らない名前で静かに空回りさせない。**(sweep_lever.ts と同じ検査)
  if (!(key in K)) {
    console.error(`未知の定数: '${key}'`);
    process.exit(2);
  }
  const values = rawValues.split(',').map((s) => Number(s.trim()));
  if (values.some((v) => !Number.isFinite(v))) {
    console.error(`水準に数値でない値がある: ${rawValues}`);
    process.exit(2);
  }
  if (SWEEP_OVERRIDES.some(([k]) => k === key)) {
    console.error(`'${key}' は SWEEP_OVERRIDE と重複している。掃引対象は上書きしないこと`);
    process.exit(2);
  }

  const targets = resolveTargets();
  const threads = resolveThreads(values.length);
  console.log(formatHeader(key, K[key] ?? 0, targets));
  console.log(`\nスレッド数 ${threads}(バッチ実行器)\n`);

  // 水準の順に印字する(完了順ではない — runSweep と同じ理由で、表を読むのは
  // 人間なので行が飛ぶと追えなくなる。終わった水準は先頭から詰めて出す)
  const done: Array<LevelReport | null> = values.map(() => null);
  let printed = 0;
  const flush = (): void => {
    while (printed < values.length) {
      const p = done[printed];
      if (!p) break;
      console.log(formatLevel(p));
      printed++;
    }
  };
  let reports: LevelReport[];
  try {
    reports = await runSweepBatch(key, values, targets, {
      threads,
      onReport: (idx, report): void => {
        done[idx] = report;
        flush();
      },
    });
  } finally {
    releaseGpu(); // デバイスを破棄(呼ばないと exit 139)
  }
  flush();

  // ---- まとめ(sweep_lever.ts の「まとめ」表と同じ主要列)----
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
