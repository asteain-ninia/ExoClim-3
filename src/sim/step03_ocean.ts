// Step 3: 海流。docs/spec/03_海流.md
// (a) 海盆のトポロジー(緯度行ごとの連続海域)から境界流・高緯度吹送流・
//     赤道湧昇を判定し、海面温度偏差(°C)として定量化する。
// (b) Artifexian / Pasta WL#28 の演繹手順(docs/動画書き起こし/)どおりに
//     環流の流線を構築する: 貿易風帯で西向き → 大陸棚で分割(赤道側は反流、
//     極側は境界流)→ フェレルセル中程で東向き → 分割で環流を閉じる →
//     極東風帯で西向き → 開いた極海には周極流。赤 = 暖、青 = 寒、黒 = 中立。
// 地理決め打ちはしない。逆行自転では東西が鏡像になる。

import { colOfLonDeg, latDegOfRow, lonDegOfCol, rowOfLatDeg, cellWidthKm, wrapCol } from '@/domain/grid';
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

/** 2 点間の線分が陸を横切るか(セル単位でサンプリング。経度は循環最短経路) */
function segmentCrossesLand(
  ctx: SimContext,
  row0: number,
  col0: number,
  row1: number,
  col1: number,
): boolean {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  let dc = col1 - col0;
  if (dc > W / 2) dc -= W;
  if (dc < -W / 2) dc += W;
  const steps = Math.max(Math.abs(row1 - row0), Math.abs(dc), 1);
  for (let k = 1; k < steps; k++) {
    const r = Math.round(row0 + ((row1 - row0) * k) / steps);
    const c = wrapCol(grid, Math.round(col0 + (dc * k) / steps));
    if (terrain.landMask[r * W + c]) return true;
  }
  return false;
}

/**
 * 海盆の縁(大陸棚)に沿って rowFrom → rowTo へ流線を這わせる。
 * 各行で前行のランと最も重なる海ランを選び、その縁の 1 セル沖を点にする。
 * 縁の急跳躍(湾・海峡・多島海)や線分の陸横断が出たら分枝を打ち切る —
 * **流線は決して陸を横切らない**ことをデータ側で保証する。
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
  let prevRow = -1;
  let prevCol = -1;
  for (let row = rowFrom; row !== rowTo + step; row += step) {
    if (row < 0 || row >= grid.heightCells) break;
    const runs = oceanRunsAtRow(ctx, row);
    // 前行と重なるランのうち「追跡中の縁が最も連続する」ものを選ぶ。
    // 重なり最大だと縁海(南シナ海など)に迷い込んで環流が低緯度で閉じてしまう。
    let best: OceanRun | null = null;
    let bestDist = Infinity;
    const prevEdge = prevCol >= 0 ? prevCol : wrapCol(grid, edgeCol(prev, side, W));
    for (const r of runs) {
      if (r.len < 3) continue; // 幅 3 セル未満の水路は追跡しない
      if (r.len >= W) continue; // 全周リング(陸なし行)には「縁」が無い
      if (runOverlap(prev, r, W) === 0) continue;
      const e = edgeCol(r, side, W);
      const dist = Math.min((e - prevEdge + W) % W, (prevEdge - e + W) % W);
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    }
    if (!best) break;
    const off = side === 'west' ? 1 : -1;
    const col = wrapCol(grid, edgeCol(best, side, W) + off);
    if (prevCol >= 0 && segmentCrossesLand(ctx, prevRow, prevCol, row, col)) {
      // 岬の回り込み: L 字迂回(縦→横 / 横→縦)を試し、両方塞がれていたら打ち切り
      const { terrain } = ctx;
      const viaVertOk =
        !terrain.landMask[row * W + prevCol] &&
        !segmentCrossesLand(ctx, prevRow, prevCol, row, prevCol) &&
        !segmentCrossesLand(ctx, row, prevCol, row, col);
      const viaHorizOk =
        !terrain.landMask[prevRow * W + col] &&
        !segmentCrossesLand(ctx, prevRow, prevCol, prevRow, col) &&
        !segmentCrossesLand(ctx, prevRow, col, row, col);
      if (viaVertOk) {
        points.push(latDegOfRow(grid, row), lonDegOfCol(grid, prevCol));
      } else if (viaHorizOk) {
        points.push(latDegOfRow(grid, prevRow), lonDegOfCol(grid, col));
      } else {
        break;
      }
    }
    prev = best;
    endRow = row;
    prevRow = row;
    prevCol = col;
    points.push(latDegOfRow(grid, row), lonDegOfCol(grid, col));
  }
  return { points, endRun: prev, endRow };
}

/**
 * ラン内で colFrom → colTo をランに沿って歩く緯線上の点列(流向 = 並び順)。
 * 両端の列を厳密に含める(環流の接合点を一致させるため)。
 */
