// Step 5: 気温 — 2 次元エネルギー収支モデル(EBM)。docs/spec/05_気温.md
//
//   C·dT/dt = S(t)·(1−α(T, 雲)) − (A_eff + B·T) + ∇·(D∇T) − 移流結合 + Q_ocean
//
// 状態は海面高度相当温度 T_sl。標高は OLR 定数項(−B·Γ·h)として入り、
// 出力時に T_surf = T_sl − Γ·h で降尺度する。時間積分は陰解法(ガウス=ザイデル)。
// 設計上の要点(較正ログ 2026-07-29):
//  - 拡散は異方性: 南北 = 文献値 D、東西 = 弱い拡散 + 方向性の移流結合。
//    等方 + 球面計量では高緯度の大陸規模季節モードが潰れる。
//  - 移流はセル熱容量に掛けない(海面が風速で流される誤り)。固定結合 W/m²/K。
//  - 雲アルベドは循環で変調(沈降域 = 晴天、ITCZ = 曇天)。一様雲は砂漠を 9°C 冷やす。
//  - 恒常氷床は 2 パス目で判定(年平均 < 閾値 → 高アルベド)。単一の温度ランプでは
//    「北半球の春の雪解け」と「南極の恒常氷」を両立できない。
//  - 寒冷開始は雪玉解へ落ちるため温暖側から初期化し、序盤は熱容量 1/16 で加速。
// 教訓 §5「線形の日射→気温変換は極夜極昼で破綻」への根本対策そのもの。

import { createGrid, latDegOfRow } from '@/domain/grid';
import type { Grid } from '@/domain/grid';
import { computeInsolation, MONTHS_PER_YEAR } from '@/domain/insolation';
import { orbitalPeriodYears } from '@/domain/planetParams';
import { resolveTerrain } from '@/domain/terrain';
import type { TerrainField } from '@/domain/terrain';
import { MODEL_CONSTANTS as K } from './constants';
import { chamferDistanceCells } from './context';
import type {
  AirflowResult,
  ItczResult,
  OceanCurrentResult,
  SimContext,
  TemperatureResult,
  WindBeltResult,
} from './types';

const RHO_C_WATER = 4.19e6; // J/m³/K
const SECONDS_PER_EARTH_YEAR = 3.156e7;
const GS_SWEEPS = 8;

interface CoarseCell {
  landFrac: number;
  meanLandElevM: number;
  sstAnomalyC: number;
}

