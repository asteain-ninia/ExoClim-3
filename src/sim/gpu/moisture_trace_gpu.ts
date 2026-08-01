// 風上追跡による水蒸気供給(step06 の traceMoistureSupply)の WebGPU 実装。
//
// 対応 spec: docs/spec/06_降水.md「水蒸気の供給」。
// CPU 実装と同じ順序・同じ式・同じ打ち切り条件で移植する。
//
// なぜここが本命か(実機計測 2026-08-01):
//   パイプライン全体 66.6s のうち step6 が 81%。その step6 を定数の切り替えで
//   切り分けると、土壌水分は 12% しかなく、**88% が風上追跡と変換**だった。
//   当初「土壌が支配的」と見立てたのは誤りで、土壌を 121 倍にしても全体では
//   1.1 倍にしかならない。
//
// 設計(src/sim/gpu/device.ts の実測制約に従う):
//   - **12 か月を 1 カーネルにまとめる**。1 セル 1 月を 1 スレッドに割り当てると
//     64,800 × 12 = 777,600 スレッドになり GPU が埋まる。dispatch と readback が
//     1/12 になるのも重要(往復は 1 回 0.3ms の固定費 + 数百回で segfault)。
//   - 追跡は各スレッドが自分だけで完結する(近傍との通信なし)。読むのは
//     標高・稜線・陸海・内海・気温・風・陸面供給で、すべて読み取り専用。

import { GPU_WORKGROUP_SIZE, ReadbackStage, asBufferSource, type GpuContext } from './device';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import type {
  MoistureTraceAccel,
  TraceConstants,
  TraceMonthlyFields,
  TraceStaticFields,
} from '../accel';

const WGSL = /* wgsl */ `
struct Params {
  width           : u32,
  height          : u32,
  cellCount       : u32,
  maxSteps        : u32,
  dyKm            : f32,
  radiusKm        : f32,
  resolutionDeg   : f32,
  stepWeight      : f32,
  depletionM      : f32,
  traceMaxKm      : f32,
  decayLandKm     : f32,
  decayOceanKm    : f32,
  fetchCapKm      : f32,
  hasLandSource   : u32,
  _pad0           : u32,
  _pad1           : u32,
};

@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read> elev       : array<f32>;
@group(0) @binding(2) var<storage, read> crest      : array<f32>;
@group(0) @binding(3) var<storage, read> landMask   : array<f32>;
@group(0) @binding(4) var<storage, read> smallWater : array<f32>;
@group(0) @binding(5) var<storage, read> temperature: array<f32>;  // 12*N
@group(0) @binding(6) var<storage, read> windU      : array<f32>;  // 12*N
@group(0) @binding(7) var<storage, read> windV      : array<f32>;  // 12*N
@group(0) @binding(8) var<storage, read> landSource : array<f32>;  // 12*N
@group(0) @binding(9) var<storage, read_write> supplyOut : array<f32>; // 12*N

fn esHpa(t : f32) -> f32 {
  return 6.112 * exp(17.67 * t / (t + 243.5));
}

fn wrapCol(c : i32, w : i32) -> i32 {
  var x = c % w;
  if (x < 0) { x = x + w; }
  return x;
}

// 行の東西セル寸法(km)。CPU の cellWidthKm と同じ式、下限 20km も同じ
fn cellWidthKmOf(row : i32) -> f32 {
  let lat = 90.0 - (f32(row) + 0.5) * P.resolutionDeg;
  let w = P.radiusKm * (P.resolutionDeg * 0.017453292519943295) * cos(lat * 0.017453292519943295);
  return max(20.0, w);
}

@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let flat = gid.x;
  if (flat >= P.cellCount * 12u) { return; }
  let month = flat / P.cellCount;
  let i0 = flat % P.cellCount;
  let W = i32(P.width);
  let H = i32(P.height);
  let row0 = i32(i0) / W;
  let col0 = i32(i0) % W;
  let base = month * P.cellCount;

  let dxKm = cellWidthKmOf(row0);
  let dyKm = P.dyKm;
  let q0 = esHpa(20.0);

  var fr = f32(row0) + 0.5;
  var fc = f32(col0) + 0.5;
  var traveledKm = 0.0;
  var attenuation = 1.0;
  var supply = 0.0;

  // Fetch 則(WL#32): 閉じた内海の湿潤は水域の風上幅までしか内陸へ届かない。
  // 内海ごとに供給を保留し、横断幅が確定した時点でゲートを掛けて計上する
  var landKmFromTarget = 0.0;
  var inWater = false;
  var bodyFetchKm = 0.0;
  var bodyLandAtEntry = 0.0;
  var pendingSupply = 0.0;

  let targetElev = max(0.0, elev[i0]);
  var maxBarrierM = targetElev;

  for (var step : u32 = 0u; step < P.maxSteps; step = step + 1u) {
    let r = clamp(i32(floor(fr)), 0, H - 1);
    let c = wrapCol(i32(floor(fc)), W);
    let i = u32(r * W + c);

    let eHere = max(0.0, elev[i]);
    // 障壁は稜線推定標高で判定(狭い山脈が 1° 平均で均される問題への対策)
    let crestHere = crest[i];
    if (crestHere > maxBarrierM) { maxBarrierM = crestHere; }
    let barrierOver = max(0.0, maxBarrierM - max(eHere, targetElev));
    let barrierFactor = max(0.25, exp(-barrierOver / P.depletionM));
    let qRel = (esHpa(temperature[base + i]) / q0) * barrierFactor;

    let isLand = landMask[i] >= 0.5;
    let isSmall = smallWater[i] >= 0.5;

    if (!isLand) {
      if (isSmall) {
        if (!inWater) {
          inWater = true;
          bodyLandAtEntry = landKmFromTarget;
          bodyFetchKm = 0.0;
          pendingSupply = 0.0;
        }
        pendingSupply = pendingSupply + attenuation * qRel * P.stepWeight;
      } else {
        if (inWater) {
          inWater = false;
          // commitBody: Fetch を超えた先も完全遮断はしない(下限 0.12)
          if (pendingSupply > 0.0) {
            let reach = min(bodyFetchKm, P.fetchCapKm);
            let f = min(1.0, max(0.12, (reach + 250.0 - bodyLandAtEntry) / 500.0));
            supply = supply + pendingSupply * f;
          }
          pendingSupply = 0.0;
          bodyFetchKm = 0.0;
        }
        supply = supply + attenuation * qRel * P.stepWeight;
      }
    } else {
      if (inWater) {
        inWater = false;
        if (pendingSupply > 0.0) {
          let reach = min(bodyFetchKm, P.fetchCapKm);
          let f = min(1.0, max(0.12, (reach + 250.0 - bodyLandAtEntry) / 500.0));
          supply = supply + pendingSupply * f;
        }
        pendingSupply = 0.0;
        bodyFetchKm = 0.0;
      }
      if (P.hasLandSource == 1u) {
        supply = supply + attenuation * qRel * landSource[base + i] * P.stepWeight;
      }
    }

    if (traveledKm >= P.traceMaxKm) { break; }

    // 風上へ 1 セルぶん移動(風が弱い所は打ち切り)
    let uu = windU[base + i];
    let vv = windV[base + i];
    let speed = sqrt(uu * uu + vv * vv);
    if (speed < 0.5) { break; }
    let stepKm = dyKm;
    fc = fc + (-uu / speed) * (stepKm / dxKm);
    // 北向き風 → 南から来た(row 増加方向)
    fr = fr + (vv / speed) * (stepKm / dyKm);
    if (fr < 0.0 || fr >= f32(H)) { break; }
    traveledKm = traveledKm + stepKm;
    if (isLand) {
      landKmFromTarget = landKmFromTarget + stepKm;
    } else if (isSmall) {
      bodyFetchKm = bodyFetchKm + stepKm;
    }
    var decayKm = P.decayOceanKm;
    if (isLand) { decayKm = P.decayLandKm; }
    attenuation = attenuation * exp(-stepKm / decayKm);
    if (attenuation < 0.02) { break; }
  }

  // 途中終了した水域の保留分を精算
  if (inWater && pendingSupply > 0.0) {
    let reach = min(bodyFetchKm, P.fetchCapKm);
    let f = min(1.0, max(0.12, (reach + 250.0 - bodyLandAtEntry) / 500.0));
    supply = supply + pendingSupply * f;
  }

  supplyOut[base + i0] = supply;
}
`;

