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
import type { Grid } from '@/domain/grid';
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

// ---- R1 診断(地域降水 FB §5)----
// 降水の内部要因(供給 3 種・持上げ/抑制の各倍率)を診断時のみ捕捉する。
// 通常実行では一切割り当てず、計算経路も変えない(倍率の named 化は乗算順を
// 保存しており出力はビット不変 — テストで担保)。
// 再構成恒等式(月 m・セル i、床再配分と月ブレンドの前):
//   preAdjustMm = (supplyOcean + supplyLand + supplyStorm)
//                 × upwindBlock × liftItcz × liftFrontal × liftOther部の storm
//                 ... 正確には liftItcz × liftFrontal × liftStorm × liftOrographic
//                 × subsidenceResidual × coldCoast × warmHumid の積 = lift。
//   ここでは FB の 8 因子以外(liftStorm・coldCoast・warmHumid)を liftOther に
//   まとめ、preAdjustMm = 供給和 × upwindBlock × liftItcz × liftFrontal ×
//   liftOrographic × subsidenceResidual × liftOther × 変換係数 で厳密再構成できる。
//   最終降水との差は床再配分・月ブレンド(陸のみ)による。
export interface PrecipDiagnostics {
  /** [month][cell] 海洋由来供給(無次元供給量) */
  supplyOcean: Float32Array[];
  /** [month][cell] 陸面再循環由来供給(全供給 − 海洋のみ供給) */
  supplyLand: Float32Array[];
  /** [month][cell] ストームトラック渦由来供給 */
  supplyStorm: Float32Array[];
  liftItcz: Float32Array[];
  liftFrontal: Float32Array[];
  liftOrographic: Float32Array[];
  /** R4: 湿潤収束による持上げ倍率(1 = 収束なし) */
  liftConvergence: Float32Array[];
  /** R4: 水蒸気フラックス収束指数(供給単位、正 = 収束)。倍率ではなく生の場 */
  convergenceIndex: Float32Array[];
  /** 亜熱帯沈降の残存倍率(1 = 抑制なし) */
  subsidenceResidual: Float32Array[];
  /** 風上山脈の遮蔽倍率(1 = 遮蔽なし) */
  upwindBlock: Float32Array[];
  /** その他の倍率の積(ストーム帯持上げ × 寒流沿岸 × 高温湿潤対流) */
  liftOther: Float32Array[];
  /** 床再配分・月ブレンド前の降水 mm/月 */
  preAdjustMm: Float32Array[];
  /**
   * 後処理(冬季床再配分 + 月ブレンド、陸のみ)による差分 mm/月。
   * 最終降水 = preAdjustMm + postAdjustDeltaMm(全セルで厳密)
   */
  postAdjustDeltaMm: Float32Array[];
  /** mm 変換係数(precipScaleMmPerUnit × 気圧係数) — 再構成用 */
  mmPerSupplyUnit: number;
}

/** 診断の受け皿。computePrecipitation に渡すと fields が割り当てられる */
export interface PrecipDiagBox {
  fields?: PrecipDiagnostics;
  /** R3 土壌水分の周期定常解(有効時のみ) */
  soil?: SoilWaterResult;
}

// ---- R4(地域降水 FB §8): 水蒸気フラックス収束 ----
// 局所水蒸気量の代理を既存の供給場 q とし、地表風 V との積で水平フラックスを
// つくり、球面計量で発散を取る:
//   div(qV) = (1/(a cosφ)) [ ∂(q u)/∂λ + ∂(q v cosφ)/∂φ ]
// 収束(div < 0)かつ湿潤な場所だけ持上げを増やし、亜熱帯沈降の実効抑制を
// 連続的に弱める。乾いた収束(供給が乏しい低圧)では何も起こらない。
// 中国東部の梅雨前線・ラプラタへの暖湿流・アマゾン内陸収束・米国南東部を
// 同じ原理で表現する(地域名は使わない)。
//
// 実装上の要点(2026-08-01 の外部レビュー指摘への対応):
//  - **有限体積形**で発散を取る(共有面フラックス × 辺長 / セル面積)。
//    中心差分 + max(20km) のセル幅では高緯度で保存性を失う。極の辺長は 0。
//    Σ(面積 × 発散) ≈ 0 をテストで担保する。
//  - 供給場 q は「局所水蒸気量」ではなく風上経路の到達可能性であり、海岸や
//    稜線を跨ぐ経路差で不連続に跳ぶ。そのまま微分すると偽の収束線ができる
//    ため、**固定角半径で平滑化してから**フラックスを作る。
//  - 乾燥ゲートは局所 q で割らない(乾燥域で比が発散する)。基準値 q_ref で
//    無次元化し、飽和関数 x/(1+x) で [0,1) に収める。
//  - 発散演算の中で自転方向を掛けない(風場が既に反転済み)。
const DIVERGENCE_SMOOTH_DEG = 1.5;
/** 収束指数を供給と同じ単位へ戻す時間スケール(基準長 1000km / 基準風速 5m/s) */
const CONVERGENCE_TIME_SCALE_S = 1_000_000 / 5;

