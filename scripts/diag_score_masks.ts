// 診断: 一致率のどれだけが「難しくない土地」で稼がれているか。
//
// 対応 spec: なし(採点の解釈)。
//
// なぜ要るか(2026-08-06):
//   一致マップを描いたら南極大陸が全面緑だった。観測もモデルも一様に EF(氷雪)を
//   返すので当たるが、これは**当てて嬉しい一致ではない**。面積重み(cos 緯度)を
//   掛けてなお観測の 9.5% を EF が占めるので、成績への寄与は無視できない。
//   南極・グリーンランド・氷雪全体をそれぞれ外したときに一致率がどこへ落ちるかを
//   測り、**今後どの数字を見て判断するか**を決める。
//
//   ここで出す数字は目的関数を置き換えるものではない(較正の物差しを動かすと
//   過去の実験と比べられなくなる)。**解釈のための併記値**として使う。
//
// 実行: npx tsx scripts/diag_score_masks.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { getKoppenObs, koppenScore, type CellFilter } from './scoring';
import { createGrid, latDegOfRow, lonDegOfCol, areaWeightOfRow } from '../src/domain/grid';
import { majorClassOf } from '../src/domain/koppen';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

/** グリーンランド本体を囲む枠(緯度経度の矩形で足りる — 周りは海) */
const isGreenland = (lat: number, lon: number): boolean =>
  lat >= 59 && lat <= 84 && lon >= -73 && lon <= -11;

const MASKS: Array<{ id: string; label: string; keep?: CellFilter }> = [
  { id: 'all', label: '全球(現行の採点)' },
  { id: 'noAntarctica', label: '南極大陸を除く(60°S 以南)', keep: (lat) => lat > -60 },
  {
    id: 'noIceSheets',
    label: '南極 + グリーンランドを除く',
    keep: (lat, lon) => lat > -60 && !isGreenland(lat, lon),
  },
  { id: 'noPolar', label: 'さらに 66.5° 以北も除く(極圏全体)', keep: (lat) => lat > -60 && lat < 66.5 },
];

/** 観測が EF のセルを外す(氷雪という分類そのものを除く) */
function scoreExcludingObsClass(result: PipelineResult, excludeIds: number[]): {
  major: number;
  detail: number;
  wShare: number;
} {
  const obs = getKoppenObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  const ex = new Set(excludeIds);
  let wTotal = 0;
  let wKept = 0;
  let major = 0;
  let detail = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const o = obs.classRaster[i] ?? 0;
      if (!land[i] || o === 0) continue;
      const mdl = model[i] ?? 0;
      if (mdl === 0) continue;
      wTotal += w;
      if (ex.has(o)) continue;
      wKept += w;
      if (mdl === o) detail += w;
      if (majorClassOf(mdl) === majorClassOf(o)) major += w;
    }
  }
  return { major: (major / wKept) * 100, detail: (detail / wKept) * 100, wShare: wKept / wTotal };
}

/** 各マスクが全球の重みのどれだけを残すか */
function keptShare(result: PipelineResult, keep?: CellFilter): number {
  const obs = getKoppenObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  let all = 0;
  let kept = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    const lat = latDegOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!land[i] || (obs.classRaster[i] ?? 0) === 0 || (model[i] ?? 0) === 0) continue;
      all += w;
      if (!keep || keep(lat, lonDegOfCol(grid, col))) kept += w;
    }
  }
  return kept / all;
}

async function main(): Promise<void> {
  const accel = await openAccel();
  let result: PipelineResult;
  try {
    result = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const obs = getKoppenObs();

  console.log('一致率(面積重み cos 緯度)を、除外する土地を変えて測る\n');
  console.log('マスク                                残る面積   大分類   詳細');
  const base = koppenScore(result, obs);
  for (const m of MASKS) {
    const s = koppenScore(result, obs, m.keep);
    const share = keptShare(result, m.keep);
    console.log(
      `${m.label.padEnd(34, ' ')} ${(share * 100).toFixed(1).padStart(6)}%  ` +
        `${s.majorPct.toFixed(2).padStart(6)}  ${s.detailPct.toFixed(2).padStart(6)}` +
        (m.id === 'all'
          ? ''
          : `   (大分類 ${(s.majorPct - base.majorPct >= 0 ? '+' : '') + (s.majorPct - base.majorPct).toFixed(2)})`),
    );
  }

  // 分類そのものを外す
  const EF = 30;
  const ET = 29;
  const noEF = scoreExcludingObsClass(result, [EF]);
  const noE = scoreExcludingObsClass(result, [ET, EF]);
  console.log(`\n観測が EF(氷雪)のセルを除く      ${(noEF.wShare * 100).toFixed(1).padStart(6)}%  ` +
    `${noEF.major.toFixed(2).padStart(6)}  ${noEF.detail.toFixed(2).padStart(6)}`);
  console.log(`観測が E(寒帯)のセルを除く       ${(noE.wShare * 100).toFixed(1).padStart(6)}%  ` +
    `${noE.major.toFixed(2).padStart(6)}  ${noE.detail.toFixed(2).padStart(6)}`);

  // 大分類ごとの「当たりやすさ」— どの分類が成績を支えているか
  console.log('\n観測の大分類ごとの内訳(その分類の陸のうち、モデルが当てた割合)');
  console.log('大分類   面積シェア   大分類一致   詳細一致');
  const grid = createGrid(1);
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  const names = ['A 熱帯', 'B 乾燥', 'C 温帯', 'D 冷帯', 'E 寒帯'];
  const wTot = new Array<number>(5).fill(0);
  const wMaj = new Array<number>(5).fill(0);
  const wDet = new Array<number>(5).fill(0);
  let wAll = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const o = obs.classRaster[i] ?? 0;
      if (!land[i] || o === 0) continue;
      const mdl = model[i] ?? 0;
      if (mdl === 0) continue;
      const mo = majorClassOf(o);
      if (mo < 0) continue;
      wAll += w;
      wTot[mo] = (wTot[mo] ?? 0) + w;
      if (majorClassOf(mdl) === mo) wMaj[mo] = (wMaj[mo] ?? 0) + w;
      if (mdl === o) wDet[mo] = (wDet[mo] ?? 0) + w;
    }
  }
  for (let k = 0; k < 5; k++) {
    const t = wTot[k] ?? 1;
    console.log(
      `${names[k]}  ${((t / wAll) * 100).toFixed(1).padStart(9)}%  ` +
        `${(((wMaj[k] ?? 0) / t) * 100).toFixed(1).padStart(9)}%  ` +
        `${(((wDet[k] ?? 0) / t) * 100).toFixed(1).padStart(8)}%`,
    );
  }
  void latDegOfRow;
}

void main();
