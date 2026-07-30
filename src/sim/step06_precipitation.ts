// Step 6: 降水(mm/月)。docs/spec/06_降水.md
// 水収支モデル: 風上追跡による水蒸気供給(海面蒸発 ∝ 飽和水蒸気圧、
// 距離減衰、陸面再蒸発の 2 パス)× 持ち上げ効率(ITCZ 収束・ストームトラック・
// 地形性上昇)× 抑制(亜熱帯沈降・雨陰・寒流沿岸)。
// derle-climate の系統バイアス(教訓 §8.2)への正面対応:
//  - シベリア過乾燥 → 長い偏西風輸送 + 陸面再蒸発の 2 パス
//  - 地中海性気候の欠落 → 寒候期に赤道側へ移るストームトラック
//  - アラビア過湿 → 沈降域の強い抑制と供給の距離減衰
//  - 東岸モンスーン → 夏の大陸低圧への onshore 風(Step 4)が供給を運ぶ

import { MONTHS_PER_YEAR } from '@/domain/insolation';
import { latDegOfRow, cellHeightKm, cellWidthKm, wrapCol } from '@/domain/grid';
import { MODEL_CONSTANTS as K } from './constants';
import { itczInfluenceAt } from './step01_itcz';
import type {
  AirflowResult,
  ItczResult,
  OceanCurrentResult,
  PrecipitationResult,
  SimContext,
  TemperatureResult,
  WindBeltResult,
} from './types';

/** 飽和水蒸気圧 hPa(Magnus 式)。水蒸気供給のスケールとして使用 */
export function saturationVaporPressureHpa(tempC: number): number {
  return 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
}

export function computePrecipitation(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
  ocean: OceanCurrentResult,
  airflow: AirflowResult,
  temperature: TemperatureResult,
): PrecipitationResult {
  const { grid, params, terrain } = ctx;
  const monthlyPrecipMm: Float32Array[] = [];
  const annualPrecipMm = new Float32Array(grid.cellCount);
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  const smallWater = buildSmallWaterMask(ctx);

  // 「自転方向の東」側の海までの距離(km)。亜熱帯高気圧の西翼湿潤化に使用。
  // 順行 = 東、逆行 = 西。行内スキャン(最大 40 セル)。
  const eastOceanKm = new Float32Array(grid.cellCount).fill(1e9);
  {
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    const W = grid.widthCells;
    for (let row = 0; row < grid.heightCells; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!terrain.landMask[i]) {
          eastOceanKm[i] = 0;
          continue;
        }
        const maxScan = Math.max(10, Math.round(4400 / dxKm)); // 距離基準(解像度非依存)
        for (let d = 1; d <= maxScan; d++) {
          const j = row * W + wrapCol(grid, col + dir * d);
          if (!terrain.landMask[j]) {
            eastOceanKm[i] = d * dxKm;
            break;
          }
        }
      }
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;
    if (!tField || !u || !v) continue;

    // ---- パス 1: 海洋のみを供給源として風上追跡 ----
    const supply1 = traceMoistureSupply(ctx, smallWater, tField, u, v, null);

    // ---- 持ち上げ・抑制係数と降水化(パス 1) ----
    const precip1 = convertToPrecip(ctx, itcz, m, tField, u, v, supply1, ridgeN, ridgeS, pfN, pfS, dyKm, ocean, eastOceanKm);

    // ---- パス 2: 陸面再蒸発を供給源に加えて再追跡 ----
    const landSource = new Float32Array(grid.cellCount);
    for (let i = 0; i < grid.cellCount; i++) {
      if (!terrain.landMask[i]) continue;
      const wetness = Math.min(1, (precip1[i] ?? 0) / 70); // 70mm/月で飽和
      landSource[i] = K.landRecyclingStrength * wetness;
    }
    const supply2 = traceMoistureSupply(ctx, smallWater, tField, u, v, landSource);
    const precip2 = convertToPrecip(ctx, itcz, m, tField, u, v, supply2, ridgeN, ridgeS, pfN, pfS, dyKm, ocean, eastOceanKm);

    monthlyPrecipMm.push(precip2);
    for (let i = 0; i < grid.cellCount; i++) {
      annualPrecipMm[i] = (annualPrecipMm[i] ?? 0) + (precip2[i] ?? 0);
    }
  }
  return { monthlyPrecipMm, annualPrecipMm };
}

