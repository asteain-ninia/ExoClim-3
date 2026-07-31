// 検証の合否基準の単一定義(FB 2026-07-31 P0-4)。
// 「退行防止ゲート」(凍結基準からの数値退行を検知 — CI 用、非零終了)と
// 「最終受入ゲート」(docs/要件.md §6 の到達判定 — 現状未達でも正直に報告)を
// 分離する。閾値は結果を見て緩めない(教訓 §8.3)。変更時は凍結日と根拠を更新し、
// docs/較正記録.md に記録すること。

// ---- 退行防止ゲート ----
// 凍結日: 2026-07-31。根拠: v2 採用モデル(較正記録参照)の実測値
// (大分類 73.93% / 詳細 42.74% / ゲート 14 / 気温 RMSE 3.65°C / 降水 RMSE 773mm /
//  ITCZ 線 RMSE 8.33° — すべて面積重み付き正本)に、意図した変更の判断誤差を
// 吸収する小さな余裕幅を加えた線。これを下回る変更は退行として非零終了する。
export const REGRESSION_BASELINE = {
  frozenAt: '2026-07-31',
  majorPctMin: 73.4, // 実測 73.93 − 0.5pt
  detailPctMin: 42.2, // 実測 42.74 − 0.5pt
  gatesMin: 14, // 実測 14(余裕なし — ゲート喪失は常に退行)
  tempRmseMaxC: 3.8, // 実測 3.65 + 0.15
  precipRmseMaxMm: 800, // 実測 773 + 27(約 +3.5%)
  itczRmseMaxDeg: 8.6, // 実測 8.33 + 0.27
  landMeanRatioMin: 0.9, // 陸平均降水 モデル/観測(実測 825/794 = 1.04)
  landMeanRatioMax: 1.1,
} as const;

export interface RegressionMetrics {
  majorPct: number;
  detailPct: number;
  gates: number;
  tempRmseC: number;
  precipRmseMm: number;
  itczRmseDeg: number;
  landMeanModelMm: number;
  landMeanObsMm: number;
}

export interface GateVerdict {
  pass: boolean;
  failures: string[];
}

export function evaluateRegression(
  m: RegressionMetrics,
  b: typeof REGRESSION_BASELINE = REGRESSION_BASELINE,
): GateVerdict {
  const failures: string[] = [];
  if (m.majorPct < b.majorPctMin) failures.push(`大分類一致率 ${m.majorPct.toFixed(2)}% < 基準 ${b.majorPctMin}%`);
  if (m.detailPct < b.detailPctMin) failures.push(`詳細一致率 ${m.detailPct.toFixed(2)}% < 基準 ${b.detailPctMin}%`);
  if (m.gates < b.gatesMin) failures.push(`地域ゲート ${m.gates} < 基準 ${b.gatesMin}`);
  if (m.tempRmseC > b.tempRmseMaxC) failures.push(`気温年 RMSE ${m.tempRmseC.toFixed(2)}°C > 基準 ${b.tempRmseMaxC}°C`);
  if (m.precipRmseMm > b.precipRmseMaxMm) failures.push(`降水年 RMSE ${Math.round(m.precipRmseMm)}mm > 基準 ${b.precipRmseMaxMm}mm`);
  if (m.itczRmseDeg > b.itczRmseMaxDeg) failures.push(`ITCZ 線 RMSE ${m.itczRmseDeg.toFixed(2)}° > 基準 ${b.itczRmseMaxDeg}°`);
  const ratio = m.landMeanModelMm / Math.max(1e-9, m.landMeanObsMm);
  if (ratio < b.landMeanRatioMin || ratio > b.landMeanRatioMax) {
    failures.push(`陸平均降水比 ${ratio.toFixed(3)} が [${b.landMeanRatioMin}, ${b.landMeanRatioMax}] の外`);
  }
  return { pass: failures.length === 0, failures };
}

// ---- 最終受入ゲート(docs/要件.md §6-1) ----
// 凍結日: 2026-07-31。根拠: 要件 §6-1 の文言を機械判定に落としたもの。
//   - 大分類 A〜E の陸面積比が観測 ±10 ポイント以内
//   - 代表地域の主要区分一致率 70% 以上(地域ゲート合格率で代理)
//   - 帯状平均気温(年・1月・7月)が観測 ±5°C 以内(「±5°C 程度」は厳密適用)
// §6-2(理想化大陸)と §6-3(退化条件)は別ハーネスで判定し、ここでは扱わない。
// 退行防止と異なり、未達でも終了コードは変えない(現状の正直な到達度報告)。
export const ACCEPTANCE_CRITERIA = {
  frozenAt: '2026-07-31',
  majorAreaGapMaxPt: 10,
  regionGatePassRateMin: 0.7,
  zonalTempAbsMaxC: 5,
} as const;

export interface AcceptanceMetrics {
  /** 大分類 A〜E の面積%差(モデル − 観測、ポイント) */
  majorAreaGapPt: number[];
  gatesPassed: number;
  gatesTotal: number;
  /** 帯状平均気温の |モデル − 観測|(°C)。年・1月・7月の全帯を平坦に並べる */
  zonalTempAbsDiffsC: number[];
}

export function evaluateAcceptance(
  m: AcceptanceMetrics,
  c: typeof ACCEPTANCE_CRITERIA = ACCEPTANCE_CRITERIA,
): GateVerdict {
  const failures: string[] = [];
  m.majorAreaGapPt.forEach((gap, k) => {
    if (Math.abs(gap) > c.majorAreaGapMaxPt) {
      failures.push(`大分類 ${'ABCDE'[k] ?? '?'} の面積差 ${gap.toFixed(1)}pt が ±${c.majorAreaGapMaxPt}pt の外`);
    }
  });
  const rate = m.gatesPassed / Math.max(1, m.gatesTotal);
  if (rate < c.regionGatePassRateMin) {
    failures.push(
      `地域ゲート合格率 ${(rate * 100).toFixed(0)}%(${m.gatesPassed}/${m.gatesTotal}) < ${c.regionGatePassRateMin * 100}%`,
    );
  }
  const worst = m.zonalTempAbsDiffsC.reduce((a, b) => Math.max(a, b), 0);
  if (worst > c.zonalTempAbsMaxC) {
    failures.push(`帯状平均気温の最大乖離 ${worst.toFixed(1)}°C > ±${c.zonalTempAbsMaxC}°C`);
  }
  return { pass: failures.length === 0, failures };
}
