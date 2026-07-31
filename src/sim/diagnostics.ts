// 対応 spec: FB 2026-07-31 P1-3(モデル適用範囲と異常診断)。
// 「NaN がない」は「定性的に妥当」と同義ではない。適用範囲外の入力・出力は
// 値を黙って切り詰めず、理由つきで「このモデルでは判定不能」と宣言する。
// 適用範囲外のとき、ケッペン分類は有効な科学出力として表示しない(UI・検証共通)。
//
// 適用範囲の根拠:
// - 気温: OLR の線形化(A + B·T)と Magnus 飽和水蒸気式は地球型の温度域での
//   近似。月平均 ±側の外挿限界として [-120, +70] °C を適用域とする
//   (地球の極値 −89〜+57 °C を余裕込みで含む。これを超える惑星は
//   雲・水循環・大気組成の仮定自体が崩れる)。
// - 降水: 観測された月降水の極値は ~9,300 mm/月(チェラプンジ 1861-07)。
//   1 桁の余裕を見て 20,000 mm/月 を超える値は水収支近似の破綻とみなす。
// - 入力: UI スライダーの定義域(docs/要件.md §2)を機械化した範囲。
//   範囲内でも組合せで場が適用域を外れることがあるため、事後診断と併用する。

import type { PlanetParams } from '@/domain/planetParams';
import type { PrecipitationResult, TemperatureResult } from './types';

export interface DiagnosticIssue {
  /** 'error' = 判定不能(適用範囲外)、'warning' = 参考情報 */
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface PipelineDiagnostics {
  /** 'ok' = 適用範囲内、'out_of_domain' = 判定不能(ケッペンを有効出力としない) */
  status: 'ok' | 'out_of_domain';
  issues: DiagnosticIssue[];
}

/** 場の適用域(月平均) */
export const FIELD_DOMAIN = {
  monthlyTempMinC: -120,
  monthlyTempMaxC: 70,
  monthlyPrecipMaxMm: 20000,
} as const;

/** 入力の適用域(docs/要件.md §2 のスライダー定義域) */
export const INPUT_DOMAIN: Array<{
  code: string;
  label: string;
  min: number;
  max: number;
  get: (p: PlanetParams) => number;
}> = [
  { code: 'starLuminositySolar', label: '主星光度(太陽=1)', min: 0.01, max: 100, get: (p) => p.orbital.starLuminositySolar },
  { code: 'semiMajorAxisAu', label: '軌道長半径(AU)', min: 0.05, max: 50, get: (p) => p.orbital.semiMajorAxisAu },
  { code: 'eccentricity', label: '軌道離心率', min: 0, max: 0.9, get: (p) => p.orbital.eccentricity },
  { code: 'radiusKm', label: '惑星半径(km)', min: 1000, max: 20000, get: (p) => p.body.radiusKm },
  { code: 'rotationPeriodHours', label: '自転周期(時間)', min: 4, max: 10000, get: (p) => p.body.rotationPeriodHours },
  { code: 'axialTiltDeg', label: '地軸傾斜(度)', min: 0, max: 90, get: (p) => p.body.axialTiltDeg },
  { code: 'surfacePressureBar', label: '表面気圧(bar)', min: 0.1, max: 10, get: (p) => p.atmosphere.surfacePressureBar },
  { code: 'greenhouseStrength', label: '温室効果強度', min: 0, max: 5, get: (p) => p.atmosphere.greenhouseStrength },
  { code: 'cloudAlbedo', label: '雲アルベド', min: 0, max: 0.6, get: (p) => p.atmosphere.cloudAlbedo },
  { code: 'oceanMixedLayerDepthM', label: '海洋混合層深(m)', min: 5, max: 500, get: (p) => p.atmosphere.oceanMixedLayerDepthM },
  { code: 'heatTransportStrength', label: '熱輸送強度', min: 0.1, max: 5, get: (p) => p.atmosphere.heatTransportStrength },
];

// ---- 計算可能性の事前検査(変更レビュー FB「P1 適用範囲の事前診断」) ----
// 「計算不能な入力(invalid_input)」と「計算可能だが科学的適用範囲外
// (out_of_domain)」を分離する。前者は配列確保・反復回数・除算を壊すため、
// パイプライン冒頭で例外にして一切計算しない。後者は生の場は計算するが、
// ケッペン等の科学判定を無効とする。
// 注: UI スライダーの操作範囲は UI 側の定義であり、ここは科学的適用範囲の
// 単一定義(二重定義しない)。UI 範囲が狭い分には矛盾しない。

const TERRAIN_PRESETS = new Set([
  'earth',
  'idealized_continent',
  'two_continents',
  'aquaplanet',
  'all_land',
]);

/** 計算不能な入力を列挙(1 件でもあれば計算してはならない) */
export function invalidInputIssues(params: PlanetParams): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const bad = (code: string, message: string) =>
    issues.push({ severity: 'error', code: `invalid_input:${code}`, message });