/**
 * 閉じた内海・湖(面積 < 1.2M km² の海成分)のマスク。Fetch 則の対象。
 * 海峡で外洋に繋がる縁辺海(地中海など)は外洋と同成分になり対象外。
 */
function buildSmallWaterMask(ctx: SimContext): Uint8Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const label = new Int32Array(grid.cellCount).fill(-1);
  const mask = new Uint8Array(grid.cellCount);
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  let next = 0;
  const stack: number[] = [];
  for (let seed = 0; seed < grid.cellCount; seed++) {
    if (terrain.landMask[seed] || (label[seed] ?? 0) >= 0) continue;
    const id = next++;
    let areaKm2 = 0;
    const cells: number[] = [];
    stack.push(seed);
    label[seed] = id;
    while (stack.length > 0) {
      const i = stack.pop();
      if (i === undefined) break;
      const row = Math.floor(i / W);
      const col = i % W;
      areaKm2 += cellWidthKm(grid, row, params.body.radiusKm) * dyKm;
      cells.push(i);
      const nbs = [
        row > 0 ? (row - 1) * W + col : -1,
        row < H - 1 ? (row + 1) * W + col : -1,
        row * W + ((col + 1) % W),
        row * W + ((col + W - 1) % W),
      ];
      for (const nb of nbs) {
        if (nb >= 0 && !terrain.landMask[nb] && (label[nb] ?? 0) < 0) {
          label[nb] = id;
          stack.push(nb);
        }
      }
    }
    if (areaKm2 < 1_200_000) {
      for (const i of cells) mask[i] = 1;
    }
  }
  return mask;
}

/**
 * 風上追跡による水蒸気供給量(無次元)。各セルから風を遡り、
 * 海セルで q_sat(SST) に比例した蒸発を拾い、距離減衰で持ち込む。
 * landSource ≠ null のとき陸セルも(局所降水に応じて)供給源になる。
 * 閉じた内海(smallWater)からの供給は Fetch 則で内陸到達を制限する。
 */
