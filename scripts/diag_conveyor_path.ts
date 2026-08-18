// 診断: **コンベアの経路場(段 45a)— 既存の量だけで合成し、判別力を測る。**
//
// なぜ要るか(2026-08-18):
//   C→B(華中型)を救い、B→C(豪州型)を守る判別は、幾何(緯度・距離)では
//   全滅した(diag_penetration)。設計方針(モンスーンコンベア)の主張は
//   「分けているのは気流の水そのもの」。物理に触れる前に、その経路強度を
//   診断として合成し、救う群と守る群を本当に分けられるかを測る。
//
//   強度_j(月) = 取水(東の海の 暖流偏差 × W) × 浸透減衰 exp(−東海岸距離/L)
//               × 夏ゲート × 緯度窓(ITCZ 極側〜リッジ+5°)
//
// 実行: npx tsx scripts/diag_conveyor_path.ts
//   (DIAG_OVERRIDE で定数上書き可)
// 事前登録: docs/事前登録_コンベア経路場_2026-08-18.md(予測 19〜21)

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { latDegOfRow, lonDegOfCol, cellWidthKm, wrapCol } from '../src/domain/grid';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: 値が数値でない '${key}'`);
    K[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

/** フェッチ(取水走査の奥行き km)と浸透感度 */
const FETCH_KM = 2500;
const PENETRATION_KM = [500, 1000, 2000];

interface Cell {
  w: number;
  lat: number;
  lon: number;
  /** 浸透 L ごとの夏平均経路強度 */
  strength: number[];
  /** 因子別(切り分け用): 夏平均 */
  intakeSst: number; // 取水域の max(0, sstAnomaly) 平均
  intakeW: number; // 取水域の waterMm 平均
  eastCoastKm: number; // 東海岸までの距離
  latWindow: number; // 緯度窓の夏平均(0〜1)
  rhFactor: number; // 追記 2: R-H 西側沈降の因子(1 = 抑制なし)
  crestFactor: number; // 追記 2: 経路上の峰の絞り(1 = 絞りなし)
}

function stats(cells: Cell[], f: (c: Cell) => number): { med: number; q25: number; q75: number } {
  const a = [...cells].sort((x, y) => f(x) - f(y));
  const tot = a.reduce((s, c) => s + c.w, 0);
  const q = (p: number): number => {
    let acc = 0;
    for (const c of a) {
      acc += c.w;
      if (acc >= p * tot) return f(c);
    }
    return a.length ? f(a[a.length - 1] as Cell) : 0;
  };
  return { med: q(0.5), q25: q(0.25), q75: q(0.75) };
}

function fmt(cells: Cell[], f: (c: Cell) => number, digits = 2): string {
  const s = stats(cells, f);
  return `中央 ${s.med.toFixed(digits).padStart(8)} (25% ${s.q25.toFixed(digits)} / 75% ${s.q75.toFixed(digits)})`;
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const r = out.result;
  const d = out.precipDiag;
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const H = grid.heightCells;
  const land = r.context.terrain.landMask;
  const ins = r.context.insolation;
  const kobs = getKoppenObs();
  const dirE = r.context.params.body.rotationDirection >= 0 ? 1 : -1;
  const radiusKm = r.context.params.body.radiusKm;

  if (!d.waterMm.length) throw new Error('保存型でない(waterMm が空)— この診断は保存型前提');

  // 月別・セル別の経路強度(浸透 L ごと)と因子を合成
  const nL = PENETRATION_KM.length;
  const sumStrength = PENETRATION_KM.map(() => new Float64Array(grid.cellCount));
  const sumIntakeSst = new Float64Array(grid.cellCount);
  const sumIntakeW = new Float64Array(grid.cellCount);
  const sumLatWindow = new Float64Array(grid.cellCount);
  const sumRh = new Float64Array(grid.cellCount);
  const sumCrest = new Float64Array(grid.cellCount);
  const cntSummer = new Float64Array(grid.cellCount);
  const eastCoastKm = new Float32Array(grid.cellCount).fill(9e9);
  const crest = r.context.terrain.crestElevationMeters;
  /** 追記 2: 峰の絞りの標高スケール(m) */
  const CREST_SCALE_M = 1000;

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const waterM = d.waterMm[m];
    const ridgeN = r.windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = r.windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const centers = r.itcz.monthlyCenterLatDegByCol[m];
    const insMonth = ins.monthlyByRow[m];
    // 追記 2: R-H 西側沈降の因子(段 44 の hCol/eastH と同じ規則の鏡像)。
    // 東(自転方向)に自分より強いモンスーン加熱がある列は沈降側 = 降らせられない
    const rhWestFactor = new Float64Array(WC).fill(1);
    {
      const rowN30 = Math.max(0, Math.round((90 - 30) / grid.resolutionDeg) - 1);
      const rowS30 = Math.min(H - 1, Math.round((90 + 30) / grid.resolutionDeg));
      const hCol = new Float64Array(WC);
      for (let col = 0; col < WC; col++) {
        let n = 0;
        let nl = 0;
        for (let row = rowN30; row <= rowS30; row++) {
          n++;
          if (land[row * WC + col]) nl++;
        }
        const frac = n > 0 ? nl / n : 0;
        const itczLat = centers?.[col] ?? 0;
        const disp = Math.min(1, Math.abs(itczLat) / (K.crossEquatorialRefDeg ?? 15));
        hCol[col] = disp * Math.min(1, frac / (K.monsoonLandFracRef ?? 0.3));
      }
      const degPerCol = 360 / WC;
      const minD = Math.max(1, Math.round(5 / degPerCol));
      const maxD = Math.round(60 / degPerCol);
      for (let col = 0; col < WC; col++) {
        let eastH = 0;
        for (let dd = minD; dd <= maxD; dd++) {
          const c2 = (((col + dirE * dd) % WC) + WC) % WC;
          eastH = Math.max(eastH, (hCol[c2] ?? 0) * Math.exp(-(dd * degPerCol) / 30));
        }
        const rhWest = Math.min(
          1,
          Math.max(0, (eastH - (hCol[col] ?? 0)) / (K.monsoonHeatContrastNorm ?? 0.1)),
        );
        rhWestFactor[col] = 1 - rhWest;
      }
    }
    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      // 夏ゲート: 日射の季節偏差(step02 と同じ規格化)
      const seasonalHeating = ((insMonth?.[row] ?? 0) - (ins.annualMeanByRow[row] ?? 0)) / 120;
      const summerW = Math.max(0, Math.min(1.2, seasonalHeating));
      if (summerW <= 0) continue;
      const dxKm = Math.max(20, cellWidthKm(grid, row, radiusKm));
      const maxScan = Math.max(10, Math.round((FETCH_KM + 4400) / dxKm));
      for (let col = 0; col < WC; col++) {
        const i = row * WC + col;
        if (!land[i]) continue;
        // 緯度窓: ITCZ の極側 〜 リッジ+5°(LLJ は高気圧の西縁を回る帯)
        const itczLat = centers?.[col] ?? 0;
        const ridge = lat >= 0 ? ridgeN : ridgeS;
        const aLat = Math.abs(lat);
        const lo = Math.abs(itczLat);
        const hi = Math.abs(ridge) + 5;
        // 窓の内側 1、外は 3° で減衰(硬い崖を作らない)
        let latW = 0;
        if (aLat >= lo && aLat <= hi) latW = 1;
        else if (aLat < lo) latW = Math.max(0, 1 - (lo - aLat) / 3);
        else latW = Math.max(0, 1 - (aLat - hi) / 3);
        if (latW <= 0) continue;
        // 東へ走査: 海岸まで陸を数え、その先フェッチ内の海で取水
        let coastKm = -1;
        let fetchSst = 0;
        let fetchW = 0;
        let fetchN = 0;
        let pathCrestM = 0; // 追記 2: 海岸〜セル j の経路上の最大峰標高
        // 追記 3: 走査は「東+赤道側」の斜め(2 セル東につき 1 セル赤道側)。
        // 高気圧の西縁を回る LLJ の近似 — メキシコ湾 LLJ がアパラチアを
        // 「越えない」ための幾何。ITCZ 緯度で打ち切り(その先は反対セルの水)
        const eqStep = lat >= 0 ? 1 : -1; // 赤道側 = 北半球なら南(行番号は増える)
        const rowItcz = Math.max(0, Math.min(H - 1, Math.round((90 - itczLat) / grid.resolutionDeg)));
        const dyKm = (111 * grid.resolutionDeg) / 2; // 1 歩あたりの南北移動(半セル)
        const stepKm = Math.hypot(dxKm, dyKm);
        for (let d2 = 1; d2 <= maxScan; d2++) {
          const row2 = row + eqStep * Math.round(d2 / 2);
          if (lat >= 0 ? row2 > rowItcz : row2 < rowItcz) break; // ITCZ を跨がない
          if (row2 < 0 || row2 >= H) break;
          const j = row2 * WC + wrapCol(grid, col + dirE * d2);
          const distKm = d2 * stepKm;
          if (coastKm < 0) {
            if (!land[j]) coastKm = distKm;
            else {
              pathCrestM = Math.max(pathCrestM, crest[j] ?? 0);
              if (distKm > 4400) break; // 海岸が遠すぎる(内陸の奥)
            }
            continue;
          }
          if (distKm - coastKm > FETCH_KM) break;
          if (!land[j]) {
            fetchSst += Math.max(0, r.ocean.sstAnomalyC[j] ?? 0);
            fetchW += waterM?.[j] ?? 0;
            fetchN++;
          }
          // フェッチ内の陸(島・半島)は取水に数えないだけで走査は続ける
        }
        if (coastKm < 0 || fetchN === 0) continue;
        const intakeSst = fetchSst / fetchN;
        const intakeW = fetchW / fetchN;
        const rhF = rhWestFactor[col] ?? 1;
        const crestF = Math.exp(-pathCrestM / CREST_SCALE_M);
        const intake = intakeSst * intakeW * rhF * crestF;
        eastCoastKm[i] = Math.min(eastCoastKm[i] ?? 9e9, coastKm);
        for (let li = 0; li < nL; li++) {
          const decay = Math.exp(-coastKm / (PENETRATION_KM[li] ?? 1000));
          sumStrength[li]![i] = (sumStrength[li]![i] ?? 0) + intake * decay * summerW * latW;
        }
        sumIntakeSst[i] = (sumIntakeSst[i] ?? 0) + intakeSst * summerW;
        sumIntakeW[i] = (sumIntakeW[i] ?? 0) + intakeW * summerW;
        sumLatWindow[i] = (sumLatWindow[i] ?? 0) + latW * summerW;
        sumRh[i] = (sumRh[i] ?? 0) + rhF * summerW;
        sumCrest[i] = (sumCrest[i] ?? 0) + crestF * summerW;
        cntSummer[i] = (cntSummer[i] ?? 0) + summerW;
      }
    }
  }

  // 動的分類(diag_penetration と同じ)
  const ctb: Cell[] = [];
  const btc: Cell[] = [];
  // 追記 1(予測 22〜23): 45b で壊してはならない「B 維持」群(観測 B・モデル B)
  const bkeep: Cell[] = [];
  const mkCell = (i: number, row: number, col: number): Cell => {
    const n = Math.max(1e-9, cntSummer[i] ?? 0);
    return {
      w: Math.cos((latDegOfRow(grid, row) * Math.PI) / 180),
      lat: latDegOfRow(grid, row),
      lon: lonDegOfCol(grid, col),
      strength: PENETRATION_KM.map((_, li) => (sumStrength[li]![i] ?? 0) / n),
      intakeSst: (sumIntakeSst[i] ?? 0) / n,
      intakeW: (sumIntakeW[i] ?? 0) / n,
      eastCoastKm: Math.min(9999, eastCoastKm[i] ?? 9e9),
      latWindow: (sumLatWindow[i] ?? 0) / n,
      rhFactor: (sumRh[i] ?? 0) / n,
      crestFactor: (sumCrest[i] ?? 0) / n,
    };
  };
  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) > 45) continue;
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const om = majorClassOf(obsId);
      const mm = majorClassOf(r.koppen.classId[i] ?? 0);
      if (om === MAJOR.C && mm === MAJOR.B) ctb.push(mkCell(i, row, col));
      else if (om === MAJOR.B && mm === MAJOR.C) btc.push(mkCell(i, row, col));
      else if (om === MAJOR.B && mm === MAJOR.B) bkeep.push(mkCell(i, row, col));
    }
  }

  console.log(`\nC→B(救う対象) ${ctb.length} セル / B→C(守る対象) ${btc.length} セル\n`);
  console.log('経路強度(夏平均、浸透 L 別)      C→B(救う)                              B→C(守る)');
  for (let li = 0; li < nL; li++) {
    const f = (c: Cell): number => c.strength[li] ?? 0;
    const sc = stats(ctb, f);
    const sb = stats(btc, f);
    const ratio = sb.med > 1e-9 ? (sc.med / sb.med).toFixed(1) : '∞';
    console.log(
      `L=${String(PENETRATION_KM[li]).padEnd(5)} ${fmt(ctb, f)}   ${fmt(btc, f)}   中央比 ${ratio}`,
    );
  }
  console.log(`\nB 維持(観測 B・モデル B — 壊してはならない) ${bkeep.length} セル`);
  for (let li = 0; li < nL; li++) {
    const f = (c: Cell): number => c.strength[li] ?? 0;
    const sc = stats(ctb, f);
    const sk = stats(bkeep, f);
    console.log(
      `L=${String(PENETRATION_KM[li]).padEnd(5)} ${fmt(bkeep, f)}   対 C→B 中央比 ${(sk.med / Math.max(1e-9, sc.med)).toFixed(2)}`,
    );
  }
  // 箱内の B 維持セルの強度(豪州内陸・アラビアが 45b で壊れないかの直接検査)
  {
    const inBox = (c: Cell, la0: number, la1: number, lo0: number, lo1: number): boolean => {
      let lon = c.lon;
      if (lon > 180) lon -= 360;
      return c.lat >= la0 && c.lat <= la1 && lon >= lo0 && lon <= lo1;
    };
    const aus = bkeep.filter((c) => inBox(c, -30, -22, 120, 140));
    const ara = bkeep.filter((c) => inBox(c, 18, 28, 40, 55));
    const f = (c: Cell): number => c.strength[1] ?? 0;
    if (aus.length) console.log(`豪州内陸の B 維持 (${aus.length}) L=1000: ${fmt(aus, f)}`);
    if (ara.length) console.log(`アラビアの B 維持 (${ara.length}) L=1000: ${fmt(ara, f)}`);
  }
  console.log('\n因子別(切り分け用)');
  console.log(`取水 SST 偏差 (°C)      ${fmt(ctb, (c) => c.intakeSst)}   ${fmt(btc, (c) => c.intakeSst)}`);
  console.log(`取水 W (mm)             ${fmt(ctb, (c) => c.intakeW)}   ${fmt(btc, (c) => c.intakeW)}`);
  console.log(`東海岸距離 (km)         ${fmt(ctb, (c) => c.eastCoastKm, 0)}   ${fmt(btc, (c) => c.eastCoastKm, 0)}`);
  console.log(`緯度窓 (0-1)            ${fmt(ctb, (c) => c.latWindow)}   ${fmt(btc, (c) => c.latWindow)}`);
  console.log(`R-H 因子 (0-1)          ${fmt(ctb, (c) => c.rhFactor)}   ${fmt(btc, (c) => c.rhFactor)}`);
  console.log(`峰の絞り (0-1)          ${fmt(ctb, (c) => c.crestFactor)}   ${fmt(btc, (c) => c.crestFactor)}`);

  // 名指しの箱(目視の参考のみ。判定には使わない)
  const boxes: Array<[string, number, number, number, number]> = [
    ['華中', 25, 33, 105, 122],
    ['米南東', 30, 37, -95, -78],
    ['豪州内陸', -30, -22, 120, 140],
    ['アラビア', 18, 28, 40, 55],
    ['ラプラタ', -35, -27, -65, -55],
  ];
  console.log('\n名指しの箱(参考): L=1000 の夏平均経路強度の箱平均');
  for (const [name, la0, la1, lo0, lo1] of boxes) {
    let s = 0;
    let wsum = 0;
    for (let row = 0; row < H; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < la0 || lat > la1) continue;
      for (let col = 0; col < WC; col++) {
        let lon = lonDegOfCol(grid, col);
        if (lon > 180) lon -= 360;
        if (lon < lo0 || lon > lo1) continue;
        const i = row * WC + col;
        if (!land[i]) continue;
        const n = Math.max(1e-9, cntSummer[i] ?? 0);
        s += (sumStrength[1]![i] ?? 0) / n;
        wsum++;
      }
    }
    console.log(`  ${name.padEnd(6)} ${(wsum > 0 ? s / wsum : 0).toFixed(3)}  (${wsum} セル)`);
  }
  console.log(
    '\n読み(事前登録の判定): 予測 19 = L=1000 の中央比 ≥ 3。' +
      '予測 20 = B→C の 25% 分位 < C→B 中央値の 10%。予測 21 = L を振っても向き不変。',
  );
}

void main();
