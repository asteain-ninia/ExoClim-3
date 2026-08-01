// 観測(Beck ら)のケッペン図とモデル地形の位置合わせを検査する。
//
// 動機(利用者の指摘 2026-08-01): 観測データが地形に比べて微妙に膨らんで
// 見える。もし系統的なずれがあれば、沿岸のセルが隣の気候と突き合わされ、
// すべてのスコアが理由なく下がっていることになる。
//
// 採点は「モデル陸 ∩ 観測陸」の共通セルのみを対象にしているので、ずれた
// セルは誤採点ではなく**除外**される。したがって害は 2 通りありうる:
//   (a) 除外が多すぎて採点対象が偏る
//   (b) 位置がずれていて、共通セルの中身自体が隣のセルと比べられている
//
// (b) の検出法: 観測ラスタを ±2 セル動かして一致率を測る。ずれが無ければ
// (0,0) が最大になるはず。他の位置が最大なら位置合わせの誤りである。
//
// 実行: npx tsx scripts/diag_obs_alignment.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { getKoppenObs } from './scoring';
import { areaWeightOfRow, wrapCol } from '../src/domain/grid';
import { majorClassOf } from '../src/domain/koppen';

const result = await runPipeline(EARTH_PARAMS);
const grid = result.context.grid;
const W = grid.widthCells;
const H = grid.heightCells;
const land = result.context.terrain.landMask;
const model = result.koppen.classId;
const obs = getKoppenObs().classRaster;

// ---- 1. 被覆の食い違い(面積重み)----
let wBoth = 0;
let wModelOnly = 0;
let wObsOnly = 0;
let wNeither = 0;
for (let row = 0; row < H; row++) {
  const w = areaWeightOfRow(grid, row);
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    const isLand = land[i] === 1;
    const hasObs = (obs[i] ?? 0) !== 0;
    if (isLand && hasObs) wBoth += w;
    else if (isLand) wModelOnly += w;
    else if (hasObs) wObsOnly += w;
    else wNeither += w;
  }
}
const wLandTotal = wBoth + wModelOnly;
const wObsTotal = wBoth + wObsOnly;
console.log('被覆の食い違い(面積重み、全球を 100 とした割合)');
const all = wBoth + wModelOnly + wObsOnly + wNeither;
console.log(`  両方が陸        : ${((wBoth / all) * 100).toFixed(2)}%`);
console.log(
  `  モデルのみ陸    : ${((wModelOnly / all) * 100).toFixed(2)}%` +
    `(モデル陸の ${((wModelOnly / wLandTotal) * 100).toFixed(1)}% が採点から外れている)`,
);
console.log(
  `  観測のみ陸      : ${((wObsOnly / all) * 100).toFixed(2)}%` +
    `(観測陸の ${((wObsOnly / wObsTotal) * 100).toFixed(1)}% が採点から外れている)`,
);
console.log(
  `  観測 / モデルの陸面積比: ${(wObsTotal / wLandTotal).toFixed(4)}` +
    `(1 より大きければ観測のほうが膨らんでいる)`,
);

// ---- 2. ずらして一致率を測る ----
console.log('\n観測ラスタをずらしたときの大分類一致率(%)');
console.log('  行↓ = 緯度方向のずらし(+ は南へ)、列→ = 経度方向のずらし(+ は東へ)');
const SHIFTS = [-2, -1, 0, 1, 2];
const header = '        ' + SHIFTS.map((d) => String(d).padStart(8)).join('');
console.log(header);
let best = { dLat: 0, dLon: 0, pct: -1 };
for (const dRow of SHIFTS) {
  const cells: string[] = [];
  for (const dCol of SHIFTS) {
    let hit = 0;
    let tot = 0;
    for (let row = 0; row < H; row++) {
      const w = areaWeightOfRow(grid, row);
      const or_ = row + dRow;
      if (or_ < 0 || or_ >= H) continue;
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (land[i] !== 1) continue;
        const mdl = model[i] ?? 0;
        if (mdl === 0) continue;
        const oi = or_ * W + wrapCol(grid, col + dCol);
        const o = obs[oi] ?? 0;
        if (o === 0) continue;
        tot += w;
        if (majorClassOf(mdl) === majorClassOf(o)) hit += w;
      }
    }
    const pct = tot > 0 ? (hit / tot) * 100 : 0;
    if (pct > best.pct) best = { dLat: dRow, dLon: dCol, pct };
    cells.push(pct.toFixed(2).padStart(8));
  }
  console.log(String(dRow).padStart(6) + '  ' + cells.join(''));
}
console.log(
  `\n最良: 緯度 ${best.dLat} / 経度 ${best.dLon} セルずらしで ${best.pct.toFixed(2)}%`,
);
if (best.dLat === 0 && best.dLon === 0) {
  console.log('→ 位置合わせは正しい(ずらしても改善しない)');
} else {
  console.log('→ **位置合わせがずれている可能性が高い**。フィクスチャの作り方を確認すること');
}