/** 固定角半径の円形平均で場を平滑化(解像度不変) */
function smoothAngular(grid: Grid, field: Float32Array, radiusDeg: number): Float32Array {
  const out = new Float32Array(grid.cellCount);
  for (let row = 0; row < grid.heightCells; row++) {
    for (let col = 0; col < grid.widthCells; col++) {
      let sum = 0;
      let n = 0;
      forEachCellWithinAngularRadius(grid, row, col, radiusDeg, (j) => {
        sum += field[j] ?? 0;
        n++;
      });
      out[row * grid.widthCells + col] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/**
 * 水蒸気フラックスの収束指数(供給と同じ単位、正 = 収束)。
 * 有限体積形: D = (F_E L_E − F_W L_W + F_N L_N − F_S L_S) / A。
 * 経度は周期境界、極の辺長は 0。返り値は −D × 時間スケール。
 */
export function moistureConvergenceIndex(
  grid: Grid,
  radiusKm: number,
  supply: Float32Array,
  u: Float32Array,
  v: Float32Array,
): Float32Array {
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const q = smoothAngular(grid, supply, DIVERGENCE_SMOOTH_DEG);
  const aM = radiusKm * 1000;
  const dPhi = (grid.resolutionDeg * Math.PI) / 180;
  const dLam = (grid.resolutionDeg * Math.PI) / 180;
  // 南北の辺長は一定(経線に沿う長さ)、東西の辺長は面の緯度の cos に比例
  const lenMeridionalM = aM * dPhi;
  const cosFaceOf = (rowFaceNorthOf: number): number => {
    // row と row−1 の境界(= row の北面)の緯度
    const latFace = 90 - rowFaceNorthOf * grid.resolutionDeg;
    return Math.max(0, Math.cos((latFace * Math.PI) / 180));
  };
  for (let row = 0; row < H; row++) {
    const latC = latDegOfRow(grid, row);
    const cosC = Math.max(1e-6, Math.cos((latC * Math.PI) / 180));
    const areaM2 = aM * aM * dLam * dPhi * cosC;
    const lenNorthM = aM * dLam * cosFaceOf(row); // 北面(row と row−1 の境)
    const lenSouthM = aM * dLam * cosFaceOf(row + 1); // 南面
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const iE = row * W + wrapCol(grid, col + 1);
      const iW = row * W + wrapCol(grid, col - 1);
      const iN = row > 0 ? (row - 1) * W + col : -1;
      const iS = row < H - 1 ? (row + 1) * W + col : -1;
      const qu = (q[i] ?? 0) * (u[i] ?? 0);
      // 面フラックスは両側セルの平均(共有面で一意 = 保存的)
      const fE = 0.5 * (qu + (q[iE] ?? 0) * (u[iE] ?? 0));
      const fW = 0.5 * (qu + (q[iW] ?? 0) * (u[iW] ?? 0));
      const qv = (q[i] ?? 0) * (v[i] ?? 0);
      const fN = iN >= 0 ? 0.5 * (qv + (q[iN] ?? 0) * (v[iN] ?? 0)) : 0;
      const fS = iS >= 0 ? 0.5 * (qv + (q[iS] ?? 0) * (v[iS] ?? 0)) : 0;
      const netOutflow = (fE - fW) * lenMeridionalM + fN * lenNorthM - fS * lenSouthM;
      const divergence = netOutflow / areaM2;
      out[i] = -divergence * CONVERGENCE_TIME_SCALE_S;
    }
  }
  return out;
}

/** 収束の実効度 0〜1(飽和関数)。局所 q で割らない — 乾燥域で発散するため */
export function convergenceStrength01(convIndex: number, refNorm: number): number {
  const x = Math.max(0, convIndex) / Math.max(1e-9, refNorm);
  return x / (1 + x);
}

/** 湿潤ゲート(smoothstep)。乾いた収束では降水を作らない */
export function wetnessGate01(supplyValue: number, wetNorm: number): number {
  const t = Math.min(1, Math.max(0, supplyValue / Math.max(1e-9, wetNorm)));
  return t * t * (3 - 2 * t);
}

// ---- R3(地域降水 FB §7): 土壌水分の季節記憶 ----
// 各陸セルの月別貯水を状態として持ち、乾季へ前月までの雨を持ち越す。
//   S[m] = clamp(S[m-1] + P[m] − ET[m], 0, 容量)、超過分は流出
//   ET[m] = 可能蒸発散(気温) × (S[m-1] / 容量)  ← 供給律速の線形近似
// 陸面水蒸気供給は「当月降水に比例」ではなく実蒸発散に比例させる。
// 12 月 → 1 月を接続し、周期定常解へ収束するまで空回しする(初期値に
// 依らない決定的な解)。バケツ収支は風上追跡を含まないため安価。

/** 可能蒸発散(mm/月)。0°C 以下は凍結として 0 */
export function potentialEtMmPerMonth(tempC: number): number {
  if (tempC <= 0) return 0;
  return (
    (K.soilPetScaleMmPerMonth * saturationVaporPressureHpa(tempC)) / saturationVaporPressureHpa(20)
  );
}

export interface SoilWaterResult {
  /** [month][cell] 実蒸発散 mm/月 */
  actualEtMm: Float32Array[];
  /** [month][cell] 月末貯水 mm */
  storageMm: Float32Array[];
  /** [month][cell] 流出 mm/月 */
  runoffMm: Float32Array[];
  /** [month][cell] 利用可能水(前月貯水 + 当月降水)/ 容量の 0〜1 クランプ */
  wetness01: Float32Array[];
  /** [cell] 記録年の貯水変化(年末 − 年初)。周期定常なら 0 */
  storageChangeMm: Float32Array;
  /** 実施した空回し年数 */
  spinupYears: number;
  /** 最終年の年間貯水変化の陸セル平均絶対値(mm)— 周期定常への到達度 */
  meanAnnualStorageDriftMm: number;
  /** 同・最大絶対値(mm)。中立帯のセルに支配されるため参考値 */
  maxAnnualStorageDriftMm: number;
  /** 周期定常解へ収束したか(上限年数に達した場合は false) */
  converged: boolean;
}

/**
 * 周期定常判定の許容差(mm/年)。結果を見る前に固定 — 較正つまみではない。
 * 判定は陸セルの**平均**絶対ドリフトで行う(2026-07-31 に統計量を最大値から
 * 平均へ変更。理由: 利用可能水が容量〜容量+可能蒸発散の帯にある月は
 * ET が貯水に依存せず写像の傾きが 1 になり、中立(縮小しない)固定点の
 * 連続族ができる。この帯のセルではドリフトが線形にしか減らず、最大値は
 * 数百年でも 2mm/年程度で下げ止まる。バケツモデル固有の縮退であり、
 * 収支・場の値には効かない[実測: 面積重み ΔS = 0.006mm/年]。
 * 閾値そのものは緩めていない。最大値も併せて報告する)
 */
export const SOIL_SPINUP_TOLERANCE_MM = 0.05;

/**
 * 土壌水分の周期定常解。降水場・気温場を固定し、年間の貯水変化が
 * SOIL_SPINUP_TOLERANCE_MM を下回るまで空回しする(上限 maxYears)。
 * 決定的(乱数なし)。initialFillFrac は収束検証用の初期値指定。
 * 極寒・極乾など蒸発散が極端に小さい惑星では収束に多くの年数を要するため、
 * 固定年数ではなくドリフト判定にしている(第四 FB の退化条件対応)。
 */
export function solveSoilWater(
  cellCount: number,
  isLand: (i: number) => boolean,
  precipByMonth: Float32Array[],
  tempByMonth: Float32Array[],
  capacityMm: number,
  maxYears: number,
  initialFillFrac = 0,
  /**
   * 初期貯水(mm)。結合反復のウォームスタート用 — 前反復の周期定常解を
   * 渡すと必要な空回し年数が大幅に減る。周期定常への収束判定は同じなので
   * 得られる解は許容差内で同一(テストで担保)
   */
  initialStorage?: ArrayLike<number>,
): SoilWaterResult {
  const storage = new Float64Array(cellCount);
  if (capacityMm > 0 && initialStorage) {
    for (let i = 0; i < cellCount; i++) {
      if (isLand(i)) {
        storage[i] = Math.min(capacityMm, Math.max(0, initialStorage[i] ?? 0));
      }
    }
  } else if (capacityMm > 0 && initialFillFrac > 0) {
    for (let i = 0; i < cellCount; i++) {
      if (isLand(i)) storage[i] = capacityMm * initialFillFrac;
    }
  }
  const actualEtMm: Float32Array[] = [];
  const storageMm: Float32Array[] = [];
  const runoffMm: Float32Array[] = [];
  const wetness01: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    actualEtMm.push(new Float32Array(cellCount));
    storageMm.push(new Float32Array(cellCount));
    runoffMm.push(new Float32Array(cellCount));
    wetness01.push(new Float32Array(cellCount));
  }
  const storageChangeMm = new Float32Array(cellCount);
  if (capacityMm <= 0) {
    return {
      actualEtMm,
      storageMm,
      runoffMm,
      wetness01,
      storageChangeMm,
      spinupYears: 0,
      meanAnnualStorageDriftMm: 0,
      maxAnnualStorageDriftMm: 0,
      converged: true,
    };
  }
  const limitYears = Math.max(1, Math.round(maxYears));
  const yearStart = new Float64Array(cellCount);
  let drift = Number.POSITIVE_INFINITY;
  let maxDrift = Number.POSITIVE_INFINITY;
  let usedYears = 0;
  let converged = false;
  for (let y = 0; y < limitYears; y++) {
    usedYears = y + 1;
    yearStart.set(storage);
    // 年間ドリフトが許容内に入った次の年を記録年にする(前年の判定結果で決める
    // ため、記録年そのものが周期定常であることが保証される)
    const record = converged || y === limitYears - 1;
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const p = precipByMonth[m];
      const t = tempByMonth[m];
      for (let i = 0; i < cellCount; i++) {
        if (!isLand(i)) continue;
        // 第四 FB P0-2: 前月貯水へ**当月降水を加えてから**湿り度を決める。
        // 降水前の s0 で湿り度を測ると、空の土壌に大雨が降っても当月 ET が 0 に
        // なり、季節記憶ではなく 1 か月の位相ずれで乾季が改善してしまう
        const available = (storage[i] ?? 0) + (p?.[i] ?? 0);
        const pet = potentialEtMmPerMonth(t?.[i] ?? 0);
        // 供給律速: 利用可能水が少ないほど蒸発散が減る(乾季の自己制限)
        const wet = Math.min(1, Math.max(0, available / capacityMm));
        const et = Math.min(available, pet * wet);
        const remaining = available - et;
        let s = remaining;
        let runoff = 0;
        if (s > capacityMm) {
          runoff = s - capacityMm;
          s = capacityMm;
        }
        if (s < 0) s = 0;
        storage[i] = s;
        if (record) {
          actualEtMm[m]![i] = et;
          storageMm[m]![i] = s;
          runoffMm[m]![i] = runoff;
          wetness01[m]![i] = wet;
        }
      }
    }
    // 年間ドリフト(年末 − 年初)。判定は陸セル平均、最大値も記録する
    let sum = 0;
    let count = 0;
    maxDrift = 0;
    for (let i = 0; i < cellCount; i++) {
      if (!isLand(i)) continue;
      const d = (storage[i] ?? 0) - (yearStart[i] ?? 0);
      if (record) storageChangeMm[i] = d;
      const ad = Math.abs(d);
      sum += ad;
      count++;
      if (ad > maxDrift) maxDrift = ad;
    }
    drift = count > 0 ? sum / count : 0;
    if (record) break; // 周期定常の年を記録し終えた
    if (drift <= SOIL_SPINUP_TOLERANCE_MM) converged = true; // 次の年を記録年にする
  }
  return {
    actualEtMm,
    storageMm,
    runoffMm,
    wetness01,
    storageChangeMm,
    spinupYears: usedYears,
    meanAnnualStorageDriftMm: drift,
    maxAnnualStorageDriftMm: maxDrift,
    converged,
  };
}

