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

export function runPipeline(params: PlanetParams): PipelineResult {
  const timings: Record<string, number> = {};
  const mark = (label: string, start: number) => {
    timings[label] = Math.round(performance.now() - start);
  };

  let t0 = performance.now();
  const context = buildSimContext(params);
  mark('context', t0);

  t0 = performance.now();
  const itcz = computeItcz(context);
  mark('step1_itcz', t0);

  t0 = performance.now();
  const windBelt = computeWindBelt(context, itcz);
  mark('step2_windbelt', t0);

  t0 = performance.now();
  const ocean = computeOceanCurrent(context);
  mark('step3_ocean', t0);

  t0 = performance.now();
  const airflow = computeAirflow(context, itcz, windBelt);
  mark('step4_airflow', t0);

  t0 = performance.now();
  const temperature = computeTemperature(context, itcz, windBelt, ocean);
  mark('step5_temperature', t0);

  t0 = performance.now();
  const precipitation = computePrecipitation(context, itcz, windBelt, ocean, airflow, temperature);
  mark('step6_precipitation', t0);

  t0 = performance.now();
  const koppen = computeKoppen(context, temperature, precipitation);
  mark('step7_koppen', t0);

  return {
    context,
    itcz,
    windBelt,
    ocean,
    airflow,
    temperature,
    precipitation,
    koppen,
    stepTimingsMs: timings,
  };
}
