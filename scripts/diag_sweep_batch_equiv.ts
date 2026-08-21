// 同値検証: 掃引のバッチ実行器(scripts/sweep_batch_lib.ts)が、既存
// sweep_lever の単発実行(並列 1 = 直列 measureLevel + 実 GPU accel)と
// **各水準スコアで完全一致**するかを確かめる。
//
// 判定(結果を見る前に固定):
//   conveyorStrength ∈ {0, 15, 30}(SWEEP_OVERRIDE なし)、2° 格子 +
//   EBM 短縮(sweeps 64 / 全熱容量 4 年 — diag_ebm_batch_equiv.ts の頭と同じ組)で、
//   LevelReport の全数値(大分類・詳細・気温RMSE・分位・位相・連続部分・乾いた端・
//   収束統計ほか。実行時間 sec だけ除く)が **Object.is の意味で完全一致**すること。
//   CPU 部は f64 の決定的計算、GPU 部は「同じ入力に対する GPU 同士はビット一致」
//   (src/sim/accel.ts の注記)+ バッチ版と単発版の同値(diag_ebm_batch_equiv.ts で
//   受入済み)なので、丸めの許容は置かない。
//
// 実行時間も測る(参考値。合否にしない):
//   直列(並列 1 相当)/ バッチ実行器(スレッド 3)/ 既存 sweep_lever --parallel 3。
//   **注記: GPU では v30 較正が並走しており、時間の数字には汚染がある。**
//   1° の本計測は較正走行中のためやらない。
//
// 実行: npx tsx scripts/diag_sweep_batch_equiv.ts [--skip-spawn]
//   --skip-spawn で「既存 sweep_lever --parallel 3」の壁時間測定を飛ばす。

import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import type { LevelReport } from './sweep_lib';

// **安い設定は import より前に env へ掛ける**(sweep_lib は読み込み時に反映する)。
// そのため本体の import はすべて main() 内の動的 import にしてある
process.env['SWEEP_GRID_DEG'] = '2';
process.env['SWEEP_EBM_SWEEPS'] = '64';
process.env['SWEEP_EBM_YEARS'] = '4';

const KEY = 'conveyorStrength';
const VALUES = [0, 15, 30];
const THREADS = 3;

/** sec(実行時間)以外の全数値を Object.is で比べ、違いを列挙する */
function diffReport(a: unknown, b: unknown): string[] {
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, p: string): void => {
    if (p === 'sec') return; // 実行時間だけは当然違う
    if (typeof x === 'number' && typeof y === 'number') {
      if (!Object.is(x, y)) diffs.push(`${p}: ${x} ≠ ${y}`);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) {
        diffs.push(`${p}: 長さ ${x.length} ≠ ${y.length}`);
        return;
      }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) {
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          p ? `${p}.${k}` : k,
        );
      }
      return;
    }
    if (x !== y) diffs.push(`${p}: ${String(x)} ≠ ${String(y)}`);
  };
  walk(a, b, '');
  return diffs;
}

/** 受入条件に挙がった主要列を並べて印字する(全数値の照合は diffReport が行う) */
function acceptanceRow(r: LevelReport): string {
  const q = (pct: number): string => {
    const hit = r.quantiles.find((x) => x[0] === pct);
    return hit ? hit[1].toFixed(3) : '—';
  };
  return (
    `大分類 ${r.majorPct.toFixed(4)} / 詳細 ${r.detailPct.toFixed(4)} / ` +
    `位相 ${r.precipPhaseRmseDays.toFixed(4)} / 気温RMSE ${r.tempRmseC.toFixed(6)} / ` +
    `分位誤差 ${r.quantileLogErr.toFixed(6)} / 連続部分 ${r.continuousV3.toFixed(6)} / ` +
    `1% ${q(1)} / 50% ${q(50)} / 99% ${q(99)}`
  );
}

