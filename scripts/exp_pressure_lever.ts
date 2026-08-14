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

import { performance } from 'node:perf_hooks';
import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs, REGION_GATES, scoreRegionGates } from './scoring';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { EBM_SOLVER_STATS } from '../src/sim/step05_temperature';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const KEY = process.argv[2] ?? 'monsoonTroughDeepening';
const VALUES = (process.argv[3] ?? '0,0.5,1,1.5').split(',').map(Number);

/**
 * 見る地域。既定は未達 3 件 + 対照 2 件。
 *
 * **判定に要る地域は、測る前に足しておくこと。** 段 10 で「降らせる側の機構を
 * 運ぶ側の物差しだけで判定して、何が起きたか分からなくなった」失敗をした。
 * 環境変数 `LEVER_TARGETS`(カンマ区切りのゲート id)で差し替えられる。
 */
const TARGETS = (process.env['LEVER_TARGETS'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (TARGETS.length === 0) {
  TARGETS.push(
    'india_tropical',
    'us_southeast_humid',
    'east_asia_humid',
    'congo_tropical',
    'europe_russia_continental',
  );
}

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

/**
 * 地域の年降水を観測比で返す(1.00 = 観測どおり)。
 * **運ぶ機構は正味流入、降らせる機構は降水そのもので判定する。**
 * 観測は 2° の気候値なので最近傍で引く
 */
function regionPrecipRatio(r: PipelineResult, cells: number[]): string {
  const grid = r.context.grid;
  const clim = getClimObs();
  let mp = 0;
  let op = 0;
  let w = 0;
  for (const i of cells) {
    const row = Math.floor(i / grid.widthCells);
    const col = i % grid.widthCells;
    const cw = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    const cr = Math.min(clim.heightCells - 1, Math.round((row / grid.heightCells) * clim.heightCells));
    const cc = Math.min(clim.widthCells - 1, Math.round((col / grid.widthCells) * clim.widthCells));
    const ci = cr * clim.widthCells + cc;
    let o = 0;
    let bad = false;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const v = clim.monthlyPrecipitationMm[m]?.[ci];
      if (v === undefined || v <= -9000) {
        bad = true;
        break;
      }
      o += v;
    }
    if (bad) continue;
    let p = 0;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
    mp += cw * p;
    op += cw * o;
    w += cw;
  }
  if (w <= 0 || op <= 0) return '  —  ';
  return (mp / op).toFixed(2).padStart(5);
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
    const t0 = performance.now();
    let r: PipelineResult;
    try {
      r = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const sec = (performance.now() - t0) / 1000;
    const wMm = CONSERVATIVE_STATS.meanWaterMm / Math.max(1, CONSERVATIVE_STATS.waterSamples);
    const s = evaluateResult(r);
    const f = fieldScore(r, getClimObs());
    const gates = scoreRegionGates(r).filter((g) => g.pass).length;
    const cols: string[] = [];
    const obsRatio: string[] = [];
    for (const id of TARGETS) {
      const cells = regionCells(r, id);
      const gate = REGION_GATES.find((g) => g.id === id);
      const north = gate ? (gate.latMin + gate.latMax) / 2 >= 0 : true;
      const summer = north ? [5, 6, 7] : [11, 0, 1];
      const p = meanRate(r, r.precipitation.monthlyPrecipMm, cells, summer);
      const e = meanRate(r, r.precipitation.land?.monthlyEtMm, cells, summer);
      cols.push((p - e).toFixed(0).padStart(7));
      // **降水そのものも観測比で出す**(2026-08-11)。段 10 で「降らせる側の機構を
      // 運ぶ側の物差し(正味流入)だけで判定して、何が起きたか分からなくなった」
      // 反省。運ぶ機構と降らせる機構では見るべき量が違う
      obsRatio.push(regionPrecipRatio(r, cells));
    }
    console.log(
      `${value.toString().padEnd(6)} ${sec.toFixed(0).padStart(4)}s W${wMm.toFixed(1).padStart(5)} ${s.fitness.toFixed(3)}  ${s.majorPct.toFixed(2)}  ` +
        `${s.detailPct.toFixed(2)}  ${String(gates).padStart(4)}  ` +
        `${f.precipPhaseRmseDays.toFixed(1)}  ${f.tempRmseC.toFixed(3).padStart(7)}  ${cols.join(' ')}`,
    );
    console.log(`       年降水／観測: ${obsRatio.join('  ')}`);
    // **収束の状態を必ず並べる(2026-08-14)。**
    // 段 20 の掃引は未収束の件数を出しておらず、鋭さ 8 以上で W が 328mm・462mm
    // という物理的にありえない値を「解」として表に載せてしまった。
    // 「反復の打ち切りが答えを決める」型の欠陥は EBM で 3 件踏んでいる
    // (docs/教訓.md)。未収束の解は黙って採用しない。
    const nc = CONSERVATIVE_STATS.nonConverged;
    const vnc = CONSERVATIVE_STATS.virgaNonConverged;
    // **結合反復も必ず出す(2026-08-14)。** 輸送だけ見ていたので、
    // 事前登録が要求する「輸送**と**結合反復が収束する」の片方が抜けていた。
    // 鋭さ 4 は輸送が収束していても結合反復が上限に当たる(テストで判明)。
    const cp = r.precipitation.coupling;
    const bad = nc + vnc > 0 || !cp.converged;
    console.log(
      `       収束: 輸送 未収束 ${String(nc).padStart(3)} 件` +
        ` / virga 未収束 ${String(vnc).padStart(3)} 件` +
        ` / 最悪残差 ${CONSERVATIVE_STATS.worstResidual.toExponential(2)}` +
        ` / 反復 ${CONSERVATIVE_STATS.iterations}`,
    );
    // **収束を要する反復は 5 系統ある**(2026-08-14 に数え上げた):
    //   輸送 / virga の外側反復 / 結合反復 / 土壌の周期定常 / EBM の周期定常。
    // 3 系統しか見ていなかったため、結合反復が発散している解を健全と読んだ。
    // 1 つ通ったことは他が通ったことを意味しない。
    const soil = r.precipitation.soil;
    const soilBad = soil ? !soil.converged : false;
    const ebmBad = EBM_SOLVER_STATS.capHits > 0;
    const anyBad = bad || soilBad || ebmBad;
    console.log(
      `             結合反復 ${cp.converged ? '収束' : '**未収束**'}` +
        ` ${cp.iterations}/${cp.maxIterations} 回` +
        ` / 残差 ${cp.finalResidualMmPerMonth.toFixed(3)} mm/月` +
        `(許容 ${cp.toleranceMmPerMonth})`,
    );
    console.log(
      `             土壌 ${soil ? (soil.converged ? '収束' : '**未収束**') : '—'}` +
        `${soil ? `（年貯水ドリフト 平均 ${soil.meanAnnualStorageDriftMm.toFixed(2)} / 最大 ${soil.maxAnnualStorageDriftMm.toFixed(2)} mm）` : ''}` +
        ` / EBM 上限到達 ${EBM_SOLVER_STATS.capHits} 回` +
        ` / 最大残差 ${EBM_SOLVER_STATS.maxResidualC.toFixed(4)}°C` +
        `${anyBad ? '   ← **この行は適用範囲外。解として読まない**' : ''}`,
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
