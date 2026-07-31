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

/** 入力の事前診断(計算前)。範囲外・非有限は判定不能 */
export function diagnoseInputs(params: PlanetParams): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  for (const d of INPUT_DOMAIN) {
    const v = d.get(params);
    if (!Number.isFinite(v)) {
      issues.push({
        severity: 'error',
        code: `input:${d.code}:nonfinite`,
        message: `${d.label} が有限値ではない`,
      });
      continue;
    }
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
