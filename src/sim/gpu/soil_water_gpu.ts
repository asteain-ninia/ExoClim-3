// 土壌水分バケツ(R3)の WebGPU 実装。
//
// 対応 spec: docs/spec/06_降水.md「土壌水分の季節記憶」。
// CPU 実装 step06_precipitation.ts の solveSoilWater と同じ順序・同じ式で、
// 唯一の違いは貯水が f64 でなく f32 であること(GPU に倍精度は無い)。
//
// なぜこの形か(実機計測 2026-08-01):
//  - **セル間依存がまったく無い**(各陸セルが独立した月次バケツ)ので、
//    時間ループごと 1 カーネルに入れられる = readback を極小にできる。
//    これは性能上の都合ではなく、往復を数百回繰り返すと segfault する
//    という実測制約への対処でもある(src/sim/gpu/device.ts の注記参照)。
//  - 実測 3,145ms → 24ms(**121 倍**)。決定性は 3/3 でビット一致。
//  - 資源は**常駐**にする。バッファを毎回作り直すと 100 回未満でアクセス違反が
//    起きる。較正は 1 プロセスで数千回パイプラインを回すため必須。
//
// 精度について: 貯水は CPU(f64)と最大 6.7% ずれるが、これは
// **モデル自身が持つ縮退**のほうが大きい — 初期値を空 / 満杯に変えるだけで
// CPU 同士でも貯水が 100%、蒸発散が 5.3% 変わる(2026-08-01 実測)。
// 実際に下流へ渡るのは蒸発散で、そちらは CPU と 0.002% 一致する。

import { GPU_WORKGROUP_SIZE, ReadbackStage, asBufferSource, type GpuContext } from './device';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import type { SoilAccelResult, SoilWaterAccel } from '../accel';

/** 空回しをこの年数ごとに区切り、境界でだけ収束を確かめる(readback 削減) */
const YEARS_PER_BATCH = 32;

const WGSL = /* wgsl */ `
struct Params {
  cellCount  : u32,
  capacityMm : f32,
  petScale   : f32,
  years      : u32,
  recordYear : u32,
  _pad0      : u32,
  _pad1      : u32,
  _pad2      : u32,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read>       landMask : array<f32>;
@group(0) @binding(2) var<storage, read>       precip   : array<f32>;
@group(0) @binding(3) var<storage, read>       temp     : array<f32>;
@group(0) @binding(4) var<storage, read_write> storage_ : array<f32>;
@group(0) @binding(5) var<storage, read_write> drift    : array<f32>;
@group(0) @binding(6) var<storage, read_write> outStore : array<f32>;
@group(0) @binding(7) var<storage, read_write> outEt    : array<f32>;
@group(0) @binding(8) var<storage, read_write> outRunoff: array<f32>;
@group(0) @binding(9) var<storage, read_write> outWet   : array<f32>;

fn esHpa(t : f32) -> f32 {
  return 6.112 * exp(17.67 * t / (t + 243.5));
}
// 可能蒸発散(mm/月)。0°C 以下は凍結として 0
fn petMm(t : f32, scale : f32) -> f32 {
  if (t <= 0.0) { return 0.0; }
  return scale * esHpa(t) / esHpa(20.0);
}

@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.cellCount) { return; }
  if (landMask[i] < 0.5) { return; }

  var s = storage_[i];
  let cap = P.capacityMm;

  for (var y : u32 = 0u; y < P.years; y = y + 1u) {
    let isLast = (y + 1u == P.years);
    var yearStart = 0.0;
    if (isLast) { yearStart = s; }
    for (var m : u32 = 0u; m < 12u; m = m + 1u) {
      let idx = m * P.cellCount + i;
      // 第四 FB P0-2: 前月貯水へ当月降水を加えてから湿り度を決める
      let available = s + precip[idx];
      let pet = petMm(temp[idx], P.petScale);
      let wet = clamp(available / cap, 0.0, 1.0);
      let et = min(available, pet * wet);
      var rem = available - et;
      var runoff = 0.0;
      if (rem > cap) { runoff = rem - cap; rem = cap; }
      if (rem < 0.0) { rem = 0.0; }
      s = rem;
      if (P.recordYear == 1u && isLast) {
        outStore[idx] = s;
        outEt[idx] = et;
        outRunoff[idx] = runoff;
        outWet[idx] = wet;
      }
    }
    if (isLast) { drift[i] = s - yearStart; }
  }
  storage_[i] = s;
}
`;

