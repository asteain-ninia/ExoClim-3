// EBM(step5 気温)の時間積分の WebGPU 実装。
//
// 対応 spec: docs/spec/05_気温.md。CPU 実装 step05_temperature.ts の integrate()
// と同じ式・同じ作用素で移植する。
//
// なぜ GPU 化が**正しさの要求**でもあるか(2026-08-01 の実測):
//   陰的ステップの線形解を 8 スイープで打ち切っていたが、16・32・…・256 と
//   増やすと気温場が面積平均で計 2.1°C 動いた。つまり打ち切り回数が答えを
//   決めており、拡散・移流係数はその誤差を打ち消す向きに較正されていた
//   (CLAUDE.md が禁じる隠しパラメータ)。収束には 1 ステップあたり 256 反復
//   要り、CPU では 1 回の実行に 5 分以上かかって較正が回らない。
//   詳細: docs/実験記録_EBM赤黒順序_2026-08-01.md
//
// 設計(src/sim/gpu/device.ts の実測制約に従う):
//   - 反復は**赤黒順序**。市松の色は (row+col) の偶奇で、5 点ステンシルの
//     隣接は必ず相手色なので同色内は完全に並列。収束解は一意なので、
//     行優先 Gauss-Seidel と同じ答えになる(実測: 大分類の差 0.01pt)。
//   - **1 時間ステップ = 1 submit**。1 つのコマンドエンコーダへ
//     前処理 2 回 + 反復 3×N 回 + 残差 1 回をまとめて積む。ディスパッチは
//     エンコーダ内なら安いが、submit と読み戻しは高い(往復 1 回 0.3ms)。
//   - **読み戻しは積分が終わってから 1 回だけ**。往復を数百回繰り返すと
//     不安定になる実測制約への対処。
//   - 残差は**合成作用素の変化量**で測る。掃引と極行平滑は互いに押し戻すため、
//     掃引だけの変化量は 0 に落ちない(極行で下げ止まる)。
//     1 反復まるごとの前後差を見るのが正しい収束判定。

import { GPU_WORKGROUP_SIZE, ReadbackStage, asBufferSource, type GpuContext } from './device';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import type { EbmAccel, EbmAccelResult, EbmConstants, EbmStaticFields } from '../accel';

/** セル別静的場の本数(WGSL 側の添字と一致させる) */
const CELL_FIELDS = 10;
/** 作業領域の本数 */
const WORK_FIELDS = 12;
/** 残差バッファに収まる時間ステップ数の上限 */
const MAX_STEPS = 8192;