export function computeTemperature(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
  ocean: OceanCurrentResult,
  airflow: AirflowResult,
): TemperatureResult {
  const { params } = ctx;
  const cg = createGrid(Math.max(K.ebmResolutionDeg, params.gridResolutionDeg));
  const CW = cg.widthCells;
  const CH = cg.heightCells;
  const N = cg.cellCount;

  // 陸率・標高の集約は常に固定 1° 地形から行う(表示解像度に物理を依存させない。
  // 表示 = EBM 格子だと landFrac が二値になり沿岸の熱容量混合が消える)
  const refGrid = createGrid(Math.min(1, params.gridResolutionDeg));
  const refTerrain =
    refGrid.resolutionDeg === ctx.grid.resolutionDeg
      ? ctx.terrain
      : resolveTerrain(refGrid, params.terrain);
  const coarse = aggregateToCoarse(ctx, refGrid, refTerrain, ocean, cg);
  const insolation = computeInsolation(cg, params.orbital, params.body.axialTiltDeg);

  // 周極海峡: ほぼ陸に遮られない緯度行(地衡流水路 = 南北隔離 + 深い鉛直混合)
  const rowIsChannel = new Uint8Array(CH);
  for (let row = 0; row < CH; row++) {
    if (Math.abs(latDegOfRow(cg, row)) > K.channelMaxAbsLatDeg) continue;
    let landSum = 0;
    for (let col = 0; col < CW; col++) landSum += coarse[row * CW + col]?.landFrac ?? 0;
    rowIsChannel[row] = landSum / CW < K.channelLandFracMax ? 1 : 0;
  }

  // ---- セル定数 ----
  const atm = params.atmosphere;
  const aBase = K.olrAWm2 - K.greenhouseDeltaAWm2 * Math.log2(Math.max(0.05, atm.greenhouseStrength));
  const gamma = K.lapseRateCPerKm / 1000;
  const heatCap = new Float64Array(N);
  const aEff = new Float64Array(N);
  const surfAlbedoBase = new Float64Array(N);
  const iceOnset = new Float64Array(N);
  const qFlux = new Float64Array(N);
  const elevM = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = coarse[i];
    if (!c) continue;
    const row = Math.floor(i / CW);
    const landDepth = Math.max(0.3, K.landEffectiveWaterDepthM + 0.5 * (atm.surfacePressureBar - 1));
    let oceanDepth = atm.oceanMixedLayerDepthM + 2.4 * atm.surfacePressureBar;
    if (rowIsChannel[row]) oceanDepth *= K.channelMixedLayerBoost;
    heatCap[i] = RHO_C_WATER * (c.landFrac * landDepth + (1 - c.landFrac) * oceanDepth);
    const h = c.landFrac * Math.max(0, c.meanLandElevM);
    elevM[i] = h;
    aEff[i] = aBase - K.olrBWm2PerC * gamma * h;
    surfAlbedoBase[i] = K.albedoLand * c.landFrac + K.albedoOcean * (1 - c.landFrac);
    iceOnset[i] = K.iceOnsetC * c.landFrac + K.seaFreezeC * (1 - c.landFrac);
    qFlux[i] = K.sstAnomalyCouplingWm2PerK * c.sstAnomalyC * (1 - c.landFrac);
  }
  // Q フラックスのエネルギー中立化。補償は**海セルのみ**に配賦する —
  // 全セル一律に引くと、qFlux が 0 の陸にまで恒常の寒冷税(全球 ~−4 W/m²
  // ≈ −1.9°C)がかかる(2026-07-30 レビュー指摘。SST 偏差は構造的に正味プラス)
  {
    let sum = 0;
    let wOcean = 0;
    for (let row = 0; row < CH; row++) {
      const w = Math.cos((latDegOfRow(cg, row) * Math.PI) / 180);
      for (let col = 0; col < CW; col++) {
        const i = row * CW + col;
        sum += (qFlux[i] ?? 0) * w;
        wOcean += w * (1 - (coarse[i]?.landFrac ?? 0));
      }
    }
    const meanOcean = wOcean > 1e-9 ? sum / wOcean : 0;
    for (let i = 0; i < N; i++) {
      qFlux[i] = (qFlux[i] ?? 0) - meanOcean * (1 - (coarse[i]?.landFrac ?? 0));
    }
  }

  // ---- 雲アルベドの循環変調(月別・セル別) ----
  const cloudAlbedoMonthly: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const field = new Float32Array(N);
    const ridgeN = windBelt.monthlyRidgeLatNDeg[m] ?? 31;
    const ridgeS = windBelt.monthlyRidgeLatSDeg[m] ?? -31;
    const pfN = windBelt.monthlyPolarFrontLatNDeg[m] ?? 60;
    const pfS = windBelt.monthlyPolarFrontLatSDeg[m] ?? -60;
    const declM = insolation.monthlyDeclinationDeg[m] ?? 0;
    const centers = itcz.monthlyCenterLatDegByCol[m];
    const colScale = ctx.grid.widthCells / CW;
    for (let row = 0; row < CH; row++) {
      const lat = latDegOfRow(cg, row);
      const ridge = lat >= 0 ? ridgeN : ridgeS;
      const pf = lat >= 0 ? pfN : pfS;
      // 沈降晴天域はリッジ中心ではなく下降枝の全域(|ridge|−16° 〜 |ridge|+5°)
      const aLatHere = Math.abs(lat);
      const descLo = Math.abs(ridge) - 16;
      const descHi = Math.abs(ridge) + 5;
      let ridgeProx: number;
      if (aLatHere >= descLo && aLatHere <= descHi) {
        ridgeProx = 1;
      } else {
        const d = aLatHere < descLo ? descLo - aLatHere : aLatHere - descHi;
        ridgeProx = Math.exp(-(d * d) / 16);
      }
      // ストームトラック帯(リッジ極側〜極前線先): 海上で雲が厚い
      const aLat = Math.abs(lat);
      const stLo = Math.abs(ridge) + 8;
      const stHi = Math.abs(pf) + 15;
      // 夏半球ではストームトラックが弱まる — ただし弱まるのは大陸側ジェット。
      // 海(南大洋型)は夏も曇天のまま(レビュー仮説 5: 陸海で季節減衰を分離)
      const isStormWinter = lat >= 0 ? declM < 0 : declM > 0;
      const stormWBase =
        aLat > stLo && aLat < stHi ? Math.sin((Math.PI * (aLat - stLo)) / (stHi - stLo)) : 0;
      for (let col = 0; col < CW; col++) {
        const i = row * CW + col;
        const fineCol = Math.min(ctx.grid.widthCells - 1, Math.round((col + 0.5) * colScale));
        const center = centers?.[fineCol] ?? 0;
        // 雲変調の ITCZ 幅は降水・循環より狭い(実物の雲帯は ±3〜5°。
        // 広いと夏の 20-30°N 乾燥帯まで曇らせて寒くする — レビュー仮説 6)
        const dI = (lat - center) / (itcz.halfWidthDeg * K.itczCloudWidthFactor);
        const itczInf = Math.exp(-dI * dI);
        const landFrac = coarse[i]?.landFrac ?? 0;
        const oceanFrac = 1 - landFrac;
        const stormSeason = isStormWinter ? 1 : 0.35 + (K.stormCloudSummerOcean - 0.35) * oceanFrac;
        const stormW = stormWBase * stormSeason;
        const subsidenceWeight = K.subsidenceOceanFactor + (1 - K.subsidenceOceanFactor) * landFrac;
        // 寒流上の層積雲デッキ(SST 負偏差の海で雲が増える)
        const sstA = coarse[i]?.sstAnomalyC ?? 0;
        const scDeck = sstA < 0 ? K.stratocumulusBoostPerNegC * Math.min(1.5, -sstA / 2) * oceanFrac : 0;
        // 周極海峡行は常時ストーム雲(南大洋型。上限も少し引き上げる)
        const chanCloud = rowIsChannel[row] ? K.channelCloudBoost * oceanFrac : 0;
        const factor =
          1 -
          K.subsidenceCloudReduction * subsidenceWeight * ridgeProx * (1 - itczInf) +
          K.convectiveCloudBoost * itczInf +
          K.stormTrackCloudBoost * stormW * oceanFrac +
          scDeck +
          chanCloud;
        const capMax = K.cloudAlbedoMax + (rowIsChannel[row] ? 0.08 : 0);
        field[i] = Math.min(capMax, Math.max(0.04, atm.cloudAlbedo * factor));
      }
    }
    cloudAlbedoMonthly.push(field);
  }

  // ---- 拡散・移流係数 ----
  const dPhi = (cg.resolutionDeg * Math.PI) / 180;
  const radiusRatio = 6371 / params.body.radiusKm;
  const dBase =
    K.diffusionWm2PerK * radiusRatio * radiusRatio * Math.max(0.1, atm.heatTransportStrength);
  const cosCenter = new Float64Array(CH);
  const metricZonal = new Float64Array(CH);
  for (let row = 0; row < CH; row++) {
    const phi = (latDegOfRow(cg, row) * Math.PI) / 180;
    cosCenter[row] = Math.cos(phi);
    metricZonal[row] = Math.min(K.zonalMetricCap, 1 / Math.max(1e-6, Math.cos(phi) * Math.cos(phi)));
  }
  const diffFactor = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = coarse[i];
    diffFactor[i] = 1 + (K.oceanDiffusionBoost - 1) * (1 - (c?.landFrac ?? 0));
  }
  // 内陸度(0 = 海岸/海、1 = ~1500km 以上内陸)。冬の接地逆転層は内陸で強い
  // (海沿いの陸は冬も海風で暖まる: 西欧型。内陸は遮断される: シベリア型)
  const interior01 = new Float64Array(N);
  {
    const distToOceanCells = chamferDistanceCells(cg, (i) => (coarse[i]?.landFrac ?? 0) < 0.5);
    const cellKm = (Math.PI * params.body.radiusKm) / CH;
    for (let i = 0; i < N; i++) {
      interior01[i] = Math.min(1, ((distToOceanCells[i] ?? 0) * cellKm) / 1500);
    }
  }
  // 月別 2D 風(Step 4)を EBM 格子へ集約(2026-07-30: 帯状移流を 2D 化。
  // 冬の大陸冷気の吹き出し・海からの暖気移流を経度別に表現する)
  const windOnCg = aggregateWinds(ctx, airflow, cg);
  // 夏半球は結合を弱める(ジェット弱化で大陸が海洋の影響から解放される —
  // 旧・帯状移流の seasonFactor を踏襲)
  const meanRidgeN =
    windBelt.monthlyRidgeLatNDeg.reduce((a, b) => a + b, 0) / windBelt.monthlyRidgeLatNDeg.length;
  const meanRidgeS =
    windBelt.monthlyRidgeLatSDeg.reduce((a, b) => a + b, 0) / windBelt.monthlyRidgeLatSDeg.length;

  const yearSeconds = orbitalPeriodYears(params.orbital) * SECONDS_PER_EARTH_YEAR;
  const dt = yearSeconds / K.ebmStepsPerYear;

  // ---- 時間積分(クロージャ: 恒常氷マスクを与えて 1 回まわす) ----
  const integrate = (permanentIce: Uint8Array | null) => {
    const t = new Float64Array(N);
    for (let row = 0; row < CH; row++) {
      const init = -20 + 48 * (cosCenter[row] ?? 0);
      for (let col = 0; col < CW; col++) t[row * CW + col] = init;
    }
    const rhs = new Float64Array(N);
    // 海氷断熱: 氷結セルの実効熱容量(氷量に応じて毎ステップ更新)。
    // 注: 氷厚状態を持つ 0 層海氷(融解 0°C 固定)は 2026-07-30 に試行したが、
    // 断熱×融解固定の正帰還で南極海リングが夏に融け残り −60S が −14°C へ
    // 暴走(双安定)。温度ランプ近似を維持する(較正記録参照)
    const capEff = new Float64Array(N);
    const monthAccum: Float64Array[] = Array.from({ length: MONTHS_PER_YEAR }, () => new Float64Array(N));
    const monthCount = new Array<number>(MONTHS_PER_YEAR).fill(0);
    const totalSteps = K.ebmYears * K.ebmStepsPerYear;
    const spinupSteps = Math.max(0, (K.ebmYears - 2) * K.ebmStepsPerYear);

    for (let step = 0; step < totalSteps; step++) {
      const capScale = step < spinupSteps ? 1 / 16 : 1;
      const yearFrac = (step % K.ebmStepsPerYear) / K.ebmStepsPerYear;
      const monthFloat = yearFrac * MONTHS_PER_YEAR;
      const m0 = Math.floor(monthFloat - 0.5 + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
      const m1 = (m0 + 1) % MONTHS_PER_YEAR;
      const frac = (monthFloat - 0.5 + MONTHS_PER_YEAR) % 1;
      const cloud0 = cloudAlbedoMonthly[m0];
      const cloud1 = cloudAlbedoMonthly[m1];

      for (let row = 0; row < CH; row++) {
        const s0 = insolation.monthlyByRow[m0]?.[row] ?? 0;
        const s1 = insolation.monthlyByRow[m1]?.[row] ?? 0;
        const s = s0 * (1 - frac) + s1 * frac;
        for (let col = 0; col < CW; col++) {
          const i = row * CW + col;
          const tSurf = (t[i] ?? 0) - gamma * (elevM[i] ?? 0);
          const iceW = Math.min(1, Math.max(0, ((iceOnset[i] ?? 0) - tSurf) / K.iceRampWidthC));
          let aSurf = (surfAlbedoBase[i] ?? 0.15) + (K.albedoIce - (surfAlbedoBase[i] ?? 0.15)) * iceW;
          if (permanentIce?.[i]) aSurf = Math.max(aSurf, K.permanentIceAlbedo);
          const cloud = ((cloud0?.[i] ?? 0.2) * (1 - frac) + (cloud1?.[i] ?? 0.2) * frac);
          const albedo = cloud + (1 - cloud) * aSurf;
          // 海氷断熱: 氷結海面は混合層を切り離し実効熱容量が陸並みに落ちる
          // (極域の季節振幅の再現に必須 — constants.seaIceInsulationFactor 参照)
          const oceanFrac = 1 - (coarse[i]?.landFrac ?? 0);
          capEff[i] =
            (heatCap[i] ?? 1) * (1 - K.seaIceInsulationFactor * iceW * oceanFrac) * capScale;
          rhs[i] =
            ((capEff[i] ?? 1) / dt) * (t[i] ?? 0) +
            s * (1 - albedo) -
            (aEff[i] ?? K.olrAWm2) +
            (qFlux[i] ?? 0);
        }
      }

      const uField = windOnCg.u[m0];
      const vField = windOnCg.v[m0];
      const ridgeNNow = windBelt.monthlyRidgeLatNDeg[m0] ?? 31;
      const ridgeSNow = windBelt.monthlyRidgeLatSDeg[m0] ?? -31;
      // リッジは半球別(北半球の値を南に流用すると、南半球の冬にハドレー増強が
      // 12° はみ出し、v 結合の許可帯も誤る — 2026-07-30 レビューで発見のバグ)
      const ridgeAbsN = Math.max(15, Math.abs(ridgeNNow));
      const ridgeAbsS = Math.max(15, Math.abs(ridgeSNow));
      const summerN = ridgeNNow > meanRidgeN;
      const summerS = ridgeSNow < meanRidgeS;
      for (let sweep = 0; sweep < GS_SWEEPS; sweep++) {
        for (let row = 0; row < CH; row++) {
          const lat = latDegOfRow(cg, row);
          const cosC = Math.max(1e-3, cosCenter[row] ?? 1e-3);
          const gz = (dBase * K.zonalDiffusionFactor * (metricZonal[row] ?? 1)) / (dPhi * dPhi);
          const ridgeAbs = lat >= 0 ? ridgeAbsN : ridgeAbsS;
          // ハドレー域はリッジ内側で南北拡散を増強(熱帯の平坦な温度場を再現)
          const hadleyW = Math.max(0, 1 - (lat / ridgeAbs) * (lat / ridgeAbs));
          const dMerid = dBase * (1 + K.hadleyDiffusionBoost * hadleyW);
          const phiEdgeN = ((lat + cg.resolutionDeg / 2) * Math.PI) / 180;
          const phiEdgeS = ((lat - cg.resolutionDeg / 2) * Math.PI) / 180;
          const chanN = rowIsChannel[row] || (row > 0 && rowIsChannel[row - 1]) ? K.circumpolarChannelFactor : 1;
          const chanS = rowIsChannel[row] || (row < CH - 1 && rowIsChannel[row + 1]) ? K.circumpolarChannelFactor : 1;
          const gN = row > 0 ? (chanN * dMerid * Math.cos(phiEdgeN)) / (dPhi * dPhi * cosC) : 0;
          const gS = row < CH - 1 ? (chanS * dMerid * Math.cos(phiEdgeS)) / (dPhi * dPhi * cosC) : 0;
          const seasonFactor = (lat >= 0 ? summerN : summerS) ? K.summerAdvectionFactor : 1;
          // 南北結合はリッジより極側のみ(温帯低気圧の南北混合が実在する帯)。
          // ハドレー域の南北輸送は拡散増強で表現済みで、そこに v 結合を足すと
          // 「冷気コンベア」(シベリア→インド)の二重計上になる(2026-07-30 実測)
          const vBandW = Math.min(1, Math.max(0, (Math.abs(lat) - ridgeAbs) / 10));
          // 冬(月日射 < 年平均)の陸は接地逆転層で移流が地表に届きにくい
          const isWinterRow = (insolation.monthlyByRow[m0]?.[row] ?? 0) < (insolation.annualMeanByRow[row] ?? 0);
          for (let col = 0; col < CW; col++) {
            const i = row * CW + col;
            const uMs = uField?.[i] ?? 0;
            const vMs = vField?.[i] ?? 0;
            const inv = isWinterRow
              ? 1 - (1 - K.winterInversionAdvectionFactor) * (interior01[i] ?? 0)
              : 1;
            const advScale = seasonFactor * inv * K.zonalAdvectionCouplingWm2PerK;
            const east = row * CW + ((col + 1) % CW);
            const west = row * CW + ((col + CW - 1) % CW);
            const north = row > 0 ? (row - 1) * CW + col : i;
            const south = row < CH - 1 ? (row + 1) * CW + col : i;
            // 2D 風上結合: 東西 = u、南北 = v(v > 0 = 北向き → 南から来る)。
            // 結合は実効風速 7/5 m/s で頭打ち(地表結合は風速に線形では増えない)
            const advCu = advScale * (Math.min(7, Math.abs(uMs)) / 4);
            const upwindU = uMs >= 0 ? west : east;
            const upwindV = vMs >= 0 ? south : north;
            // v 結合は (a) 周極海峡の隔離則を尊重(迂回すると南極海が過熱)、
            // (b) 陸で強く外洋で弱い(海面温度への大気移流の掴みは小さい)
            const upwindVRow = Math.floor(upwindV / CW);
            const chanV =
              rowIsChannel[row] || rowIsChannel[upwindVRow] ? K.circumpolarChannelFactor : 1;
            const landGrip = 0.25 + 0.75 * (coarse[i]?.landFrac ?? 0);
            const advCv =
              upwindV === i
                ? 0
                : advScale * vBandW * chanV * landGrip * (Math.min(5, Math.abs(vMs)) / 4);
            const cOverDt = (capEff[i] ?? 1) / dt;
            // 界面伝導度は両セルの係数平均(受け手の値だけ掛けると行列が
            // 非対称になり厳密には保存しない — 2026-07-30 レビュー指摘)。
            // 冬の接地逆転は自由大気との混合(拡散)も絶縁する(内陸で強い)
            const invD = isWinterRow
              ? 1 - (1 - K.winterInversionDiffusionFactor) * (interior01[i] ?? 0)
              : 1;
            const df = (diffFactor[i] ?? 1) * invD;
            const gzE = gz * 0.5 * (df + (diffFactor[east] ?? 1));
            const gzW = gz * 0.5 * (df + (diffFactor[west] ?? 1));
            const gNEff = gN * 0.5 * (df + (diffFactor[north] ?? 1));
            const gSEff = gS * 0.5 * (df + (diffFactor[south] ?? 1));
            const diag = cOverDt + K.olrBWm2PerC + gzE + gzW + gNEff + gSEff + advCu + advCv;
            const off =
              gzE * (t[east] ?? 0) +
              gzW * (t[west] ?? 0) +
              gNEff * (t[north] ?? 0) +
              gSEff * (t[south] ?? 0) +
              advCu * (t[upwindU] ?? 0) +
              advCv * (t[upwindV] ?? 0);
            t[i] = ((rhs[i] ?? 0) + off) / diag;
          }
        }
        relaxPolarRows(cg, t);
      }

      if (step >= (K.ebmYears - 1) * K.ebmStepsPerYear) {
        const mIdx = Math.min(MONTHS_PER_YEAR - 1, Math.floor(yearFrac * MONTHS_PER_YEAR));
        const acc = monthAccum[mIdx];
        if (acc) {
          for (let i = 0; i < N; i++) acc[i] = (acc[i] ?? 0) + (t[i] ?? 0);
          monthCount[mIdx] = (monthCount[mIdx] ?? 0) + 1;
        }
      }
    }
    return { monthAccum, monthCount };
  };

  // パス 1: 恒常氷なしで積分 → 年平均と最暖月の複合条件で氷床を判定
  // (年平均だけではシベリア(夏 +19°C)を誤って氷床にしてしまう)
  const pass1 = integrate(null);
  const permanentIce = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let annual = 0;
    let warmest = -1e9;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const v = (pass1.monthAccum[m]?.[i] ?? 0) / Math.max(1, pass1.monthCount[m] ?? 1);
      annual += v;
      if (v > warmest) warmest = v;
    }
    const elevOffset = gamma * (elevM[i] ?? 0);
    annual = annual / MONTHS_PER_YEAR - elevOffset;
    warmest -= elevOffset;
    // 恒常氷床は陸優勢セルのみ(海氷は薄く季節性で、夏は融解が 0°C 近傍に張り付く)
    const landDominant = (coarse[i]?.landFrac ?? 0) > 0.5;
    if (landDominant && annual < K.permanentIceAnnualMeanC && warmest < K.permanentIceWarmestMonthC) {
      permanentIce[i] = 1;
    }
  }
  // 氷床の隣接拡張: 氷床は流動し周囲を冷やすため、核に隣接する冷涼な陸へ広げる
  // (無記憶モデルでは日射だけで沿岸氷床を自発形成できないことへの近似)
  for (let iter = 0; iter < 2; iter++) {
    let changed = false;
    for (let i = 0; i < N; i++) {
      if (permanentIce[i]) continue;
      if ((coarse[i]?.landFrac ?? 0) <= 0.5) continue;
      let warmest = -1e9;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const v = (pass1.monthAccum[m]?.[i] ?? 0) / Math.max(1, pass1.monthCount[m] ?? 1);
        if (v > warmest) warmest = v;
      }
      warmest -= gamma * (elevM[i] ?? 0);
      if (warmest >= 3) continue;
      const row = Math.floor(i / CW);
      const col = i % CW;
      const nbs = [
        row > 0 ? (row - 1) * CW + col : -1,
        row < CH - 1 ? (row + 1) * CW + col : -1,
        row * CW + ((col + 1) % CW),
        row * CW + ((col + CW - 1) % CW),
      ];
      if (nbs.some((nb) => nb >= 0 && permanentIce[nb])) {
        permanentIce[i] = 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // パス 2: 氷床アルベドを反映して確定
  const pass2 = integrate(permanentIce);

  return downscale(ctx, cg, pass2.monthAccum, pass2.monthCount, gamma);
}

function aggregateToCoarse(
  ctx: SimContext,
  refGrid: Grid,
  refTerrain: TerrainField,
  ocean: OceanCurrentResult,
  cg: Grid,
): CoarseCell[] {
  const f = Math.round(cg.resolutionDeg / refGrid.resolutionDeg);
  const fSst = Math.round(cg.resolutionDeg / ctx.grid.resolutionDeg);
  const out: CoarseCell[] = new Array(cg.cellCount);
  for (let row = 0; row < cg.heightCells; row++) {
    for (let col = 0; col < cg.widthCells; col++) {
      let n = 0;
      let landN = 0;
      let landElevSum = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const fr = row * f + dr;
          const fc = col * f + dc;
          if (fr >= refGrid.heightCells || fc >= refGrid.widthCells) continue;
          const i = fr * refGrid.widthCells + fc;
          n++;
          if (refTerrain.landMask[i]) {
            landN++;
            landElevSum += refTerrain.elevationMeters[i] ?? 0;
          }
        }
      }
      // SST 偏差は表示格子(Step 3 の出力)から集約
      let sstSum = 0;
      let oceanN = 0;
      for (let dr = 0; dr < fSst; dr++) {
        for (let dc = 0; dc < fSst; dc++) {
          const fr = row * fSst + dr;
          const fc = col * fSst + dc;
          if (fr >= ctx.grid.heightCells || fc >= ctx.grid.widthCells) continue;
          const i = fr * ctx.grid.widthCells + fc;
          if (!ctx.terrain.landMask[i]) {
            oceanN++;
            sstSum += ocean.sstAnomalyC[i] ?? 0;
          }
        }
      }
      out[row * cg.widthCells + col] = {
        landFrac: n > 0 ? landN / n : 0,
        meanLandElevM: landN > 0 ? landElevSum / landN : 0,
        sstAnomalyC: oceanN > 0 ? sstSum / oceanN : 0,
      };
    }
  }
  return out;
}