// ---- 結合反復の収束(第四 FB P0-1、2026-07-31 事前登録)----
// 土壌水分 → 実蒸発散 → 陸面供給 → 月ブレンド → 変換 → 後処理(冬季床・
// 月平滑)までを一つの演算子とし、その固定点を求める。反復内と最終出力で
// 同じ演算子を使う(旧実装は反復内が月ブレンドと後処理を欠いており、
// 土壌が収支計算に使った降水と最終降水が一致しなかった = 構造的残差 6.2%)。
// 許容差と上限は結果を見る前に固定する(較正つまみにしない)。
export const COUPLING_TOLERANCE_MM_PER_MONTH = 0.2;
export const COUPLING_MAX_ITERATIONS = 8;

export interface PrecipCouplingDiagnostics {
  /** 実施した結合反復回数 */
  iterations: number;
  maxIterations: number;
  toleranceMmPerMonth: number;
  /** 最終反復での陸面積重み付き平均 |ΔP|(mm/月) */
  finalResidualMmPerMonth: number;
  converged: boolean;
}

// ---- R2(地域降水 FB §6): 供給場の循環 3 点月ブレンド ----
// 月平均風の単一方向トレースは風向の月替わりで供給が断絶する
// (ガンジス 7 月 589mm → 8 月 0mm — レビュー H8)。実際の遷移月はどちらの
// 風も吹くため、供給場を前/当/翌月で 0.25/0.5/0.25 に均す。
// 後段の precipMonthBlend(最終降水場の平滑)とは役割が異なる: こちらは
// 変換(持上げ・抑制の非線形)の**前**に供給の断絶を埋める。
// 旧実装は 0/1/0 の恒等写像でコメントと不一致だった(FB 指摘)。
// 2026-07-31 R2 単独実験として 0.25 を復活(採否は事前凍結基準で判定)。
export const SUPPLY_MONTH_BLEND_SIDE = 0.25;

/** 循環 3 点ブレンド(1 月と 12 月は互いに隣接)。side=0 で恒等 */
export function blendSupplyMonths(
  arr: Float32Array[],
  m: number,
  cellCount: number,
  side: number = SUPPLY_MONTH_BLEND_SIDE,
): Float32Array {
  const prev = arr[(m + MONTHS_PER_YEAR - 1) % MONTHS_PER_YEAR];
  const cur = arr[m];
  const next = arr[(m + 1) % MONTHS_PER_YEAR];
  const out = new Float32Array(cellCount);
  const center = 1 - 2 * side;
  for (let i = 0; i < cellCount; i++) {
    out[i] = side * (prev?.[i] ?? 0) + center * (cur?.[i] ?? 0) + side * (next?.[i] ?? 0);
  }
  return out;
}

