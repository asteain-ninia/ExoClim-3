// 診断: 理想化大陸でコンベアと東岸沖の暖流が立っているか(45d の切り分け)。
// 実行: npx tsx scripts/diag_conveyor_ideal.ts [--two]
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS, type PlanetParams } from '../src/domain/planetParams';
import { CONVEYOR_STATS } from '../src/sim/step06_precipitation';
import { latDegOfRow } from '../src/domain/grid';
import { openAccel } from './accel_cli';

const TWO = process.argv.includes('--two');
async function main(): Promise<void> {
  const params: PlanetParams = {
    ...EARTH_PARAMS,
    gridResolutionDeg: 2,
    terrain: { kind: 'preset', preset: TWO ? 'two_continents' : 'idealized_continent' },
  };
  const accel = await openAccel(true);
  let r;
  try { r = await runPipeline(params, accel.opts); } finally { accel.close(); }
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;
  console.log(`applyConveyor 呼び出し ${CONVEYOR_STATS.calls} 回 / 不発 ${CONVEYOR_STATS.skippedNoWarm} / Σ取水 ${CONVEYOR_STATS.takeMmArea.toFixed(1)}`);
  // 亜熱帯(15〜35°N)の海セルを「大陸の東岸沖 / 西岸沖」で分け SST 偏差の平均を出す
  const dirE = r.context.params.body.rotationDirection >= 0 ? 1 : -1;
  let eastN = 0, eastS = 0, westN = 0, westS = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < 15 || lat > 35) continue;
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (land[i]) continue;
      // 西(自転の逆)へ 10 セル以内に陸 → 大陸の東岸沖
      let nearWestLand = false, nearEastLand = false;
      for (let d = 1; d <= 10; d++) {
        if (land[row * W + (((col - dirE * d) % W) + W) % W]) nearWestLand = true;
        if (land[row * W + (((col + dirE * d) % W) + W) % W]) nearEastLand = true;
      }
      const a = r.ocean.sstAnomalyC[i] ?? 0;
      if (nearWestLand && !nearEastLand) { eastS += a; eastN++; }
      if (nearEastLand && !nearWestLand) { westS += a; westN++; }
    }
  }
  console.log(`亜熱帯の海 SST 偏差: 大陸東岸沖(暖流が立つべき) ${eastN ? (eastS / eastN).toFixed(2) : '-'}°C (${eastN} セル) / 西岸沖(寒流が立つべき) ${westN ? (westS / westN).toFixed(2) : '-'}°C (${westN} セル)`);
  console.log('読み: 東岸沖が正でなければコンベアの取水(max(0, sstA) × W)が 0 になり発火しない。');
}
void main();
