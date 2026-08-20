// 同値検証: EBM の GPU バッチ版(src/sim/gpu/ebm_gpu_batch.ts)が
// 単発版(src/sim/gpu/ebm_gpu.ts)と同じ答えを出すことを確かめる。
//
// 設計の出発点: docs/実験記録_掃引のGPUバッチ化案_2026-08-19.md。
// バッチ版は「緯度方向に水準を積む」レイアウトで L 水準を 1 ディスパッチに
// 載せる。**数値の式は単発版と 1 対 1** なので、同じ入力に対し同じ答え
// (GPU 同士はビット一致が期待値 — src/sim/accel.ts の注記)になるはず。
//
// 入力は捏造しない: 本物のパイプライン(step05 の accel 経路)が加速器へ
// 渡した EbmStaticFields / EbmConstants を EBM_CAPTURE で控え、
// **同一の入力**を単発版とバッチ版の両方へ与える。
//
// 判定(結果を見る前に固定):
//   A. L=1(同一定数)      — 月別気温 12 か月×全セルの最大絶対差 ≤ 1e-4°C
//   B. L=3(olrA 203/205/207)— 各水準がそれぞれの単発実行と同基準で一致
//   C. L=3 の実行時間 対 単発 3 回の合計 — 数字を出すだけで合否にしない
//
// 実行: npx tsx scripts/diag_ebm_batch_equiv.ts

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';
import {
  EBM_CAPTURE,
  EBM_FULL_CAPACITY_YEARS,
  EBM_SOLVER,
} from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import { acquireGpu } from '../src/sim/gpu/device_node';
import { createEbmGpu } from '../src/sim/gpu/ebm_gpu';
import { createEbmGpuBatchAccel } from '../src/sim/gpu/ebm_gpu_batch';
import type { EbmAccelResult, EbmStaticFields } from '../src/sim/accel';

/** 合否のしきい値(°C)。理想は 0(GPU 同士はビット一致するはず) */
const TOL_C = 1e-4;

/**
 * 月別気温(= 積算 / 回数)の最大絶対差。
 * 受入基準の monthlyTemperatureC は accel の monthAccum / monthCount から
 * 組み立てられる量なので、その最小構成で比べる。
 */
function maxMonthlyDiffC(a: EbmAccelResult, b: EbmAccelResult): number {
  let maxAbs = 0;
  for (let m = 0; m < a.monthAccum.length; m++) {
    const am = a.monthAccum[m]!;
    const bm = b.monthAccum[m]!;
    const ca = Math.max(1, a.monthCount[m] ?? 1);
    const cb = Math.max(1, b.monthCount[m] ?? 1);
    for (let i = 0; i < am.length; i++) {
      const d = Math.abs((am[i] ?? 0) / ca - (bm[i] ?? 0) / cb);
      if (d > maxAbs) maxAbs = d;
    }
  }
  return maxAbs;
}

/** 最終温度場の最大絶対差(参考値) */
function maxFinalDiffC(a: EbmAccelResult, b: EbmAccelResult): number {
  let maxAbs = 0;
  for (let i = 0; i < a.finalT.length; i++) {
    const d = Math.abs((a.finalT[i] ?? 0) - (b.finalT[i] ?? 0));
    if (d > maxAbs) maxAbs = d;
  }
  return maxAbs;
}

function convInfo(r: EbmAccelResult): string {
  return (
    `残差 ${r.maxResidualC.toExponential(3)} / 収束 ${r.converged ? '○' : '×'} / ` +
    `年次ドリフト(面積平均) ${r.meanYearDriftC.toExponential(3)}`
  );
}

