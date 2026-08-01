// 風上追跡の GPU 実装を CPU 実装と突き合わせる。
//
// 対応: src/sim/gpu/moisture_trace_gpu.ts。
// 12 か月ぶんを 1 カーネルで解き(777,600 スレッド)、readback は 1 回。
// GPU を正・CPU を参照実装とする方針なので、完全一致ではなく
// 許容誤差で照合し、乖離が大きければバグとして検出する。
//
// 実行: npx tsx scripts/check_trace_gpu.ts

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import {
  traceMoistureSupply,
  buildCrestElev,
  buildSmallWaterMask,
} from '../src/sim/step06_precipitation';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';
import { cellHeightKm } from '../src/domain/grid';
import { acquireGpu, releaseGpu } from '../src/sim/gpu/device';
import { createMoistureTraceGpu } from '../src/sim/gpu/moisture_trace_gpu';

async function main(): Promise<void> {
  const result = await runPipeline(EARTH_PARAMS);
  const ctx = result.context;
  const grid = ctx.grid;
  const N = grid.cellCount;
  const smallWater = buildSmallWaterMask(ctx);
  const crestElev = buildCrestElev(ctx);
  const dyKm = cellHeightKm(grid, ctx.params.body.radiusKm);

  const temperature: Float32Array[] = [];
  const windU: Float32Array[] = [];
  const windV: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    temperature.push(result.temperature.monthlyTemperatureC[m]!);
    windU.push(result.airflow.monthlyWindU[m]!);
    windV.push(result.airflow.monthlyWindV[m]!);
  }

  // ---- CPU 参照(パス 1 相当: 陸は供給源にしない)----
  const t0 = performance.now();
  const cpu: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    cpu.push(
      traceMoistureSupply(
        ctx,
        smallWater,
        crestElev,
        temperature[m]!,
        windU[m]!,
        windV[m]!,
        null,
        0,
      ),
    );
  }
  const cpuMs = performance.now() - t0;
  console.log(`CPU: 12 か月で ${cpuMs.toFixed(0)}ms`);

  const gpu = await acquireGpu();
  if (!gpu) {
    console.error('GPU を取得できない');
    process.exit(1);
  }
  console.log(`GPU: ${gpu.adapterInfo}`);

  try {
    const fields = {
      widthCells: grid.widthCells,
      heightCells: grid.heightCells,
      dyKm,
      radiusKm: ctx.params.body.radiusKm,
      resolutionDeg: grid.resolutionDeg,
      elevationMeters: ctx.terrain.elevationMeters,
      crestElevationMeters: crestElev,
      landMask: Float32Array.from(ctx.terrain.landMask),
      smallWater: Float32Array.from(smallWater),
    };
    const constants = {
      orographicDepletionM: K.orographicDepletionM,
      moistureTraceMaxKm: K.moistureTraceMaxKm,
      moistureDecayLandKm: K.moistureDecayLandKm,
      moistureDecayOceanKm: K.moistureDecayOceanKm,
      fetchOpenOceanCapKm: K.fetchOpenOceanCapKm,
    };
    const monthly = { temperature, windU, windV, landSource: null };

    gpu.device.pushErrorScope('validation');
    const res = createMoistureTraceGpu(gpu, N);
    const err = await gpu.device.popErrorScope();
    if (err) console.error('[パイプライン生成エラー]', err.message);

    // 暖機(シェーダのコンパイルを計測から外す)
    gpu.device.pushErrorScope('validation');
    await res.run(fields, constants, monthly);
    const err2 = await gpu.device.popErrorScope();
    if (err2) console.error('[実行エラー]', err2.message);
    const t1 = performance.now();
    const out = await res.run(fields, constants, monthly);
    const gpuMs = performance.now() - t1;
    console.log(`GPU: 12 か月で ${gpuMs.toFixed(1)}ms(高速化 ${(cpuMs / gpuMs).toFixed(1)} 倍)`);

    // ---- 照合 ----
    let maxAbs = 0;
    let sumAbs = 0;
    let sumRef = 0;
    let n = 0;
    let refMax = 0;
    let worst = -1;
    for (let m = 0; m < 12; m++) {
      const a = out[m]!;
      const b = cpu[m]!;
      for (let i = 0; i < N; i++) {
        const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
        if (d > maxAbs) {
          maxAbs = d;
          worst = m * N + i;
        }
        sumAbs += d;
        sumRef += Math.abs(b[i] ?? 0);
        if (Math.abs(b[i] ?? 0) > refMax) refMax = Math.abs(b[i] ?? 0);
        n++;
      }
    }
    console.log(
      `照合: 最大差 ${maxAbs.toExponential(3)} / 平均差 ${(sumAbs / n).toExponential(3)} ` +
        `/ 平均値 ${(sumRef / n).toFixed(4)}(参照の最大 ${refMax.toFixed(3)})`,
    );
    console.log(`相対: 最大差 / 参照最大 = ${((maxAbs / refMax) * 100).toFixed(4)}%`);

    // 経路分岐の頻度: 追跡は丸め差で floor が別セルへ落ちると経路ごと変わる。
    // 平均差が極小でも一部のセルだけ大きくずれるのはこのため。何セルかを測る
    const thresholds = [1e-4, 1e-3, 1e-2, 1e-1, 1];
    const counts = new Array<number>(thresholds.length).fill(0);
    for (let m = 0; m < 12; m++) {
      const a = out[m]!;
      const b = cpu[m]!;
      for (let i = 0; i < N; i++) {
        const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
        for (let t = 0; t < thresholds.length; t++) if (d > thresholds[t]!) counts[t]!++;
      }
    }
    console.log('差の大きさ別のセル月数(全 ' + n.toLocaleString() + '):');
    for (let t = 0; t < thresholds.length; t++) {
      console.log(
        `  差 > ${thresholds[t]!.toExponential(0).padStart(6)}: ${counts[t]!.toLocaleString().padStart(9)} ` +
          `(${((counts[t]! / n) * 100).toFixed(4)}%)`,
      );
    }
    if (worst >= 0) {
      const m = Math.floor(worst / N);
      const i = worst % N;
      const row = Math.floor(i / grid.widthCells);
      const col = i % grid.widthCells;
      console.log(
        `  最大差の場所: ${m + 1} 月 / 緯度 ${(90 - (row + 0.5)).toFixed(1)}° ` +
          `経度 ${(-180 + col + 0.5).toFixed(1)}° / CPU ${cpu[m]![i]!.toFixed(4)} vs GPU ${out[m]![i]!.toFixed(4)}`,
      );
    }

    // ---- 決定性(3 回連続でビット一致するか)----
    const a1 = await res.run(fields, constants, monthly);
    const a2 = await res.run(fields, constants, monthly);
    let same = true;
    for (let m = 0; m < 12 && same; m++) {
      for (let i = 0; i < N; i++) {
        if (a1[m]![i] !== a2[m]![i]) {
          same = false;
          break;
        }
      }
    }
    console.log(`決定性: 連続 2 回が ${same ? 'ビット一致 ✓' : '不一致 ✗'}`);

    res.destroy();
  } finally {
    releaseGpu();
  }
}

void main();