/**
 * 月別 2D 風(表示格子)を EBM 格子へ平均集約する。
 * 移流結合の風上方向・強度に使う(旧・帯状移流の置換、2026-07-30)
 */
function aggregateWinds(
  ctx: SimContext,
  airflow: AirflowResult,
  cg: Grid,
): { u: Float32Array[]; v: Float32Array[] } {
  const src = ctx.grid;
  const uMonthly: Float32Array[] = [];
  const vMonthly: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const su = airflow.monthlyWindU[m];
    const sv = airflow.monthlyWindV[m];
    const u = new Float32Array(cg.cellCount);
    const v = new Float32Array(cg.cellCount);
    const n = new Float32Array(cg.cellCount);
    if (su && sv) {
      for (let row = 0; row < src.heightCells; row++) {
        const cgRow = Math.min(
          cg.heightCells - 1,
          Math.floor((row * src.resolutionDeg) / cg.resolutionDeg),
        );
        for (let col = 0; col < src.widthCells; col++) {
          const cgCol = Math.min(
            cg.widthCells - 1,
            Math.floor((col * src.resolutionDeg) / cg.resolutionDeg),
          );
          const ci = cgRow * cg.widthCells + cgCol;
          const i = row * src.widthCells + col;
          u[ci] = (u[ci] ?? 0) + (su[i] ?? 0);
          v[ci] = (v[ci] ?? 0) + (sv[i] ?? 0);
          n[ci] = (n[ci] ?? 0) + 1;
        }
      }
      for (let i = 0; i < cg.cellCount; i++) {
        const c = Math.max(1, n[i] ?? 1);
        u[i] = (u[i] ?? 0) / c;
        v[i] = (v[i] ?? 0) / c;
      }
    }
    uMonthly.push(u);
    vMonthly.push(v);
  }
  return { u: uMonthly, v: vMonthly };
}