function zonalBetween(
  ctx: SimContext,
  row: number,
  run: OceanRun,
  colFrom: number,
  colTo: number,
): number[] {
  const { grid } = ctx;
  const W = grid.widthCells;
  const lat = latDegOfRow(grid, row);
  const ia = (colFrom - run.s + W) % W;
  const ib = (colTo - run.s + W) % W;
  const dir = ib >= ia ? 1 : -1;
  const points: number[] = [];
  for (let k = ia; dir > 0 ? k <= ib : k >= ib; k += dir * 3) {
    points.push(lat, lonDegOfCol(grid, wrapCol(grid, run.s + k)));
  }
  const lastCol = wrapCol(grid, run.s + ib);
  const lastLon = lonDegOfCol(grid, lastCol);
  if (points[points.length - 1] !== lastLon) points.push(lat, lastLon);
  return points;
}

/**
 * 帯状区間を環流の内側へ弓なりに湾曲させる(bulgeDeg 正 = 北へ膨らむ)。
 * 直線 + 直角コーナーだと「縞」に見えて環流が輪として読めないため
 * (ExoClim-2 P4-21 と同趣旨)。両端は接合点なので動かさない。
 * 湾曲先が陸のときはその点を湾曲させない(流線は陸を横切らない)。
 */
function bowZonal(ctx: SimContext, points: number[], bulgeDeg: number): number[] {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  const n = points.length / 2;
  if (n < 3 || bulgeDeg === 0) return points;
  const out = points.slice();
  let prevRow = rowOfLatDeg(grid, out[0] ?? 0);
  let prevCol = colOfLonDeg(grid, out[1] ?? 0);
  for (let k = 1; k < n - 1; k++) {
    const origLat = out[k * 2] ?? 0;
    const col = colOfLonDeg(grid, out[k * 2 + 1] ?? 0);
    const candLat = origLat + bulgeDeg * Math.sin((Math.PI * k) / (n - 1));
    const candRow = rowOfLatDeg(grid, candLat);
    const candOk =
      !terrain.landMask[candRow * W + col] && !segmentCrossesLand(ctx, prevRow, prevCol, candRow, col);
    if (candOk) {
      out[k * 2] = candLat;
      prevRow = candRow;
    } else {
      prevRow = rowOfLatDeg(grid, origLat);
    }
    prevCol = col;
  }
  return out;
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
      // ---- 亜熱帯環流を「閉じたループ」として構築する ----
      // 接合点(枝の端の列)を厳密に共有し、海岸追跡が途中で止まった場合は
      // その緯度で輪を閉じる(Artifexian「隙間は論理的に延長して埋める」)。
      const off = leadSide === 'west' ? 1 : -1;
      const wbStartCol = wrapCol(grid, edgeCol(basin, leadSide, W) + off);

      // 西岸境界流(暖、極向き): 海岸に沿って這行(短くても海盆は捨てない)
      const wb = followCoast(ctx, leadSide, seedRow, driftRow, basin);
      if (wb.points.length >= 4) out.push({ kind: 'warm', points: wb.points });
      const topRow = wb.endRow; // 実際に届いた緯度(ここで輪を閉じる)
      const topRun = wb.endRun;
      const wbEndCol =
        wb.points.length >= 2 ? colOfLonDeg(grid, wb.points[wb.points.length - 1] ?? 0) : wbStartCol;

      // 東岸境界流(寒、赤道向き): 到達縁から赤道へ戻る
      const eb = followCoast(ctx, trailSide, topRow, seedRow, topRun);
      const ebStartCol =
        eb.points.length >= 2
          ? colOfLonDeg(grid, eb.points[1] ?? 0)
          : wrapCol(grid, edgeCol(topRun, trailSide, W) - off);
      if (eb.points.length >= 4) out.push({ kind: 'cold', points: eb.points });

      // 環流内側への湾曲量(海盆幅に応じて。輪として読ませる)
      const widthDeg = basin.len * grid.resolutionDeg;
      const bulge = Math.min(3.5, widthDeg / 14);

      // ドリフト(中立、偏西風向き): 西岸枝の終端 → 東岸枝の始端(赤道側へ湾曲)
      if (topRun.len >= 4 && topRow !== seedRow) {
        out.push({
          kind: 'neutral',
          points: bowZonal(ctx, zonalBetween(ctx, topRow, topRun, wbEndCol, ebStartCol), -bulge * sign),
        });
      }

      // 赤道流(中立、貿易風向き): 東岸枝の終端 → 西岸枝の始端で輪を閉じる(極側へ湾曲)
      const eqCloseCol =
        eb.points.length >= 2
          ? colOfLonDeg(grid, eb.points[eb.points.length - 1] ?? 0)
          : wrapCol(grid, edgeCol(basin, trailSide, W) - off);
      const eqRun = oceanRunsAtRow(ctx, seedRow).find(
        (r) => runContains(r, eqCloseCol, W) && runContains(r, wbStartCol, W),
      );
      if (eqRun) {
        out.push({
          kind: 'neutral',
          points: bowZonal(ctx, zonalBetween(ctx, seedRow, eqRun, eqCloseCol, wbStartCol), bulge * sign),
        });
      }

      // 亜寒帯環流(ドリフト緯度の先に海盆が続く場合): ドリフト線と境界を共有
      const sub = followCoast(ctx, trailSide, topRow, polarRow, topRun);
      if (sub.points.length >= 6) {
        out.push({ kind: 'warm', points: sub.points }); // 東側を極向きに進む暖流(ノルウェー海流相当)
        const spRow = sub.endRow;
        const spRun = sub.endRun;
        const spEndCol = colOfLonDeg(grid, sub.points[sub.points.length - 1] ?? 0);
        const back = followCoast(ctx, leadSide, spRow, topRow, spRun);
        const backStartCol =
          back.points.length >= 2
            ? colOfLonDeg(grid, back.points[1] ?? 0)
            : wrapCol(grid, edgeCol(spRun, leadSide, W) + off);
        if (spRun.len >= 4 && spRow !== topRow) {
          out.push({
            kind: 'neutral',
            points: bowZonal(
              ctx,
              zonalBetween(ctx, spRow, spRun, spEndCol, backStartCol),
              -Math.min(2.5, (spRun.len * grid.resolutionDeg) / 16) * sign,
            ),
          }); // 極帯の戻り(ドリフト側へ湾曲)
        }
        if (back.points.length >= 4) out.push({ kind: 'cold', points: back.points }); // 西側を赤道向きに戻る寒流
      }
    }

    // 赤道反流(中立、貿易風と逆向き): 赤道寄り 5° 付近
    if (sign > 0) {
      const eccRow = rowOfLatDeg(grid, 5);
      const eccOff = leadSide === 'west' ? 2 : -2;
      for (const run of oceanRunsAtRow(ctx, eccRow)) {
        if (run.len < minWidthCells * 1.5 || run.len >= W) continue;
        const a = wrapCol(grid, edgeCol(run, leadSide, W) + eccOff);
        const b = wrapCol(grid, edgeCol(run, trailSide, W) - eccOff);
        out.push({ kind: 'neutral', points: zonalBetween(ctx, eccRow, run, a, b) });
      }
    }
  }

  // 7. 周極流: 陸のない緯度帯は風帯ごとの帯状流に分解する(全海惑星では
  //    木星型のバンドになる。Artifexian「water world will be banded」)。
  //    貿易風帯 = 西向き、偏西風帯 = 東向き、極東風帯 = 西向き(順行時)。
  const bandCenters: Array<{ lat: number; eastward: boolean }> = [];
  for (const sign of [1, -1]) {
    bandCenters.push({ lat: (ridgeDeg / 2) * sign, eastward: !prograde });
    bandCenters.push({ lat: ((ridgeDeg + pfDeg) / 2) * sign, eastward: prograde });
    bandCenters.push({ lat: Math.min(84, pfDeg + 10) * sign, eastward: !prograde });
  }
  let groupStart = -1;
  for (let row = 0; row <= grid.heightCells; row++) {
    const isChannel =
      row < grid.heightCells && oceanRunsAtRow(ctx, row).some((r) => r.len >= W);
    if (isChannel && groupStart < 0) groupStart = row;
    if (!isChannel && groupStart >= 0) {
      const groupEnd = row - 1;
      if (groupEnd - groupStart + 1 >= 2 / grid.resolutionDeg) {
        const latHi = latDegOfRow(grid, groupStart);
        const latLo = latDegOfRow(grid, groupEnd);
        // 帯中心がこの帯域に入っていればその緯度に、入っていなければ帯域中央に 1 本
        const hits = bandCenters.filter((b) => b.lat <= latHi && b.lat >= latLo);
        const lines =
          hits.length > 0
            ? hits
            : [
                {
                  lat: (latHi + latLo) / 2,
                  eastward:
                    (Math.abs((latHi + latLo) / 2) > ridgeDeg &&
                      Math.abs((latHi + latLo) / 2) < pfDeg + 8) === prograde,
                },
              ];
        for (const line of lines) {
          const pts: number[] = [];
          for (let c = 0; c <= W; c += 3) {
            const col = line.eastward ? c % W : (W - (c % W)) % W;
            pts.push(line.lat, lonDegOfCol(grid, col));
          }
          out.push({ kind: 'neutral', points: pts });
        }
      }
      groupStart = -1;
    }
  }

  return out;
}