  // 構造値: 格子・自転方向・地形は配列確保やループ回数に直結する
  const res = params.gridResolutionDeg;
  if (!Number.isFinite(res) || res < 0.25 || res > 5) {
    bad('gridResolutionDeg', `格子分解能 ${String(res)}° が計算可能域 [0.25, 5] の外`);
  }
  if (params.body.rotationDirection !== 1 && params.body.rotationDirection !== -1) {
    bad('rotationDirection', `自転方向 ${String(params.body.rotationDirection)} は 1 か -1 のみ`);
  }
  const ecc = params.orbital.eccentricity;
  if (!Number.isFinite(ecc) || ecc < 0 || ecc >= 0.95) {
    bad('eccentricity', `軌道離心率 ${String(ecc)} が計算可能域 [0, 0.95) の外`);
  }
  const peri = params.orbital.perihelionSeasonDeg;
  if (!Number.isFinite(peri)) bad('perihelionSeasonDeg', '近日点位相が有限値ではない');
  // 全数値の非有限検査(NaN は下流の全比較を狂わせる)
  const nums: Array<[string, number]> = [
    ['starLuminositySolar', params.orbital.starLuminositySolar],
    ['semiMajorAxisAu', params.orbital.semiMajorAxisAu],
    ['radiusKm', params.body.radiusKm],
    ['rotationPeriodHours', params.body.rotationPeriodHours],
    ['axialTiltDeg', params.body.axialTiltDeg],
    ['surfacePressureBar', params.atmosphere.surfacePressureBar],
    ['greenhouseStrength', params.atmosphere.greenhouseStrength],
    ['cloudAlbedo', params.atmosphere.cloudAlbedo],
    ['oceanMixedLayerDepthM', params.atmosphere.oceanMixedLayerDepthM],
    ['heatTransportStrength', params.atmosphere.heatTransportStrength],
  ];
  for (const [code, v] of nums) {
    if (!Number.isFinite(v)) bad(code, `${code} が有限値ではない`);
  }
  if (params.body.radiusKm <= 0) bad('radiusKm', `惑星半径 ${params.body.radiusKm} km が正でない`);
  if (params.body.rotationPeriodHours <= 0) {
    bad('rotationPeriodHours', `自転周期 ${params.body.rotationPeriodHours} h が正でない`);
  }
  // 地形
  const t = params.terrain;
  if (t.kind === 'preset') {
    if (!TERRAIN_PRESETS.has(t.preset)) bad('terrainPreset', `未知の地形プリセット ${String(t.preset)}`);
  } else {
    if (!Number.isFinite(t.seed)) bad('terrainSeed', '手続き地形の種子が有限値ではない');
    if (!Number.isFinite(t.landFraction) || t.landFraction < 0 || t.landFraction > 1) {
      bad('landFraction', `陸面積率 ${String(t.landFraction)} が [0, 1] の外`);
    }
    if (!Number.isFinite(t.reliefScale) || t.reliefScale <= 0 || t.reliefScale > 10) {
      bad('reliefScale', `起伏の強さ ${String(t.reliefScale)} が (0, 10] の外`);
    }
  }
  return issues;
}

/**
 * 計算不能入力の専用エラー型。診断コード(invalid_input:*)を構造のまま保持し、
 * message にも同じコードを含める — ワーカー境界を文字列で越えても、UI と
 * ヘッドレス実行が同一の診断コードを表示できる(変更レビュー FB の受入条件)
 */
