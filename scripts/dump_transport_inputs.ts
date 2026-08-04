// 保存型水蒸気輸送の実験に要る場を**一度だけ**書き出す。
//
// 対応 spec: なし(実験の足回り)。
//
// なぜ要るか: 輸送ソルバ自体は純粋な CPU 計算だが、入力(風・気温・実蒸発散・
// 持上げ倍率)を得るにはパイプラインを回す必要があり、そこが GPU を使う。
// 較正が走っている間は GPU を取り合ってどちらも遅くなるので、**入力を一度
// 書き出して、以後の反復実験は CPU だけで回す**。
//
// 出力: out/exp/transport_inputs.bin(Float32 の生配列)+ .json(見出し)
//
// 実行: npx tsx scripts/dump_transport_inputs.ts [パラメータJSON]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { openAccel } from './accel_cli';

const PARAM_PATH = process.argv[2];
const MONTHS = 12;
const OUT_DIR = 'out/exp';

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`パラメータ: ${PARAM_PATH}`);
  }
  // 陸面 ET を返させるため 2 パスを起こす(物理は変えない値)
  (MODEL_CONSTANTS as unknown as Record<string, number>).landDryCapacityFrac = 0.999;

  const accel = await openAccel();
  const { result, precipDiag: d } = await (async () => {
    try {
      return await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
  })();

  const grid = result.context.grid;
  const N = grid.cellCount;
  const et = result.precipitation.land?.monthlyEtMm;
  if (!et) throw new Error('陸面 ET が取れていない');

  // 月ごとに 5 面: 風 u / 風 v / 気温 / 実蒸発散 / 持上げ倍率の積
  const FIELDS = 5;
  const blob = new Float32Array(MONTHS * FIELDS * N);
  for (let m = 0; m < MONTHS; m++) {
    const base = m * FIELDS * N;
    blob.set(result.airflow.monthlyWindU[m]!, base);
    blob.set(result.airflow.monthlyWindV[m]!, base + N);
    blob.set(result.temperature.monthlyTemperatureC[m]!, base + 2 * N);
    blob.set(et[m]!, base + 3 * N);
    const g = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      g[i] =
        (d.liftItcz[m]?.[i] ?? 1) *
        (d.liftFrontal[m]?.[i] ?? 1) *
        (d.liftOrographic[m]?.[i] ?? 1) *
        (d.liftConvergence[m]?.[i] ?? 1) *
        (d.subsidenceResidual[m]?.[i] ?? 1) *
        (d.upwindBlock[m]?.[i] ?? 1) *
        (d.liftOther[m]?.[i] ?? 1);
    }
    blob.set(g, base + 4 * N);
  }
  // 月に依らない面: 陸マスク / 現行の月別降水(比較の基準)
  const landF = new Float32Array(N);
  for (let i = 0; i < N; i++) landF[i] = result.context.terrain.landMask[i] ? 1 : 0;
  const precip = new Float32Array(MONTHS * N);
  for (let m = 0; m < MONTHS; m++) precip.set(result.precipitation.monthlyPrecipMm[m]!, m * N);
  const tempAll = new Float32Array(MONTHS * N);
  for (let m = 0; m < MONTHS; m++) tempAll.set(result.temperature.monthlyTemperatureC[m]!, m * N);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const all = new Float32Array(blob.length + N + precip.length + tempAll.length);
  all.set(blob, 0);
  all.set(landF, blob.length);
  all.set(precip, blob.length + N);
  all.set(tempAll, blob.length + N + precip.length);
  fs.writeFileSync(path.join(OUT_DIR, 'transport_inputs.bin'), Buffer.from(all.buffer));
  fs.writeFileSync(
    path.join(OUT_DIR, 'transport_inputs.json'),
    JSON.stringify(
      {
        paramPath: PARAM_PATH ?? null,
        widthCells: grid.widthCells,
        heightCells: grid.heightCells,
        cellCount: N,
        resolutionDeg: grid.resolutionDeg,
        radiusKm: result.context.params.body.radiusKm,
        months: MONTHS,
        // 面の並び(月ごとに 5 面 → 陸マスク → 現行降水 12 面 → 気温 12 面)
        layout: ['windU', 'windV', 'tempC', 'etMm', 'liftProduct'],
        offsets: {
          monthly: 0,
          landMask: blob.length,
          precipMm: blob.length + N,
          tempMonthly: blob.length + N + precip.length,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    `書き出し: ${OUT_DIR}/transport_inputs.bin (${(all.byteLength / 1e6).toFixed(1)} MB)`,
  );
}

void main();
