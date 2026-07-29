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
// ---------------------------------------------------------------------------
// 環流の流線: Worldbuilder's Log #28 / Artifexian の手順の忠実なトレース
// (docs/動画書き起こし/ の字幕原文に基づく。docs/spec/01-04_循環.md 参照)
//
//   1. 貿易風帯で西向きの流れを出発させる(順行時。逆行は全て鏡像)
//   2. 陸(大陸棚)に当たったら分割: 極向き = 暖流(赤)、赤道向き = 寒流(青)
//   3. 分割された流れは沿岸を壁伝いに這行し、その緯度の帯風が離岸方向を
//      向いたときに離岸して帯状の流れ(中立)になる:
//        - 東岸: フェレルセル中程以上で偏西風が東へ引き剥がす
//        - 西岸: 貿易風・極東風が西へ引き剥がす
//        - 赤道近傍: 赤道反流として東へ戻る
//   4. 帯状の流れが再び陸に当たれば再分割 — の連鎖で環流が「結果として」生じる。
//      閉ループは強制しない(手順に従うと必ずしも全てが閉じない)。
//   5. 訪問済みの状態に到達したら合流とみなして停止する。
//      陸のない緯度帯は風帯ごとの周極流(全海惑星では木星型バンド)。
//
// 流れはセル単位で海のみを移動するため、陸横断は構造的に起こらない。
// ---------------------------------------------------------------------------

/** 進行方位: 0=北, 1=東, 2=南, 3=西(row0 = 北端の格子) */
type Heading = 0 | 1 | 2 | 3;
const DROW = [-1, 0, 1, 0] as const;
const DCOL = [0, 1, 0, -1] as const;

function rotate(h: Heading, quarterTurns: number): Heading {
  return (((h + quarterTurns) % 4) + 4) % 4 as Heading;
}

interface TraceBands {
  eccDeg: number;
  ridgeDeg: number;
  pfDeg: number;
  westerlyReleaseDeg: number;
  polarReleaseDeg: number;
  tradeDirEast: boolean; // 貿易風の流す向き(順行 = 西 = false)
}

/** その緯度で帯風が流れを運ぶ向き(東 = true)。離岸判定にも使う。null = 遷移帯 */
function bandCarryDirEast(bands: TraceBands, latDeg: number): boolean | null {
  const a = Math.abs(latDeg);
  if (a <= bands.eccDeg) return !bands.tradeDirEast; // 赤道反流
  if (a < bands.ridgeDeg) return bands.tradeDirEast;
  if (a >= bands.westerlyReleaseDeg && a < bands.pfDeg) return !bands.tradeDirEast; // 偏西風
  if (a >= bands.polarReleaseDeg) return bands.tradeDirEast; // 極東風
  return null; // リッジ直上・極前線の遷移帯では離岸しない
}

interface ZonalThread {
  phase: 'zonal';
  row: number;
  col: number;
  dirEast: boolean;
}
interface CoastThread {
  phase: 'coast';
  row: number;
  col: number;
  heading: Heading;
  /** 陸が進行方向のどちら側か: +1 = 右、-1 = 左 */
  wallSide: 1 | -1;
  kind: 'warm' | 'cold';
}
type Thread = ZonalThread | CoastThread;

