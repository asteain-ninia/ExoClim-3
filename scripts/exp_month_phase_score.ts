// モデルの月別場を「暦月の位相」へ移してから採点し、成績がどう変わるかを測る。
//
// 問題(2026-08-01):
//   モデルの月 0 は北半球冬至(12/21 頃)開始。観測フィクスチャと Beck の
//   ケッペン図は暦月(1 月始まり)。約 11 日 = 0.355 か月の位相差があるのに、
//   採点は月 m 同士をそのまま比べている。
//   観測側を位相補正すると詳細分類が 7.4% 変わることは実測済み
//   (scripts/check_month_phase.ts)。つまり無視できる大きさではない。
//
// ここではモデル側を暦月位相へ移して採点し、**実際に成績が動くか**を見る。
// 動くなら採点の物差しを直す必要がある(較正の前に直すべき)。
//
// 位相移動は 12 点の離散フーリエで厳密に行う(線形補間だと年周成分の振幅が
// 3% 落ち、位相誤差と同程度の別の歪みを持ち込む)。
//
// 実行: npx tsx scripts/exp_month_phase_score.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { evaluateResult } from './optimize_lib';
import { openAccel } from './accel_cli';
import { computeKoppen } from '../src/sim/step07_koppen';
import type { PipelineResult } from '../src/sim/types';

/** モデル月の中心を暦月の目盛へ直す量(か月)。冬至 → 1/1 が 11 日 */
const SHIFT = 0.355;

/**
 * 12 点の周期系列を s か月ぶん進める(離散フーリエで厳密)。
 * 正の s は「時刻を s だけ遅らせて標本化する」= 系列を s だけ前へずらす。
 */
function fourierShift(series: Float32Array[], cellCount: number, s: number): Float32Array[] {
  const M = 12;
  const out: Float32Array[] = [];
  for (let m = 0; m < M; m++) out.push(new Float32Array(cellCount));
  const re = new Float64Array(M);
  const im = new Float64Array(M);
  const v = new Float64Array(M);
  for (let i = 0; i < cellCount; i++) {
    for (let m = 0; m < M; m++) v[m] = series[m]?.[i] ?? 0;
    // 前進変換
    for (let k = 0; k <= M / 2; k++) {
      let a = 0;
      let b = 0;
      for (let m = 0; m < M; m++) {
        const th = (2 * Math.PI * k * m) / M;
        a += (v[m] ?? 0) * Math.cos(th);
        b -= (v[m] ?? 0) * Math.sin(th);
      }
      re[k] = a;
      im[k] = b;
    }
    // 位相回転して逆変換(実数系列なので k と M-k は共役)
    for (let m = 0; m < M; m++) {
      let acc = re[0] ?? 0;
      for (let k = 1; k < M / 2; k++) {
        const th = (2 * Math.PI * k * (m + s)) / M;
        acc += 2 * ((re[k] ?? 0) * Math.cos(th) - (im[k] ?? 0) * Math.sin(th));
      }
      const kN = M / 2;
      acc += (re[kN] ?? 0) * Math.cos((2 * Math.PI * kN * (m + s)) / M);
      out[m]![i] = acc / M;
    }
  }
  return out;
}

const accel = await openAccel();
const base = await runPipeline(EARTH_PARAMS, accel.opts);
accel.close();

const N = base.context.grid.cellCount;
const s0 = evaluateResult(base);
console.log(
  `位相補正なし: 大分類 ${s0.majorPct.toFixed(2)} / 詳細 ${s0.detailPct.toFixed(2)} / ` +
    `ゲート ${s0.gates} / 気温RMSE ${s0.tempRmse.toFixed(3)} / fit ${s0.fitness.toFixed(2)}`,
);

// 恒等変換(s = 0)での往復誤差 — フーリエ移動の実装検査
{
  const t0 = fourierShift(base.temperature.monthlyTemperatureC, N, 0);
  let maxD = 0;
  for (let m = 0; m < 12; m++) {
    for (let i = 0; i < N; i++) {
      const d = Math.abs((t0[m]?.[i] ?? 0) - (base.temperature.monthlyTemperatureC[m]?.[i] ?? 0));
      if (d > maxD) maxD = d;
    }
  }
  console.log(`フーリエ移動の恒等検査(s=0): 最大誤差 ${maxD.toExponential(2)}°C`);
}

for (const s of [SHIFT, -SHIFT]) {
  const t = fourierShift(base.temperature.monthlyTemperatureC, N, s);
  const p = fourierShift(base.precipitation.monthlyPrecipMm, N, s);
  for (let m = 0; m < 12; m++) {
    const pm = p[m]!;
    for (let i = 0; i < N; i++) if ((pm[i] ?? 0) < 0) pm[i] = 0;
  }
  const annual = new Float32Array(N);
  for (let m = 0; m < 12; m++)
    for (let i = 0; i < N; i++) annual[i] = (annual[i] ?? 0) + (p[m]?.[i] ?? 0);
  const annualT = new Float32Array(N);
  for (let m = 0; m < 12; m++)
    for (let i = 0; i < N; i++) annualT[i] = (annualT[i] ?? 0) + (t[m]?.[i] ?? 0) / 12;

  const shifted: PipelineResult = {
    ...base,
    temperature: { ...base.temperature, monthlyTemperatureC: t, annualMeanC: annualT },
    precipitation: { ...base.precipitation, monthlyPrecipMm: p, annualPrecipMm: annual },
  };
  shifted.koppen = computeKoppen(base.context, shifted.temperature, shifted.precipitation);
  const s1 = evaluateResult(shifted);
  console.log(
    `位相 ${s >= 0 ? '+' : ''}${s.toFixed(3)} か月(${(s * 30.44).toFixed(1)} 日): ` +
      `大分類 ${s1.majorPct.toFixed(2)} / 詳細 ${s1.detailPct.toFixed(2)} / ` +
      `ゲート ${s1.gates} / 気温RMSE ${s1.tempRmse.toFixed(3)} / fit ${s1.fitness.toFixed(2)}`,
  );
}
console.log(
  '\n読み方: 片方向で成績が明確に上がるなら、採点の物差しに位相の歪みがある。\n' +
    '両方向とも下がるなら、現行の対応付けが最良で、位相補正は不要。',
);