const WGSL = /* wgsl */ `
struct Params {
  cw : u32, ch : u32, n : u32, iters : u32,
  m0 : u32, m1 : u32, monthIndex : u32, stepIndex : u32,
  frac : f32, capScale : f32, dtSec : f32, gamma : f32,
  iceRamp : f32, albedoIce : f32, permIceAlbedo : f32, seaIceInsul : f32,
  olrB : f32, dBase : f32, zonalDiff : f32, hadleyBoost : f32,
  chanFactor : f32, summerAdv : f32, advCoupling : f32, winterInvDiff : f32,
  winterInvAdv : f32, dPhi : f32, resDeg : f32, ridgeAbsN : f32,
  ridgeAbsS : f32, summerN : u32, summerS : u32, hasEvap : u32,
  accumulate : u32, _p0 : u32, _p1 : u32, _p2 : u32,
};

@group(0) @binding(0) var<uniform> P : Params;
// セル別静的場: 0 heatCap, 1 aEff, 2 surfAlbedoBase, 3 iceOnset, 4 qFlux,
//               5 elevM, 6 landFrac, 7 diffFactor, 8 interior01, 9 permanentIce
@group(0) @binding(1) var<storage, read> cells : array<f32>;
// 行別(間隔は ch): 0 cosCenter, 1 metricZonal, 2 rowIsChannel, 3 insolAnnual,
//                   4.. 12 か月の日射
@group(0) @binding(2) var<storage, read> rows : array<f32>;
// 月別セル別(各 12*N): 0 cloud, 1 windU, 2 windV, 3 evap
@group(0) @binding(3) var<storage, read> monthly : array<f32>;
@group(0) @binding(4) var<storage, read_write> temp : array<f32>;
// 作業: 0 rhs, 1 diag, 2 gzE, 3 gzW, 4 gN, 5 gS, 6 advCu, 7 advCv,
//       8 upwindU, 9 upwindV, 10 dfEff, 11 cOverDt
// dfEff と diag を別の場に分けるのは、第 2 段が隣接セルの dfEff を読みながら
// 自セルへ diag を書くため(同じ場だと未読のスレッドの入力を壊す)
@group(0) @binding(5) var<storage, read_write> work : array<f32>;
@group(0) @binding(6) var<storage, read_write> accum : array<f32>;
@group(0) @binding(7) var<storage, read_write> residual : array<f32>;
/** 反復前の温度(残差 = 合成作用素の変化量 を測るための控え) */
@group(0) @binding(8) var<storage, read_write> tPrev : array<f32>;

const WG : u32 = ${GPU_WORKGROUP_SIZE}u;
var<workgroup> partial : array<f32, ${GPU_WORKGROUP_SIZE}>;

fn cellF(field : u32, i : u32) -> f32 { return cells[field * P.n + i]; }
fn workF(field : u32, i : u32) -> f32 { return work[field * P.n + i]; }
fn setWork(field : u32, i : u32, v : f32) { work[field * P.n + i] = v; }
fn rowF(field : u32, r : u32) -> f32 { return rows[field * P.ch + r]; }
fn insolOf(month : u32, r : u32) -> f32 { return rows[(4u + month) * P.ch + r]; }
fn monthlyF(field : u32, month : u32, i : u32) -> f32 {
  return monthly[field * 12u * P.n + month * P.n + i];
}
fn latOfRow(r : u32) -> f32 { return 90.0 - (f32(r) + 0.5) * P.resDeg; }

/** 行の実効南北拡散係数(ハドレー増強込み)。面の伝導度はこの両側平均 */
fn dMeridOfRow(r : u32) -> f32 {
  let lat = latOfRow(r);
  var ridgeAbs = P.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = P.ridgeAbsN; }
  let hadleyW = max(0.0, 1.0 - (lat / ridgeAbs) * (lat / ridgeAbs));
  return P.dBase * (1.0 + P.hadleyBoost * hadleyW);
}

// ---- 第 1 段: 実効熱容量・実効拡散係数・右辺(t に依存する) ----
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn prepA(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let r = i / P.cw;
  let s0 = insolOf(P.m0, r);
  let s1 = insolOf(P.m1, r);
  let s = s0 * (1.0 - P.frac) + s1 * P.frac;

  let tSurf = temp[i] - P.gamma * cellF(5u, i);
  let iceW = clamp((cellF(3u, i) - tSurf) / P.iceRamp, 0.0, 1.0);
  let base = cellF(2u, i);
  var aSurf = base + (P.albedoIce - base) * iceW;
  if (cellF(9u, i) >= 0.5) { aSurf = max(aSurf, P.permIceAlbedo); }
  let cloud = monthlyF(0u, P.m0, i) * (1.0 - P.frac) + monthlyF(0u, P.m1, i) * P.frac;
  let albedo = cloud + (1.0 - cloud) * aSurf;

  let oceanFrac = 1.0 - cellF(6u, i);
  let capEff = cellF(0u, i) * (1.0 - P.seaIceInsul * iceW * oceanFrac) * P.capScale;
  var evap = 0.0;
  if (P.hasEvap == 1u) {
    evap = monthlyF(3u, P.m0, i) * (1.0 - P.frac) + monthlyF(3u, P.m1, i) * P.frac;
  }
  let cOverDt = capEff / P.dtSec;
  setWork(0u, i, cOverDt * temp[i] + s * (1.0 - albedo) - cellF(1u, i) + cellF(4u, i) - evap);
  // 冬(月日射 < 年平均)の陸は接地逆転層で拡散が地表に届きにくい
  var invD = 1.0;
  if (insolOf(P.m0, r) < rowF(3u, r)) {
    invD = 1.0 - (1.0 - P.winterInvDiff) * cellF(8u, i);
  }
  setWork(10u, i, cellF(7u, i) * invD);
  setWork(11u, i, cOverDt);
}

// ---- 第 2 段: 界面伝導度・移流結合・対角(t に依存しない) ----
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn prepB(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let W = P.cw;
  let H = P.ch;
  let r = i / W;
  let c = i % W;
  let lat = latOfRow(r);
  let cosC = max(1.0e-3, rowF(0u, r));
  let gz = (P.dBase * P.zonalDiff * rowF(1u, r)) / (P.dPhi * P.dPhi);
  var ridgeAbs = P.ridgeAbsS;
  if (lat >= 0.0) { ridgeAbs = P.ridgeAbsN; }
  let phiEdgeN = (lat + P.resDeg * 0.5) * 0.017453292519943295;
  let phiEdgeS = (lat - P.resDeg * 0.5) * 0.017453292519943295;
  var chanN = 1.0;
  if (rowF(2u, r) >= 0.5 || (r > 0u && rowF(2u, r - 1u) >= 0.5)) { chanN = P.chanFactor; }
  var chanS = 1.0;
  if (rowF(2u, r) >= 0.5 || (r < H - 1u && rowF(2u, r + 1u) >= 0.5)) { chanS = P.chanFactor; }
  // 南北の面伝導度は**面の量**。ハドレー増強は緯度で変わるので、自セルの緯度で
  // 評価すると i→j と j→i が食い違う(Codex レビュー 2026-08-02)。
  // 面の値 = 両側セルの実効南北拡散係数の平均。cosC で割るのは体積規格化
  var gN = 0.0;
  if (r > 0u) {
    let dm = 0.5 * (dMeridOfRow(r) + dMeridOfRow(r - 1u));
    gN = (chanN * dm * cos(phiEdgeN)) / (P.dPhi * P.dPhi * cosC);
  }
  var gS = 0.0;
  if (r < H - 1u) {
    let dm = 0.5 * (dMeridOfRow(r) + dMeridOfRow(r + 1u));
    gS = (chanS * dm * cos(phiEdgeS)) / (P.dPhi * P.dPhi * cosC);
  }
  var isSummer = P.summerS == 1u;
  if (lat >= 0.0) { isSummer = P.summerN == 1u; }
  var seasonFactor = 1.0;
  if (isSummer) { seasonFactor = P.summerAdv; }
  let vBandW = clamp((abs(lat) - ridgeAbs) / 10.0, 0.0, 1.0);

  let east = r * W + ((c + 1u) % W);
  let west = r * W + ((c + W - 1u) % W);
  var north = i;
  if (r > 0u) { north = (r - 1u) * W + c; }
  var south = i;
  if (r < H - 1u) { south = (r + 1u) * W + c; }

  let uMs = monthlyF(1u, P.m0, i);
  let vMs = monthlyF(2u, P.m0, i);
  var inv = 1.0;
  if (insolOf(P.m0, r) < rowF(3u, r)) {
    inv = 1.0 - (1.0 - P.winterInvAdv) * cellF(8u, i);
  }
  let advScale = seasonFactor * inv * P.advCoupling;
  let advCu = advScale * (min(9.0, abs(uMs)) / 4.0);
  var upwindU = east;
  if (uMs >= 0.0) { upwindU = west; }
  var upwindV = north;
  if (vMs >= 0.0) { upwindV = south; }
  var chanV = 1.0;
  if (rowF(2u, r) >= 0.5 || rowF(2u, upwindV / W) >= 0.5) { chanV = P.chanFactor; }
  let landGrip = 0.25 + 0.75 * cellF(6u, i);
  var advCv = 0.0;
  if (upwindV != i) {
    advCv = advScale * vBandW * chanV * landGrip * (min(5.0, abs(vMs)) / 4.0);
  }

  // 界面伝導度 = 両セルの実効拡散係数の平均(i→j と j→i で同一 = 保存的)
  let dfI = workF(10u, i);
  let gzE = gz * 0.5 * (dfI + workF(10u, east));
  let gzW = gz * 0.5 * (dfI + workF(10u, west));
  let gNEff = gN * 0.5 * (dfI + workF(10u, north));
  let gSEff = gS * 0.5 * (dfI + workF(10u, south));
  setWork(1u, i, workF(11u, i) + P.olrB + gzE + gzW + gNEff + gSEff + advCu + advCv);
  setWork(2u, i, gzE);
  setWork(3u, i, gzW);
  setWork(4u, i, gNEff);
  setWork(5u, i, gSEff);
  setWork(6u, i, advCu);
  setWork(7u, i, advCv);
  setWork(8u, i, f32(upwindU));
  setWork(9u, i, f32(upwindV));
}

fn sweepCell(i : u32, color : u32) {
  let W = P.cw;
  let H = P.ch;
  let r = i / W;
  let c = i % W;
  if ((r + c) % 2u != color) { return; }
  let east = r * W + ((c + 1u) % W);
  let west = r * W + ((c + W - 1u) % W);
  var north = i;
  if (r > 0u) { north = (r - 1u) * W + c; }
  var south = i;
  if (r < H - 1u) { south = (r + 1u) * W + c; }
  let off =
    workF(2u, i) * temp[east] +
    workF(3u, i) * temp[west] +
    workF(4u, i) * temp[north] +
    workF(5u, i) * temp[south] +
    workF(6u, i) * temp[u32(workF(8u, i))] +
    workF(7u, i) * temp[u32(workF(9u, i))];
  temp[i] = (workF(0u, i) + off) / workF(1u, i);
}

// 赤黒の 2 巡は別のエントリにする。同じエンコーダ内でユニフォームを
// 書き換えられないため(色を uniform で渡すと 1 ステップ 1 色になってしまう)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepRed(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n) { return; }
  sweepCell(gid.x, 0u);
}
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn sweepBlack(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= P.n) { return; }
  sweepCell(gid.x, 1u);
}

// ---- 極行の帯状平滑(反復作用素の一部)----
// 1 行を 1 スレッドが担当し、加算順を固定して決定性を保つ
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn polar(@builtin(global_invocation_id) gid : vec3<u32>) {
  let r = gid.x;
  if (r >= P.ch) { return; }
  if (abs(latOfRow(r)) < 84.0) { return; }
  let W = P.cw;
  var sum = 0.0;
  for (var c = 0u; c < W; c = c + 1u) { sum = sum + temp[r * W + c]; }
  let mean = sum / f32(W);
  for (var c = 0u; c < W; c = c + 1u) {
    let i = r * W + c;
    temp[i] = temp[i] * 0.5 + mean * 0.5;
  }
}

// ---- 残差(合成作用素 1 反復ぶんの最大変化量)と月別積算 ----
// 縮約は 1 ワークグループ・固定順で行う(atomic や順序不定の並列縮約は
// 実行ごとに答えが変わる — device.ts の注記)
@compute @workgroup_size(${GPU_WORKGROUP_SIZE})
fn finish(@builtin(local_invocation_id) lid : vec3<u32>) {
  let tid = lid.x;
  var m = 0.0;
  for (var i = tid; i < P.n; i = i + WG) {
    m = max(m, abs(temp[i] - tPrev[i]));
  }
  partial[tid] = m;
  workgroupBarrier();
  if (tid == 0u) {
    var mm = 0.0;
    for (var k = 0u; k < WG; k = k + 1u) { mm = max(mm, partial[k]); }
    residual[P.stepIndex] = mm;
  }
  if (P.accumulate == 1u) {
    for (var i = tid; i < P.n; i = i + WG) {
      let idx = P.monthIndex * P.n + i;
      accum[idx] = accum[idx] + temp[i];
    }
  }
}
`;