async function main(): Promise<void> {
  // ---- 安い設定(2° 格子・反復固定・年数固定)----
  // 同値だけを見るので収束品質は要らない。結果を見て緩めたのではなく、
  // 実行前に「同値検証は安い設定で足りる」と決めている(check_ebm_gpu.ts と同じ理屈)
  const P = { ...EARTH_PARAMS, gridResolutionDeg: 2 };
  EBM_SOLVER.sweeps = 64; // 回数固定(適応の倍化を切る — 両版へ同じ回数を渡すため)
  EBM_FULL_CAPACITY_YEARS.years = 4; // 年数固定(4 + 加速期 2 = 6 年)

  // ---- 本物のパイプラインを 1 回まわして、加速器へ渡った入力を控える ----
  const accel = await openAccel();
  if (!accel.enabled) {
    console.error('GPU が使えないため同値検証を実行できない');
    process.exitCode = 1;
    return;
  }
  EBM_CAPTURE.enabled = true;
  console.log('パイプライン(2°)を 1 回実行して EBM の実入力を捕捉する…');
  await runPipeline(P, accel.opts);
  EBM_CAPTURE.enabled = false;
  const fields = EBM_CAPTURE.fields;
  const kBase = EBM_CAPTURE.constants;
  if (!fields || !kBase) throw new Error('EBM の入力を捕捉できなかった(GPU 経路が走っていない)');
  const N = fields.widthCells * fields.heightCells;
  console.log(
    `捕捉した入力: ${fields.widthCells}×${fields.heightCells} = ${N} セル、` +
      `${fields.years} 年(全熱容量 ${fields.fullCapacityYears} 年)、` +
      `反復 ${kBase.iterationsPerStep}、0 層海氷 ${kBase.slabIce ? '有効' : '無効'}`,
  );

  const ctx = await acquireGpu();
  if (!ctx) throw new Error('GPU コンテキストを取得できない');
  const single = createEbmGpu(ctx, N);
  let ok = true;

  // ---- ケース A: L=1(同一入力)----
  console.log('\n== ケース A: L=1(同一の入力)==');
  const batch1 = createEbmGpuBatchAccel(ctx, N, 1);
  const rSingleA = await single.run(fields, kBase);
  const rBatchA = (await batch1.runBatch([fields], [kBase]))[0]!;
  const dA = maxMonthlyDiffC(rSingleA, rBatchA);
  const dAF = maxFinalDiffC(rSingleA, rBatchA);
  console.log(`  単発: ${convInfo(rSingleA)}`);
  console.log(`  バッチ: ${convInfo(rBatchA)}`);
  console.log(
    `  月別気温の最大絶対差 ${dA.toExponential(3)}°C(最終温度場 ${dAF.toExponential(3)}°C)` +
      ` → ${dA <= TOL_C ? '✅ 合格' : '❌ 不合格'}(基準 ≤ ${TOL_C}°C)`,
  );
  if (dA > TOL_C) ok = false;
  batch1.destroy();

  // ---- ケース B: L=3(olrA を 203 / 205 / 207 に振る)----
  // olrA は EbmConstants ではなくセル場 aEff の切片
  // (step05: aEff[i] = aBase − B·Γ·h、aBase = olrA − 温室補正)。
  // olrA を δ 動かすことは aEff を一様に δ 動かすことと厳密に同値なので、
  // 水準は aEff をずらした fields で作る(f32 で作った同じ配列を両版へ渡す)
  console.log('\n== ケース B: L=3(olrA 203 / 205 / 207 W/m²)==');
  const targets = [203, 205, 207];
  const fieldsList: EbmStaticFields[] = targets.map((olrA) => {
    const delta = olrA - K.olrAWm2;
    const aEff = new Float32Array(fields.aEff.length);
    for (let i = 0; i < aEff.length; i++) aEff[i] = (fields.aEff[i] ?? 0) + delta;
    return { ...fields, aEff };
  });
  const kList = targets.map(() => ({ ...kBase }));

  const singles: EbmAccelResult[] = [];
  const t0 = performance.now();
  for (let j = 0; j < targets.length; j++) {
    singles.push(await single.run(fieldsList[j]!, kList[j]!));
  }
  const tSingle3 = performance.now() - t0;

  const batch3 = createEbmGpuBatchAccel(ctx, N, 3);
  const t1 = performance.now();
  const batched = await batch3.runBatch(fieldsList, kList);
  const tBatch3 = performance.now() - t1;

  for (let j = 0; j < targets.length; j++) {
    const d = maxMonthlyDiffC(singles[j]!, batched[j]!);
    const dF = maxFinalDiffC(singles[j]!, batched[j]!);
    console.log(`  水準 ${j}(olrA=${targets[j]}):`);
    console.log(`    単発: ${convInfo(singles[j]!)}`);
    console.log(`    バッチ: ${convInfo(batched[j]!)}`);
    console.log(
      `    月別気温の最大絶対差 ${d.toExponential(3)}°C(最終温度場 ${dF.toExponential(3)}°C)` +
        ` → ${d <= TOL_C ? '✅ 合格' : '❌ 不合格'}`,
    );
    if (d > TOL_C) ok = false;
  }

  // ---- ケース C: 実行時間(参考値。合否にしない)----
  console.log('\n== ケース C: 実行時間(参考値)==');
  console.log(`  単発 3 回の合計: ${(tSingle3 / 1000).toFixed(2)} 秒`);
  console.log(
    `  バッチ L=3:      ${(tBatch3 / 1000).toFixed(2)} 秒` +
      `(単発合計の ${(tSingle3 / tBatch3).toFixed(2)} 倍速)`,
  );
  console.log(
    '  ※ 2° 格子はセル数が 1° の 1/4 でコマンド律速がさらに強く、' +
      'バッチ化の効きはここでの数字より 1° 掃引で大きくなる見込み',
  );

  batch3.destroy();
  single.destroy();
  accel.close(); // デバイスを破棄(呼ばないと exit 139)

  console.log(`\n総合判定: ${ok ? '✅ 全ケース合格' : '❌ 不合格あり — バッチ版を直すこと'}`);
  if (!ok) process.exitCode = 1;
}

void main();
