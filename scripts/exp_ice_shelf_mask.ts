// 南極の棚氷を陸から外したときの影響を測る(感度試験)。
//
// 問題(利用者の指摘 2026-08-01):
//   地形の出所が ETOPO の **surface(氷の上面)標高**で、陸判定が「標高 > 0」。
//   ロス棚氷(上面 41m)・ロンネ棚氷(63m)などの**浮いている氷**が陸になる。
//   実測: 南緯 60° 以南でモデル陸 6,670 セルに対し Beck は 6,040。
//   余分な 630 セルの 95% が標高 200m 未満。逆向きのずれは 0 セル。
//
// 本来の直し方は ETOPO の bedrock を使った静水圧判定
//   浮いている ⇔ bedrock < −11.05 × surface(氷 917 / 海水 1028 kg/m³)
// だが bedrock データが手元に無い。ここでは影響の大きさだけを先に測るため、
// **Beck が気候区分を持たない南極の低標高セルを海に落とす**という
// 代用マスクで感度を見る(採用する直し方ではない — 地形が観測に依存するため)。
//
// 実行: npx tsx scripts/exp_ice_shelf_mask.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { getKoppenObs } from './scoring';
import earthTerrain from '../src/domain/data/earth_terrain_1deg.json';
import earthCrest from '../src/domain/data/earth_crest_1deg.json';
import type { PlanetParams } from '../src/domain/planetParams';

interface TerrainJson {
  widthCells: number;
  heightCells: number;
  elevationMeters: number[];
  landMask: number[];
}
interface CrestJson {
  crestMeters: number[];
}
const t = earthTerrain as unknown as TerrainJson;
const crest = (earthCrest as unknown as CrestJson).crestMeters;
const obs = getKoppenObs().classRaster;

const W = t.widthCells;
const H = t.heightCells;
const land = t.landMask.slice();
const elev = t.elevationMeters.slice();

/** 棚氷候補: 南緯 60° 以南 / 標高 200m 未満 / Beck に区分が無い */
let flipped = 0;
for (let row = 0; row < H; row++) {
  const lat = 90 - (row + 0.5) * (180 / H);
  if (lat > -60) continue;
  for (let col = 0; col < W; col++) {
    const i = row * W + col;
    if (land[i] !== 1) continue;
    if ((elev[i] ?? 0) >= 200) continue;
    if ((obs[i] ?? 0) !== 0) continue;
    land[i] = 0;
    elev[i] = -50; // 浅い海として置く(棚氷下は実際には数百 m)
    flipped++;
  }
}
console.log(`棚氷として海へ落としたセル: ${flipped}`);

const withShelfAsOcean: PlanetParams = {
  ...EARTH_PARAMS,
  terrain: {
    kind: 'custom',
    name: 'earth-noshelf',
    widthCells: W,
    heightCells: H,
    elevationMeters: elev,
    landMask: land,
    crestMeters: crest,
  },
};

const accel = await openAccel();
const base = await runPipeline(EARTH_PARAMS, accel.opts);
const sb = evaluateResult(base);
console.log(
  `現行(棚氷 = 陸): 大分類 ${sb.majorPct.toFixed(2)} / 詳細 ${sb.detailPct.toFixed(2)} / ` +
    `ゲート ${sb.gates} / 気温RMSE ${sb.tempRmse.toFixed(3)} / 陸平均 ${Math.round(sb.landMeanMm)}mm / fit ${sb.fitness.toFixed(2)}`,
);
const mod = await runPipeline(withShelfAsOcean, accel.opts);
const sm = evaluateResult(mod);
console.log(
  `棚氷 = 海:       大分類 ${sm.majorPct.toFixed(2)} / 詳細 ${sm.detailPct.toFixed(2)} / ` +
    `ゲート ${sm.gates} / 気温RMSE ${sm.tempRmse.toFixed(3)} / 陸平均 ${Math.round(sm.landMeanMm)}mm / fit ${sm.fitness.toFixed(2)}`,
);
accel.close();

// 南半球中高緯度の気温がどれだけ動くか(南大洋の熱容量が変わる影響)
const grid = base.context.grid;
const BANDS: [number, number][] = [
  [-90, -60],
  [-60, -40],
  [-40, -20],
  [20, 40],
];
for (const [lo, hi] of BANDS) {
  let s = 0;
  let w = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = 90 - (row + 0.5) * grid.resolutionDeg;
    if (lat < lo || lat >= hi) continue;
    const ww = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      s += ww * ((mod.temperature.annualMeanC[i] ?? 0) - (base.temperature.annualMeanC[i] ?? 0));
      w += ww;
    }
  }
  console.log(`  緯度 ${lo}〜${hi}° の年平均気温の変化: ${(s / w).toFixed(3)}°C`);
}