function relaxPolarRows(cg: Grid, t: Float64Array): void {
  const CW = cg.widthCells;
  for (let row = 0; row < cg.heightCells; row++) {
    const lat = latDegOfRow(cg, row);
    if (Math.abs(lat) < 84) continue;
    let sum = 0;
    for (let col = 0; col < CW; col++) sum += t[row * CW + col] ?? 0;
    const mean = sum / CW;
    for (let col = 0; col < CW; col++) {
      const i = row * CW + col;
      t[i] = (t[i] ?? 0) * 0.5 + mean * 0.5;
    }
  }
}

function downscale(
  ctx: SimContext,
  cg: Grid,
  monthAccum: Float64Array[],
  monthCount: number[],
  gamma: number,
): TemperatureResult {
  const { grid, terrain } = ctx;
  const monthlyTemperatureC: Float32Array[] = [];
  const monthlyIceMask: Uint8Array[] = [];
  const annualMeanC = new Float32Array(grid.cellCount);
  const warmestMonthC = new Float32Array(grid.cellCount).fill(-1e9);
  const coldestMonthC = new Float32Array(grid.cellCount).fill(1e9);

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const acc = monthAccum[m];
    const count = Math.max(1, monthCount[m] ?? 1);
    const out = new Float32Array(grid.cellCount);
    const ice = new Uint8Array(grid.cellCount);
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        const tSl = bilinearSample(cg, acc, lat, lon) / count;
        const elev = terrain.landMask[i] ? Math.max(0, terrain.elevationMeters[i] ?? 0) : 0;
        const tSurf = tSl - gamma * elev;
        out[i] = tSurf;
        const freeze = terrain.landMask[i] ? -1 : K.seaFreezeC;
        if (tSurf < freeze) ice[i] = 1;
        annualMeanC[i] = (annualMeanC[i] ?? 0) + tSurf / MONTHS_PER_YEAR;
        if (tSurf > (warmestMonthC[i] ?? -1e9)) warmestMonthC[i] = tSurf;
        if (tSurf < (coldestMonthC[i] ?? 1e9)) coldestMonthC[i] = tSurf;
      }
    }
    monthlyTemperatureC.push(out);
    monthlyIceMask.push(ice);
  }
  return { monthlyTemperatureC, annualMeanC, warmestMonthC, coldestMonthC, monthlyIceMask };
}

function bilinearSample(cg: Grid, field: Float64Array | undefined, latDeg: number, lonDeg: number): number {
  if (!field) return 0;
  const CW = cg.widthCells;
  const CH = cg.heightCells;
  const fy = (90 - latDeg) / cg.resolutionDeg - 0.5;
  const fx = (lonDeg + 180) / cg.resolutionDeg - 0.5;
  const y0 = Math.max(0, Math.min(CH - 1, Math.floor(fy)));
  const y1 = Math.max(0, Math.min(CH - 1, y0 + 1));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const x0f = Math.floor(fx);
  const tx = fx - x0f;
  const x0 = ((x0f % CW) + CW) % CW;
  const x1 = (x0 + 1) % CW;
  const v00 = field[y0 * CW + x0] ?? 0;
  const v10 = field[y0 * CW + x1] ?? 0;
  const v01 = field[y1 * CW + x0] ?? 0;
  const v11 = field[y1 * CW + x1] ?? 0;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}