interface PrecipDiagMonth {
  supplyStorm: Float32Array;
  liftItcz: Float32Array;
  liftFrontal: Float32Array;
  liftOrographic: Float32Array;
  liftConvergence: Float32Array;
  convergenceIndex: Float32Array;
  subsidenceResidual: Float32Array;
  upwindBlock: Float32Array;
  liftOther: Float32Array;
  preAdjustMm: Float32Array;
}

export function computePrecipitation(
  ctx: SimContext,
  itcz: ItczResult,
  windBelt: WindBeltResult,
  ocean: OceanCurrentResult,
  airflow: AirflowResult,
  temperature: TemperatureResult,
  diagOut?: PrecipDiagBox,
): PrecipitationResult {
  const { grid, params, terrain } = ctx;
  const monthlyPrecipMm: Float32Array[] = [];
  const annualPrecipMm = new Float32Array(grid.cellCount);
  // R1 診断: 要求時のみ割り当て(通常実行はゼロコスト)
  const diag: PrecipDiagnostics | null = diagOut
    ? {
        supplyOcean: [],
        supplyLand: [],
        supplyStorm: [],
        liftItcz: [],
        liftFrontal: [],
        liftOrographic: [],
        liftConvergence: [],
        convergenceIndex: [],
        subsidenceResidual: [],
        upwindBlock: [],
        liftOther: [],
        preAdjustMm: [],
        postAdjustDeltaMm: [],
        mmPerSupplyUnit:
          K.precipScaleMmPerUnit *
          Math.pow(Math.max(0.1, params.atmosphere.surfacePressureBar), 0.5),
      }
    : null;
  if (diag && diagOut) diagOut.fields = diag;
  const dyKm = cellHeightKm(grid, params.body.radiusKm);
  const smallWater = buildSmallWaterMask(ctx);
  const crestElev = buildCrestElev(ctx);

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
        ? traceMoistureSupply(ctx, smallWater, crestElev, tField, u, v, null, 0)
        : new Float32Array(grid.cellCount),
    );
  }
  const blend = (arr: Float32Array[], m: number): Float32Array =>
    blendSupplyMonths(arr, m, grid.cellCount);

  // ---- パス 2: 陸面再蒸発を供給源に加えて再追跡(結合反復)----
  // 実物の内陸雨林は降水の 5〜8 割が再蒸発の再循環で自己保持される。
  // 1 回パスだと海から遠い赤道内陸が立ち上がれない(鶏と卵 — 仮想大陸の
  // 赤道内陸が砂漠化する実測 2026-07-31)ため、固定点に向けて反復する。
  // R3: 陸面供給は「当月降水に比例」ではなく土壌水分バケツの実蒸発散に
  // 比例させる(乾季へ前月までの雨を持ち越す)。月をまたぐ状態を持つため
  // 結合反復を月ループの外側に置く — 土壌無効時は月ごと独立で従来と同一。
  const monthlyConvert = (m: number, supply: Float32Array): Float32Array => {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    if (!tField || !u || !v) return new Float32Array(grid.cellCount);
    return convertToPrecip(
      ctx,
      itcz,
      m,
      tField,
      u,
      v,
      supply,
      windBelt.monthlyRidgeLatNDeg[m] ?? 31,
      windBelt.monthlyRidgeLatSDeg[m] ?? -31,
      windBelt.monthlyPolarFrontLatNDeg[m] ?? 60,
      windBelt.monthlyPolarFrontLatSDeg[m] ?? -60,
      dyKm,
      ocean,
      eastOceanKm,
      eastOceanSstA,
      meanItczCenters,
      crestElev,
    );
  };

  // ---- 後処理: 冬季の弱前線の床 + 降水の月平滑(いずれも陸のみ)----
  // 第四 FB P0-1: これらは結合演算子の一部であり、反復の中でも最終出力と
  // 同じものを適用する(旧実装は反復内で欠けており、土壌が収支に使った降水と
  // 最終降水が別物になっていた)。どちらもセル年総量を保存する。
  const applyPostAdjust = (arr: Float32Array[]): void => {
    // 冬季の弱前線の床(年総量保存の再配分)。最乾月が 0mm に張り付く癖
    // (Cwa 最多/最少比)への対策。熱帯のサバナ乾季には掛からない
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
            const p = arr[m]?.[i] ?? 0;
            if (p > wettest) wettest = p;
          }
          const floorMm = Math.min(K.winterFloorMaxMm, K.winterFloorFracOfWettest * wettest);
          if (floorMm < 0.5) continue;
          let deficit = 0;
          let surplus = 0;
          const floors: number[] = [];
          for (let m = 0; m < MONTHS_PER_YEAR; m++) {
            // 適用月 = 盛夏以外(正規化赤緯 < 0.5)。冬限定だと 4〜5 月の
            // 「春の谷」が夏半年の最乾月になり、秋こぶ(10 月)との組で
            // タイガが夏乾 Ds に誤判定される(s 条件: 4月 < 10月/3)
            const summerNorm =
              (lat >= 0 ? (decls[m] ?? 0) : -(decls[m] ?? 0)) /
              Math.max(1e-6, ctx.params.body.axialTiltDeg);
            const ridge =
              lat >= 0
                ? (windBelt.monthlyRidgeLatNDeg[m] ?? 31)
                : (windBelt.monthlyRidgeLatSDeg[m] ?? -31);
            const pf =
              lat >= 0
                ? (windBelt.monthlyPolarFrontLatNDeg[m] ?? 60)
                : (windBelt.monthlyPolarFrontLatSDeg[m] ?? -60);
            const inBand = aLat > Math.abs(ridge) + 1 && aLat < Math.abs(pf) + 12;
            const f = summerNorm < 0.5 && inBand ? floorMm : 0;
            floors.push(f);
            const p = arr[m]?.[i] ?? 0;
            if (p < f) deficit += f - p;
            else surplus += p - f;
          }
          if (deficit <= 0 || surplus <= 0) continue;
          // 移転は湿潤月の余剰の 35% まで(無制限だと夏の雨をほぼ全部持って
          // いき、タイガが夏乾の Ds に化ける — 実測)
          const transfer = Math.min(deficit, surplus * 0.35);
          const k = transfer / surplus;
          const fill = transfer / deficit;
          for (let m = 0; m < MONTHS_PER_YEAR; m++) {
            const a = arr[m];
            if (!a) continue;
            const p = a[i] ?? 0;
            const f = floors[m] ?? 0;
            a[i] = p < f ? p + (f - p) * fill : p - (p - f) * k;
          }
        }
      }
    }
    // 降水の月平滑(循環 3 点)。風向の月替わりで遷移月が 0 近くまで陥没し
    // 「夏半年の最乾月」になってタイガが夏乾 Ds に誤判定される対策。
    // 乾季が連続する所(サバナ・地中海の夏)は隣接月も乾いており不変
    if (K.precipMonthBlend > 0) {
      const b = K.precipMonthBlend;
      const before = arr.map((a) => Float32Array.from(a));
      for (let m = 0; m < MONTHS_PER_YEAR; m++) {
        const cur = arr[m];
        const prev = before[(m + MONTHS_PER_YEAR - 1) % MONTHS_PER_YEAR];
        const next = before[(m + 1) % MONTHS_PER_YEAR];
        if (!cur || !prev || !next) continue;
        for (let i = 0; i < grid.cellCount; i++) {
          if (!terrain.landMask[i]) continue;
          cur[i] = (1 - 2 * b) * (before[m]?.[i] ?? 0) + b * (prev[i] ?? 0) + b * (next[i] ?? 0);
        }
      }
    }
  };

  /** 陸面積重み付き平均 |ΔP|(mm/月) — 結合反復の収束指標 */
  const meanAbsChange = (a: Float32Array[], b: Float32Array[]): number => {
    let acc = 0;
    let wsum = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const w = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (!terrain.landMask[i]) continue;
        wsum += w;
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          acc += w * Math.abs((a[m]?.[i] ?? 0) - (b[m]?.[i] ?? 0));
        }
      }
    }
    return wsum > 0 ? acc / (wsum * MONTHS_PER_YEAR) : 0;
  };

  const supplies2: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) supplies2.push(new Float32Array(grid.cellCount));

  // 初期推定: 海洋のみ供給 → 変換 → 後処理(演算子は反復内と同一)
  let precipEst: Float32Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const tField = temperature.monthlyTemperatureC[m];
    const u = airflow.monthlyWindU[m];
    const v = airflow.monthlyWindV[m];
    precipEst.push(
      tField && u && v ? monthlyConvert(m, blend(supplies1, m)) : new Float32Array(grid.cellCount),
    );
  }
  applyPostAdjust(precipEst);

  const soilOn = K.soilWaterCapacityMm > 0;
  const isLand = (i: number): boolean => terrain.landMask[i] === 1;
  let soil: SoilWaterResult | null = null;
  let iterations = 0;
  let residual = Number.POSITIVE_INFINITY;
  let converged = false;
  for (let it = 1; it <= COUPLING_MAX_ITERATIONS; it++) {
    iterations = it;
    if (soilOn) {
      soil = solveSoilWater(
        grid.cellCount,
        isLand,
        precipEst,
        temperature.monthlyTemperatureC,
        K.soilWaterCapacityMm,
        K.soilSpinupYears,
        0,
        // 結合反復のウォームスタート(前反復の 12 月末貯水)。周期定常への
        // 収束判定は同じなので解は許容差内で同一、空回し年数だけ減る
        soil?.storageMm[MONTHS_PER_YEAR - 1],
      );
    }
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const tField = temperature.monthlyTemperatureC[m];
      const u = airflow.monthlyWindU[m];
      const v = airflow.monthlyWindV[m];
      if (!tField || !u || !v) continue;
      const landSource = new Float32Array(grid.cellCount);
      const etM = soil?.actualEtMm[m];
      for (let i = 0; i < grid.cellCount; i++) {
        if (!terrain.landMask[i]) continue;
        // 大気への水蒸気供給は実蒸発散(質量フラックス)に比例させ、20°C 基準の
        // 可能蒸発散で無次元化する(旧: 当月降水 / 40mm)。
        // 湿り度分数 S/容量 での正規化も試したが、暑く湿った熱帯で実蒸発散が
        // 可能蒸発散に近づく効果が落ちて全指標が悪化した(2026-07-31 実測:
        // 容量 300mm で詳細 43.47→42.61、アマゾン最乾 68→57mm)。
        // 供給は「フラックス」であって「湿り具合」ではない
        const wetness = soilOn
          ? Math.min(1, (etM?.[i] ?? 0) / K.soilPetScaleMmPerMonth)
          : Math.min(1, (precipEst[m]?.[i] ?? 0) / 40);
        landSource[i] = K.landRecyclingStrength * wetness;
      }
      supplies2[m] = traceMoistureSupply(ctx, smallWater, crestElev, tField, u, v, landSource, 0);
    }
    const next: Float32Array[] = [];
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      next.push(monthlyConvert(m, blend(supplies2, m)));
    }
    applyPostAdjust(next);
    residual = meanAbsChange(next, precipEst);
    precipEst = next;
    if (residual <= COUPLING_TOLERANCE_MM_PER_MONTH) {
      converged = true;
      break;
    }
  }
  // 最終の土壌診断は収束後の最終降水場で解き直す(返す ET・流出・貯水が
  // 最終降水と同じ周期解になり、統合水収支が閉じる)
  if (soilOn) {
    soil = solveSoilWater(
      grid.cellCount,
      isLand,
      precipEst,
      temperature.monthlyTemperatureC,
      K.soilWaterCapacityMm,
      K.soilSpinupYears,
    );
  }
  if (diagOut && soil) diagOut.soil = soil;
  const coupling: PrecipCouplingDiagnostics = {
    iterations,
    maxIterations: COUPLING_MAX_ITERATIONS,
    toleranceMmPerMonth: COUPLING_TOLERANCE_MM_PER_MONTH,
    finalResidualMmPerMonth: residual,
    converged,
  };

  for (let m = 0; m < MONTHS_PER_YEAR; m++) monthlyPrecipMm.push(precipEst[m]!);

  // R1 診断: 収束後の供給からもう一度変換して因子分解を捕捉する
  // (後処理前の値なので preAdjustMm と一致する)
  if (diag) {
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const tField = temperature.monthlyTemperatureC[m];
      const u = airflow.monthlyWindU[m];
      const v = airflow.monthlyWindV[m];
      const N = grid.cellCount;
      if (!tField || !u || !v) {
        diag.supplyOcean.push(new Float32Array(N));
        diag.supplyLand.push(new Float32Array(N));
        diag.supplyStorm.push(new Float32Array(N));
        diag.liftItcz.push(new Float32Array(N));
        diag.liftFrontal.push(new Float32Array(N));
        diag.liftOrographic.push(new Float32Array(N));
        diag.liftConvergence.push(new Float32Array(N));
        diag.convergenceIndex.push(new Float32Array(N));
        diag.subsidenceResidual.push(new Float32Array(N));
        diag.upwindBlock.push(new Float32Array(N));
        diag.liftOther.push(new Float32Array(N));
        diag.preAdjustMm.push(new Float32Array(N));
        continue;
      }
      const supply2 = blend(supplies2, m);
      const diagM: PrecipDiagMonth = {
        supplyStorm: new Float32Array(N),
        liftItcz: new Float32Array(N),
        liftFrontal: new Float32Array(N),
        liftOrographic: new Float32Array(N),
        liftConvergence: new Float32Array(N),
        convergenceIndex: new Float32Array(N),
        subsidenceResidual: new Float32Array(N),
        upwindBlock: new Float32Array(N),
        liftOther: new Float32Array(N),
        preAdjustMm: new Float32Array(N),
      };
      convertToPrecip(
        ctx,
        itcz,
        m,
        tField,
        u,
        v,
        supply2,
        windBelt.monthlyRidgeLatNDeg[m] ?? 31,
        windBelt.monthlyRidgeLatSDeg[m] ?? -31,
        windBelt.monthlyPolarFrontLatNDeg[m] ?? 60,
        windBelt.monthlyPolarFrontLatSDeg[m] ?? -60,
        dyKm,
        ocean,
        eastOceanKm,
        eastOceanSstA,
        meanItczCenters,
        crestElev,
        diagM,
      );
      // 海洋由来 = 海のみトレース(パス 1)、陸面再循環由来 = 全供給 − 海のみ
      const supply1b = blend(supplies1, m);
      const so = new Float32Array(N);
      const sl = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        so[i] = supply1b[i] ?? 0;
        sl[i] = (supply2[i] ?? 0) - (supply1b[i] ?? 0);
      }
      diag.supplyOcean.push(so);
      diag.supplyLand.push(sl);
      diag.supplyStorm.push(diagM.supplyStorm);
      diag.liftItcz.push(diagM.liftItcz);
      diag.liftFrontal.push(diagM.liftFrontal);
      diag.liftOrographic.push(diagM.liftOrographic);
      diag.liftConvergence.push(diagM.liftConvergence);
      diag.convergenceIndex.push(diagM.convergenceIndex);
      diag.subsidenceResidual.push(diagM.subsidenceResidual);
      diag.upwindBlock.push(diagM.upwindBlock);
      diag.liftOther.push(diagM.liftOther);
      diag.preAdjustMm.push(diagM.preAdjustMm);
    }
  }

  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const arr = monthlyPrecipMm[m];
    if (!arr) continue;
    for (let i = 0; i < grid.cellCount; i++) {
      annualPrecipMm[i] = (annualPrecipMm[i] ?? 0) + (arr[i] ?? 0);
    }
  }
  // R1 診断: 後処理差分(最終 − 変換直後)。全セルで 最終 = pre + delta が成立
  if (diag) {
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const N = grid.cellCount;
      const delta = new Float32Array(N);
      const fin = monthlyPrecipMm[m];
      const pre = diag.preAdjustMm[m];
      for (let i = 0; i < N; i++) {
        delta[i] = (fin?.[i] ?? 0) - (pre?.[i] ?? 0);
      }
      diag.postAdjustDeltaMm.push(delta);
    }
  }
  return { monthlyPrecipMm, annualPrecipMm, coupling };
}

