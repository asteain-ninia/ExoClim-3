// パイプライン: Step 1〜7 を順に実行する純粋関数。docs/要件.md §3
// 部分再計算のキャッシュはワーカー層の責務(この関数は常に全段を計算する)。
// P1-4 + 変更レビュー FB P2-1: 物理計算(runPipelineCore)は時計 API を一切
// 読まない。時刻を読むのは runPipelineTimed の計測側だけで、runPipeline の
// 呼出経路には performance.now() が存在しない(時計 API の無い環境でも動く)。

import type { PlanetParams } from '@/domain/planetParams';
import { buildSimContext } from './context';
import { computeItcz } from './step01_itcz';
import { computeWindBelt } from './step02_windbelt';
import { computeOceanCurrent } from './step03_ocean';
import { computeAirflow } from './step04_airflow';
import { computeTemperature } from './step05_temperature';
import { computePrecipitation } from './step06_precipitation';
import { computeKoppen } from './step07_koppen';
import type { PipelineResult } from './types';
import { MODEL_CONSTANTS } from './constants';
import { assertComputableInputs, buildDiagnostics } from './diagnostics';

/** 区間計測フック。物理側は時計を読まず、計測側だけがこの中で時刻を扱う */
type SectionTimer = <T>(label: string, fn: () => T) => T;

const noTimer: SectionTimer = (_label, fn) => fn();

/** 物理結果のみ(決定的)。計測が要る場合は runPipelineTimed を使う */
export function runPipeline(params: PlanetParams): PipelineResult {
  return runPipelineCore(params, noTimer);
}

/** 物理結果 + ステップ別所要時間(計測は時刻依存 — 物理結果には含めない) */
export function runPipelineTimed(params: PlanetParams): {
  result: PipelineResult;
  stepTimingsMs: Record<string, number>;
} {
  const timings: Record<string, number> = {};
  const timer: SectionTimer = (label, fn) => {
    const t0 = performance.now();
    const out = fn();
    timings[label] = Math.round(performance.now() - t0);
    return out;
  };
  return { result: runPipelineCore(params, timer), stepTimingsMs: timings };
}

function runPipelineCore(params: PlanetParams, time: SectionTimer): PipelineResult {
  // 事前検査(変更レビュー FB): 計算不能な入力は配列確保・反復の前に明示エラー
  assertComputableInputs(params);

  const context = time('context', () => buildSimContext(params));

  // ---- プレパス: 半球間 SST 非対称 → ITCZ の北偏オフセット ----
  // 実物の ITCZ は暖かい半球へ寄る(~3°/K)。海流場(周極海峡で切られる
  // 南半球 vs 暖流ドリフトの北半球)が持つ非対称を測り、線に恒常オフセットを
  // 与える。ステップ 1-3 のプレパスは計 ~150ms(ストリームライン含む)
  const hemisOffsetDeg = time('step0_hemis', () => {
    if (MODEL_CONSTANTS.itczHemisOffsetPerC <= 0) return 0;
    const itcz0 = computeItcz(context);
    const wb0 = computeWindBelt(context, itcz0);
    const ocean0 = computeOceanCurrent(context, itcz0, wb0);
    const grid = context.grid;
    let nSum = 0;
    let nW = 0;
    let sSum = 0;
    let sW = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5) * grid.resolutionDeg;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (context.terrain.landMask[i]) continue;
        const a = ocean0.sstAnomalyC[i] ?? 0;
        if (lat >= 0) {
          nSum += w * a;
          nW += w;
        } else {
          sSum += w * a;
          sW += w;
        }
      }
    }
    const deltaC = (nW > 0 ? nSum / nW : 0) - (sW > 0 ? sSum / sW : 0);
    return Math.max(-6, Math.min(6, MODEL_CONSTANTS.itczHemisOffsetPerC * deltaC));
  });

  const itcz = time('step1_itcz', () => computeItcz(context, hemisOffsetDeg));
  const windBelt = time('step2_windbelt', () => computeWindBelt(context, itcz));
  const ocean = time('step3_ocean', () => computeOceanCurrent(context, itcz, windBelt));
  const airflow = time('step4_airflow', () => computeAirflow(context, itcz, windBelt));
  const temperature1 = time('step5_temperature', () =>
    computeTemperature(context, itcz, windBelt, ocean, airflow),
  );
  const precipitation1 = time('step6_precipitation', () =>
    computePrecipitation(context, itcz, windBelt, ocean, airflow, temperature1),
  );

  // ---- 蒸発冷却フィードバック(降水 → 気温 → 降水の 2 パス目)----
  // 湿った陸は潜熱で冷え、乾いた陸は乾熱で暑い(実在の砂漠の暑さ)。
  // 注(2026-08-01): 係数 12/6 とも実測否定 — 現状はモデル自身の降水誤差が
  // 温度誤差へ増幅される(誤差の正帰還)。降水場の成熟後に再訪(較正記録)。
  // 係数 0 のときは 2 パス目を丸ごとスキップする
  let temperature = temperature1;
  let precipitation = precipitation1;
  if (MODEL_CONSTANTS.evapCoolingWm2PerMmDay > 0) {
    temperature = time('step5b_temperature', () =>
      computeTemperature(context, itcz, windBelt, ocean, airflow, precipitation1),
    );
    precipitation = time('step6b_precipitation', () =>
      computePrecipitation(context, itcz, windBelt, ocean, airflow, temperature),
    );
  }

  const koppen = time('step7_koppen', () => computeKoppen(context, temperature, precipitation));

  // P1-3: 適用範囲診断。範囲外は値を切り詰めず「判定不能」を宣言する
  const diagnostics = buildDiagnostics(params, temperature, precipitation);

  return {
    context,
    itcz,
    windBelt,
    ocean,
    airflow,
    temperature,
    precipitation,
    koppen,
    diagnostics,
  };
}
