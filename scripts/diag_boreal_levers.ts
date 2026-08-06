// 診断: 冷帯の夏(+5°C)を実際に動かせる定数はどれか。感度を総当たりで測る。
//
// 対応 spec: なし(原因の切り分け)。R1 の続き。
//
// なぜ要るか(2026-08-07):
//   蒸発帰還(∂LE/∂T を対角へ)は事前登録の主判定に届かなかった。
//   理由は着想の側にある: **k·(T − T_ref) は「前パスの気温へ引き戻す」項**で、
//   外側の反復が収束すれば T → T_ref となって消える。**冷やす項ではない。**
//   陽的な冷却の**大きさ**(係数 4 対 物理値 28.4)が本命だった可能性が高い。
//
//   ここでは推測をやめ、**どの定数が冷帯の夏を動かすか**を実測で並べる。
//   動かないものが分かれば、そこに時間を使わずに済む(陸の熱容量で学んだこと)。
//
//   指標は borealMetrics の 50〜60°N の最暖月ずれ(現在 +5.38°C)。
//   各定数を +12% 動かして 1 回ずつ回す(較正の降下と同じ振り幅)。
//
// 実行: npx tsx scripts/diag_boreal_levers.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { evaluateResult } from './optimize_lib';
import { borealMetrics } from './boreal_metrics';
import { openAccel } from './accel_cli';

/** 触る定数と、動かす向き。+12% は較正の降下と同じ振り幅 */
const LEVERS: string[] = [
  // 移流結合(陸の気温を支配していると分かっている系統)
  'zonalAdvectionCouplingWm2PerK',
  'summerAdvectionFactor',
  // 地表の熱収支
  'evapCoolingWm2PerMmDay',
  'olrBWm2PerC',
  'albedoLand',
  // 雲(夏の大陸の日射を削る候補)
  'cloudAlbedoMax',
  'convectiveCloudBoost',
  'stormCloudSummerOcean',
  // 拡散
  'diffusionWm2PerK',
  'hadleyDiffusionBoost',
  // 対照: 効かないと分かっているもの / 冬にしか効かないもの
  'landEffectiveWaterDepthM',
  'winterInversionDiffusionFactor',
];

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const original: Record<string, number> = {};
  for (const k of LEVERS) original[k] = K[k]!;

  const accel = await openAccel();
  try {
    const base = await runPipeline(EARTH_PARAMS, accel.opts);
    const b0 = borealMetrics(base);
    const s0 = evaluateResult(base);
    console.log(
      `基準: 50〜60°N の最暖月ずれ ${b0.dTmaxByBand[50]!.toFixed(2)}°C  ` +
        `文字一致 ${b0.letterHitPct.toFixed(1)}%  v3=${s0.fitness.toFixed(3)}\n`,
    );
    console.log('定数                              値 → +12%      50-60N の変化   文字   v3');

    const rows: Array<{ name: string; d50: number; letter: number; fit: number }> = [];
    for (const name of LEVERS) {
      const v0 = original[name]!;
      K[name] = v0 * 1.12;
      const r = await runPipeline(EARTH_PARAMS, accel.opts);
      const b = borealMetrics(r);
      const s = evaluateResult(r);
      K[name] = v0;
      const d = b.dTmaxByBand[50]! - b0.dTmaxByBand[50]!;
      rows.push({ name, d50: d, letter: b.letterHitPct - b0.letterHitPct, fit: s.fitness - s0.fitness });
      console.log(
        `${name.padEnd(32)} ${v0.toFixed(3).padStart(7)} → ${(v0 * 1.12).toFixed(3).padStart(7)}   ` +
          `${(d >= 0 ? '+' : '') + d.toFixed(3)}°C        ` +
          `${(b.letterHitPct - b0.letterHitPct >= 0 ? '+' : '') + (b.letterHitPct - b0.letterHitPct).toFixed(1)}   ` +
          `${(s.fitness - s0.fitness >= 0 ? '+' : '') + (s.fitness - s0.fitness).toFixed(3)}`,
      );
    }

    console.log('\n夏を冷やす向きに効く順(負が大きいほど有望)');
    for (const r of [...rows].sort((a, b) => a.d50 - b.d50)) {
      console.log(
        `  ${r.name.padEnd(32)} ${(r.d50 >= 0 ? '+' : '') + r.d50.toFixed(3)}°C   ` +
          `(v3 ${(r.fit >= 0 ? '+' : '') + r.fit.toFixed(3)})`,
      );
    }
    console.log(
      '\n注: 符号が逆の定数は「減らす」側が有望。' +
        'v3 が大きく下がるものは単独では使えないので、較正で他と釣り合わせる必要がある。',
    );
  } finally {
    accel.close();
  }
}

void main();