export function buildStreamlines(ctx: SimContext, windBelt: WindBeltResult): OceanStreamline[] {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = terrain.landMask;
  const prograde = params.body.rotationDirection >= 0;
  const isOcean = (row: number, col: number): boolean =>
    row >= 0 && row < H && !land[row * W + wrapCol(grid, col)];

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const ridgeDeg = Math.max(12, Math.abs(mean(windBelt.monthlyRidgeLatNDeg)));
  const pfDeg = Math.max(ridgeDeg + 8, Math.abs(mean(windBelt.monthlyPolarFrontLatNDeg)));
  const bands: TraceBands = {
    eccDeg: Math.min(7, ridgeDeg * 0.25),
    ridgeDeg,
    pfDeg,
    westerlyReleaseDeg: ridgeDeg + (pfDeg - ridgeDeg) * 0.35, // 「フェレルセル中程」(WL#28)
    polarReleaseDeg: pfDeg + 3,
    tradeDirEast: !prograde,
  };

  const out: OceanStreamline[] = [];
  const queue: Thread[] = [];
  const zonalVisited = new Set<number>();
  const coastVisited = new Set<number>();
  let totalSegments = 0;

  const pushSegment = (kind: OceanStreamline['kind'], points: number[]) => {
    if (points.length >= 6 && totalSegments < 160) {
      out.push({ kind, points });
      totalSegments++;
    }
  };

  /** 陸に衝突した流れを分割する(極向き = 暖、赤道向き = 寒) */
  const spawnSplit = (row: number, col: number, landDirEast: boolean) => {
    const landHeading: Heading = landDirEast ? 1 : 3;
    for (const poleward of [true, false]) {
      const north = latDegOfRow(grid, row) >= 0;
      const heading: Heading = (poleward ? (north ? 0 : 2) : north ? 2 : 0) as Heading;
      // 陸方位が進行方向の右なら wallSide=+1
      const wallSide: 1 | -1 = rotate(heading, 1) === landHeading ? 1 : -1;
      queue.push({ phase: 'coast', row, col, heading, wallSide, kind: poleward ? 'warm' : 'cold' });
    }
  };

  // ---- 種まき: 貿易風帯の中央で各海盆に 1 本 + 陸なし帯の周極流 ----
  for (const sign of [1, -1]) {
    const seedRow = rowOfLatDeg(grid, ridgeDeg * 0.5 * sign);
    for (const run of oceanRunsAtRow(ctx, seedRow)) {
      if (run.len < 4) continue;
      const startCol = wrapCol(grid, run.s + (bands.tradeDirEast ? 2 : run.len - 3));
      queue.push({ phase: 'zonal', row: seedRow, col: startCol, dirEast: bands.tradeDirEast });
    }
  }
  {
    // 陸のない緯度帯: 帯風の向きの周極流(帯中心が帯域内にあればその緯度)
    const centers: Array<{ lat: number; east: boolean }> = [];
    for (const sign of [1, -1]) {
      centers.push({ lat: (ridgeDeg / 2) * sign, east: bands.tradeDirEast });
      centers.push({ lat: ((ridgeDeg + pfDeg) / 2) * sign, east: !bands.tradeDirEast });
      centers.push({ lat: Math.min(84, pfDeg + 10) * sign, east: bands.tradeDirEast });
    }
    let groupStart = -1;
    for (let row = 0; row <= H; row++) {
      const isChannel = row < H && oceanRunsAtRow(ctx, row).some((r) => r.len >= W);
      if (isChannel && groupStart < 0) groupStart = row;
      if (!isChannel && groupStart >= 0) {
        const latHi = latDegOfRow(grid, groupStart);
        const latLo = latDegOfRow(grid, row - 1);
        if (row - 1 - groupStart >= 2 / grid.resolutionDeg) {
          const hits = centers.filter((b) => b.lat <= latHi && b.lat >= latLo);
          const lines = hits.length > 0 ? hits : [{ lat: (latHi + latLo) / 2, east: bands.tradeDirEast }];
          for (const line of lines) {
            queue.push({ phase: 'zonal', row: rowOfLatDeg(grid, line.lat), col: 0, dirEast: line.east });
          }
        }
        groupStart = -1;
      }
    }
  }

  // ---- トレース本体 ----
  let processed = 0;
  while (queue.length > 0 && processed < 500) {
    const t = queue.shift();
    if (!t) break;
    processed++;

    if (t.phase === 'zonal') {
      // 近接緯度(±2 行)の同方向の流れは 1 本に合流させる(離岸のたびに
      // 平行線が量産されて縞になるのを防ぐ)
      const zkey = (row: number, col: number) => (row * W + wrapCol(grid, col)) * 2 + (t.dirEast ? 1 : 0);
      if (zonalVisited.has(zkey(t.row, t.col))) continue;
      const dc = t.dirEast ? 1 : -1;
      const points: number[] = [];
      let col = t.col;
      let steps = 0;
      if (!isOcean(t.row, col)) continue;
      for (; steps <= W; steps++) {
        if (steps > 0 && zonalVisited.has(zkey(t.row, col))) break; // 既存の流れに合流
        for (let dr = -2; dr <= 2; dr++) {
          if (t.row + dr >= 0 && t.row + dr < H) zonalVisited.add(zkey(t.row + dr, col));
        }
        if (steps % 2 === 0) points.push(latDegOfRow(grid, t.row), lonDegOfCol(grid, wrapCol(grid, col)));
        if (!isOcean(t.row, col + dc)) {
          // 大陸棚に衝突 → 分割
          points.push(latDegOfRow(grid, t.row), lonDegOfCol(grid, wrapCol(grid, col)));
          spawnSplit(t.row, wrapCol(grid, col), t.dirEast);
          break;
        }
        col += dc;
      }
      pushSegment('neutral', points);
      continue;
    }

    // ---- 沿岸這行(壁伝い) ----
    let { row, col, heading } = t;
    const { wallSide, kind } = t;
    const points: number[] = [];
    if (!isOcean(row, col)) continue;
    for (let steps = 0; steps < 3 * (W + H); steps++) {
      const key = ((row * W + wrapCol(grid, col)) * 4 + heading) * 2 + (wallSide > 0 ? 1 : 0);
      if (coastVisited.has(key)) break; // 合流
      coastVisited.add(key);
      points.push(latDegOfRow(grid, row), lonDegOfCol(grid, wrapCol(grid, col)));

      // 離岸判定: 壁(陸)の反対方向が東西で、その緯度の帯風がその向きに運ぶ
      const wallDir = rotate(heading, wallSide);
      if (wallDir === 1 || wallDir === 3) {
        const offshoreEast = wallDir === 3; // 陸が西なら離岸方向は東
        const lat = latDegOfRow(grid, row);
        const carry = bandCarryDirEast(bands, lat);
        if (carry !== null && carry === offshoreEast && steps > 2) {
          queue.push({ phase: 'zonal', row, col: wrapCol(grid, col), dirEast: offshoreEast });
          break;
        }
      }

      // 壁伝いの次の一歩: 壁側 → 直進 → 反壁側 → 後退 の順で海を探す
      const tryHeadings: Heading[] = [
        rotate(heading, wallSide),
        heading,
        rotate(heading, -wallSide),
        rotate(heading, 2),
      ];
      let moved = false;
      for (const h of tryHeadings) {
        const nr = row + DROW[h];
        const nc = col + DCOL[h];
        if (isOcean(nr, nc)) {
          row = nr;
          col = wrapCol(grid, nc);
          heading = h;
          moved = true;
          break;
        }
      }
      if (!moved) break; // 袋小路(閉じた内海など)
    }
    pushSegment(kind, points);
  }

  return out;
}
