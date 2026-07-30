// Step 3: 海流。docs/spec/01-04_循環.md
// (a) 海盆のトポロジーから境界流・高緯度吹送流・赤道湧昇を判定し、
//     海面温度偏差(°C)として定量化する(気温 EBM への Q フラックス源)。
// (b) Worldbuilder's Log #28 の手順を月別に忠実トレースして環流の流線を作る。
//     字幕全文と動画フレーム(docs/動画書き起こし/)に基づく:
//     - まず ITCZ に沿う赤道反流(東向き・中立)。陸棚で U ターンし、
//       ITCZ から 5〜10° 離れた西向きの赤道流(中立)を返す
//     - 赤道流が陸棚に当たると分割: 極向き = 暖(赤)、赤道向き = 寒(青)
//     - 海流は海岸を数百 km 沖でなぞり、小さな湾・沿岸海は無視する
//       (実装: 陸を膨張させたブロックマスク上を壁伝いに這行)
//     - 夏半球は ~50°、冬半球は ~40° で偏西風が東へ転回させ、横断中も
//       極向きに傾く(まだ熱を運ぶので赤のまま)
//     - 極向きの暖流は夏 ~78° / 冬 ~70° まで(海氷が陸棚と同様にブロック)、
//       そこで極東風が西向きに返す(スラントつき)。青が環流を閉じる
//     - 閉ループは強制しない。訪問済み状態への到達 = 合流で停止
//     - 陸のない緯度帯は風帯ごとの周極流(全海惑星は木星型バンド)
// 地理決め打ちはしない。逆行自転では帯風の反転だけで全て鏡像になる。

import { latDegOfRow, lonDegOfCol, rowOfLatDeg, cellHeightKm, cellWidthKm, wrapCol } from '@/domain/grid';
import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { MODEL_CONSTANTS as K } from './constants';
import type {
  ItczResult,
  OceanCurrentResult,
  OceanStreamline,
  SimContext,
  WindBeltResult,
} from './types';

export function computeOceanCurrent(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
): OceanCurrentResult {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const land = terrain.landMask;
  const prograde = params.body.rotationDirection >= 0;

  const sstAnomalyC = new Float32Array(grid.cellCount);
  const currentClass = new Int8Array(grid.cellCount);

  // SST 偏差の帯域も惑星固有の風帯から導出(地球でそれぞれ ~8/38/68° に一致)
  const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const ridgeMean = Math.abs(meanOf(windBelt.monthlyRidgeLatNDeg));
  const pfMean = Math.abs(meanOf(windBelt.monthlyPolarFrontLatNDeg));
  const eccMean = Math.min(8, Math.max(4, ridgeMean * 0.22));
  const separationLat = ridgeMean + 0.25 * (pfMean - ridgeMean); // 境界流の分離緯度
  const driftHiLat = Math.min(84, pfMean + 8);

  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    const absLat = Math.abs(lat);
    if (absLat > driftHiLat + 4) continue;
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
      // 暖流は分離緯度(リッジ + フェレルセル幅×0.25。地球 ≈ 38°)で海盆内へ
      // 分離する。これより極側の海盆西縁は亜寒帯循環の寒流(ラブラドル/親潮)
      if (absLat >= eccMean && absLat <= separationLat) {
        const bandW = bellBand(absLat, eccMean, separationLat, 4);
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
      if (absLat >= separationLat && absLat <= driftHiLat) {
        const bandW = bellBand(absLat, separationLat, driftHiLat, 6);
        const widthFactor = Math.min(1, basinWidthDeg / 55); // 狭い海では発達しない
        anomaly += K.warmDriftC * Math.pow(pos, 1.4) * bandW * widthFactor;
        if (pos < 0.35) {
          anomaly += K.coldReturnC * (1 - pos / 0.35) * bandW * widthFactor;
        }
      }
      // 赤道湧昇(海盆東側の寒水舌)
      if (absLat < eccMean && pos > 0.5 && basinWidthDeg > 40) {
        anomaly += K.equatorialUpwellingC * ((pos - 0.5) / 0.5) * (1 - absLat / eccMean);
      }

      sstAnomalyC[i] = anomaly;
      currentClass[i] = anomaly > 0.5 ? 1 : anomaly < -0.5 ? -1 : 0;
    }
  }

  // ---- 流線: 月別トレース + 年平均(帯の年平均値でトレース) ----
  const monthlyStreamlines: OceanStreamline[][] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    monthlyStreamlines.push(traceStreamlines(ctx, itcz, windBelt, m));
  }
  const streamlines = traceStreamlines(ctx, itcz, windBelt, -1);
  return { sstAnomalyC, currentClass, streamlines, monthlyStreamlines };
}

