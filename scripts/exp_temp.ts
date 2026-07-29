// 気温 EBM の較正実験ランナー(Step 6/7 を省いて高速反復する開発用)。
// 帯状プロファイル(陸のみ)と全球指標を観測(Beck 平年値)と並置する。

import fs from 'node:fs';
import path from 'node:path';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { computeWindBelt } from '../src/sim/step02_windbelt';
import { computeOceanCurrent } from '../src/sim/step03_ocean';
import { computeTemperature } from '../src/sim/step05_temperature';
import { areaWeightedMean } from '../src/domain/grid';

interface ClimateFixture {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}

const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimateFixture;

const t0 = Date.now();
const ctx = buildSimContext(EARTH_PARAMS);
const itcz = computeItcz(ctx);
const wind = computeWindBelt(ctx, itcz);
const ocean = computeOceanCurrent(ctx, itcz, wind);
const temp = computeTemperature(ctx, itcz, wind, ocean);
console.log('気温まで', ((Date.now() - t0) / 1000).toFixed(1), 's');

const grid = ctx.grid;
// 全球平均(海含む)
console.log(
  '全球年平均(海含む):',
  areaWeightedMean(grid, temp.annualMeanC).toFixed(1),
  '°C(実地球 ≈ 14.5)',
);

// 帯状(陸のみ、観測は 2° フィクスチャ)
console.log('lat | 観測年平均 | モデル年平均 | 観測1月 | モデル1月 | 観測7月 | モデル7月');
const f = Math.round(2 / grid.resolutionDeg);
for (let band = 80; band >= -80; band -= 10) {
  let oA = 0, mA = 0, o1 = 0, m1 = 0, o7 = 0, m7 = 0, n = 0;
  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    if (Math.abs(lat - band) > 5) continue;
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      let obsMonthly: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (v === -9999) { ok = false; break; }
        obsMonthly.push(v / 10);
      }
      if (!ok) continue;
      let mm = new Array<number>(12).fill(0);
      let nn = 0;
      for (let dr = 0; dr < f; dr++) for (let dc = 0; dc < f; dc++) {
        const gr = cr * f + dr, gc = cc * f + dc;
        if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
        const gi = gr * grid.widthCells + gc;
        if (!ctx.terrain.landMask[gi]) continue;
        nn++;
        for (let m = 0; m < 12; m++) mm[m] = (mm[m] ?? 0) + (temp.monthlyTemperatureC[m]?.[gi] ?? 0);
      }
      if (nn === 0) continue;
      for (let m = 0; m < 12; m++) mm[m] = (mm[m] ?? 0) / nn;
      oA += obsMonthly.reduce((a, b) => a + b, 0) / 12;
      mA += mm.reduce((a, b) => a + b, 0) / 12;
      o1 += obsMonthly[0] ?? 0; m1 += mm[0] ?? 0;
      o7 += obsMonthly[6] ?? 0; m7 += mm[6] ?? 0;
      n++;
    }
  }
  if (n === 0) continue;
  const r = (x: number) => (x / n).toFixed(1).padStart(6);
  console.log(`${String(band).padStart(3)} | ${r(oA)} | ${r(mA)} | ${r(o1)} | ${r(m1)} | ${r(o7)} | ${r(m7)}`);
}