/**
 * 遮蔽・脱水に使う稜線標高。
 *
 * R5(地域降水 FB §9、2026-08-01): 生の高解像度標高(ETOPO 60 秒)から作った
 * **セル内 p95 標高**(terrain.crestElevationMeters)を第一候補とする。
 * 実測: 南部アンデスは平均 989m に対し p95 1,734m(1.75 倍)、チベット高原は
 * 4,914m → 5,277m(1.07 倍)、アマゾン平地は 33m → 43m。狭い山脈だけが跳ね、
 * 広い高原の縁を誤って狭い山脈と判定しない。
 *
 * 高解像度データの無い地形(手続き生成・簡易プリセット)では平均標高と同じ値に
 * なるため、隣接との比高(プロミネンス)による推定を加算で補う
 * (K.crestProminenceFactor。既定 0 = 無効 — 高原の縁と区別できず熱帯を壊した
 * 実測があるため)。演算子は全惑星で同一で、入力データの精細さだけが違う。
 */
function buildCrestElev(ctx: SimContext): Float32Array {
  const { grid, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      const e = Math.max(0, terrain.elevationMeters[i] ?? 0);
      const dataCrest = Math.max(e, terrain.crestElevationMeters[i] ?? 0);
      let minNb = e;
      const nbs = [
        row > 0 ? (row - 1) * W + col : -1,
        row < H - 1 ? (row + 1) * W + col : -1,
        row * W + ((col + 1) % W),
        row * W + ((col + W - 1) % W),
      ];
      for (const nb of nbs) {
        if (nb < 0) continue;
        const en = Math.max(0, terrain.elevationMeters[nb] ?? 0);
        if (en < minNb) minNb = en;
      }
      // セル内分位で足りない分だけプロミネンス推定で補う(二重計上しない)
      const prominence = K.crestProminenceFactor * Math.max(0, e - minNb);
      out[i] = Math.max(dataCrest, e + prominence);
    }
  }
  return out;
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
  crestElev: Float32Array,
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
          // Fetch を超えた先も完全遮断はしない(下限 0.12)— 黒海・バルト海は
          // 遠方にも幾らか湿潤を送る。0.3 ではペルシャ湾型(q_sat が巨大な熱い
          // 内海)の漏れが大きすぎ、アラビア内陸が Aw 化した(2026-07-31)
          const reach = Math.min(bodyFetchKm, K.fetchOpenOceanCapKm);
          const f = Math.min(1, Math.max(0.12, (reach + 250 - bodyLandAtEntry) / 500));
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
        // 障壁は稜線推定標高で判定(狭い山脈が 1° 平均で均される問題への対策)
        const crestHere = crestElev[i] ?? eHere;
        if (crestHere > maxBarrierM) maxBarrierM = crestHere;
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
  crestElev: Float32Array,
  diagM?: PrecipDiagMonth,
): Float32Array {
  const { grid, params, terrain } = ctx;
  const W = grid.widthCells;
  const H = grid.heightCells;
  const out = new Float32Array(grid.cellCount);
  const elev = terrain.elevationMeters;
  const decl = ctx.insolation.monthlyDeclinationDeg[month] ?? 0;
  // R4: 水蒸気フラックス収束(供給場と地表風から。診断時は生の場も返す)
  const convergenceOn =
    K.convergenceLiftBoost > 0 || K.convergenceSubsidenceRelief > 0 || diagM !== undefined;
  const convIndex = convergenceOn
    ? moistureConvergenceIndex(grid, params.body.radiusKm, supply, u, v)
    : null;

  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    const dxKm = Math.max(20, cellWidthKm(grid, row, params.body.radiusKm));
    const ridge = lat >= 0 ? ridgeN : ridgeS;
    const pf = lat >= 0 ? pfN : pfS;
    // 冬の深さ(0〜1、至点で最大)。二値の寒候期ブーストは秋分直後から全開に
    // なり 10 月にスパイクを作る(秋こぶ — 西シベリア Dsa の源)。初回試験は
    // −0.3 で撤回したが、床・再循環の再較正後に再試験して採用(詳細 +0.6、
    // europe_russia が Df 首位に。2026-07-31)
    const winterDepth01 = Math.min(
      1,
      Math.max(0, (lat >= 0 ? -decl : decl) / Math.max(1e-6, ctx.params.body.axialTiltDeg)),
    );
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
      // R1 診断のため各倍率を named 化(乗算の順序・値は従来と同一 — ビット不変)
      const liftItczF = 1 + K.itczLiftBoost * gI * marineW;
      lift *= liftItczF;

      // R4: 湿潤収束 = 飽和した収束強度 × 湿潤ゲート(smoothstep)。
      // 乾いた収束(供給の乏しい低圧)では 0 のまま
      const wetConv = convIndex
        ? convergenceStrength01(convIndex[i] ?? 0, K.moistureConvergenceNorm) *
          wetnessGate01(supply[i] ?? 0, K.convergenceWetnessNorm)
        : 0;
      const liftConvF = 1 + K.convergenceLiftBoost * wetConv;
      lift *= liftConvF;

      // 前線収束(WL#29「セル衝突線 = 前線(低圧・湿潤)」の定量化):
      // 湿った空気(高供給)が極向き風で乾いた側へ押し込まれる場所が前線。
      // ITCZ 傘とストーム帯の間(≈25-40°)の梅雨・バイウ前線の空白を埋める
      let liftFrontalF = 1;
      {
        const north2 = row > 0 ? (row - 1) * W + col : i;
        const south2 = row < H - 1 ? (row + 1) * W + col : i;
        const eqNb = lat >= 0 ? south2 : north2;
        const polNb = lat >= 0 ? north2 : south2;
        const gradPoleward = Math.max(0, (supply[eqNb] ?? 0) - (supply[polNb] ?? 0));
        const vPoleward = lat >= 0 ? (v[i] ?? 0) : -(v[i] ?? 0);
        const aLat0 = Math.abs(lat);
        if (
          vPoleward > 0 &&
          gradPoleward > 0 &&
          aLat0 > Math.abs(ridge) - 6 &&
          aLat0 < Math.abs(pf)
        ) {
          const frontW = Math.min(1.5, (vPoleward / 4) * gradPoleward);
          liftFrontalF = 1 + K.frontalLiftBoost * frontW;
          lift *= liftFrontalF;
        }
      }

      // ストームトラック(リッジの極側〜極前線先の台形プラトー、寒候期に増強)
      const stLo = Math.abs(ridge) + 4;
      const stHi = Math.abs(pf) + 12;
      const aLat = Math.abs(lat);
      let stormW = 0;
      let liftStormF = 1;
      if (aLat > stLo && aLat < stHi) {
        const riseW = Math.min(1, (aLat - stLo) / 5);
        const fallW = Math.min(1, (stHi - aLat) / 10);
        stormW = Math.min(riseW, fallW);
        liftStormF =
          1 + (K.stormTrackBoost + K.stormTrackWinterBoost * 1.4 * winterDepth01) * stormW;
        lift *= liftStormF;
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
      let liftOroF = 1;
      if (upslopeMPerKmPerS > 0) {
        liftOroF = 1 + K.orographicBoost * Math.min(2.5, upslopeMPerKmPerS / refSlope);
        lift *= liftOroF;
      } else if (upslopeMPerKmPerS < 0) {
        const shadow = Math.min(1, -upslopeMPerKmPerS / refSlope);
        liftOroF = 1 - (1 - K.rainShadowFloor) * shadow;
        lift *= liftOroF;
      }

      // 風上山脈の遮蔽(広域雨陰): 風上へ遡って自セルより十分高い稜線があれば
      // 水蒸気の到達そのものを減衰させる(パタゴニア型の乾燥帯の根本機構)
      const blockFactor = upwindMountainFactor(ctx, elev, crestElev, u, v, row, col, dxKm, dyKm);

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
      // 条件は 2 つ: (a) 東の海が暖流(SST 正偏差 — バミューダ/黒潮型)、
      // (b) その海から実際に湿潤が届いている(供給実績 — アラビア海のように
      // 「暖かいが乾いた流入」の海を自動除外する。2026-07-31: SST だけでは
      // アラビアと華中を区別できず、到達延長がアラビアを再湿潤化した)
      const eastWarmth = Math.min(1, Math.max(0, ((eastOceanSstA[i] ?? 0) + 0.6) / 1.2));
      const supplyGate = Math.min(1, (supply[i] ?? 0) / K.eastReliefSupplyNorm);
      const eastRelief =
        K.eastCoastSubsidenceRelief *
        eastWarmth *
        supplyGate *
        Math.exp(-(eastOceanKm[i] ?? 1e9) / K.eastCoastSubsidenceDecayKm);
      // R4: 湿潤収束があるところは沈降の実効抑制が連続的に弱まる
      // (緯度帯だけで全開にしない — 中国東部・ラプラタの梅雨/暖湿流)
      const subs =
        descW *
        (1 - K.subsidenceItczProtection * gI * marineW) *
        (1 - eastRelief) *
        (1 - K.convergenceSubsidenceRelief * wetConv);
      const subsResidualF = 1 - K.subsidenceSuppression * subs;
      lift *= subsResidualF;

      // 寒流沿岸の安定化(亜熱帯〜中緯度の海岸乾燥: 沿岸〜300km。
      // フォークランド型の寒流帰還域まで含めるため上限 50°)
      let coldCoastF = 1;
      if (terrain.landMask[i] && aLat > 10 && aLat < 50) {
        const coastKm = ctx.landDistToCoastKm[i] ?? 1e9;
        if (coastKm < 300) {
          const cold = nearestOceanAnomaly(ctx, ocean, row, col);
          if (cold < -0.8) {
            coldCoastF = 1 - K.coldCoastSuppression * Math.min(1, -cold / 2.5);
            lift *= coldCoastF;
          }
        }
      }

      // 高温湿潤の陸での対流性増幅(夏の東岸・熱帯の午後対流)。
      // 分母を 2.8 に上げて高供給の湿潤域だけ発火させる(1.2 では半乾燥内陸まで
      // 飽和して豪州が Aw 化した — 較正記録の撤回理由への対処。レビュー H5)
      let warmHumidF = 1;
      if (terrain.landMask[i]) {
        const warmth = Math.min(1, Math.max(0, ((_tField[i] ?? 0) - 22) / 8));
        if (warmth > 0) {
          const supplyNorm = Math.min(1, (supply[i] ?? 0) / K.warmHumidSupplyNorm);
          warmHumidF = 1 + K.warmHumidConvectiveBoost * warmth * supplyNorm * supplyNorm;
          lift *= warmHumidF;
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
        const qBaseT = oceanT !== null ? Math.max(oceanT, _tField[i] ?? 0) : (_tField[i] ?? 0);
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
          K.stormMoistureSupply *
          supplyW *
          qRel *
          Math.exp(-coastKm / decayKm) *
          (1 + 0.55 * winterDepth01);
      }

      // 供給 × 持ち上げ × 遮蔽 → mm/月(気圧が低い惑星は降水効率も下がる)
      const pressureFactor = Math.pow(Math.max(0.1, params.atmosphere.surfacePressureBar), 0.5);
      out[i] = Math.max(
        0,
        ((supply[i] ?? 0) + stormSupply) *
          blockFactor *
          lift *
          K.precipScaleMmPerUnit *
          pressureFactor,
      );
      if (diagM) {
        diagM.supplyStorm[i] = stormSupply;
        diagM.liftItcz[i] = liftItczF;
        diagM.liftFrontal[i] = liftFrontalF;
        diagM.liftOrographic[i] = liftOroF;
        diagM.liftConvergence[i] = liftConvF;
        diagM.convergenceIndex[i] = convIndex?.[i] ?? 0;
        diagM.subsidenceResidual[i] = subsResidualF;
        diagM.upwindBlock[i] = blockFactor;
        diagM.liftOther[i] = liftStormF * coldCoastF * warmHumidF;
        diagM.preAdjustMm[i] = out[i] ?? 0;
      }
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
  crestElev: Float32Array,
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
    // 稜線は推定標高で判定(狭い山脈の 1° 平均均し対策)
    const e = Math.max(0, crestElev[r * W + c] ?? elev[r * W + c] ?? 0);
    if (e > maxRidge) maxRidge = e;
  }
  const relief = maxRidge - ownElev;
  if (relief <= 300) return 1;
  const t = Math.min(1, (relief - 300) / K.upwindBlockReliefM);
  return 1 - (1 - K.upwindBlockFloor) * t;
}

/** 近傍(半径 3 セル)の海セル SST 偏差の最小値(寒流検出用) */
// 対応 spec: FB 2026-07-31 P1-2 + 変更レビュー FB P2-3。探索半径は固定セル数
// ではなく球面上の角距離で定義する(解像度を変えても同じ地形で同じ探索対象
// 距離になる)。値は旧実装 ±6/±3 セルの 1° 地球での実効角半径の仕様化。
// 窓は正方形ではなく円形: 候補は dφ² + (dλ·cos(中間緯度))² ≤ R² で判定する
// (境界は R ちょうどを含む)。高緯度では同じ角半径がより多くの経度列に届く。
export const WARM_OCEAN_SEARCH_RADIUS_DEG = 6;
export const COLD_COAST_SEARCH_RADIUS_DEG = 3;

/** 中心セルから球面角距離 radiusDeg 以内の全セルを列挙(近似: cos 補正付き平面) */
export function forEachCellWithinAngularRadius(
  grid: Grid,
  row: number,
  col: number,
  radiusDeg: number,
  visit: (cellIndex: number) => void,
): void {
  const res = grid.resolutionDeg;
  const W = grid.widthCells;
  const lat0 = 90 - (row + 0.5) * res;
  const drMax = Math.ceil(radiusDeg / res);
  const r2 = radiusDeg * radiusDeg;
  for (let dr = -drMax; dr <= drMax; dr++) {
    const r = row + dr;
    if (r < 0 || r >= grid.heightCells) continue;
    const lat1 = 90 - (r + 0.5) * res;
    const dPhi = Math.abs(lat1 - lat0);
    const rem2 = r2 - dPhi * dPhi;
    if (rem2 < -1e-9) continue;
    const cosMid = Math.max(0.05, Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180));
    const dcMax = Math.min(
      Math.floor(W / 2),
      Math.ceil(Math.sqrt(Math.max(0, rem2)) / (res * cosMid)),
    );
    for (let dc = -dcMax; dc <= dcMax; dc++) {
      const dLam = Math.abs(dc) * res * cosMid;
      if (dPhi * dPhi + dLam * dLam > r2 + 1e-9) continue;
      visit(r * W + wrapCol(grid, col + dc));
    }
  }
}