async function main(): Promise<void> {
  const skipSpawn = process.argv.includes('--skip-spawn');
  const { measureLevel, resolveTargets } = await import('./sweep_lib');
  const { MODEL_CONSTANTS } = await import('../src/sim/constants');
  const { acquireGpu, releaseGpu } = await import('../src/sim/gpu/device_node');
  const { makeAccelerator } = await import('../src/sim/gpu/accelerator');
  const { runSweepBatch } = await import('./sweep_batch_lib');

  const targets = resolveTargets();
  console.log(
    `同値検証: ${KEY} ∈ {${VALUES.join(', ')}} / 2° 格子 / EBM sweeps 64・4 年 / ` +
      `対象地域 ${targets.length} 件`,
  );
  console.log('**注記: GPU では v30 較正が並走中。時間の数字には汚染がある。**\n');

  // ---- 1) バッチ実行器(スレッド 3)----
  // デバイスはプロセスで共有(sweep_batch_lib はデバイスを破棄しない)ので、
  // 先にバッチを回しても後段の直列測定と資源が衝突しない
  console.log(`== バッチ実行器(スレッド ${THREADS})==`);
  const tB0 = performance.now();
  const batchReports = await runSweepBatch(KEY, VALUES, targets, { threads: THREADS });
  const tBatch = (performance.now() - tB0) / 1000;
  console.log(`壁時間 ${tBatch.toFixed(1)} 秒\n`);

  // ---- 2) 既存経路の単発実行(sweep_lever --parallel 1 と同じ:
  //         直列 measureLevel + makeAccelerator の実 GPU)----
  console.log('== 既存経路(直列 = 並列 1 相当)==');
  const ctx = await acquireGpu();
  if (!ctx) throw new Error('GPU を取得できない');
  const accel = makeAccelerator(ctx);
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const base = K[KEY] ?? 0;
  const serialReports: LevelReport[] = [];
  const tS0 = performance.now();
  try {
    for (const v of VALUES) {
      const r = await measureLevel(KEY, v, targets, { accel });
      serialReports.push(r);
      process.stderr.write(`[直列] ${KEY}=${v} 完了 ${r.sec.toFixed(0)}s\n`);
    }
  } finally {
    K[KEY] = base;
  }
  const tSerial = (performance.now() - tS0) / 1000;
  console.log(`壁時間 ${tSerial.toFixed(1)} 秒\n`);

  // ---- 照合 ----
  console.log('== 照合(sec 以外の全数値を Object.is で比較)==');
  let ok = true;
  for (let i = 0; i < VALUES.length; i++) {
    const s = serialReports[i]!;
    const b = batchReports[i]!;
    console.log(`\n水準 ${KEY}=${VALUES[i]}:`);
    console.log(`  直列:   ${acceptanceRow(s)}`);
    console.log(`  バッチ: ${acceptanceRow(b)}`);
    const diffs = diffReport(s, b);
    if (diffs.length === 0) {
      console.log('  → ✅ 完全一致');
    } else {
      ok = false;
      console.log(`  → ❌ 不一致 ${diffs.length} 件:`);
      for (const d of diffs.slice(0, 20)) console.log(`     ${d}`);
      if (diffs.length > 20) console.log(`     …ほか ${diffs.length - 20} 件`);
    }
  }

  // ---- 3) 既存 sweep_lever --parallel 3 の壁時間(参考値)----
  let tSpawn: number | null = null;
  if (!skipSpawn) {
    console.log('\n== 既存 sweep_lever --parallel 3(壁時間の参考値)==');
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'npx',
        ['tsx', 'scripts/sweep_lever.ts', KEY, VALUES.join(','), '--parallel', String(THREADS)],
        {
          shell: true,
          stdio: ['ignore', 'ignore', 'inherit'],
          cwd: process.cwd(),
          env: { ...process.env }, // 安い設定(SWEEP_GRID_DEG 等)を継承させる
        },
      );
      proc.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`sweep_lever が code ${code} で終了`)),
      );
      proc.on('error', reject);
    });
    tSpawn = (performance.now() - t0) / 1000;
  }

  console.log('\n===== まとめ =====');
  console.log(`同値: ${ok ? '✅ 全 3 水準が完全一致' : '❌ 不一致あり — バッチ実行器を直すこと'}`);
  console.log(`壁時間(参考値。v30 較正の GPU 汚染あり):`);
  console.log(`  直列(並列 1 相当)        ${tSerial.toFixed(1)} 秒`);
  console.log(
    `  バッチ実行器(スレッド 3)  ${tBatch.toFixed(1)} 秒(直列の ${(tSerial / tBatch).toFixed(2)} 倍速)`,
  );
  if (tSpawn !== null) {
    console.log(
      `  既存 sweep_lever 並列 3     ${tSpawn.toFixed(1)} 秒(起動費込み。バッチは同条件で ${(
        tSpawn / tBatch
      ).toFixed(2)} 倍速)`,
    );
  }
  console.log(
    '  ※ 2° はコマンド律速がさらに強い条件で、1° の本計測は v30 較正の完走後に行うこと',
  );

  accel.destroy(); // 参照経路の常駐資源ごとデバイスを破棄(exit 139 予防)
  releaseGpu(); // 二重破棄でも安全(cached が消えていれば何もしない)
  if (!ok) process.exitCode = 1;
}

void main();