/** 帯 [lo, hi] 内で 1、外側へ幅 edge の余韻で減衰 */
function bellBand(x: number, lo: number, hi: number, edge: number): number {
  if (x >= lo && x <= hi) return 1;
  const d = x < lo ? lo - x : x - hi;
  return Math.exp(-(d * d) / (edge * edge));
}

// ---------------------------------------------------------------------------
// WL#28 手順の流れ追跡
// ---------------------------------------------------------------------------

/** 進行方位: 0=北, 1=東, 2=南, 3=西(row0 = 北端の格子) */
type Heading = 0 | 1 | 2 | 3;
const DROW = [-1, 0, 1, 0] as const;
const DCOL = [0, 1, 0, -1] as const;

function rotate(h: Heading, quarterTurns: number): Heading {
  return ((((h + quarterTurns) % 4) + 4) % 4) as Heading;
}

interface SeasonBands {
  /** 反流帯の半幅(この範囲は ITCZ 系の東向き) */
  eccDeg: number;
  /** 貿易風帯の外縁(リッジ)。N/S 別 */
  ridgeN: number;
  ridgeS: number;
  /** 偏西風が東へ転回させる緯度(夏 ~50 / 冬 ~40)。N/S 別 */
  turnN: number;
  turnS: number;
  /** 暖流の極側到達 = 海氷縁(夏 ~78 / 冬 ~70)。N/S 別 */
  polarN: number;
  polarS: number;
  tradeDirEast: boolean;
}

interface ZonalThread {
  phase: 'zonal';
  row: number;
  col: number;
  dirEast: boolean;
  kind: 'neutral' | 'warm';
  /** 横断中の極向きスラント(-1 = 北へ、+1 = 南へ、0 = なし) */
  slantRowDir: -1 | 0 | 1;
}
interface CoastThread {
  phase: 'coast';
  row: number;
  col: number;
  heading: Heading;
  wallSide: 1 | -1;
  kind: 'warm' | 'cold';
}
type Thread = ZonalThread | CoastThread;

/**
 * month = 0..11 で月別、-1 で年平均の帯を使ってトレースする。
 */