export class InvalidInputError extends Error {
  readonly issues: DiagnosticIssue[];
  constructor(issues: DiagnosticIssue[]) {
    super(`計算不能な入力: ${issues.map((x) => `[${x.code}] ${x.message}`).join(' / ')}`);
    this.name = 'InvalidInputError';
    this.issues = issues;
  }
}

/**
 * 計算不能な入力があれば明示エラー(パイプライン冒頭で必ず呼ぶ)。
 * 巨大配列確保・深い計算へ進む前に止める
 */
export function assertComputableInputs(params: PlanetParams): void {
  const issues = invalidInputIssues(params);
  if (issues.length > 0) {
    throw new InvalidInputError(issues);
  }
}

/** 入力の事前診断(科学的適用範囲)。計算可能性は invalidInputIssues が受け持つ */
export function diagnoseInputs(params: PlanetParams): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  for (const d of INPUT_DOMAIN) {
    const v = d.get(params);
    if (!Number.isFinite(v)) continue; // 非有限は invalid_input 側で計算前に停止
    if (v < d.min || v > d.max) {
      issues.push({
        severity: 'error',
        code: `input:${d.code}:range`,
        message: `${d.label} = ${v} が適用範囲 [${d.min}, ${d.max}] の外`,
      });
    }
  }
  return issues;
}

/** 計算後の場の診断。非有限・適用域外の温度・非物理な降水は判定不能 */
export function diagnoseFields(
  temperature: TemperatureResult,
  precipitation: PrecipitationResult,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  let tNonFinite = 0;
  for (const monthArr of temperature.monthlyTemperatureC) {
    for (let i = 0; i < monthArr.length; i++) {
      const t = monthArr[i] ?? 0;
      if (!Number.isFinite(t)) {
        tNonFinite++;
        continue;
      }
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  let pMax = -Infinity;
  let pMin = Infinity;
  let pNonFinite = 0;
  for (const monthArr of precipitation.monthlyPrecipMm) {
    for (let i = 0; i < monthArr.length; i++) {
      const p = monthArr[i] ?? 0;
      if (!Number.isFinite(p)) {
        pNonFinite++;
        continue;
      }
      if (p > pMax) pMax = p;
      if (p < pMin) pMin = p;
    }
  }
  if (tNonFinite > 0) {
    issues.push({
      severity: 'error',
      code: 'field:temp:nonfinite',
      message: `気温場に非有限値が ${tNonFinite} セル`,
    });
  }
  if (pNonFinite > 0) {
    issues.push({
      severity: 'error',
      code: 'field:precip:nonfinite',
      message: `降水場に非有限値が ${pNonFinite} セル`,
    });
  }
  if (tMax > FIELD_DOMAIN.monthlyTempMaxC || tMin < FIELD_DOMAIN.monthlyTempMinC) {
    issues.push({
      severity: 'error',
      code: 'field:temp:domain',
      message:
        `月平均気温 ${Math.round(tMin)}〜${Math.round(tMax)}°C が適用域 ` +
        `[${FIELD_DOMAIN.monthlyTempMinC}, ${FIELD_DOMAIN.monthlyTempMaxC}]°C の外 — ` +
        `線形 OLR と Magnus 式の外挿限界を超えており判定不能`,
    });
  }
  if (pMax > FIELD_DOMAIN.monthlyPrecipMaxMm) {
    issues.push({
      severity: 'error',
      code: 'field:precip:domain',
      message:
        `月降水の最大 ${Math.round(pMax).toLocaleString()} mm/月 が適用域上限 ` +
        `${FIELD_DOMAIN.monthlyPrecipMaxMm.toLocaleString()} mm/月 を超過 — 水収支近似の破綻`,
    });
  }
  if (pMin < 0) {
    issues.push({
      severity: 'error',
      code: 'field:precip:negative',
      message: `負の降水 ${Math.round(pMin)} mm/月 が存在`,
    });
  }
  return issues;
}

export function buildDiagnostics(
  params: PlanetParams,
  temperature: TemperatureResult,
  precipitation: PrecipitationResult,
): PipelineDiagnostics {
  const issues = [...diagnoseInputs(params), ...diagnoseFields(temperature, precipitation)];
  return {
    status: issues.some((x) => x.severity === 'error') ? 'out_of_domain' : 'ok',
    issues,
  };
}