/**
 * 近傍(球面角半径 6°)で最も暖かい海セルの気温(°C)。渦供給の水蒸気量の基準。
 * 冬の東岸の移動性低気圧は局所の陸気温ではなく暖流の海面から水蒸気を汲む
 * (湾流・黒潮の冬の東岸降水 — 2026-07-30 レビュー H1)
 */
export function nearestOceanTempC(
  ctx: SimContext,
  tField: Float32Array,
  row: number,
  col: number,
): number | null {
  const { grid, terrain } = ctx;
  let best: number | null = null;
  forEachCellWithinAngularRadius(grid, row, col, WARM_OCEAN_SEARCH_RADIUS_DEG, (i) => {
    if (terrain.landMask[i]) return;
    const t = tField[i] ?? 0;
    if (best === null || t > best) best = t;
  });
  return best;
}

/** 近傍(球面角半径 3°)で最も冷たい海面偏差(寒流沿岸判定) */
export function nearestOceanAnomaly(
  ctx: SimContext,
  ocean: OceanCurrentResult,
  row: number,
  col: number,
): number {
  const { grid, terrain } = ctx;
  let minA = 0;
  forEachCellWithinAngularRadius(grid, row, col, COLD_COAST_SEARCH_RADIUS_DEG, (i) => {
    if (terrain.landMask[i]) return;
    const a = ocean.sstAnomalyC[i] ?? 0;
    if (a < minA) minA = a;
  });
  return minA;
}