/** GPU 側の常駐資源。月ごと・反復ごとに作り直さない */
export interface TraceGpuResources extends MoistureTraceAccel {
  /** 読み戻さずに計算だけ投げる(安定性の切り分け用) */
  dispatchOnly(
    fields: TraceStaticFields,
    constants: TraceConstants,
    monthly: TraceMonthlyFields,
  ): void;
}

/**
 * セル数だけを固定した常駐資源を作る。
 *
 * 静的な場(標高・稜線・陸海・内海)も**毎回転送する**。1MB 弱なので費用は
 * 無視でき、地形が変わる呼び出し(惑星を変える較正・デーレ)でキャッシュの
 * 無効化を誤る危険を無くせる。正しさを微小な最適化より優先する。
 */
export function createMoistureTraceGpu(gpu: GpuContext, cellCount: number): TraceGpuResources {
  const { device } = gpu;
  const N = cellCount;
  const M = MONTHS_PER_YEAR;
  const ST = GPUBufferUsage.STORAGE;
  const CS = GPUBufferUsage.COPY_SRC;
  const CD = GPUBufferUsage.COPY_DST;

  const bufElev = device.createBuffer({ size: N * 4, usage: ST | CD });
  const bufCrest = device.createBuffer({ size: N * 4, usage: ST | CD });
  const bufLand = device.createBuffer({ size: N * 4, usage: ST | CD });
  const bufSmall = device.createBuffer({ size: N * 4, usage: ST | CD });
  const bufTemp = device.createBuffer({ size: M * N * 4, usage: ST | CD });
  const bufU = device.createBuffer({ size: M * N * 4, usage: ST | CD });
  const bufV = device.createBuffer({ size: M * N * 4, usage: ST | CD });
  const bufLandSrc = device.createBuffer({ size: M * N * 4, usage: ST | CD });
  const bufOut = device.createBuffer({ size: M * N * 4, usage: ST | CS });
  const bufParams = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | CD });

  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bufParams } },
      { binding: 1, resource: { buffer: bufElev } },
      { binding: 2, resource: { buffer: bufCrest } },
      { binding: 3, resource: { buffer: bufLand } },
      { binding: 4, resource: { buffer: bufSmall } },
      { binding: 5, resource: { buffer: bufTemp } },
      { binding: 6, resource: { buffer: bufU } },
      { binding: 7, resource: { buffer: bufV } },
      { binding: 8, resource: { buffer: bufLandSrc } },
      { binding: 9, resource: { buffer: bufOut } },
    ],
  });

  // 読み戻しは常駐バッファで行う(毎回作り直すと 100 回未満で segfault する)
  const stage = new ReadbackStage(device, M * N);
  const groups = Math.ceil((M * N) / GPU_WORKGROUP_SIZE);

  // 転送用の一時配列は**バッファごとに別々に**持つ。使い回すと同じ配列を
  // 続けて writeBuffer へ渡すことになり、実測で不安定だった(2026-08-01)
  const zeroMonth = new Float32Array(N);
  const scratches = new Map<GPUBuffer, Float32Array>();
  const upload = (buf: GPUBuffer, arrs: Float32Array[] | null): void => {
    let flat = scratches.get(buf);
    if (!flat) {
      flat = new Float32Array(M * N);
      scratches.set(buf, flat);
    }
    if (arrs) {
      for (let m = 0; m < M; m++) flat.set(arrs[m] ?? zeroMonth, m * N);
    } else {
      flat.fill(0);
    }
    device.queue.writeBuffer(buf, 0, asBufferSource(flat));
  };
  const uploadStatic = (buf: GPUBuffer, a: Float32Array): void => {
    let s = scratches.get(buf);
    if (!s) {
      s = new Float32Array(N);
      scratches.set(buf, s);
    }
    s.set(a.length === N ? a : a.subarray(0, N));
    device.queue.writeBuffer(buf, 0, asBufferSource(s));
  };

  return {
    destroy(): void {
      for (const b of [
        bufElev,
        bufCrest,
        bufLand,
        bufSmall,
        bufTemp,
        bufU,
        bufV,
        bufLandSrc,
        bufOut,
        bufParams,
      ]) {
        b.destroy();
      }
      stage.destroy();
    },
    dispatchOnly(
      fields: TraceStaticFields,
      constants: TraceConstants,
      monthly: TraceMonthlyFields,
    ): void {
      submit(fields, constants, monthly, false);
    },
    async run(
      fields: TraceStaticFields,
      constants: TraceConstants,
      monthly: TraceMonthlyFields,
    ): Promise<Float32Array[]> {
      if (fields.widthCells * fields.heightCells !== N) {
        throw new Error(
          `追跡器のセル数が違う(確保 ${N} / 要求 ${fields.widthCells * fields.heightCells})`,
        );
      }
      // 計算と読み戻しのコピーは 1 回の submit にまとめる(device.ts の注記)
      submit(fields, constants, monthly, true);
      const flat = await stage.map(M * N);
      const out: Float32Array[] = [];
      for (let m = 0; m < M; m++) out.push(flat.slice(m * N, (m + 1) * N));
      return out;
    },
  };

  function submit(
    fields: TraceStaticFields,
    constants: TraceConstants,
    monthly: TraceMonthlyFields,
    withCopy: boolean,
  ): void {
    uploadStatic(bufElev, fields.elevationMeters);
    uploadStatic(bufCrest, fields.crestElevationMeters);
    uploadStatic(bufLand, fields.landMask);
    uploadStatic(bufSmall, fields.smallWater);
    upload(bufTemp, monthly.temperature);
    upload(bufU, monthly.windU);
    upload(bufV, monthly.windV);
    upload(bufLandSrc, monthly.landSource);

    // CPU 実装と同じ打ち切り(距離基準。解像度を変えても挙動が変わらないように)
    const maxSteps = Math.min(200, Math.ceil(constants.moistureTraceMaxKm / fields.dyKm) + 4);
    const stepWeight = fields.dyKm / 111;
    const u = new ArrayBuffer(64);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = fields.widthCells;
    ui[1] = fields.heightCells;
    ui[2] = N;
    ui[3] = maxSteps;
    uf[4] = fields.dyKm;
    uf[5] = fields.radiusKm;
    uf[6] = fields.resolutionDeg;
    uf[7] = stepWeight;
    uf[8] = constants.orographicDepletionM;
    uf[9] = constants.moistureTraceMaxKm;
    uf[10] = constants.moistureDecayLandKm;
    uf[11] = constants.moistureDecayOceanKm;
    uf[12] = constants.fetchOpenOceanCapKm;
    ui[13] = monthly.landSource ? 1 : 0;
    device.queue.writeBuffer(bufParams, 0, u);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(groups);
    pass.end();
    if (withCopy) stage.enqueueCopy(enc, bufOut, M * N);
    device.queue.submit([enc.finish()]);
  }
}
