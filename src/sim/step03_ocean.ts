// Step 3: 海流。docs/spec/03_海流.md
// (a) 海盆のトポロジー(緯度行ごとの連続海域)から境界流・高緯度吹送流・
//     赤道湧昇を判定し、海面温度偏差(°C)として定量化する。
// (b) Artifexian / Pasta WL#28 の演繹手順(docs/動画書き起こし/)どおりに
//     環流の流線を構築する: 貿易風帯で西向き → 大陸棚で分割(赤道側は反流、
//     極側は境界流)→ フェレルセル中程で東向き → 分割で環流を閉じる →
//     極東風帯で西向き → 開いた極海には周極流。赤 = 暖、青 = 寒、黒 = 中立。
// 地理決め打ちはしない。逆行自転では東西が鏡像になる。

import { latDegOfRow, lonDegOfCol, rowOfLatDeg, cellWidthKm, wrapCol } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import type { OceanCurrentResult, OceanStreamline, SimContext, WindBeltResult } from './types';

export function computeOceanCurrent(ctx: SimContext, windBelt: WindBeltResult): OceanCurrentResult {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = terrain.landMask;
  const prograde = params.body.rotationDirection >= 0;

  const sstAnomalyC = new Float32Array(grid.cellCount);
  const currentClass = new Int8Array(grid.cellCount);

  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    const absLat = Math.abs(lat);
    if (absLat > 72) continue;
    const kmPerCell = cellWidthKm(grid, row, params.body.radiusKm);

    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (land[i]) continue;

      // 同一行内で西向き・東向きに陸まで何セルか(最大 1 周)
      let westCells = -1;
      let eastCells = -1;
      for (let d = 1; d < W; d++) {
        if (westCells < 0 && land[row * W + ((col - d + W * 4) % W)]) westCells = d;
        if (eastCells < 0 && land[row * W + ((col + d) % W)]) eastCells = d;
        if (westCells >= 0 && eastCells >= 0) break;
      }
      if (westCells < 0 || eastCells < 0) continue; // 周極海(陸なし行)は中立

      const basinCells = westCells + eastCells - 1;
      const basinWidthDeg = basinCells * grid.resolutionDeg;
      const basinPos = westCells / (basinCells + 1); // 0 = 海盆西端、1 = 東端
      const westKm = westCells * kmPerCell;
      const eastKm = eastCells * kmPerCell;
      // 逆行自転では海盆の東西役割が入れ替わる
      const nearWestBoundaryKm = prograde ? westKm : eastKm;
      const nearEastBoundaryKm = prograde ? eastKm : westKm;
      const pos = prograde ? basinPos : 1 - basinPos;

      let anomaly = 0;
      // 亜熱帯: 西岸境界流(暖・極向き)と東岸境界流(寒・赤道向き)。
      // 暖流は ~40° で海盆内へ分離する(実物の黒潮・メキシコ湾流の分離緯度。
      // これより極側の海盆西縁は亜寒帯循環の寒流: ラブラドル/親潮/フォークランド)
      if (absLat >= 8 && absLat <= 40) {
        const bandW = bellBand(absLat, 8, 40, 4);
        if (nearWestBoundaryKm < K.boundaryCurrentReachKm) {
          anomaly +=
            K.warmBoundaryCurrentC * (1 - nearWestBoundaryKm / K.boundaryCurrentReachKm) * bandW;
        }
        if (nearEastBoundaryKm < K.boundaryCurrentReachKm) {
          anomaly +=
            K.coldBoundaryCurrentC * (1 - nearEastBoundaryKm / K.boundaryCurrentReachKm) * bandW;
        }
      }
      // 中高緯度: 暖流吹送域(海盆東側ほど暖かい)と海盆西縁の寒流帰還
      if (absLat >= 40 && absLat <= 68) {
        const bandW = bellBand(absLat, 40, 68, 6);
        const widthFactor = Math.min(1, basinWidthDeg / 55); // 狭い海では発達しない
        anomaly += K.warmDriftC * Math.pow(pos, 1.4) * bandW * widthFactor;
        if (pos < 0.35) {
          anomaly += K.coldReturnC * (1 - pos / 0.35) * bandW * widthFactor;
        }
      }
      // 赤道湧昇(海盆東側の寒水舌)
      if (absLat < 7 && pos > 0.5 && basinWidthDeg > 40) {
        anomaly += K.equatorialUpwellingC * ((pos - 0.5) / 0.5) * (1 - absLat / 7);
      }

      sstAnomalyC[i] = anomaly;
      currentClass[i] = anomaly > 0.5 ? 1 : anomaly < -0.5 ? -1 : 0;
    }
  }
  const streamlines = buildStreamlines(ctx, windBelt);
  return { sstAnomalyC, currentClass, streamlines };
}

/** 帯 [lo, hi] 内で 1、外側へ幅 edge の余韻で減衰 */
function bellBand(x: number, lo: number, hi: number, edge: number): number {
  if (x >= lo && x <= hi) return 1;
  const d = x < lo ? lo - x : x - hi;
  return Math.exp(-(d * d) / (edge * edge));
}