export function createEbmGpu(gpu: GpuContext, cellCount: number): EbmAccel {
  const { device } = gpu;
  const N = cellCount;
  const M = MONTHS_PER_YEAR;
  const ST = GPUBufferUsage.STORAGE;
  const CS = GPUBufferUsage.COPY_SRC;
  const CD = GPUBufferUsage.COPY_DST;
  /** 行別バッファの本数: cos, metric, channel, 年平均日射 + 12 か月 */
  const ROW_FIELDS = 4 + M;
  const MAX_ROWS = 512;

  const bufCells = device.createBuffer({ size: CELL_FIELDS * N * 4, usage: ST | CD });
  const bufRows = device.createBuffer({ size: ROW_FIELDS * MAX_ROWS * 4, usage: ST | CD });
  const bufMonthly = device.createBuffer({ size: 4 * M * N * 4, usage: ST | CD });
  const bufTemp = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufWork = device.createBuffer({ size: WORK_FIELDS * N * 4, usage: ST });
  const bufAccum = device.createBuffer({ size: M * N * 4, usage: ST | CS | CD });
  const bufResidual = device.createBuffer({ size: MAX_STEPS * 4, usage: ST | CS | CD });
  const bufPrev = device.createBuffer({ size: N * 4, usage: ST | CS | CD });
  const bufParams = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | CD });
  const stage = new ReadbackStage(device, M * N + N + MAX_STEPS);

  const module = device.createShaderModule({ code: WGSL });
  // **明示レイアウトが必須**。layout: 'auto' はエントリごとに「実際に使う
  // バインディングだけ」のレイアウトを作るため、polar のように一部しか触らない
  // カーネルに全 9 本の束ねを渡すと検証エラーになる(2026-08-01 実測)。
  // 明示レイアウトなら、使っていないバインディングが宣言されていても構わない
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
  const mk = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ layout: pipeLayout, compute: { module, entryPoint } });
  const pipePrepA = mk('prepA');
  const pipePrepB = mk('prepB');
  const pipeRed = mk('sweepRed');
  const pipeBlack = mk('sweepBlack');
  const pipePolar = mk('polar');
  const pipeFinish = mk('finish');

  const entries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: bufParams } },
    { binding: 1, resource: { buffer: bufCells } },
    { binding: 2, resource: { buffer: bufRows } },
    { binding: 3, resource: { buffer: bufMonthly } },
    { binding: 4, resource: { buffer: bufTemp } },
    { binding: 5, resource: { buffer: bufWork } },
    { binding: 6, resource: { buffer: bufAccum } },
    { binding: 7, resource: { buffer: bufResidual } },
    { binding: 8, resource: { buffer: bufPrev } },
  ];
  // レイアウトが共通なので束ねは 1 つで足りる
  const bind = device.createBindGroup({ layout: bindLayout, entries });

  const cellGroups = Math.ceil(N / GPU_WORKGROUP_SIZE);
  const scratchCells = new Float32Array(CELL_FIELDS * N);
  const scratchRows = new Float32Array(ROW_FIELDS * MAX_ROWS);
  const scratchMonthly = new Float32Array(4 * M * N);
  const scratchTemp = new Float32Array(N);
  const scratchZeroCells = new Float32Array(M * N);
  const scratchResidual = new Float32Array(MAX_STEPS);
  const zeroMonth = new Float32Array(N);
  const paramBuf = new ArrayBuffer(144);
  const pu = new Uint32Array(paramBuf);
  const pf = new Float32Array(paramBuf);

  return {
    destroy(): void {
      for (const b of [
        bufCells,
        bufRows,
        bufMonthly,
        bufTemp,
        bufWork,
        bufAccum,
        bufResidual,
        bufPrev,
        bufParams,
      ]) {
        b.destroy();
      }
      stage.destroy();
    },

    async run(fields: EbmStaticFields, k: EbmConstants): Promise<EbmAccelResult> {
      const CW = fields.widthCells;
      const CH = fields.heightCells;
      if (CW * CH !== N) throw new Error(`EBM のセル数が違う(確保 ${N} / 要求 ${CW * CH})`);
      if (CH > MAX_ROWS) throw new Error(`行数が上限を超えた(${CH} > ${MAX_ROWS})`);
      // 市松 (row+col)%2 が経度の折り返しで成立するのは**経度セル数が偶数**のとき
      // だけ。奇数だと col=CW-1 と col=0 が同色になり、同じディスパッチ内で
      // 同一セルの読み書きが競合して結果が非決定になる(Codex レビュー 2026-08-02)。
      // 解像度は 0.25〜5° を許しているので 2.7°(CW=133)などで実際に起こりうる。
      if (CW % 2 !== 0) {
        throw new Error(
          `EBM の GPU 経路は経度セル数が偶数であることを要求する(CW=${CW})。` +
            '赤黒順序の市松が経度の折り返しで壊れる。CPU 経路(行優先)を使うこと',
        );
      }

      const cellSrc = [
        fields.heatCap,
        fields.aEff,
        fields.surfAlbedoBase,
        fields.iceOnset,
        fields.qFlux,
        fields.elevM,
        fields.landFrac,
        fields.diffFactor,
        fields.interior01,
        fields.permanentIce,
      ];
      for (let f = 0; f < CELL_FIELDS; f++) scratchCells.set(cellSrc[f]!, f * N);
      device.queue.writeBuffer(bufCells, 0, asBufferSource(scratchCells));

      // 行別。**間隔は CH**(シェーダ側の rowF が P.ch を掛けている)
      scratchRows.fill(0);
      scratchRows.set(fields.cosCenter, 0);
      scratchRows.set(fields.metricZonal, CH);
      scratchRows.set(fields.rowIsChannel, 2 * CH);
      scratchRows.set(fields.insolAnnualByRow, 3 * CH);
      for (let m = 0; m < M; m++) {
        scratchRows.set(fields.insolMonthlyByRow.subarray(m * CH, (m + 1) * CH), (4 + m) * CH);
      }
      device.queue.writeBuffer(bufRows, 0, asBufferSource(scratchRows));

      const monthlySrc = [fields.cloudAlbedo, fields.windU, fields.windV];
      for (let f = 0; f < 3; f++) {
        for (let m = 0; m < M; m++) {
          scratchMonthly.set(monthlySrc[f]![m] ?? zeroMonth, (f * M + m) * N);
        }
      }
      for (let m = 0; m < M; m++) {
        scratchMonthly.set(fields.evapAnom?.[m] ?? zeroMonth, (3 * M + m) * N);
      }
      device.queue.writeBuffer(bufMonthly, 0, asBufferSource(scratchMonthly));

      if (fields.initialT) {
        scratchTemp.set(fields.initialT);
      } else {
        for (let row = 0; row < CH; row++) {
          const init = -20 + 48 * (fields.cosCenter[row] ?? 0);
          for (let col = 0; col < CW; col++) scratchTemp[row * CW + col] = init;
        }
      }
      device.queue.writeBuffer(bufTemp, 0, asBufferSource(scratchTemp));
      scratchZeroCells.fill(0);
      device.queue.writeBuffer(bufAccum, 0, asBufferSource(scratchZeroCells));
      scratchResidual.fill(0);
      device.queue.writeBuffer(bufResidual, 0, asBufferSource(scratchResidual));

      const totalSteps = fields.years * fields.stepsPerYear;
      if (totalSteps > MAX_STEPS) throw new Error(`時間ステップ数が上限を超えた(${totalSteps})`);
      const spinupSteps = Math.max(0, (fields.years - 2) * fields.stepsPerYear);
      const lastYearStart = (fields.years - 1) * fields.stepsPerYear;
      const iters = Math.max(1, Math.round(k.iterationsPerStep));
      const monthCount = new Array<number>(M).fill(0);
      const polarGroups = Math.ceil(CH / GPU_WORKGROUP_SIZE);

      for (let step = 0; step < totalSteps; step++) {
        const capScale = step < spinupSteps ? 1 / 16 : 1;
        const yearFrac = (step % fields.stepsPerYear) / fields.stepsPerYear;
        const monthFloat = yearFrac * M;
        const m0 = Math.floor(monthFloat - 0.5 + M) % M;
        const m1 = (m0 + 1) % M;
        const frac = (monthFloat - 0.5 + M) % 1;
        const ridgeNNow = fields.ridgeLatN[m0] ?? 31;
        const ridgeSNow = fields.ridgeLatS[m0] ?? -31;
        const accumulate = step >= lastYearStart;
        const monthIndex = Math.min(M - 1, Math.floor(yearFrac * M));
        if (accumulate) monthCount[monthIndex] = (monthCount[monthIndex] ?? 0) + 1;

        pu[0] = CW;
        pu[1] = CH;
        pu[2] = N;
        pu[3] = iters;
        pu[4] = m0;
        pu[5] = m1;
        pu[6] = monthIndex;
        pu[7] = step;
        pf[8] = frac;
        pf[9] = capScale;
        pf[10] = fields.dtSeconds;
        pf[11] = k.lapseRateGammaCPerM;
        pf[12] = k.iceRampWidthC;
        pf[13] = k.albedoIce;
        pf[14] = k.permanentIceAlbedo;
        pf[15] = k.seaIceInsulationFactor;
        pf[16] = k.olrBWm2PerC;
        pf[17] = k.diffusionBase;
        pf[18] = k.zonalDiffusionFactor;
        pf[19] = k.hadleyDiffusionBoost;
        pf[20] = k.circumpolarChannelFactor;
        pf[21] = k.summerAdvectionFactor;
        pf[22] = k.zonalAdvectionCouplingWm2PerK;
        pf[23] = k.winterInversionDiffusionFactor;
        pf[24] = k.winterInversionAdvectionFactor;
        pf[25] = (360 / CW) * (Math.PI / 180);
        pf[26] = 360 / CW;
        pf[27] = Math.max(15, Math.abs(ridgeNNow));
        pf[28] = Math.max(15, Math.abs(ridgeSNow));
        pu[29] = ridgeNNow > fields.meanRidgeN ? 1 : 0;
        pu[30] = ridgeSNow < fields.meanRidgeS ? 1 : 0;
        pu[31] = fields.evapAnom ? 1 : 0;
        pu[32] = accumulate ? 1 : 0;
        device.queue.writeBuffer(bufParams, 0, paramBuf);

        // 1 時間ステップぶんを 1 つのエンコーダへ積む(submit は 1 回)
        const enc = device.createCommandEncoder();
        const run = (p: GPUComputePipeline, groups: number): void => {
          const pass = enc.beginComputePass();
          pass.setPipeline(p);
          pass.setBindGroup(0, bind);
          pass.dispatchWorkgroups(groups);
          pass.end();
        };
        run(pipePrepA, cellGroups);
        run(pipePrepB, cellGroups);
        for (let it = 0; it < iters; it++) {
          // 最終反復の直前に控えを取り、合成作用素 1 回ぶんの変化量を残差にする
          if (it === iters - 1) enc.copyBufferToBuffer(bufTemp, 0, bufPrev, 0, N * 4);
          run(pipeRed, cellGroups);
          run(pipeBlack, cellGroups);
          run(pipePolar, polarGroups);
        }
        run(pipeFinish, 1);
        device.queue.submit([enc.finish()]);
      }

      // 読み戻しは 1 回だけ(積算 + 最終温度 + 残差)
      const enc = device.createCommandEncoder();
      stage.enqueueCopyAt(enc, bufAccum, 0, M * N);
      stage.enqueueCopyAt(enc, bufTemp, M * N, N);
      stage.enqueueCopyAt(enc, bufResidual, M * N + N, MAX_STEPS);
      device.queue.submit([enc.finish()]);
      const flat = await stage.map(M * N + N + MAX_STEPS);

      const monthAccum: Float32Array[] = [];
      for (let m = 0; m < M; m++) monthAccum.push(flat.slice(m * N, (m + 1) * N));
      const finalT = flat.slice(M * N, M * N + N);
      let maxResidualC = 0;
      for (let s = 0; s < totalSteps; s++) {
        const v = flat[M * N + N + s] ?? 0;
        if (v > maxResidualC) maxResidualC = v;
      }
      // 許容差を満たしたかを**返す**。渡された許容差を使わずに残差を記録する
      // だけだと、ある惑星条件で反復が足りなくてもそのまま採用されてしまう
      // (Codex レビュー 2026-08-02)
      return {
        monthAccum,
        monthCount,
        finalT,
        maxResidualC,
        converged: maxResidualC <= k.solveToleranceC,
      };
    },
  };
}