/**
 * 土壌水分の周期定常解を GPU で解く常駐資源を作る。
 * セル数だけを固定し、場・定数は毎回渡す。
 */
export function createSoilWaterGpu(gpu: GpuContext, cellCount: number): SoilWaterAccel {
  const { device } = gpu;
  const N = cellCount;
  const M = MONTHS_PER_YEAR;
  const ST = GPUBufferUsage.STORAGE;
  const CS = GPUBufferUsage.COPY_SRC;
  const CD = GPUBufferUsage.COPY_DST;

  const bufLand = device.createBuffer({ size: N * 4, usage: ST | CD });
  const bufPrecip = device.createBuffer({ size: M * N * 4, usage: ST | CD });
  const bufTemp = device.createBuffer({ size: M * N * 4, usage: ST | CD });
  const bufStorage = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufDrift = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufOutStore = device.createBuffer({ size: M * N * 4, usage: ST | CS });
  const bufOutEt = device.createBuffer({ size: M * N * 4, usage: ST | CS });
  const bufOutRunoff = device.createBuffer({ size: M * N * 4, usage: ST | CS });
  const bufOutWet = device.createBuffer({ size: M * N * 4, usage: ST | CS });
  const bufParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | CD });
  // 最終読み戻しは 貯水 + 蒸発散 + 流出 + 湿り度 + ドリフト を 1 回の map で取る
  const stage = new ReadbackStage(device, 4 * M * N + N);

  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufParams } },
      { binding: 1, resource: { buffer: bufLand } },
      { binding: 2, resource: { buffer: bufPrecip } },
      { binding: 3, resource: { buffer: bufTemp } },
      { binding: 4, resource: { buffer: bufStorage } },
      { binding: 5, resource: { buffer: bufDrift } },
      { binding: 6, resource: { buffer: bufOutStore } },
      { binding: 7, resource: { buffer: bufOutEt } },
      { binding: 8, resource: { buffer: bufOutRunoff } },
      { binding: 9, resource: { buffer: bufOutWet } },
    ],
  });
  const groups = Math.ceil(N / GPU_WORKGROUP_SIZE);

  // 転送用の一時配列はバッファごとに別々に持つ(device.ts の注記)
  const scratchLand = new Float32Array(N);
  const scratchInit = new Float32Array(N);
  const scratchPrecip = new Float32Array(M * N);
  const scratchTemp = new Float32Array(M * N);
  const zeroMonth = new Float32Array(N);
  const paramBuf = new ArrayBuffer(32);

  const dispatch = (
    capacityMm: number,
    petScale: number,
    years: number,
    record: 0 | 1,
    copies: { src: GPUBuffer; at: number; n: number }[],
  ): void => {
    new Uint32Array(paramBuf, 0, 1)[0] = N;
    new Float32Array(paramBuf, 4, 2).set([capacityMm, petScale]);
    new Uint32Array(paramBuf, 12, 2).set([years, record]);
    device.queue.writeBuffer(bufParams, 0, paramBuf);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(groups);
    pass.end();
    // 計算と読み戻しのコピーは必ず 1 回の submit にまとめる(device.ts の注記)
    for (const c of copies) stage.enqueueCopyAt(enc, c.src, c.at, c.n);
    device.queue.submit([enc.finish()]);
  };

  return {
    destroy(): void {
      for (const b of [
        bufLand,
        bufPrecip,
        bufTemp,
        bufStorage,
        bufDrift,
        bufOutStore,
        bufOutEt,
        bufOutRunoff,
        bufOutWet,
        bufParams,
      ]) {
        b.destroy();
      }
      stage.destroy();
    },

    async run(input): Promise<SoilAccelResult> {
      const {
        landMask,
        precipByMonth,
        tempByMonth,
        capacityMm,
        petScaleMmPerMonth,
        maxYears,
        toleranceMm,
        initialStorage,
      } = input;

      for (let i = 0; i < N; i++) scratchLand[i] = landMask[i] ?? 0;
      for (let m = 0; m < M; m++) {
        scratchPrecip.set(precipByMonth[m] ?? zeroMonth, m * N);
        scratchTemp.set(tempByMonth[m] ?? zeroMonth, m * N);
      }
      if (initialStorage) {
        for (let i = 0; i < N; i++) {
          scratchInit[i] = Math.min(capacityMm, Math.max(0, initialStorage[i] ?? 0));
        }
      } else {
        scratchInit.fill(0);
      }
      device.queue.writeBuffer(bufLand, 0, asBufferSource(scratchLand));
      device.queue.writeBuffer(bufPrecip, 0, asBufferSource(scratchPrecip));
      device.queue.writeBuffer(bufTemp, 0, asBufferSource(scratchTemp));
      device.queue.writeBuffer(bufStorage, 0, asBufferSource(scratchInit));

      // ---- 空回し。readback はバッチ境界のみ ----
      const limitYears = Math.max(1, Math.round(maxYears));
      let years = 0;
      let converged = false;
      let meanDrift = Number.POSITIVE_INFINITY;
      while (years < limitYears) {
        const batch = Math.min(YEARS_PER_BATCH, limitYears - years);
        dispatch(capacityMm, petScaleMmPerMonth, batch, 0, [{ src: bufDrift, at: 0, n: N }]);
        years += batch;
        const d = await stage.map(N);
        // 総和は CPU 側で固定順に取る(GPU の並列リダクションは順序が不定)
        let sum = 0;
        let count = 0;
        for (let i = 0; i < N; i++) {
          if (scratchLand[i]! < 0.5) continue;
          sum += Math.abs(d[i] ?? 0);
          count++;
        }
        meanDrift = count > 0 ? sum / count : 0;
        if (meanDrift <= toleranceMm) {
          converged = true;
          break;
        }
      }
      // 収束後の 1 年を記録年にする(CPU 実装と同じ規約 —
      // 記録年そのものが周期定常であることを保証するため)
      dispatch(capacityMm, petScaleMmPerMonth, 1, 1, [
        { src: bufOutStore, at: 0, n: M * N },
        { src: bufOutEt, at: M * N, n: M * N },
        { src: bufOutRunoff, at: 2 * M * N, n: M * N },
        { src: bufOutWet, at: 3 * M * N, n: M * N },
        { src: bufDrift, at: 4 * M * N, n: N },
      ]);
      years += 1;
      const flat = await stage.map(4 * M * N + N);

      const storageMm: Float32Array[] = [];
      const actualEtMm: Float32Array[] = [];
      const runoffMm: Float32Array[] = [];
      const wetness01: Float32Array[] = [];
      const cut = (block: number, m: number): Float32Array =>
        flat.slice(block * M * N + m * N, block * M * N + (m + 1) * N);
      for (let m = 0; m < M; m++) {
        storageMm.push(cut(0, m));
        actualEtMm.push(cut(1, m));
        runoffMm.push(cut(2, m));
        wetness01.push(cut(3, m));
      }
      const storageChangeMm = flat.slice(4 * M * N, 4 * M * N + N);
      let maxDrift = 0;
      for (let i = 0; i < N; i++) {
        if (scratchLand[i]! < 0.5) continue;
        const ad = Math.abs(storageChangeMm[i] ?? 0);
        if (ad > maxDrift) maxDrift = ad;
      }

      return {
        actualEtMm,
        storageMm,
        runoffMm,
        wetness01,
        storageChangeMm,
        spinupYears: years,
        meanAnnualStorageDriftMm: meanDrift,
        maxAnnualStorageDriftMm: maxDrift,
        converged,
      };
    },
  };
}
