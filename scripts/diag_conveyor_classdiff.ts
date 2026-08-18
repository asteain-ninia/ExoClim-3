// 診断: **コンベア(段 45b)strength 30 で大分類がどこで動いたか。**
// 掃引で大分類 74.70 → 74.22(−0.48、登録閾値 ±0.5 すれすれ)。
// 改善セルと悪化セルの分布(大分類の遷移と緯度帯・経度)を出し、
// 「給水位置が悪い」のか「取水で上流が乾く」のかを切り分ける。
// 実行: npx tsx scripts/diag_conveyor_classdiff.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
const MAJOR_NAME = ['A', 'B', 'C', 'D', 'E'];

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let base: ArrayLike<number>;
  let conv: ArrayLike<number>;
  let grid;
  let land: ArrayLike<number | boolean>;
  try {
    K['conveyorStrength'] = 0;
    const r0 = await runPipeline(EARTH_PARAMS, accel.opts);
    base = r0.koppen.classId;
    grid = r0.context.grid;
    land = r0.context.terrain.landMask;
    K['conveyorStrength'] = 30;
    const r1 = await runPipeline(EARTH_PARAMS, accel.opts);
    conv = r1.koppen.classId;
  } finally {
    accel.close();
  }
  const kobs = getKoppenObs();
  const W = grid.widthCells;

  // 遷移の集計: 正解→不正解(悪化)と不正解→正解(改善)を大分類の組で数える
  const worse = new Map<string, { w: number; lats: number[]; lons: number[] }>();
  const better = new Map<string, number>();
  let wWorse = 0;
  let wBetter = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const om = majorClassOf(obsId);
      const b = majorClassOf(base[i] ?? 0);
      const c = majorClassOf(conv[i] ?? 0);
      if (b === c) continue;
      const okB = b === om;
      const okC = c === om;
      if (okB && !okC) {
        const key = `${MAJOR_NAME[om]}: ${MAJOR_NAME[b]}→${MAJOR_NAME[c]}`;
        const e = worse.get(key) ?? { w: 0, lats: [], lons: [] };
        e.w += cw;
        e.lats.push(lat);
        let lon = lonDegOfCol(grid, col);
        if (lon > 180) lon -= 360;
        e.lons.push(lon);
        worse.set(key, e);
        wWorse += cw;
      } else if (!okB && okC) {
        const key = `${MAJOR_NAME[om]}: ${MAJOR_NAME[b]}→${MAJOR_NAME[c]}`;
        better.set(key, (better.get(key) ?? 0) + cw);
        wBetter += cw;
      }
    }
  }
  console.log(`改善(不正解→正解) 重み計 ${wBetter.toFixed(1)} / 悪化(正解→不正解) ${wWorse.toFixed(1)}\n`);
  console.log('悪化の内訳(観測: 変化。重み降順、代表的な緯度・経度)');
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  for (const [key, e] of [...worse.entries()].sort((a, b) => b[1].w - a[1].w).slice(0, 8)) {
    console.log(
      `  ${key.padEnd(12)} 重み ${e.w.toFixed(1).padStart(6)}  中央値 (${med(e.lats).toFixed(0)}°, ${med(e.lons).toFixed(0)}°)  n=${e.lats.length}`,
    );
  }
  console.log('\n改善の内訳');
  for (const [key, w] of [...better.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${key.padEnd(12)} 重み ${w.toFixed(1)}`);
  }
}

void main();