function traceMoistureSupply(
  ctx: SimContext,
  smallWater: Uint8Array,
  tField: Float32Array,
  u: Float32Array,
  v: Float32Array,
  landSource: Float32Array | null,
): Float32Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  const q0 = saturationVaporPressureHpa(20); // 規格化基準(20°C の海面)

  for (let row = 0; row < H; row++) {
    const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
    for (let col = 0; col < W; col++) {
      const i0 = row * W + col;
      // 現在位置(セル座標、浮動小数)
      let fr = row + 0.5;
      let fc = col + 0.5;
      let traveledKm = 0;
      let attenuation = 1;
      let supply = 0;
      // 供給は経路の線積分(ステップ距離で重み付け。解像度に依存させない。
      // 基準は 1° の南北セル寸法 ≈ 111km)。ステップ数上限も距離基準
      const stepWeight = dyKm / 111;
      const maxSteps = Math.min(200, Math.ceil(K.moistureTraceMaxKm / dyKm) + 4);
      // Fetch 則(WL#32): 閉じた内海・湖の湿潤は「水域の風上幅(Fetch)」まで
      // しか内陸へ届かない。外洋(縁辺海含む)は対象外 — 到達は減衰長が決める。
      // 内海ごとに供給を保留し、横断幅が確定した時点でゲートを掛けて計上する。
      let landKmFromTarget = 0; // 対象セルからこれまでに歩いた陸の距離
      let inWater = false; // いま「内海」を横断中か(外洋は含めない)
      let bodyFetchKm = 0; // いま横断中の内海の幅
      let bodyLandAtEntry = 0; // その内海に入る手前までの陸距離
      let pendingSupply = 0; // その内海からの保留供給
      const commitBody = () => {
        if (pendingSupply > 0) {
          // Fetch を超えた先も完全遮断はしない(下限 0.3)— 実在の黒海・バルト海は
          // 遠方にも幾らか湿潤を送る。規則は「到達を抑える」性質のもの
          const reach = Math.min(bodyFetchKm, K.fetchOpenOceanCapKm);
          const f = Math.min(1, Math.max(0.3, (reach + 250 - bodyLandAtEntry) / 500));
          supply += pendingSupply * f;
        }
        pendingSupply = 0;
        bodyFetchKm = 0;
      };
      // 自セルが海なら足元の蒸発をまず拾う
      for (let step = 0; step < maxSteps; step++) {
        const r = Math.min(H - 1, Math.max(0, Math.floor(fr)));
        const c = wrapCol(grid, Math.floor(fc));
        const i = r * W + c;
        const tHere = tField[i] ?? 0;
        const qRel = saturationVaporPressureHpa(tHere) / q0;
        if (!terrain.landMask[i]) {
          if (smallWater[i]) {
            if (!inWater) {
              inWater = true;
              bodyLandAtEntry = landKmFromTarget;
              bodyFetchKm = 0;
              pendingSupply = 0;
            }
            pendingSupply += attenuation * qRel * stepWeight;
          } else {
            if (inWater) {
              inWater = false;
              commitBody();
            }
            supply += attenuation * qRel * stepWeight;
          }
        } else {
          if (inWater) {
            inWater = false;
            commitBody();
          }
          if (landSource) {
            supply += attenuation * qRel * (landSource[i] ?? 0) * stepWeight;
          }
        }
        if (traveledKm >= K.moistureTraceMaxKm) break;
        // 風上へ 1 セルぶん移動(風が弱い所は打ち切り)
        const uu = u[i] ?? 0;
        const vv = v[i] ?? 0;
        const speed = Math.hypot(uu, vv);
        if (speed < 0.5) break;
        const stepKm = dyKm; // 1 ステップ = 南北 1 セル相当の距離
        const dcCells = (-uu / speed) * (stepKm / dxKm);
        const drCells = (vv / speed) * (stepKm / dyKm); // 北向き風 → 南から来た(row 増加方向)
        fc += dcCells;
        fr += drCells;
        if (fr < 0 || fr >= H) break;
        traveledKm += stepKm;
        if (terrain.landMask[i]) landKmFromTarget += stepKm;
        else if (smallWater[i]) bodyFetchKm += stepKm;
        const decayKm = terrain.landMask[i] ? K.moistureDecayLandKm : K.moistureDecayOceanKm;
        attenuation *= Math.exp(-stepKm / decayKm);
        if (attenuation < 0.02) break;
      }
      if (inWater) commitBody(); // 途中終了した水域の保留分を精算
      out[i0] = supply;
    }
  }
  return out;
}