function traceStreamlines(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
  month: number,
): OceanStreamline[] {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const prograde = params.body.rotationDirection >= 0;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

  // ---- 季節の帯(月別 or 年平均) ----
  const ridgeNRaw = month >= 0 ? (windBelt.monthlyRidgeLatNDeg[month] ?? 31) : mean(windBelt.monthlyRidgeLatNDeg);
  const ridgeSRaw = month >= 0 ? (windBelt.monthlyRidgeLatSDeg[month] ?? -31) : mean(windBelt.monthlyRidgeLatSDeg);
  const decl = month >= 0 ? (ctx.insolation.monthlyDeclinationDeg[month] ?? 0) : 0;
  const tilt = Math.max(params.body.axialTiltDeg, 1e-6);
  const declNorm = Math.max(-1, Math.min(1, decl / tilt));
  // 夏度(0 = 冬、1 = 夏)。年平均は 0.5
  const summerN = month >= 0 ? (declNorm + 1) / 2 : 0.5;
  const summerS = 1 - summerN;
  // 帯の位置は惑星固有の風帯構造(リッジ・極前線)からの相対値で導出する。
  // 動画の「40-50°」「70-80°」は CRETÁK の値であり定数にしない:
  //  - 転回緯度 = 「フェレルセルの中程」(WL#28 原文) = リッジ + セル幅 ×(0.40〜0.65)
  //  - 極側到達 = 海氷縁 ≈ 極前線 + 10〜18°(夏ほど極側。地球で 70〜78° に一致)
  const pfN = Math.abs(month >= 0 ? (windBelt.monthlyPolarFrontLatNDeg[month] ?? 60) : mean(windBelt.monthlyPolarFrontLatNDeg));
  const pfS = Math.abs(month >= 0 ? (windBelt.monthlyPolarFrontLatSDeg[month] ?? -60) : mean(windBelt.monthlyPolarFrontLatSDeg));
  const ridgeNAbs = Math.abs(ridgeNRaw);
  const ridgeSAbs = Math.abs(ridgeSRaw);
  const bands: SeasonBands = {
    eccDeg: Math.min(8, Math.max(4, ridgeNAbs * 0.22)),
    ridgeN: ridgeNAbs,
    ridgeS: ridgeSAbs,
    turnN: ridgeNAbs + (pfN - ridgeNAbs) * (0.4 + 0.25 * summerN),
    turnS: ridgeSAbs + (pfS - ridgeSAbs) * (0.4 + 0.25 * summerS),
    polarN: Math.min(86, pfN + 10 + 8 * summerN),
    polarS: Math.min(86, pfS + 10 + 8 * summerS),
    tradeDirEast: !prograde,
  };

  // ---- ブロックマスク: 膨張させた陸(沖合スタンドオフ + 小湾バイパス)+ 季節海氷 ----
  const cellKm = cellHeightKm(grid, params.body.radiusKm);
  const standoffCells = Math.max(1, Math.round(140 / cellKm));
  const blocked = new Uint8Array(grid.cellCount);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      if (!terrain.landMask[row * W + col]) continue;
      for (let dr = -standoffCells; dr <= standoffCells; dr++) {
        const r = row + dr;
        if (r < 0 || r >= H) continue;
        for (let dc = -standoffCells; dc <= standoffCells; dc++) {
          blocked[r * W + wrapCol(grid, col + dc)] = 1;
        }
      }
    }
  }
  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat > bands.polarN || lat < -bands.polarS) {
      for (let col = 0; col < W; col++) blocked[row * W + col] = 1;
    }
  }
  const isOpen = (row: number, col: number): boolean =>
    row >= 0 && row < H && !blocked[row * W + wrapCol(grid, col)];

  // ---- 帯風の運ぶ向き(離岸判定)。N/S の季節差を反映 ----
  // 貿易風帯での離岸は赤道流レーン(ITCZ ± 5〜10°)の近傍のみ:
  // 寒流は西岸をレーンまで這い降りてから西向きに合流する(WL#28)。
  const carryDirEast = (latDeg: number): boolean | null => {
    const a = Math.abs(latDeg);
    const north = latDeg >= 0;
    const turn = north ? bands.turnN : bands.turnS;
    const polar = north ? bands.polarN : bands.polarS;
    if (a <= bands.eccDeg) return !bands.tradeDirEast; // 反流帯
    if (a <= bands.eccDeg + 4) return bands.tradeDirEast; // 赤道流レーン
    if (a >= turn && a < polar - 2) return !bands.tradeDirEast; // 偏西風の転回帯
    if (a >= polar - 2) return bands.tradeDirEast; // 極東風
    return null; // それ以外は沿岸を這い続ける
  };

  const out: OceanStreamline[] = [];
  const queue: Thread[] = [];
  const zonalVisited = new Set<number>();
  const coastVisited = new Set<number>();
  let totalSegments = 0;
  const pushSegment = (kind: OceanStreamline['kind'], points: number[]) => {
    if (points.length < 6 || totalSegments >= 170) return;
    // 微小ループ(孤立した膨張セルの周回など)は捨てる
    let latMin = 90;
    let latMax = -90;
    let lonMin = 360;
    let lonMax = -360;
    for (let k = 0; k + 1 < points.length; k += 2) {
      const lat = points[k] ?? 0;
      const lon = points[k + 1] ?? 0;
      if (lat < latMin) latMin = lat;
      if (lat > latMax) latMax = lat;
      if (lon < lonMin) lonMin = lon;
      if (lon > lonMax) lonMax = lon;
    }
    if (latMax - latMin < 7 && lonMax - lonMin < 7) return;
    out.push({ kind, points });
    totalSegments++;
  };

  // Node の診断スクリプト専用(ブラウザ/Worker には process が無いので必ずガードする)
  const debugOn =
    typeof process !== 'undefined' && !!process.env?.TRACE_DEBUG && month === 0;
  const dbg = (msg: string, row: number, col: number) => {
    if (!debugOn) return;
    const lat = latDegOfRow(grid, row);
    const lon = lonDegOfCol(grid, wrapCol(grid, col));
    if (lat > -10 && lat < 65 && lon > -100 && lon < 10) {
      console.log(`[trace] ${msg} @(${lat.toFixed(0)},${lon.toFixed(0)})`);
    }
  };

  const spawnSplit = (row: number, col: number, landDirEast: boolean) => {
    const landHeading: Heading = landDirEast ? 1 : 3;
    for (const poleward of [true, false]) {
      const north = latDegOfRow(grid, row) >= 0;
      const heading: Heading = (poleward ? (north ? 0 : 2) : north ? 2 : 0) as Heading;
      const wallSide: 1 | -1 = rotate(heading, 1) === landHeading ? 1 : -1;
      dbg(`split ${poleward ? 'warm' : 'cold'} h=${heading} s=${wallSide}`, row, col);
      queue.push({ phase: 'coast', row, col, heading, wallSide, kind: poleward ? 'warm' : 'cold' });
    }
  };

  // ---- 種まき 1: ITCZ に沿う赤道反流(東向き・中立)。陸で分断される区間ごと ----
  const centers =
    month >= 0
      ? itcz.monthlyCenterLatDegByCol[month]
      : itcz.monthlyCenterLatDegByCol[Math.floor(MONTHS_PER_YEAR / 2)];
  {
    const eccOffsetDeg = bands.eccDeg + 3; // 反流の U ターン先(赤道流の緯度)
    let seg: number[] = [];
    let segStartCol = -1;
    const flushSeg = (endCol: number) => {
      if (seg.length >= 6) {
        // 走査順が反流の流向(貿易風の逆)なので並びはそのまま = 流向
        pushSegment('neutral', seg);
        // U ターン: 反流の終端から両半球の赤道流(貿易風向き)を返す。
        // レーンは各半球側に最低 ±4° を保証する(ITCZ が季節で反対半球へ
        // 移動しても、両半球の環流は年中維持される — WL#28 の冬版と同じ)。
        // 生成点が膨張海岸にかかっていたらレーン方向へ逃がす
        for (const sign of [1, -1]) {
          const raw = (centers?.[endCol] ?? 0) + eccOffsetDeg * sign;
          const lat = sign > 0 ? Math.max(raw, 4) : Math.min(raw, -4);
          const row = rowOfLatDeg(grid, lat);
          const dc = bands.tradeDirEast ? 1 : -1;
          for (let back = 0; back <= Math.floor(W / 8); back++) {
            const col = wrapCol(grid, endCol + dc * back);
            if (isOpen(row, col)) {
              queue.push({
                phase: 'zonal',
                row,
                col,
                dirEast: bands.tradeDirEast,
                kind: 'neutral',
                slantRowDir: 0,
              });
              break;
            }
          }
        }
      }
      seg = [];
      segStartCol = -1;
    };
    const colOrder = [...Array(W).keys()];
    for (const c of colOrder) {
      const col = bands.tradeDirEast ? W - 1 - c : c; // 反流の進行方向(貿易風の逆)順に走査
      const row = rowOfLatDeg(grid, centers?.[col] ?? 0);
      if (isOpen(row, col)) {
        if (segStartCol < 0) segStartCol = col;
        seg.push(latDegOfRow(grid, row), lonDegOfCol(grid, col));
      } else if (segStartCol >= 0) {
        flushSeg(wrapCol(grid, col + (bands.tradeDirEast ? 1 : -1)));
      }
    }
    if (segStartCol >= 0) flushSeg(bands.tradeDirEast ? 0 : W - 1);
  }

  // ---- 種まき 2: 陸のない緯度帯の周極流(帯風の向き) ----
  {
    const centersBand: Array<{ lat: number; east: boolean }> = [];
    for (const sign of [1, -1]) {
      const ridge = sign > 0 ? bands.ridgeN : bands.ridgeS;
      const turn = sign > 0 ? bands.turnN : bands.turnS;
      centersBand.push({ lat: (ridge / 2) * sign, east: bands.tradeDirEast });
      centersBand.push({ lat: ((turn + (sign > 0 ? bands.polarN : bands.polarS)) / 2) * sign, east: !bands.tradeDirEast });
    }
    let groupStart = -1;
    for (let row = 0; row <= H; row++) {
      let rowOpen = row < H;
      if (rowOpen) {
        for (let col = 0; col < W; col++) {
          if (!isOpen(row, col)) {
            rowOpen = false;
            break;
          }
        }
      }
      if (rowOpen && groupStart < 0) groupStart = row;
      if (!rowOpen && groupStart >= 0) {
        const latHi = latDegOfRow(grid, groupStart);
        const latLo = latDegOfRow(grid, row - 1);
        if (row - 1 - groupStart >= 2 / grid.resolutionDeg) {
          const hits = centersBand.filter((b) => b.lat <= latHi && b.lat >= latLo);
          const lines = hits.length > 0 ? hits : [{ lat: (latHi + latLo) / 2, east: bands.tradeDirEast }];
          for (const line of lines) {
            queue.push({
              phase: 'zonal',
              row: rowOfLatDeg(grid, line.lat),
              col: 0,
              dirEast: line.east,
              kind: 'neutral',
              slantRowDir: 0,
            });
          }
        }
        groupStart = -1;
      }
    }
  }

  // ---- トレース本体 ----
  let processed = 0;
  while (queue.length > 0 && processed < 600) {
    const t = queue.shift();
    if (!t) break;
    processed++;

    if (t.phase === 'zonal') {
      const zkey = (row: number, col: number) => (row * W + wrapCol(grid, col)) * 2 + (t.dirEast ? 1 : 0);
      if (zonalVisited.has(zkey(t.row, t.col))) continue;
      const dc = t.dirEast ? 1 : -1;
      const points: number[] = [];
      let row = t.row;
      let col = t.col;
      let slantAcc = 0;
      if (!isOpen(row, col)) continue;
      for (let steps = 0; steps <= W + H; steps++) {
        if (steps > 0 && zonalVisited.has(zkey(row, col))) break; // 合流
        for (let dr = -3; dr <= 3; dr++) {
          if (row + dr >= 0 && row + dr < H) zonalVisited.add(zkey(row + dr, col));
        }
        if (steps % 2 === 0) points.push(latDegOfRow(grid, row), lonDegOfCol(grid, wrapCol(grid, col)));
        // スラント(横断しながら極向きへ 8°/90° 程度)
        if (t.slantRowDir !== 0) {
          slantAcc += 0.09;
          if (slantAcc >= 1) {
            slantAcc = 0;
            if (isOpen(row + t.slantRowDir, col)) row += t.slantRowDir;
          }
        }
        if (!isOpen(row, col + dc)) {
          points.push(latDegOfRow(grid, row), lonDegOfCol(grid, wrapCol(grid, col)));
          spawnSplit(row, wrapCol(grid, col), t.dirEast);
          break;
        }
        col += dc;
      }
      pushSegment(t.kind, points);
      continue;
    }

    // ---- 沿岸這行(膨張マスク上の壁伝い = 数百 km 沖 + 小湾バイパス) ----
    let { row, col, heading } = t;
    const { wallSide, kind } = t;
    const points: number[] = [];
    if (!isOpen(row, col)) continue;
    // 周回停止則: 出発緯度より逆方向へ 3° 以上戻ったら「海の反対側で止まった」
    // とみなす(WL#28「陸が邪魔なら海岸沿いに進み、海の反対側で止める」の近似。
    // これがないと大陸を一周するリングになる)
    const startLat = latDegOfRow(grid, row);
    const northSide = startLat >= 0;
    const polewardSign = northSide ? 1 : -1; // 緯度が増える向きが極向きか
    for (let steps = 0; steps < 3 * (W + H); steps++) {
      const latHere = latDegOfRow(grid, row);
      const progress = (latHere - startLat) * polewardSign; // 正 = 極向きに進んだ
      if (kind === 'warm' && progress < -5) {
        dbg(`coast warm end=wraparound steps=${steps}`, row, col);
        break;
      }
      if (kind === 'cold' && progress > 5 && Math.abs(latHere) > 12) {
        dbg(`coast cold end=wraparound steps=${steps}`, row, col);
        break;
      }
      const key = ((row * W + wrapCol(grid, col)) * 4 + heading) * 2 + (wallSide > 0 ? 1 : 0);
      if (coastVisited.has(key)) {
        dbg(`coast ${kind} end=visited steps=${steps}`, row, col);
        break; // 合流
      }
      coastVisited.add(key);
      points.push(latDegOfRow(grid, row), lonDegOfCol(grid, wrapCol(grid, col)));

      // 離岸判定: 壁の反対方向が東西で、その緯度の帯風がその向きに運ぶ
      const wallDir = rotate(heading, wallSide);
      if (wallDir === 1 || wallDir === 3) {
        const offshoreEast = wallDir === 3;
        const lat = latDegOfRow(grid, row);
        const carry = carryDirEast(lat);
        if (carry !== null && carry === offshoreEast && steps > 2) {
          // 転回帯の横断は熱を運び続けるので暖(赤)。極東風帯・貿易風帯は中立
          const a = Math.abs(lat);
          const north = lat >= 0;
          const inWesterly = a >= (north ? bands.turnN : bands.turnS) && a < (north ? bands.polarN : bands.polarS) - 2;
          const slant: -1 | 0 | 1 = inWesterly || a >= (north ? bands.polarN : bands.polarS) - 2 ? (north ? -1 : 1) : 0;
          queue.push({
            phase: 'zonal',
            row,
            col: wrapCol(grid, col),
            dirEast: offshoreEast,
            kind: inWesterly && kind === 'warm' ? 'warm' : 'neutral',
            slantRowDir: slant,
          });
          break;
        }
      }

      // 壁伝いの次の一歩: 壁側 → 直進 → 反壁側 → 後退
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
        if (isOpen(nr, nc)) {
          row = nr;
          col = wrapCol(grid, nc);
          heading = h;
          moved = true;
          break;
        }
      }
      if (!moved) {
        dbg(`coast ${kind} end=deadend steps=${steps}`, row, col);
        break; // 袋小路(閉じた内海など)
      }
    }
    pushSegment(kind, points);
  }

  return out;
}