// ---------------------------------------------------------------------------
// 環流の流線構築(Artifexian / Pasta WL#28 の演繹手順)
// ---------------------------------------------------------------------------

/** 循環区間: cols s .. s+len-1 (mod W) が海 */
interface OceanRun {
  s: number;
  len: number;
}

function oceanRunsAtRow(ctx: SimContext, row: number): OceanRun[] {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  const land = terrain.landMask;
  const base = row * W;
  // 陸が全く無い行は 1 本の全周ラン
  let anyLand = false;
  for (let c = 0; c < W; c++) {
    if (land[base + c]) {
      anyLand = true;
      break;
    }
  }
  if (!anyLand) return [{ s: 0, len: W }];
  const runs: OceanRun[] = [];
  // 陸セルの直後から走査開始(ラップ跨ぎのランを一体で拾う)
  let start = -1;
  for (let c = 0; c < W; c++) {
    if (land[base + c]) {
      start = c;
      break;
    }
  }
  let cur = -1;
  for (let k = 1; k <= W; k++) {
    const c = (start + k) % W;
    if (!land[base + c]) {
      if (cur < 0) cur = c;
    } else if (cur >= 0) {
      runs.push({ s: cur, len: (c - cur + W) % W });
      cur = -1;
    }
  }
  if (cur >= 0) runs.push({ s: cur, len: (start + 1 - cur + W) % W || W });
  return runs;
}

function runContains(run: OceanRun, col: number, W: number): boolean {
  return ((col - run.s + W) % W) < run.len;
}

/** 2 つの循環区間の重なりセル数 */
function runOverlap(a: OceanRun, b: OceanRun, W: number): number {
  let overlap = 0;
  // 小さい方を走査(len は最大 W)
  const [small, big] = a.len <= b.len ? [a, b] : [b, a];
  for (let k = 0; k < small.len; k++) {
    if (runContains(big, (small.s + k) % W, W)) overlap++;
  }
  return overlap;
}

function edgeCol(run: OceanRun, side: 'west' | 'east', W: number): number {
  return side === 'west' ? run.s : (run.s + run.len - 1) % W;
}

/**
 * 海盆の縁(大陸棚)に沿って rowFrom → rowTo へ流線を這わせる。
 * 各行で前行のランと最も重なる海ランを選び、その縁の 1 セル沖を点にする。
 */
function followCoast(
  ctx: SimContext,
  side: 'west' | 'east',
  rowFrom: number,
  rowTo: number,
  seedRun: OceanRun,
): { points: number[]; endRun: OceanRun; endRow: number } {
  const { grid } = ctx;
  const W = grid.widthCells;
  const step = rowTo >= rowFrom ? 1 : -1;
  const points: number[] = [];
  let prev = seedRun;
  let endRow = rowFrom;
  for (let row = rowFrom; row !== rowTo + step; row += step) {
    if (row < 0 || row >= grid.heightCells) break;
    const runs = oceanRunsAtRow(ctx, row);
    let best: OceanRun | null = null;
    let bestOv = 0;
    for (const r of runs) {
      const ov = runOverlap(prev, r, W);
      if (ov > bestOv) {
        bestOv = ov;
        best = r;
      }
    }
    if (!best || bestOv === 0) break;
    prev = best;
    endRow = row;
    const off = side === 'west' ? 1 : -1;
    const col = wrapCol(grid, edgeCol(best, side, W) + off);
    points.push(latDegOfRow(grid, row), lonDegOfCol(grid, col));
  }
  return { points, endRun: prev, endRow };
}

/** ラン内を縁から縁へ横切る緯線上の点列(order: fromSide → toSide) */
function zonalPoints(
  ctx: SimContext,
  row: number,
  run: OceanRun,
  fromSide: 'west' | 'east',
  margin: number,
): number[] {
  const { grid } = ctx;
  const lat = latDegOfRow(grid, row);
  const points: number[] = [];
  const n = Math.max(2, run.len - 2 * margin);
  const stepCells = Math.max(1, Math.floor(n / Math.max(2, Math.floor(n / 4))));
  for (let k = 0; k <= n; k += stepCells) {
    const along = fromSide === 'west' ? run.s + margin + k : run.s + run.len - 1 - margin - k;
    points.push(lat, lonDegOfCol(grid, wrapCol(grid, along)));
  }
  return points;
}

/**
 * 環流の流線一式を演繹する。
 * 亜熱帯環流(赤道流 → 西岸境界流(暖)→ ドリフト → 東岸境界流(寒))、
 * 赤道反流、亜寒帯環流(東側極向き(暖)→ 極帯西向き → 西側赤道向き(寒))、
 * 周極流(陸のない緯度帯)。逆行自転では東西の役割と流向が鏡像になる。
 */
