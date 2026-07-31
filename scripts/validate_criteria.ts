// 検証の合否基準の単一定義(FB 2026-07-31 P0-4 / 変更レビュー FB P0-2, P0-3)。
// 三段階を明示的に分離する(混同しない):
//   1. 退行防止ゲート — 凍結基準からの数値退行を検知(CI 用、非零終了)
//   2. 途中目標     — 要件 §6-1 の「地域ゲート 70% 以上」(較正の道標)
//   3. 最終受入     — 教訓 §8「地域ゲートは全部通って初めて採用」= 17/17 +
//                      大分類面積 ±10pt + 帯状気温 ±5°C
// 閾値は結果を見て緩めない(教訓 §8.3)。変更時は凍結日と根拠を更新する。
// 全判定は非有限値(NaN/±Infinity)・不正構造に対して閉じている:
// 壊れた採点は必ず FAIL(変更レビュー FB P0-2 — NaN は大小比較が全て false に
// なるため、素通りで PASS してしまう JavaScript の罠への対処)。

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

/** 非有限値の検査(P0-2)。1 件でもあれば合否は必ず FAIL */
function nonFiniteFailures(pairs: Array<[string, number]>): string[] {
  const out: string[] = [];
  for (const [label, v] of pairs) {
    if (!Number.isFinite(v)) out.push(`${label} が非有限値(${String(v)})— 判定不能として FAIL`);
  }
  return out;
}

export function evaluateRegression(
  m: RegressionMetrics,
  b: typeof REGRESSION_BASELINE = REGRESSION_BASELINE,
): GateVerdict {
  const failures = nonFiniteFailures([
    ['大分類一致率', m.majorPct],
    ['詳細一致率', m.detailPct],
    ['地域ゲート数', m.gates],
    ['気温年 RMSE', m.tempRmseC],
    ['降水年 RMSE', m.precipRmseMm],
    ['ITCZ 線 RMSE', m.itczRmseDeg],
    ['陸平均降水(モデル)', m.landMeanModelMm],
    ['陸平均降水(観測)', m.landMeanObsMm],
  ]);
  if (failures.length > 0) return { pass: false, failures };
  if (m.majorPct < b.majorPctMin) failures.push(`大分類一致率 ${m.majorPct.toFixed(2)}% < 基準 ${b.majorPctMin}%`);
  if (m.detailPct < b.detailPctMin) failures.push(`詳細一致率 ${m.detailPct.toFixed(2)}% < 基準 ${b.detailPctMin}%`);
  if (m.gates < b.gatesMin) failures.push(`地域ゲート ${m.gates} < 基準 ${b.gatesMin}`);
  if (m.tempRmseC > b.tempRmseMaxC) failures.push(`気温年 RMSE ${m.tempRmseC.toFixed(2)}°C > 基準 ${b.tempRmseMaxC}°C`);
  if (m.precipRmseMm > b.precipRmseMaxMm) failures.push(`降水年 RMSE ${Math.round(m.precipRmseMm)}mm > 基準 ${b.precipRmseMaxMm}mm`);
  if (m.itczRmseDeg > b.itczRmseMaxDeg) failures.push(`ITCZ 線 RMSE ${m.itczRmseDeg.toFixed(2)}° > 基準 ${b.itczRmseMaxDeg}°`);
  const ratio = m.landMeanModelMm / Math.max(1e-9, m.landMeanObsMm);
  if (!Number.isFinite(ratio) || ratio < b.landMeanRatioMin || ratio > b.landMeanRatioMax) {
    failures.push(`陸平均降水比 ${ratio.toFixed(3)} が [${b.landMeanRatioMin}, ${b.landMeanRatioMax}] の外`);
  }
  return { pass: failures.length === 0, failures };
}

