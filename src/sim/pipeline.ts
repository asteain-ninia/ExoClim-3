// パイプライン: Step 1〜7 を順に実行する純粋関数。docs/要件.md §3
// 部分再計算のキャッシュはワーカー層の責務(この関数は常に全段を計算する)。

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
import { buildDiagnostics } from './diagnostics';

export function runPipeline(params: PlanetParams): PipelineResult {
  const timings: Record<string, number> = {};
  const mark = (label: string, start: number) => {
    timings[label] = Math.round(performance.now() - start);
  };

  let t0 = performance.now();
  const context = buildSimContext(params);
  mark('context', t0);

  // ---- プレパス: 半球間 SST 非対称 → ITCZ の北偏オフセット ----
  // 実物の ITCZ は暖かい半球へ寄る(~3°/K)。海流場(周極海峡で切られる
  // 南半球 vs 暖流ドリフトの北半球)が持つ非対称を測り、線に恒常オフセットを
  // 与える。ステップ 1-3 のプレパスは計 ~150ms(ストリームライン含む)
  t0 = performance.now();
  let hemisOffsetDeg = 0;
  if (MODEL_CONSTANTS.itczHemisOffsetPerC > 0) {
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
    hemisOffsetDeg = Math.max(-6, Math.min(6, MODEL_CONSTANTS.itczHemisOffsetPerC * deltaC));
  }
  mark('step0_hemis', t0);

  t0 = performance.now();
  const itcz = computeItcz(context, hemisOffsetDeg);
  mark('step1_itcz', t0);

  t0 = performance.now();
  const windBelt = computeWindBelt(context, itcz);
  mark('step2_windbelt', t0);

  t0 = performance.now();
  const ocean = computeOceanCurrent(context, itcz, windBelt);
  mark('step3_ocean', t0);

  t0 = performance.now();
  const airflow = computeAirflow(context, itcz, windBelt);
  mark('step4_airflow', t0);

  t0 = performance.now();
  const temperature1 = computeTemperature(context, itcz, windBelt, ocean, airflow);
  mark('step5_temperature', t0);

  t0 = performance.now();
  const precipitation1 = computePrecipitation(context, itcz, windBelt, ocean, airflow, temperature1);
  mark('step6_precipitation', t0);

  // ---- 蒸発冷却フィードバック(降水 → 気温 → 降水の 2 パス目)----
  // 湿った陸は潜熱で冷え、乾いた陸は乾熱で暑い(実在の砂漠の暑さ)。
  // 注(2026-08-01): 係数 12/6 とも実測否定 — 現状はモデル自身の降水誤差が
  // 温度誤差へ増幅される(誤差の正帰還)。降水場の成熟後に再訪(較正記録)。
  // 係数 0 のときは 2 パス目を丸ごとスキップする
  let temperature = temperature1;
  let precipitation = precipitation1;
  if (MODEL_CONSTANTS.evapCoolingWm2PerMmDay > 0) {
    t0 = performance.now();
    temperature = computeTemperature(context, itcz, windBelt, ocean, airflow, precipitation1);
    mark('step5b_temperature', t0);

    t0 = performance.now();
    precipitation = computePrecipitation(context, itcz, windBelt, ocean, airflow, temperature);
    mark('step6b_precipitation', t0);
  }

  t0 = performance.now();
  const koppen = computeKoppen(context, temperature, precipitation);
  mark('step7_koppen', t0);

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
    stepTimingsMs: timings,
  };
}