/** 供給 × 持ち上げ × 抑制 → mm/月 */
function convertToPrecip(
  ctx: SimContext,
  itcz: ItczResult,
  month: number,
  _tField: Float32Array,
  u: Float32Array,
  v: Float32Array,
  supply: Float32Array,
  ridgeN: number,
  ridgeS: number,
  pfN: number,
  pfS: number,
  dyKm: number,
  ocean: OceanCurrentResult,
  eastOceanKm: Float32Array,
): Float32Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const elev = terrain.elevationMeters;
  const decl = ctx.insolation.monthlyDeclinationDeg[month] ?? 0;

  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
    const ridge = lat >= 0 ? ridgeN : ridgeS;
    const pf = lat >= 0 ? pfN : pfS;
    const isWinter = lat >= 0 ? decl < 0 : decl > 0;
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      let lift = 1;

      // ITCZ 収束
      const gI = itczInfluenceAt(itcz, month, col, lat);
      lift *= 1 + K.itczLiftBoost * gI;

      // ストームトラック(リッジの極側〜極前線先の台形プラトー、寒候期に増強)
      const stLo = Math.abs(ridge) + 4;
      const stHi = Math.abs(pf) + 12;
      const aLat = Math.abs(lat);
      let stormW = 0;
      if (aLat > stLo && aLat < stHi) {
        const riseW = Math.min(1, (aLat - stLo) / 5);
        const fallW = Math.min(1, (stHi - aLat) / 10);
        stormW = Math.min(riseW, fallW);
        lift *= 1 + (K.stormTrackBoost + (isWinter ? K.stormTrackWinterBoost : 0)) * stormW;
      }

      // 地形性上昇 / 局所雨陰(風と標高勾配の内積)
      const east = row * W + wrapCol(grid, col + 1);
      const west = row * W + wrapCol(grid, col - 1);
      const north = row > 0 ? (row - 1) * W + col : i;
      const south = row < H - 1 ? (row + 1) * W + col : i;
      const dhdx = (Math.max(0, elev[east] ?? 0) - Math.max(0, elev[west] ?? 0)) / (2 * dxKm);
      const dhdy = (Math.max(0, elev[north] ?? 0) - Math.max(0, elev[south] ?? 0)) / (2 * dyKm);
      const uu = u[i] ?? 0;
      const vv = v[i] ?? 0;
      const upslopeMPerKmPerS = uu * dhdx + vv * dhdy; // m/km × m/s
      const refSlope = 800; // 基準: 8 m/s × 100 m/km
      if (upslopeMPerKmPerS > 0) {
        lift *= 1 + K.orographicBoost * Math.min(2.5, upslopeMPerKmPerS / refSlope);
      } else if (upslopeMPerKmPerS < 0) {
        const shadow = Math.min(1, -upslopeMPerKmPerS / refSlope);
        lift *= 1 - (1 - K.rainShadowFloor) * shadow;
      }

      // 風上山脈の遮蔽(広域雨陰): 風上へ遡って自セルより十分高い稜線があれば
      // 水蒸気の到達そのものを減衰させる(パタゴニア型の乾燥帯の根本機構)
      const blockFactor = upwindMountainFactor(ctx, elev, u, v, row, col, dxKm, dyKm);

      // 亜熱帯沈降: 下降枝の全域(リッジ −16° 〜 +5°)を抑制。ITCZ 影響下は防護
      const descLo = Math.abs(ridge) - 16;
      const descHi = Math.abs(ridge) + 5;
      let descW: number;
      if (aLat >= descLo && aLat <= descHi) {
        descW = 1;
      } else {
        const d = aLat < descLo ? descLo - aLat : aLat - descHi;
        descW = Math.exp(-(d * d) / 16);
      }
      // 亜熱帯高気圧の西翼(自転方向の東に海が近い)では沈降が緩む
      const eastRelief =
        K.eastCoastSubsidenceRelief * Math.exp(-(eastOceanKm[i] ?? 1e9) / K.eastCoastSubsidenceDecayKm);
      const subs = descW * (1 - K.subsidenceItczProtection * gI) * (1 - eastRelief);
      lift *= 1 - K.subsidenceSuppression * subs;

      // 寒流沿岸の安定化(亜熱帯〜中緯度の海岸乾燥: 沿岸〜300km。
      // フォークランド型の寒流帰還域まで含めるため上限 50°)
      if (terrain.landMask[i] && aLat > 10 && aLat < 50) {
        const coastKm = ctx.landDistToCoastKm[i] ?? 1e9;
        if (coastKm < 300) {
          const cold = nearestOceanAnomaly(ctx, ocean, row, col);
          if (cold < -0.8) {
            lift *= 1 - K.coldCoastSuppression * Math.min(1, -cold / 2.5);
          }
        }
      }

      // 高温湿潤の陸での対流性増幅(夏の東岸・熱帯の午後対流)
      if (terrain.landMask[i]) {
        const warmth = Math.min(1, Math.max(0, ((_tField[i] ?? 0) - 22) / 8));
        if (warmth > 0) {
          const supplyNorm = Math.min(1, (supply[i] ?? 0) / 1.2);
          lift *= 1 + K.warmHumidConvectiveBoost * warmth * supplyNorm;
        }
      }

      // ストームトラック帯の渦供給: 移動性低気圧が近傍の海から水蒸気を混合する
      // (月平均風の追跡では表現できない成分。海岸距離で減衰、風上山脈で遮蔽)
      let stormSupply = 0;
      if (stormW > 0 && terrain.landMask[i]) {
        const coastKm = ctx.landDistToCoastKm[i] ?? 1e9;
        const qRel = Math.max(
          K.stormMinQRel,
          saturationVaporPressureHpa((_tField[i] ?? 0) + 3) / saturationVaporPressureHpa(20),
        );
        stormSupply =
          K.stormMoistureSupply * stormW * qRel * Math.exp(-coastKm / K.stormMoistureDecayKm) * (isWinter ? 1.4 : 1);
      }

      // 供給 × 持ち上げ × 遮蔽 → mm/月(気圧が低い惑星は降水効率も下がる)
      const pressureFactor = Math.pow(Math.max(0.1, params.atmosphere.surfacePressureBar), 0.5);
      out[i] = Math.max(
        0,
        ((supply[i] ?? 0) + stormSupply) * blockFactor * lift * K.precipScaleMmPerUnit * pressureFactor,
      );
    }
  }
  return out;
}

