// GPU の readback を実使用の形で繰り返し、何回で落ちるかを測る。
//
// 背景: 事前調査で「mapAsync の往復を数百回繰り返すと確率的に segfault
// (500 回で 3/3)。同期・バッファプール・毎回新規生成は効かず、readback
// 回数を減らすことだけが効く」と分かっている。
//
// しかし較正は 1 ワーカープロセスで数千回パイプラインを回す。
// 1 回のパイプラインで readback が 6 回なら、1 チャンクで 4,000 回を超える。
// **常駐資源を作り直さずに繰り返す**という実使用の形で限界を測り、
//   (a) そもそも落ちるのか
//   (b) 落ちるなら何回目か
//   (c) デバイスを作り直せば回復するか
// を確かめる。
//
// 実行: npx tsx scripts/stress_gpu_readback.ts [繰り返し回数]

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { buildCrestElev, buildSmallWaterMask } from '../src/sim/step06_precipitation';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';
import { cellHeightKm } from '../src/domain/grid';
import { acquireGpu, releaseGpu } from '../src/sim/gpu/device_node';
import { createMoistureTraceGpu } from '../src/sim/gpu/moisture_trace_gpu';

const REPEATS = Number(process.argv[2] ?? 2000);
const EVERY = Number(process.argv[3] ?? 100);
/** 'full' = 転送も読み戻しもする / 'noread' = 読み戻さない / 'nowrite' = 転送しない */
const MODE = process.argv[4] ?? 'full';

/** 'real' = パイプラインを回して実データを使う / 'synth' = 合成データのみ */
const DATA = process.argv[5] ?? 'real';

async function main(): Promise<void> {
  let grid: { widthCells: number; heightCells: number; cellCount: number; resolutionDeg: number };
  let elevationMeters: Float32Array;
  let crestElev: Float32Array;
  let landMask: Float32Array;
  let smallWaterF: Float32Array;
  let radiusKm = 6371;
  let dyKm = 111.19;
  const temperature: Float32Array[] = [];
  const windU: Float32Array[] = [];
  const windV: Float32Array[] = [];

  if (DATA === 'synth') {
    const W = 360;
    const H = 180;
    const N = W * H;
    grid = { widthCells: W, heightCells: H, cellCount: N, resolutionDeg: 1 };
    const fill = (n: number, f: (i: number) => number): Float32Array => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = f(i);
      return a;
    };
    elevationMeters = fill(N, (i) => (i % 7) * 300);
    crestElev = fill(N, (i) => (i % 11) * 400);
    landMask = fill(N, (i) => (i % 3 === 0 ? 1 : 0));
    smallWaterF = fill(N, (i) => (i % 17 === 0 ? 1 : 0));
    for (let m = 0; m < 12; m++) {
      temperature.push(fill(N, (i) => 20 - (i % 50)));
      windU.push(fill(N, (i) => ((i % 13) - 6) * 1.5));
      windV.push(fill(N, (i) => ((i % 9) - 4) * 1.2));
    }
    console.log('合成データを使用(パイプラインを回さない)');
  } else {
    const result = await runPipeline(EARTH_PARAMS);
    const ctx = result.context;
    grid = ctx.grid;
    radiusKm = ctx.params.body.radiusKm;
    dyKm = cellHeightKm(ctx.grid, radiusKm);
    elevationMeters = ctx.terrain.elevationMeters;
    crestElev = buildCrestElev(ctx);
    landMask = Float32Array.from(ctx.terrain.landMask);
    smallWaterF = Float32Array.from(buildSmallWaterMask(ctx));
    for (let m = 0; m < 12; m++) {
      temperature.push(result.temperature.monthlyTemperatureC[m]!);
      windU.push(result.airflow.monthlyWindU[m]!);
      windV.push(result.airflow.monthlyWindV[m]!);
    }
  }

  const gpu = await acquireGpu();
  if (!gpu) {
    console.error('GPU を取得できない');
    process.exit(1);
  }
  console.log(`GPU: ${gpu.adapterInfo}`);
  console.log(`${REPEATS} 回の readback を試みる(100 回ごとに報告)`);

  const res = createMoistureTraceGpu(gpu, grid.cellCount);
  const fields = {
    widthCells: grid.widthCells,
    heightCells: grid.heightCells,
    dyKm,
    radiusKm,
    resolutionDeg: grid.resolutionDeg,
    elevationMeters,
    crestElevationMeters: crestElev,
    landMask,
    smallWater: smallWaterF,
  };
  const constants = {
    orographicDepletionM: K.orographicDepletionM,
    moistureTraceMaxKm: K.moistureTraceMaxKm,
    moistureDecayLandKm: K.moistureDecayLandKm,
    moistureDecayOceanKm: K.moistureDecayOceanKm,
    fetchOpenOceanCapKm: K.fetchOpenOceanCapKm,
  };

  const t0 = performance.now();
  let checksum = 0;
  for (let i = 1; i <= REPEATS; i++) {
    if (MODE === 'noread') {
      res.dispatchOnly(fields, constants, { temperature, windU, windV, landSource: null });
    } else {
      const out = await res.run(fields, constants, {
        temperature,
        windU,
        windV,
        landSource: null,
      });
      checksum += out[0]![12345] ?? 0;
    }
    if (i % EVERY === 0) {
      const ms = performance.now() - t0;
      console.log(
        `  ${String(i).padStart(5)} 回 完了 / 累計 ${(ms / 1000).toFixed(1)}s ` +
          `/ 1 回あたり ${(ms / i).toFixed(2)}ms`,
      );
    }
  }
  console.log(`全 ${REPEATS} 回を完走(checksum ${checksum.toFixed(3)})`);
  res.destroy();
  releaseGpu();
}

void main();
