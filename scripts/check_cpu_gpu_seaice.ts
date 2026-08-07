// 検算: 0 層海氷模型で CPU 経路と GPU 経路が同じ物理を解いているか。
//
// 対応 spec: docs/事前登録_海氷アルベド_2026-08-07.md の副判定
//            「CPU と GPU が一致する(年平均気温の差が 0.5°C 以下)」
//
// なぜ要るか:
//   第 1 版の 0 層模型は **CPU 経路にしかなく、GPU があると黙って無効**だった。
//   第 2 版で WGSL へ移植したので、**両経路が同じ式を解いているか**を必ず確かめる。
//   ここが食い違うと、GPU で較正した定数が CPU では別の気候を出す。
//
// 費用を抑えるため**年数を固定**して短く回す(既定 6 年)。一致の検算に
// 周期定常は要らない — 同じ初期値から同じ式を回せば同じ軌道になるはずで、
// むしろ短いほうがズレが累積せず原因を切り分けやすい。
//
// 実行: npx tsx scripts/check_cpu_gpu_seaice.ts [年数]
//   (GPU 側と CPU 側を 1 プロセス内で順に回す)

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_FULL_CAPACITY_YEARS } from '../src/sim/step05_temperature';
import { createGpuAccelerator } from '../src/sim/gpu/accelerator_node';
import { areaWeightOfRow } from '../src/domain/grid';
import type { PipelineResult } from '../src/sim/types';

const YEARS = Number(process.argv[2] ?? 6);

/** 面積重みの平均 |差| と最大 |差| を、年平均気温で測る */
function compare(a: PipelineResult, b: PipelineResult): { mean: number; max: number; where: string } {
  const grid = a.context.grid;
  let sw = 0;
  let swd = 0;
  let max = 0;
  let where = '—';
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const d = Math.abs((a.temperature.annualMeanC[i] ?? 0) - (b.temperature.annualMeanC[i] ?? 0));
      sw += w;
      swd += w * d;
      if (d > max) {
        max = d;
        const lat = 90 - (row + 0.5) * grid.resolutionDeg;
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        where = `${lat.toFixed(0)}°, ${lon.toFixed(0)}°`;
      }
    }
  }
  return { mean: sw > 0 ? swd / sw : 0, max, where };
}

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  // **年数を固定する。** 自動で増やすと両経路で年数が食い違い、
  // 「物理の差」と「積分量の差」を分離できなくなる
  EBM_FULL_CAPACITY_YEARS.years = YEARS;
  console.log(`全熱容量 ${YEARS} 年に固定して比べる(海氷 0 層模型 = 有効)\n`);

  K.seaIceModel = 1;

  const gpu = await createGpuAccelerator();
  if (!gpu) throw new Error('GPU 加速器を開けない');
  console.log('GPU 経路を実行…');
  const tGpu0 = Date.now();
  const rGpu = await runPipeline(EARTH_PARAMS, { accel: gpu });
  console.log(`  完了 ${((Date.now() - tGpu0) / 60000).toFixed(1)} 分`);
  gpu.destroy();

  console.log('CPU 経路を実行…');
  const tCpu0 = Date.now();
  const rCpu = await runPipeline(EARTH_PARAMS);
  console.log(`  完了 ${((Date.now() - tCpu0) / 60000).toFixed(1)} 分`);

  const c = compare(rGpu, rCpu);
  console.log(
    `\n年平均気温の差(GPU − CPU): 面積重み平均 ${c.mean.toFixed(4)}°C / ` +
      `最大 ${c.max.toFixed(3)}°C(${c.where})`,
  );
  console.log(
    c.mean <= 0.5
      ? '\n副判定「CPU と GPU が一致する(0.5°C 以下)」… ○ 成立'
      : '\n副判定「CPU と GPU が一致する(0.5°C 以下)」… × 不成立 — 実装が食い違っている',
  );
  console.log(
    '\n注: f32(GPU)と f64(CPU)の丸めの差があるので厳密一致はしない。' +
      '桁が違えば式の食い違いを疑う。',
  );
}

void main();
