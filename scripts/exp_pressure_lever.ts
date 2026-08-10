// 実験(段 8): 気圧側のレバーを振って、**水が運ばれてくるようになるか**を見る。
//
// 事前登録: docs/事前登録_保存則で無効化された過去の棄却_2026-08-10.md
//
// なぜ要るか:
//   未達 3 ゲート(india / us_southeast / east_asia)は、境界の流束を数え切った
//   結果「夏の南からの流入がゼロ近傍」だった(docs/診断_地域の水蒸気収支)。
//   打つ手は風の側にある。
//
//   風を動かす手は過去に何度も棄却されているが、**棄却理由がいずれも
//   「供給場が水の量ではない」ことに由来している**:
//     モンスーントラフ増深 → 「豪州・アラビアが湿る割にインドは動かず」
//     赤道越えモンスーン風 → 「風上が海から陸へ切り替わるため逆効果」
//   保存型ではこの経路が無いので、結論が変わりうる。
//
// **判定は v3 ではなく「正味流入」を主にする**(事前登録)。
//   いまの定数は非保存向けで、しかも較正の途中である。成績で判定すると
//   風の改善が定数の古さに埋もれる。
//
//   正味流入 = P − E は、定常なら「外から運ばれてきた量」に等しい。
//   パイプラインの出力(月別降水と陸面蒸発散)だけで計算できる。
//
// 実行: npx tsx scripts/exp_pressure_lever.ts <定数名> <値1,値2,...>
//   例: npx tsx scripts/exp_pressure_lever.ts monsoonTroughDeepening 0,0.5,1,1.5
//       npx tsx scripts/exp_pressure_lever.ts continentalThermalHpa 9,14,20

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs, REGION_GATES, scoreRegionGates } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const KEY = process.argv[2] ?? 'monsoonTroughDeepening';
const VALUES = (process.argv[3] ?? '0,0.5,1,1.5').split(',').map(Number);

/** 見る地域(未達 3 件 + 対照 2 件) */
const TARGETS = [
  'india_tropical',
  'us_southeast_humid',
  'east_asia_humid',
  'congo_tropical',
  'europe_russia_continental',
];

/** 地域の陸セル(格子番号) */
function regionCells(r: PipelineResult, id: string): number[] {
  const gate = REGION_GATES.find((g) => g.id === id);
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  const out: number[] = [];
  if (!gate) return out;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < gate.latMin || lat > gate.latMax) continue;
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = lonDegOfCol(grid, col);
      const inLon =
        gate.lonMin <= gate.lonMax
          ? lon >= gate.lonMin && lon <= gate.lonMax
          : lon >= gate.lonMin || lon <= gate.lonMax;
      if (!inLon) continue;
      const i = row * grid.widthCells + col;
      if (land[i]) out.push(i);
    }
  }
  return out;
}

/** 月群の面積重み平均(mm/年 換算) */
function meanRate(
  r: PipelineResult,
  monthly: Float32Array[] | undefined,
  cells: number[],
  months: number[],
): number {
  if (!monthly) return 0;
  const grid = r.context.grid;
  let s = 0;
  let w = 0;
  for (const i of cells) {
    const cw = Math.cos((latDegOfRow(grid, Math.floor(i / grid.widthCells)) * Math.PI) / 180);
    let sum = 0;
    for (const m of months) sum += monthly[m]?.[i] ?? 0;
    s += cw * sum * (MONTHS_PER_YEAR / months.length);
    w += cw;
  }
  return s / Math.max(1e-9, w);
}

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  if (!(KEY in K)) {
    console.log(`定数 ${KEY} が無い`);
    return;
  }
  const base = K[KEY] ?? 0;
  console.log(`レバー: ${KEY}（現在値 ${base}）`);
  console.log(
    '\n値      v3      大分類  詳細   ゲート 位相  気温RMSE ' +
      TARGETS.map((t) => t.split('_')[0]?.padStart(7) ?? '').join(' '),
  );
  console.log(
    '                                                     ' +
      TARGETS.map(() => '  流入').join('  ') + '   ← 夏の正味流入 mm/年',
  );

  for (const value of VALUES) {
    K[KEY] = value;
    const accel = await openAccel(true);
    let r: PipelineResult;
    try {
      r = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const s = evaluateResult(r);
    const f = fieldScore(r, getClimObs());
    const gates = scoreRegionGates(r).filter((g) => g.pass).length;
    const cols: string[] = [];
    for (const id of TARGETS) {
      const cells = regionCells(r, id);
      const gate = REGION_GATES.find((g) => g.id === id);
      const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
      const summer = north ? [5, 6, 7] : [11, 0, 1];
      const p = meanRate(r, r.precipitation.monthlyPrecipMm, cells, summer);
      const e = meanRate(r, r.precipitation.land?.monthlyEtMm, cells, summer);
      cols.push((p - e).toFixed(0).padStart(7));
    }
    console.log(
      `${value.toString().padEnd(6)} ${s.fitness.toFixed(3)}  ${s.majorPct.toFixed(2)}  ` +
        `${s.detailPct.toFixed(2)}  ${String(gates).padStart(4)}  ` +
        `${f.precipPhaseRmseDays.toFixed(1)}  ${f.tempRmseC.toFixed(3).padStart(7)}  ${cols.join(' ')}`,
    );
  }
  K[KEY] = base;
  console.log(
    '\n判定(事前登録): 未達 3 地域(india / us_southeast / east_asia)の夏の\n' +
      '  **正味流入が有意に正へ動き**、対照 2 地域(congo / europe_russia)の\n' +
      '  流入が半減しないこと。そのうえで v3 が段 3 の 80.688 から 1.0 以上\n' +
      '  落ちないこと。1・2 を満たし 3 を満たさないなら保留にして原因を特定する。',
  );
}

void main();