// ---- 途中目標と最終受入(要件 §6-1・教訓 §8) ----
// 凍結日: 2026-07-31(三段階分離は変更レビュー FB P0-3 で同日改定)。
//   途中目標: 地域ゲート 70% 以上(要件 §6-1 の文言 — 較正の進捗確認用)
//   最終受入: 地域ゲート 17/17(教訓 §8「全部通って初めて採用」)+
//             大分類 A〜E の面積比 ±10pt + 帯状平均気温(年・1月・7月)±5°C
// §6-2(理想化大陸)と §6-3(退化条件)は別ハーネスで判定し、ここでは扱わない。
// いずれも未達でも終了コードは変えない(現状の正直な到達度報告)。
export const ACCEPTANCE_CRITERIA = {
  frozenAt: '2026-07-31',
  interimRegionGatePassRateMin: 0.7,
  majorAreaGapMaxPt: 10,
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

/** 構造・非有限の検査(P0-2)。合否計算の前提が壊れていれば必ず FAIL */
function structuralFailures(m: AcceptanceMetrics): string[] {
  const failures: string[] = [];
  if (!Number.isInteger(m.gatesTotal) || m.gatesTotal <= 0) {
    failures.push(`地域ゲート総数 ${String(m.gatesTotal)} が正の整数でない — 判定不能として FAIL`);
  }
  if (!Number.isInteger(m.gatesPassed) || m.gatesPassed < 0) {
    failures.push(`地域ゲート合格数 ${String(m.gatesPassed)} が非負整数でない — 判定不能として FAIL`);
  }
  if (
    Number.isInteger(m.gatesPassed) &&
    Number.isInteger(m.gatesTotal) &&
    m.gatesPassed > m.gatesTotal
  ) {
    failures.push(`地域ゲート合格数 ${m.gatesPassed} > 総数 ${m.gatesTotal} — 不正`);
  }
  if (m.majorAreaGapPt.length === 0) failures.push('大分類面積差の配列が空 — 判定不能として FAIL');
  if (m.zonalTempAbsDiffsC.length === 0) failures.push('帯状気温差の配列が空 — 判定不能として FAIL');
  failures.push(
    ...nonFiniteFailures([
      ...m.majorAreaGapPt.map((v, k): [string, number] => [`大分類面積差[${'ABCDE'[k] ?? k}]`, v]),
      ...m.zonalTempAbsDiffsC.map((v, k): [string, number] => [`帯状気温差[${k}]`, v]),
    ]),
  );
  return failures;
}

/** 途中目標(要件 §6-1 の 70%)。最終受入とは別の判定 */
export function evaluateInterimTarget(
  m: AcceptanceMetrics,
  c: typeof ACCEPTANCE_CRITERIA = ACCEPTANCE_CRITERIA,
): GateVerdict {
  const failures = structuralFailures(m);
  if (failures.length > 0) return { pass: false, failures };
  const rate = m.gatesPassed / m.gatesTotal;
  if (rate < c.interimRegionGatePassRateMin) {
    failures.push(
      `地域ゲート合格率 ${(rate * 100).toFixed(0)}%(${m.gatesPassed}/${m.gatesTotal}) < 途中目標 ${c.interimRegionGatePassRateMin * 100}%`,
    );
  }
  return { pass: failures.length === 0, failures };
}

/** 最終受入。地域ゲートは全件必須(教訓 §8 — 14/17 も 16/17 も FAIL) */
export function evaluateAcceptance(
  m: AcceptanceMetrics,
  c: typeof ACCEPTANCE_CRITERIA = ACCEPTANCE_CRITERIA,
): GateVerdict {
  const failures = structuralFailures(m);
  if (failures.length > 0) return { pass: false, failures };
  if (m.gatesPassed !== m.gatesTotal) {
    failures.push(`地域ゲート ${m.gatesPassed}/${m.gatesTotal} — 最終受入は全件 PASS が必要`);
  }
  m.majorAreaGapPt.forEach((gap, k) => {
    if (Math.abs(gap) > c.majorAreaGapMaxPt) {
      failures.push(`大分類 ${'ABCDE'[k] ?? '?'} の面積差 ${gap.toFixed(1)}pt が ±${c.majorAreaGapMaxPt}pt の外`);
    }
  });
  const worst = m.zonalTempAbsDiffsC.reduce((a, b) => Math.max(a, b), 0);
  if (worst > c.zonalTempAbsMaxC) {
    failures.push(`帯状平均気温の最大乖離 ${worst.toFixed(1)}°C > ±${c.zonalTempAbsMaxC}°C`);
  }
  return { pass: failures.length === 0, failures };
}
