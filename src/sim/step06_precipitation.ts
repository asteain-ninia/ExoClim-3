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

  // 「自転方向の東」側の海までの距離(km)とその海の SST 偏差。
  // 亜熱帯高気圧の西翼湿潤化は「東の海が暖流のとき」だけ効かせる
  // (アラビア海のような非暖流の東海で誤発火しない — 2026-07-30 レビュー A2)。
  // 順行 = 東、逆行 = 西。行内スキャン(最大 40 セル)。
  const eastOceanKm = new Float32Array(grid.cellCount).fill(1e9);
  const eastOceanSstA = new Float32Array(grid.cellCount);
  {
    const dir = params.body.rotationDirection >= 0 ? 1 : -1;
    const W = grid.widthCells;
    for (let row = 0; row < grid.heightCells; row++) {
      const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!terrain.landMask[i]) {
          eastOceanKm[i] = 0;
          eastOceanSstA[i] = ocean.sstAnomalyC[i] ?? 0;
          continue;
        }
        const maxScan = Math.max(10, Math.round(4400 / dxKm)); // 距離基準(解像度非依存)
        for (let d = 1; d <= maxScan; d++) {
          const j = row * W + wrapCol(grid, col + dir * d);
          if (!terrain.landMask[j]) {
            eastOceanKm[i] = d * dxKm;
            eastOceanSstA[i] = ocean.sstAnomalyC[j] ?? 0;
            break;
          }
        }
      }
    }
  }

  // 年平均 ITCZ 中心(経度列別)。赤道常湿帯の残留影響に使う —
  // 実物の熱赤道近傍は ITCZ が年 2 回通過し遠くへ行かないため乾季でも雨が残る
  // (Pasta/Log の「赤道 = 雨林」の定量化)。トラフが片半球へ深く出る経度でも
  // 年平均線の周りは湿ったままにする
  const meanItczCenters = new Float32Array(grid.widthCells);
  {
    for (let col = 0; col < grid.widthCells; col++) {
      let s = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        s += itcz.monthlyCenterLatDegByCol[m]?.[col] ?? 0;
      }
      meanItczCenters[col] = s / MONTHS_PER_YEAR;
    }
  }

  // ---- パス 1: 海洋のみを供給源として風上追跡(全月)----
  const supplies1: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    supplies1.push(
      tField && u && v
        ? traceMoistureSupply(ctx, smallWater, tField, u, v, null, 0)
        : new Float32Array(grid.cellCount),
    );
  }
  // 供給の月ブレンド(0.25/0.5/0.25): 月平均風の単一方向トレースは風向の
  // 月替わりで供給が断絶する(ガンジス 7 月 589mm → 8 月 0mm — レビュー H8)。
  // 実際の遷移月はどちらの風も吹く。方位を振る案は雨陰へ回り込むため月方向で均す
  const blend = (arr: Float32Array[], m: number): Float32Array => {
    const prev = arr[(m + MONTHS_PER_YEAR - 1) % MONTHS_PER_YEAR];
    const cur = arr[m];
    const next = arr[(m + 1) % MONTHS_PER_YEAR];
    const out = new Float32Array(grid.cellCount);
    for (let i = 0; i < grid.cellCount; i++) {
      out[i] = 0.0 * (prev?.[i] ?? 0) + 1.0 * (cur?.[i] ?? 0) + 0.0 * (next?.[i] ?? 0);
    }
    return out;
  };

  const supplies2: Float32Array[] = [];
  const precip1ByMonth: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;
    if (!tField || !u || !v) {
      supplies2.push(new Float32Array(grid.cellCount));
      precip1ByMonth.push(new Float32Array(grid.cellCount));
      continue;
    }
    const supply1 = blend(supplies1, m);
    const precip1 = convertToPrecip(ctx, itcz, m, tField, u, v, supply1, ridgeN, ridgeS, pfN, pfS, dyKm, ocean, eastOceanKm, eastOceanSstA, meanItczCenters);
    precip1ByMonth.push(precip1);

    // ---- パス 2: 陸面再蒸発を供給源に加えて再追跡(反復)----
    // 実物の内陸雨林は降水の 5〜8 割が再蒸発の再循環で自己保持される。
    // 1 回パスだと海から遠い赤道内陸が立ち上がれない(鶏と卵 — 仮想大陸の
    // 赤道内陸が砂漠化する実測 2026-07-31)ため、固定点に向けて反復する
    let precipIter = precip1;
    let supplyIter = supply1;
    for (let it = 0; it < K.recyclingIterations; it++) {
      const landSource = new Float32Array(grid.cellCount);
      for (let i = 0; i < grid.cellCount; i++) {
        if (!terrain.landMask[i]) continue;
        const wetness = Math.min(1, (precipIter[i] ?? 0) / 40); // 40mm/月で飽和
        landSource[i] = K.landRecyclingStrength * wetness;
      }
      supplyIter = traceMoistureSupply(ctx, smallWater, tField, u, v, landSource, 0);
      if (it < K.recyclingIterations - 1) {
        precipIter = convertToPrecip(ctx, itcz, m, tField, u, v, supplyIter, ridgeN, ridgeS, pfN, pfS, dyKm, ocean, eastOceanKm, eastOceanSstA, meanItczCenters);
      }
    }
    supplies2.push(supplyIter);
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;
    if (!tField || !u || !v) {
      monthlyPrecipMm.push(new Float32Array(grid.cellCount));
      continue;
    }
    const supply2 = blend(supplies2, m);
    const precip2 = convertToPrecip(ctx, itcz, m, tField, u, v, supply2, ridgeN, ridgeS, pfN, pfS, dyKm, ocean, eastOceanKm, eastOceanSstA, meanItczCenters);
    monthlyPrecipMm.push(precip2);
  }

  // ---- 寒候期の弱前線の床(年総量保存の再配分)----
  // 最乾月が 0mm に張り付く癖(検証観点: Cwa 最多/最少比 276 vs 実物 ~10)への
  // 対策。冬のストーム帯内では弱い前線・降雪が最乾月にも数〜十数 mm 残る。
  // 湿潤月から比例控除して年総量を保存する(B 閾値の年量判定を動かさない。
  // 夏集中率だけが下がり、実物どおり閾値 2T+28→2T+21 に戻る)。
  // 熱帯のサバナ乾季(ストーム帯外)には掛からない。
  {
    const W = grid.widthCells;
    const decls = ctx.insolation.monthlyDeclinationDeg;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      const aLat = Math.abs(lat);
      for (let col = 0; col < W; col++) {
        const i = row * W + col;
        if (!terrain.landMask[i]) continue;
        let wettest = 0;
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          const p = monthlyPrecipMm[m]?.[i] ?? 0;
          if (p > wettest) wettest = p;
        }
        const floorMm = Math.min(K.winterFloorMaxMm, K.winterFloorFracOfWettest * wettest);
        if (floorMm < 0.5) continue;
        let deficit = 0;
        let surplus = 0;
        const floors: number[] = [];
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          // 適用月 = 寒候期(赤緯が反対半球)。盛夏外(正規化赤緯 < 0.5)まで
          // 広げる案は詳細 +0.6 だが大分類 −0.7 で撤回(2026-07-31)。
          // 4〜5 月の「春の谷」→ タイガ Ds 誤判定は既知課題(較正記録)
          const isWinter = lat >= 0 ? (decls[m] ?? 0) < 0 : (decls[m] ?? 0) > 0;
          const ridge = lat >= 0 ? (windBelt.monthlyRidgeLatNDeg[m] ?? 31) : (windBelt.monthlyRidgeLatSDeg[m] ?? -31);
          const pf = lat >= 0 ? (windBelt.monthlyPolarFrontLatNDeg[m] ?? 60) : (windBelt.monthlyPolarFrontLatSDeg[m] ?? -60);
          const inBand = aLat > Math.abs(ridge) + 1 && aLat < Math.abs(pf) + 12;
          const f = isWinter && inBand ? floorMm : 0;
          floors.push(f);
          const p = monthlyPrecipMm[m]?.[i] ?? 0;
          if (p < f) deficit += f - p;
          else surplus += p - f;
        }
        if (deficit <= 0 || surplus <= 0) continue;
        // 移転は湿潤月の余剰の 35% まで(無制限だと不足 ≈ 余剰のセルで k→1 と
        // なり夏の雨をほぼ全部持っていき、タイガが夏乾の Ds に化ける — 実測)。
        // 足りない分は床の部分充足に留める(季節性の保存が最優先)
        const transfer = Math.min(deficit, surplus * 0.35);
        const k = transfer / surplus;
        const fill = transfer / deficit;
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          const arr = monthlyPrecipMm[m];
          if (!arr) continue;
          const p = arr[i] ?? 0;
          const f = floors[m] ?? 0;
          arr[i] = p < f ? p + (f - p) * fill : p - (p - f) * k;
        }
      }
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const arr = monthlyPrecipMm[m];
    if (!arr) continue;
    for (let i = 0; i < grid.cellCount; i++) {
      annualPrecipMm[i] = (annualPrecipMm[i] ?? 0) + (arr[i] ?? 0);
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
  rotRad: number,
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
      // 自セルが海なら足元の蒸発をまず拾う。
      // 経路障壁の脱水(2026-07-30 レビュー P1): 供給源と対象の間の最高障壁を
      // 越える際、障壁が両端より高い分だけ水蒸気が風上斜面の雨として失われる。
      // 逐次の複利にすると丘陵の起伏が累積して全球が乾く(実測)ため、
      // 「これまでの最高標高」1 本で判定する
      const targetElev = Math.max(0, terrain.elevationMeters[i0] ?? 0);
      let maxBarrierM = targetElev;
      for (let step = 0; step < maxSteps; step++) {
        const r = Math.min(H - 1, Math.max(0, Math.floor(fr)));
        const c = wrapCol(grid, Math.floor(fc));
        const i = r * W + c;
        const eHere = Math.max(0, terrain.elevationMeters[i] ?? 0);
        if (eHere > maxBarrierM) maxBarrierM = eHere;
        const barrierOver = Math.max(0, maxBarrierM - Math.max(eHere, targetElev));
        const barrierFactor = Math.max(0.25, Math.exp(-barrierOver / K.orographicDepletionM));
        const tHere = tField[i] ?? 0;
        const qRel = (saturationVaporPressureHpa(tHere) / q0) * barrierFactor;
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
        // 風上へ 1 セルぶん移動(風が弱い所は打ち切り)。rotRad で方位を振る
        const u0 = u[i] ?? 0;
        const v0 = v[i] ?? 0;
        const cosR = Math.cos(rotRad);
        const sinR = Math.sin(rotRad);
        const uu = u0 * cosR - v0 * sinR;
        const vv = u0 * sinR + v0 * cosR;
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
  eastOceanSstA: Float32Array,
  meanItczCenters: Float32Array,
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

      // ITCZ 収束。傘は「湿潤収束が海洋起源のときだけ開く」— 供給の乏しい
      // 乾燥内陸ではトラフ直下でも雨にならない(実物のアラビア熱低は乾いた
      // 低気圧 — 2026-07-30 レビュー A1)
      const gIm = itczInfluenceAt(itcz, month, col, lat, K.itczPrecipWidthFactor);
      // 赤道常湿帯: 年平均 ITCZ 線の周りは月別中心が離れた季節でも影響が残る
      const dMean = (lat - (meanItczCenters[col] ?? 0)) / (itcz.halfWidthDeg * 0.55);
      const gIres = K.equatorialItczResidual * Math.exp(-dMean * dMean);
      const gI = Math.max(gIm, gIres);
      const marineW = Math.min(1, (supply[i] ?? 0) / K.itczLiftSupplyNorm);
      lift *= 1 + K.itczLiftBoost * gI * marineW;

      // 前線収束(WL#29「セル衝突線 = 前線(低圧・湿潤)」の定量化):
      // 湿った空気(高供給)が極向き風で乾いた側へ押し込まれる場所が前線。
      // ITCZ 傘とストーム帯の間(≈25-40°)の梅雨・バイウ前線の空白を埋める
      {
        const north2 = row > 0 ? (row - 1) * W + col : i;
        const south2 = row < H - 1 ? (row + 1) * W + col : i;
        const eqNb = lat >= 0 ? south2 : north2;
        const polNb = lat >= 0 ? north2 : south2;
        const gradPoleward = Math.max(0, (supply[eqNb] ?? 0) - (supply[polNb] ?? 0));
        const vPoleward = lat >= 0 ? (v[i] ?? 0) : -(v[i] ?? 0);
        const aLat0 = Math.abs(lat);
        if (vPoleward > 0 && gradPoleward > 0 && aLat0 > Math.abs(ridge) - 6 && aLat0 < Math.abs(pf)) {
          const frontW = Math.min(1.5, (vPoleward / 4) * gradPoleward);
          lift *= 1 + K.frontalLiftBoost * frontW;
        }
      }

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
      // 注(2026-07-31): 沈降の気圧場駆動(高圧下で増強/湿潤低圧下で緩和)は
      // 両方向とも実測否定 — 増強はリッジ帯自体が +6hPa で飽和して一様乾燥化
      // (−1.4pt)、湿潤側緩和はトラフを開けすぎ(−2.1pt、ゲート −1)。
      // B 帯の縁の緯度直線性は Log の手法自体が「帯として描く」ものでもある
      // (較正記録参照)。
      // 亜熱帯高気圧の西翼(自転方向の東に海が近い)では沈降が緩む。
      // ただし「東の海が暖流(西岸境界流)のとき」だけ — バミューダ高気圧の
      // 西翼は暖流の上で湿る。非暖流(アラビア海型)では緩めない(レビュー A2)
      const eastWarmth = Math.min(1, Math.max(0, ((eastOceanSstA[i] ?? 0) + 0.6) / 1.2));
      const eastRelief =
        K.eastCoastSubsidenceRelief *
        eastWarmth *
        Math.exp(-(eastOceanKm[i] ?? 1e9) / K.eastCoastSubsidenceDecayKm);
      const subs = descW * (1 - K.subsidenceItczProtection * gI * marineW) * (1 - eastRelief);
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

      // 高温湿潤の陸での対流性増幅(夏の東岸・熱帯の午後対流)。
      // 分母を 2.8 に上げて高供給の湿潤域だけ発火させる(1.2 では半乾燥内陸まで
      // 飽和して豪州が Aw 化した — 較正記録の撤回理由への対処。レビュー H5)
      if (terrain.landMask[i]) {
        const warmth = Math.min(1, Math.max(0, ((_tField[i] ?? 0) - 22) / 8));
        if (warmth > 0) {
          const supplyNorm = Math.min(1, (supply[i] ?? 0) / K.warmHumidSupplyNorm);
          lift *= 1 + K.warmHumidConvectiveBoost * warmth * supplyNorm * supplyNorm;
        }
      }

      // ストームトラック帯の渦供給: 移動性低気圧が近傍の海から水蒸気を混合する
      // (月平均風の追跡では表現できない成分。海岸距離で減衰、風上山脈で遮蔽)。
      // 供給帯はリッジ +1° から(持ち上げ帯 +4° より広く — 晩秋の東岸の断絶対策)。
      // 水蒸気量は局所の陸気温ではなく近傍で最も暖かい海面の気温を基準にする
      // (冬の東岸の低気圧は暖流から汲む — 湾流・黒潮型。レビュー H1)
      let stormSupply = 0;
      const stSupplyLo = Math.abs(ridge) + 1;
      if (aLat > stSupplyLo && aLat < stHi && terrain.landMask[i]) {
        const supplyW = Math.min(
          Math.min(1, (aLat - stSupplyLo) / 5),
          Math.min(1, (stHi - aLat) / 10),
        );
        const coastKm = ctx.landDistToCoastKm[i] ?? 1e9;
        const oceanT = nearestOceanTempC(ctx, _tField, row, col);
        const qBaseT = oceanT !== null ? Math.max(oceanT, (_tField[i] ?? 0)) : (_tField[i] ?? 0);
        const qRel = Math.max(
          K.stormMinQRel,
          saturationVaporPressureHpa(qBaseT + 3) / saturationVaporPressureHpa(20),
        );
        // WL#31: 前線圏の湿気の到達は onshore 2,000km / offshore 1,000km。
        // 短い風上ウォーク(~500km)の海率で on/off を連続判定し減衰長に反映
        let oceanSteps = 0;
        {
          let fr = row + 0.5;
          let fc = col + 0.5;
          const uu2 = u[i] ?? 0;
          const vv2 = v[i] ?? 0;
          const sp = Math.max(0.5, Math.hypot(uu2, vv2));
          for (let s = 0; s < 5; s++) {
            fc -= (uu2 / sp) * (100 / dxKm);
            fr += (vv2 / sp) * (100 / dyKm);
            const rr = Math.min(H - 1, Math.max(0, Math.floor(fr)));
            const cc2 = wrapCol(grid, Math.floor(fc));
            if (!terrain.landMask[rr * W + cc2]) oceanSteps++;
          }
        }
        const onshore01 = oceanSteps / 5;
        const decayKm = K.stormMoistureDecayKm * (0.5 + 0.5 * onshore01);
        stormSupply =
          K.stormMoistureSupply * supplyW * qRel * Math.exp(-coastKm / decayKm) * (isWinter ? 1.4 : 1);
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
/**
 * 近傍(±6 セル)で最も暖かい海セルの気温(°C)。渦供給の水蒸気量の基準。
 * 冬の東岸の移動性低気圧は局所の陸気温ではなく暖流の海面から水蒸気を汲む
 * (湾流・黒潮の冬の東岸降水 — 2026-07-30 レビュー H1)
 */
function nearestOceanTempC(
  ctx: SimContext,
  tField: Float32Array,
  row: number,
  col: number,
): number | null {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  let best: number | null = null;
  for (let dr = -6; dr <= 6; dr++) {
    const r = row + dr;
    if (r < 0 || r >= grid.heightCells) continue;
    for (let dc = -6; dc <= 6; dc++) {
      const i = r * W + wrapCol(grid, col + dc);
      if (terrain.landMask[i]) continue;
      const t = tField[i] ?? 0;
      if (best === null || t > best) best = t;
    }
  }
  return best;
}

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