/**
 * 風上山脈の遮蔽係数(0.3〜1)。風上へ K.upwindBlockScanKm まで遡り、
 * 経路上の最大標高が自セルより K.upwindBlockReliefM 以上高ければ遮蔽最大。
 */
function upwindMountainFactor(
  ctx: SimContext,
  elev: Float32Array,
  u: Float32Array,
  v: Float32Array,
  row: number,
  col: number,
  dxKm: number,
  dyKm: number,
): number {
  const { grid } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const i0 = row * W + col;
  const uu = u[i0] ?? 0;
  const vv = v[i0] ?? 0;
  const speed = Math.hypot(uu, vv);
  if (speed < 1) return 1;
  const ownElev = Math.max(0, elev[i0] ?? 0);
  let fr = row + 0.5;
  let fc = col + 0.5;
  let traveled = 0;
  let maxRidge = ownElev;
  const steps = Math.max(2, Math.round(K.upwindBlockScanKm / dyKm));
  for (let s = 0; s < steps; s++) {
    fc += (-uu / speed) * (dyKm / dxKm);
    fr += (vv / speed) * 1;
    if (fr < 0 || fr >= H) break;
    traveled += dyKm;
    if (traveled > K.upwindBlockScanKm) break;
    const r = Math.min(H - 1, Math.max(0, Math.floor(fr)));
    const c = wrapCol(grid, Math.floor(fc));
    const e = Math.max(0, elev[r * W + c] ?? 0);
    if (e > maxRidge) maxRidge = e;
  }
  const relief = maxRidge - ownElev;
  if (relief <= 300) return 1;
  const t = Math.min(1, (relief - 300) / K.upwindBlockReliefM);
  return 1 - (1 - K.upwindBlockFloor) * t;
}

/** 近傍(半径 3 セル)の海セル SST 偏差の最小値(寒流検出用) */
function nearestOceanAnomaly(
  ctx: SimContext,
  ocean: OceanCurrentResult,
  row: number,
  col: number,
): number {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  let minA = 0;
  for (let dr = -3; dr <= 3; dr++) {
    const r = row + dr;
    if (r < 0 || r >= grid.heightCells) continue;
    for (let dc = -3; dc <= 3; dc++) {
      const i = r * W + wrapCol(grid, col + dc);
      if (terrain.landMask[i]) continue;
      const a = ocean.sstAnomalyC[i] ?? 0;
      if (a < minA) minA = a;
    }
  }
  return minA;
}
