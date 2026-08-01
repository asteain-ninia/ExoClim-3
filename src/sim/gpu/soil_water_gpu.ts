// 土壌水分バケツ(R3)の WebGPU 実装。
//
// 対応 spec: docs/spec/06_降水.md「土壌水分の季節記憶」。
// CPU 実装 step06_precipitation.ts の solveSoilWater と同じ順序・同じ式で、
// 唯一の違いは貯水が f64 でなく f32 であること(GPU に倍精度は無い)。
//
// なぜこの形か(実機計測 2026-08-01):
//  - 土壌バケツはパイプライン最大の負荷。1 回 3,145ms で結合反復が最大 8 回呼ぶ。
//    step6 の 24.8 秒のほとんどがこれ。
//  - **セル間依存がまったく無い**(各陸セルが独立した月次バケツ)ので、
//    時間ループごと 1 カーネルに入れられる = readback を極小にできる。
//    これは性能上の都合ではなく、往復を数百回繰り返すと segfault する
//    という実測制約への対処でもある(src/sim/gpu/device.ts の注記参照)。
//  - 実測 3,145ms → 24ms(**121 倍**)。決定性は 3/3 でビット一致。
//
// 精度について: 貯水は CPU(f64)と最大 6.7% ずれるが、これは
// **モデル自身が持つ縮退**のほうが大きい — 初期値を空 / 満杯に変えるだけで
// CPU 同士でも貯水が 100%、蒸発散が 5.3% 変わる(2026-08-01 実測)。
// 実際に下流へ渡るのは蒸発散で、そちらは CPU と 0.002% 一致する。

import { GPU_WORKGROUP_SIZE, createFilledBuffer, readBackFloats, type GpuContext } from './device';
import { MONTHS_PER_YEAR } from '@/domain/insolation';

/** 空回しをこの年数ごとに区切り、境界でだけ収束を確かめる(readback 削減) */
const YEARS_PER_BATCH = 32;

export interface GpuSoilResult {
  /** [month][cell] 実蒸発散 mm/月 */
  actualEtMm: Float32Array[];
  /** [month][cell] 月末貯水 mm */
  storageMm: Float32Array[];
  /** [cell] 記録年の貯水変化 */
  storageChangeMm: Float32Array;
  spinupYears: number;
  meanAnnualStorageDriftMm: number;
  converged: boolean;
}

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
      if (rem > cap) { rem = cap; }
      if (rem < 0.0) { rem = 0.0; }
      s = rem;
      if (P.recordYear == 1u && isLast) {
        outStore[idx] = s;
        outEt[idx] = et;
      }
    }
    if (isLast) { drift[i] = s - yearStart; }
  }
  storage_[i] = s;
}
`;

/**
 * 土壌水分の周期定常解を GPU で解く。
 * @param toleranceMm 陸セル平均の年間ドリフトがこれを下回れば収束とみなす
 */
export async function solveSoilWaterGpu(
  gpu: GpuContext,
  cellCount: number,
  landMask: ArrayLike<number>,
  precipByMonth: Float32Array[],
  tempByMonth: Float32Array[],
  capacityMm: number,
  petScaleMmPerMonth: number,
  maxYears: number,
  toleranceMm: number,
  initialStorage?: ArrayLike<number>,
): Promise<GpuSoilResult> {
  const { device } = gpu;
  const N = cellCount;
  const M = MONTHS_PER_YEAR;

  const landF = new Float32Array(N);
  for (let i = 0; i < N; i++) landF[i] = landMask[i] ?? 0;
  const flatten = (arrs: Float32Array[]): Float32Array => {
    const out = new Float32Array(M * N);
    for (let m = 0; m < M; m++) out.set(arrs[m] ?? new Float32Array(N), m * N);
    return out;
  };
  const initial = new Float32Array(N);
  if (initialStorage) {
    for (let i = 0; i < N; i++) {
      initial[i] = Math.min(capacityMm, Math.max(0, initialStorage[i] ?? 0));
    }
  }

  const ST = GPUBufferUsage.STORAGE;
  const CS = GPUBufferUsage.COPY_SRC;
  const CD = GPUBufferUsage.COPY_DST;
  const bufLand = createFilledBuffer(device, landF, ST);
  const bufPrecip = createFilledBuffer(device, flatten(precipByMonth), ST);
  const bufTemp = createFilledBuffer(device, flatten(tempByMonth), ST);
  const bufStorage = createFilledBuffer(device, initial, ST | CS | CD);
  const bufDrift = createFilledBuffer(device, new Float32Array(N), ST | CS);
  const bufOutStore = createFilledBuffer(device, new Float32Array(M * N), ST | CS);
  const bufOutEt = createFilledBuffer(device, new Float32Array(M * N), ST | CS);
  const bufParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | CD });

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
    ],
  });
  const groups = Math.ceil(N / GPU_WORKGROUP_SIZE);

  const dispatch = (years: number, record: 0 | 1): void => {
    const u = new ArrayBuffer(32);
    new Uint32Array(u, 0, 1)[0] = N;
    new Float32Array(u, 4, 2).set([capacityMm, petScaleMmPerMonth]);
    new Uint32Array(u, 12, 2).set([years, record]);
    device.queue.writeBuffer(bufParams, 0, u);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(groups);
    pass.end();
    device.queue.submit([enc.finish()]);
  };

  // ---- 空回し。readback はバッチ境界のみ ----
  const limitYears = Math.max(1, Math.round(maxYears));
  let years = 0;
  let converged = false;
  let meanDrift = Number.POSITIVE_INFINITY;
  while (years < limitYears) {
    const batch = Math.min(YEARS_PER_BATCH, limitYears - years);
    dispatch(batch, 0);
    years += batch;
    const d = await readBackFloats(device, bufDrift, N);
    // 総和は CPU 側で固定順に取る(GPU の並列リダクションは順序が不定)
    let sum = 0;
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (landF[i]! < 0.5) continue;
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
  dispatch(1, 1);
  years += 1;
  const flatStore = await readBackFloats(device, bufOutStore, M * N);
  const flatEt = await readBackFloats(device, bufOutEt, M * N);
  const change = await readBackFloats(device, bufDrift, N);

  for (const b of [
    bufLand,
    bufPrecip,
    bufTemp,
    bufStorage,
    bufDrift,
    bufOutStore,
    bufOutEt,
    bufParams,
  ]) {
    b.destroy();
  }

  const storageMm: Float32Array[] = [];
  const actualEtMm: Float32Array[] = [];
  for (let m = 0; m < M; m++) {
    storageMm.push(flatStore.slice(m * N, (m + 1) * N));
    actualEtMm.push(flatEt.slice(m * N, (m + 1) * N));
  }
  return {
    actualEtMm,
    storageMm,
    storageChangeMm: change,
    spinupYears: years,
    meanAnnualStorageDriftMm: meanDrift,
    converged,
  };
}
