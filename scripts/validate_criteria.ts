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

// ---- 数値的健全性ゲート(2026-08-02 追加、常に強制)----
// **これだけは必ず非零終了にする**。スコアの上下と違い、
// 「解けていない」「保存していない」は改善でも探索でもなく、ただの誤りだから。
//
// 経緯: 2026-08-02 に EBM の数値欠陥が 3 件見つかり、いずれも較正が
// その誤差を打ち消す向きに物理係数を決めていた(反復 8 回打ち切り、
// 界面のエネルギー非保存、緩和 2 年)。
// **未収束は歴史的に成績をよく見せる方向に働く**ので、
// スコアの門より先にここを締める。
export const NUMERICAL_GATES = {
  frozenAt: '2026-08-02',
  /** EBM の線形解の残差(°C)。src/sim/step05_temperature.ts と同じ値 */
  ebmSolveToleranceC: 1e-3,
  /** EBM の年次ドリフト(°C、面積重み平均)。周期定常への到達 */
  ebmPeriodicToleranceC: 0.05,
} as const;

export interface NumericalMetrics {
  /** EBM の全ステップ最大残差 °C */
  ebmMaxResidualC: number;
  /** EBM の年次ドリフト(面積重み平均)°C */
  ebmMeanYearDriftC: number;
  /** 降水の結合反復が収束したか */
  precipCouplingConverged: boolean;
  /** 土壌の空回しが収束したか(無効時は true) */
  soilConverged: boolean;
  /**
   * 保存型の水蒸気輸送で収束しなかった月の数(非保存のときは 0)。
   * **未収束を黙って採点しない**ための門。2026-08-09 の段 1 で、既定の
   * 反復上限 4000 では 84 か月分が未収束のまま成績が出ていた。
   * EBM で 3 回踏んだ「上限が答えを決める」型の欠陥と同じなので、
   * ここを通らない解は採点そのものを無効にする。
   */
  moistureTransportNonConverged?: number;
  /** virga の外側反復が収束しなかった月の数(無効時は 0) */
  virgaNonConverged?: number;
}

export function evaluateNumericalSoundness(
  m: NumericalMetrics,
  g: typeof NUMERICAL_GATES = NUMERICAL_GATES,
): GateVerdict {
  const failures = nonFiniteFailures([
    ['EBM 最大残差', m.ebmMaxResidualC],
    ['EBM 年次ドリフト', m.ebmMeanYearDriftC],
  ]);
  if (m.ebmMaxResidualC > g.ebmSolveToleranceC) {
    failures.push(
      `EBM の線形解が未収束(残差 ${m.ebmMaxResidualC.toExponential(2)}°C > 許容 ${g.ebmSolveToleranceC}）`,
    );
  }
  if (m.ebmMeanYearDriftC > g.ebmPeriodicToleranceC) {
    failures.push(
      `EBM が周期定常に未到達(年次ドリフト ${m.ebmMeanYearDriftC.toExponential(2)}°C > 許容 ${g.ebmPeriodicToleranceC}）`,
    );
  }
  if (!m.precipCouplingConverged) failures.push('降水の結合反復が未収束');
  if (!m.soilConverged) failures.push('土壌の空回しが未収束');
  if ((m.moistureTransportNonConverged ?? 0) > 0) {
    failures.push(`保存型の水蒸気輸送が未収束(${m.moistureTransportNonConverged} か月)`);
  }
  if ((m.virgaNonConverged ?? 0) > 0) {
    failures.push(`雲底下再蒸発の外側反復が未収束(${m.virgaNonConverged} か月)`);
  }
  return { pass: failures.length === 0, failures };
}

// ---- スコアの参照値(退行の**検知**用。単独では非零終了にしない)----
// 凍結日: 2026-07-31。根拠: v2 採用モデルの実測値。
//
// **2026-08-02 の方針変更(利用者の指示)**:
//   「意味のある退行と、そうでない退行を区別したい。数値的欠陥の修正、
//     物理構造の改善、局所解からの脱出に伴う一時的なスコア低下は、
//     恐れるべき退行ではない。」
// したがってスコアの低下は**報告するが自動では落とさない**。
// 落とすのは上の数値的健全性ゲートだけ。
// 最終的な採否は、数値的健全性・新旧両目的関数・季節指標・地域ゲート・
// 未見評価を総合して人が判断する(docs/退行防止ゲートの扱い_2026-08-02.md)。
//
// なお下の値は**欠陥のあるモデル**を指している(反復 8 回打ち切り・
// 界面の非保存・緩和 2 年)。再較正後に貼り直す。
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
  if (m.majorPct < b.majorPctMin)
    failures.push(`大分類一致率 ${m.majorPct.toFixed(2)}% < 基準 ${b.majorPctMin}%`);
  if (m.detailPct < b.detailPctMin)
    failures.push(`詳細一致率 ${m.detailPct.toFixed(2)}% < 基準 ${b.detailPctMin}%`);
  if (m.gates < b.gatesMin) failures.push(`地域ゲート ${m.gates} < 基準 ${b.gatesMin}`);
  if (m.tempRmseC > b.tempRmseMaxC)
    failures.push(`気温年 RMSE ${m.tempRmseC.toFixed(2)}°C > 基準 ${b.tempRmseMaxC}°C`);
  if (m.precipRmseMm > b.precipRmseMaxMm)
    failures.push(`降水年 RMSE ${Math.round(m.precipRmseMm)}mm > 基準 ${b.precipRmseMaxMm}mm`);
  if (m.itczRmseDeg > b.itczRmseMaxDeg)
    failures.push(`ITCZ 線 RMSE ${m.itczRmseDeg.toFixed(2)}° > 基準 ${b.itczRmseMaxDeg}°`);
  const ratio = m.landMeanModelMm / Math.max(1e-9, m.landMeanObsMm);
  if (!Number.isFinite(ratio) || ratio < b.landMeanRatioMin || ratio > b.landMeanRatioMax) {
    failures.push(
      `陸平均降水比 ${ratio.toFixed(3)} が [${b.landMeanRatioMin}, ${b.landMeanRatioMax}] の外`,
    );
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
    failures.push(
      `地域ゲート合格数 ${String(m.gatesPassed)} が非負整数でない — 判定不能として FAIL`,
    );
  }
  if (
    Number.isInteger(m.gatesPassed) &&
    Number.isInteger(m.gatesTotal) &&
    m.gatesPassed > m.gatesTotal
  ) {
    failures.push(`地域ゲート合格数 ${m.gatesPassed} > 総数 ${m.gatesTotal} — 不正`);
  }
  if (m.majorAreaGapPt.length === 0) failures.push('大分類面積差の配列が空 — 判定不能として FAIL');
  if (m.zonalTempAbsDiffsC.length === 0)
    failures.push('帯状気温差の配列が空 — 判定不能として FAIL');
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
      failures.push(
        `大分類 ${'ABCDE'[k] ?? '?'} の面積差 ${gap.toFixed(1)}pt が ±${c.majorAreaGapMaxPt}pt の外`,
      );
    }
  });
  const worst = m.zonalTempAbsDiffsC.reduce((a, b) => Math.max(a, b), 0);
  if (worst > c.zonalTempAbsMaxC) {
    failures.push(`帯状平均気温の最大乖離 ${worst.toFixed(1)}°C > ±${c.zonalTempAbsMaxC}°C`);
  }
  return { pass: failures.length === 0, failures };
}