export function buildStreamlines(ctx: SimContext, windBelt: WindBeltResult): OceanStreamline[] {
  const { grid, params } = ctx;
  const W = grid.widthCells;
  const prograde = params.body.rotationDirection >= 0;
  // 流れが最初にぶつかる縁 = 順行では海盆の西縁(貿易風が西向きのため)
  const leadSide: 'west' | 'east' = prograde ? 'west' : 'east';
  const trailSide: 'west' | 'east' = prograde ? 'east' : 'west';

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const ridgeDeg = Math.abs(mean(windBelt.monthlyRidgeLatNDeg));
  const pfDeg = Math.abs(mean(windBelt.monthlyPolarFrontLatNDeg));
  const driftDeg = Math.min(60, (ridgeDeg + pfDeg) / 2); // フェレルセル中程(WL#28)
  const polarDeg = Math.min(80, pfDeg + 6);
  const eqDeg = Math.max(8, ridgeDeg * 0.4);

  const out: OceanStreamline[] = [];

  for (const sign of [1, -1]) {
    const seedRow = rowOfLatDeg(grid, eqDeg * sign);
    const driftRow = rowOfLatDeg(grid, driftDeg * sign);
    const polarRow = rowOfLatDeg(grid, polarDeg * sign);
    const minWidthCells = Math.round(22 / grid.resolutionDeg);
    const basins = oceanRunsAtRow(ctx, seedRow).filter((r) => r.len >= minWidthCells && r.len < W);

    for (const basin of basins) {
      // 1. 赤道流(中立、貿易風向き = 順行で西向き): trailSide → leadSide
      out.push({ kind: 'neutral', points: zonalPoints(ctx, seedRow, basin, trailSide, 2) });

      // 2. 西岸境界流(暖、極向き): 海岸に沿って這行
      const wb = followCoast(ctx, leadSide, seedRow, driftRow, basin);
      if (wb.points.length >= 4) out.push({ kind: 'warm', points: wb.points });

      // 3. ドリフト(中立、偏西風向き): leadSide → trailSide
      const driftRun = wb.endRun;
      if (wb.endRow === driftRow && driftRun.len >= 4) {
        out.push({ kind: 'neutral', points: zonalPoints(ctx, driftRow, driftRun, leadSide, 2) });
      }

      // 4. 東岸境界流(寒、赤道向き)
      const eb = followCoast(ctx, trailSide, driftRow, seedRow, wb.endRow === driftRow ? driftRun : basin);
      if (eb.points.length >= 4) out.push({ kind: 'cold', points: eb.points });

      // 5. 亜寒帯環流(ドリフト緯度の先に海盆が続く場合)
      const sub = followCoast(ctx, trailSide, driftRow, polarRow, wb.endRow === driftRow ? driftRun : basin);
      if (sub.points.length >= 6) {
        out.push({ kind: 'warm', points: sub.points }); // 東側を極向きに進む暖流(ノルウェー海流相当)
        const polarRun = sub.endRun;
        if (sub.endRow === polarRow && polarRun.len >= 4) {
          out.push({ kind: 'neutral', points: zonalPoints(ctx, polarRow, polarRun, trailSide, 2) }); // 極帯で西向き
        }
        const back = followCoast(ctx, leadSide, sub.endRow, driftRow, sub.endRun);
        if (back.points.length >= 4) out.push({ kind: 'cold', points: back.points }); // 西側を赤道向きに戻る寒流
      }
    }

    // 6. 赤道反流(中立、貿易風と逆向き): 赤道寄り 5° 付近
    if (sign > 0) {
      const eccRow = rowOfLatDeg(grid, 5);
      for (const run of oceanRunsAtRow(ctx, eccRow)) {
        if (run.len < minWidthCells * 1.5 || run.len >= W) continue;
        out.push({ kind: 'neutral', points: zonalPoints(ctx, eccRow, run, leadSide, 3) });
      }
    }
  }

  // 7. 周極流: 陸のない緯度行の帯。風帯に従い偏西風帯なら東向き、極東風帯なら西向き
  let groupStart = -1;
  for (let row = 0; row <= grid.heightCells; row++) {
    const isChannel =
      row < grid.heightCells && oceanRunsAtRow(ctx, row).some((r) => r.len >= W);
    if (isChannel && groupStart < 0) groupStart = row;
    if (!isChannel && groupStart >= 0) {
      const midRow = Math.floor((groupStart + row - 1) / 2);
      const lat = latDegOfRow(grid, midRow);
      if (row - groupStart >= 2 / grid.resolutionDeg) {
        const inWesterlies = Math.abs(lat) > ridgeDeg && Math.abs(lat) < pfDeg + 8;
        const eastward = inWesterlies === prograde;
        const pts: number[] = [];
        for (let c = 0; c <= W; c += 3) {
          const col = eastward ? c % W : (W - (c % W)) % W;
          pts.push(lat, lonDegOfCol(grid, col));
        }
        out.push({ kind: 'neutral', points: pts });
      }
      groupStart = -1;
    }
  }

  return out;
}
