// ベンチ: **掃引バッチ化の go/no-go — 水準 L を第 3 軸にした赤黒スイープの実測。**
//
// なぜ要るか(2026-08-20、申し送り 実験記録_掃引のGPUバッチ化案_2026-08-19):
//   1° 格子(64,800 セル、254 WG)は RTX 4080 に対して 1 ディスパッチが小さく、
//   掃引はコマンド律速(使用率 100% 表示で 70W)。水準 L をまとめて
//   g = level×n + cell で 1 ディスパッチに載せれば、ディスパッチ回数そのままで
//   ワークグループだけ 254→254L に増える。見込み 5〜8 倍(帯域律速の壁あり)。
//   **大改修の前に、この形の 1 反復あたり実仕事時間 t1(L) を実測する。**
//
// 何を測るか: 本物の sweepCell と同じメモリアクセス形(work 12 面 + temp、
//   セルあたり約 14 読み)のカーネルを L∈{1,2,4,8,16} で 4096 反復
//   (red+black で 8192 ディスパッチ)回し、壁時間を比べる。
//   数値の検証はここではしない(形だけ本物に合わせた合成データ)。
//   判定: t(L)/t(1) が 1.5 以下なら L 倍近いスループット = go。
//
// 実行: npx tsx scripts/bench_gpu_batch.ts

import { acquireGpu, releaseGpu } from '../src/sim/gpu/device_node';
import { GPU_WORKGROUP_SIZE, createFilledBuffer } from '../src/sim/gpu/device';

const CW = 360;
const CH = 180;
const N = CW * CH;
const ITERS = 4096;
const LEVELS = [1, 2, 4, 8, 16];

function shader(l: number): string {
  return /* wgsl */ `
struct Params { n : u32, cw : u32, ch : u32, levels : u32 }
@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read> work : array<f32>;
@group(0) @binding(2) var<storage, read_write> temp : array<f32>;

fn workF(plane : u32, g : u32) -> f32 {
  // 12 面 × (L×N) の平面配列(本物と同じ「面が先」の配置)
  return work[plane * ${l}u * P.n + g];
}

fn sweepCell(g : u32, color : u32) {
  let n = P.n;
  let lvl = g / n;
  let i = g % n;
  let W = P.cw;
  let r = i / W;
  let c = i % W;
  if ((r + c) % 2u != color) { return; }
  let base = lvl * n;
  let east = base + r * W + ((c + 1u) % W);
  let west = base + r * W + ((c + W - 1u) % W);
  var north = base + i;
  if (r > 0u) { north = base + (r - 1u) * W + c; }
  var south = base + i;
  if (r < P.ch - 1u) { south = base + (r + 1u) * W + c; }
  let off =
    workF(2u, g) * temp[east] +
    workF(3u, g) * temp[west] +
    workF(4u, g) * temp[north] +
    workF(5u, g) * temp[south] +
    workF(6u, g) * temp[u32(workF(8u, g)) + base] +
    workF(7u, g) * temp[u32(workF(9u, g)) + base];
  temp[g] = (workF(0u, g) + off) / max(1.0, workF(1u, g));
}

@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepRed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n * P.levels) { return; }
  sweepCell(gid.x, 0u);
}
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepBlack(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n * P.levels) { return; }
  sweepCell(gid.x, 1u);
}
`;
}

async function benchLevel(l: number): Promise<number> {
  const ctx = await acquireGpu();
  if (!ctx) throw new Error('GPU が使えない');
  const { device } = ctx;
  const module = device.createShaderModule({ code: shader(l) });
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const pipeRed = device.createComputePipeline({
    layout,
    compute: { module, entryPoint: 'sweepRed' },
  });
  const pipeBlack = device.createComputePipeline({
    layout,
    compute: { module, entryPoint: 'sweepBlack' },
  });

  const params = new Uint32Array([N, CW, CH, l]);
  const bufParams = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(bufParams, 0, params);

  // work: 12 面 × L×N。係数は小さめの乱数、風上添字(面 8,9)はセル内に収める
  const work = new Float32Array(12 * l * N);
  for (let p = 0; p < 12; p++) {
    for (let g = 0; g < l * N; g++) {
      const idx = p * l * N + g;
      if (p === 8 || p === 9) work[idx] = g % N;
      else if (p === 1) work[idx] = 4 + Math.random();
      else work[idx] = Math.random() * 0.2;
    }
  }
  const bufWork = createFilledBuffer(device, work, GPUBufferUsage.STORAGE);
  const temp = new Float32Array(l * N).fill(15);
  const bufTemp = createFilledBuffer(
    device,
    temp,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  );

  const bind = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: bufParams } },
      { binding: 1, resource: { buffer: bufWork } },
      { binding: 2, resource: { buffer: bufTemp } },
    ],
  });

  const groups = Math.ceil((l * N) / GPU_WORKGROUP_SIZE);
  // 本物と同じ「1 submit に反復を詰める」形(512 反復/submit)
  const ITER_PER_SUBMIT = 512;
  const t0 = performance.now();
  for (let done = 0; done < ITERS; done += ITER_PER_SUBMIT) {
    const enc = device.createCommandEncoder();
    for (let it = 0; it < ITER_PER_SUBMIT; it++) {
      for (const p of [pipeRed, pipeBlack]) {
        const pass = enc.beginComputePass();
        pass.setPipeline(p);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(groups);
        pass.end();
      }
    }
    device.queue.submit([enc.finish()]);
  }
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  bufWork.destroy();
  bufTemp.destroy();
  bufParams.destroy();
  return ms;
}

async function main(): Promise<void> {
  console.log(`格子 ${CW}×${CH}、反復 ${ITERS}(red+black)、512 反復/submit`);
  let t1 = 0;
  for (const l of LEVELS) {
    const ms = await benchLevel(l);
    if (l === 1) t1 = ms;
    const ratio = ms / Math.max(1e-9, t1);
    const speedup = (l / ratio).toFixed(2);
    console.log(
      `L=${String(l).padEnd(3)} ${ms.toFixed(0).padStart(7)} ms  対 L=1 比 ${ratio.toFixed(2)}  実効スループット ${speedup} 倍`,
    );
  }
  console.log(
    '\n判定(事前の基準): L=8 の対 L=1 比が 1.5 以下なら go(≈5 倍超)。' +
      '3 を超えるなら帯域律速でバッチ化の旨みは薄い — 大改修に入らない。',
  );
  releaseGpu();
}

void main();
