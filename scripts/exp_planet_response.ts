// 実験: 惑星パラメータの応答表 — **地球では現れない壊れ方**を測る。
//
// 対応 spec: docs/計画_保存則の段階的置換_2026-08-09.md
// 動機(外部レビュー 2 件が独立に指摘、2026-08-09):
//   本ツールの本題は架空の惑星であって、地球は検証の 1 例にすぎない。
//   ところが地球はモデルにとって**恒等変換**(較正はすべて地球で行われた)なので、
//   「気圧を 2 倍にしたら降水はどう動くべきか」は成績に一切現れない。
//   応答が壊れていても 75% は出る。
//
// 保存型への移行でこれが実務問題になった。非保存では P ∝ √(気圧) という
// 降水効率の項が直接効いていたが、保存型ではその項が凝結率へ入らず、
// 気圧は**源泉の飽和比湿 q_s(T,p) を通じてのみ**効く。
// どちらが正しいかは地球の成績では決められない。**応答を測って比べる。**
//
// 何を出すか(各軸・各水準で):
//   閉包 (P−E)/E     … 保存型なら 0 のはず。**軸を振っても 0 のままか**
//   全球平均気温
//   陸平均降水
//   大分類の面積割合 A/B/C/D/E … 気候帯の分布がどちらへ動くか
//
// **判定基準は置かない。** 観測が無いので正解が無い。
// 目的は「保存型と非保存で応答の符号・桁が違うか」を記録に残すこと。
// 符号が違えば、少なくとも片方は架空惑星で嘘をつく。
//
// 実行: npx tsx scripts/exp_planet_response.ts [軸,軸,...]
//       軸: pressure | tilt | rotation | luminosity | radius | all
//       既定は pressure（保存型への移行で直接争点になっている軸）

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS, type PlanetParams } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { computeOceanEvaporation } from '../src/sim/evaporation';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { majorClassOf, type KoppenClassId } from '../src/domain/koppen';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

interface Level {
  label: string;
  make: (p: PlanetParams) => PlanetParams;
}

const AXES: Record<string, Level[]> = {
  pressure: [0.5, 1.0, 2.0].map((v) => ({
    label: `気圧 ${v.toFixed(1)} bar`,
    make: (p) => ({ ...p, atmosphere: { ...p.atmosphere, surfacePressureBar: v } }),
  })),
  tilt: [0, 23.44, 45].map((v) => ({
    label: `傾斜 ${v.toFixed(1)}°`,
    make: (p) => ({ ...p, body: { ...p.body, axialTiltDeg: v } }),
  })),
  rotation: [12, 24, 72].map((v) => ({
    label: `自転 ${v} 時間`,
    make: (p) => ({ ...p, body: { ...p.body, rotationPeriodHours: v } }),
  })),
  luminosity: [0.92, 1.0, 1.08].map((v) => ({
    label: `光度 ${v.toFixed(2)}`,
    make: (p) => ({ ...p, orbital: { ...p.orbital, starLuminositySolar: v } }),
  })),
  radius: [0.6, 1.0, 1.6].map((v) => ({
    label: `半径 ×${v.toFixed(1)}`,
    make: (p) => ({ ...p, body: { ...p.body, radiusKm: 6371 * v } }),
  })),
};

/** 面積重み平均(mm/年)。陸と全球 */
function means(r: PipelineResult, monthly: Float32Array[]): { land: number; global: number } {
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  let wl = 0, el = 0, wo = 0, eo = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = 90 - (row + 0.5) * grid.resolutionDeg;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      let sum = 0;
      for (let m = 0; m < MONTHS_PER_YEAR; m++) sum += monthly[m]?.[i] ?? 0;
      if (land[i]) { wl += w; el += w * sum; } else { wo += w; eo += w * sum; }
    }
  }
  const lm = wl > 0 ? el / wl : 0;
  const om = wo > 0 ? eo / wo : 0;
  const f = wl / Math.max(1e-9, wl + wo);
  return { land: lm, global: f * lm + (1 - f) * om };
}

/** 陸の大分類 A〜E の面積割合(%)。海は数えない */
function majorShares(r: PipelineResult): number[] {
  const grid = r.context.grid;
  const land = r.context.terrain.landMask;
  const cls = r.koppen.classId;
  const acc = [0, 0, 0, 0, 0];
  let total = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = 90 - (row + 0.5) * grid.resolutionDeg;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!land[i]) continue;
      const mj = majorClassOf((cls[i] ?? 0) as KoppenClassId);
      if (mj >= 1 && mj <= 5) { acc[mj - 1] = (acc[mj - 1] ?? 0) + w; total += w; }
    }
  }
  return acc.map((a) => (total > 0 ? (a / total) * 100 : 0));
}

/** 全球平均気温(°C)。年平均 */
function meanTempC(r: PipelineResult): number {
  const grid = r.context.grid;
  const t = r.temperature.annualMeanC;
  let w = 0, e = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = 90 - (row + 0.5) * grid.resolutionDeg;
    const ww = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      w += ww; e += ww * (t[i] ?? 0);
    }
  }
  return w > 0 ? e / w : 0;
}

async function one(params: PlanetParams): Promise<PipelineResult> {
  const accel = await openAccel(true);
  try {
    return await runPipeline(params, accel.opts);
  } finally {
    accel.close();
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'pressure';
  const names = arg === 'all' ? Object.keys(AXES) : arg.split(',');
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;

  console.log(
    '軸                  型      閉包     気温    陸降水    A     B     C     D     E',
  );
  for (const name of names) {
    const levels = AXES[name];
    if (!levels) { console.log(`(未知の軸: ${name})`); continue; }
    for (const mode of [0, 1]) {
      K.conservativeMoisture = mode;
      for (const lv of levels) {
        const r = await one(lv.make(EARTH_PARAMS));
        const P = means(r, r.precipitation.monthlyPrecipMm);
        const ev = computeOceanEvaporation(r.context, r.temperature, r.airflow);
        const et = r.precipitation.land?.monthlyEtMm ?? [];
        const grid = r.context.grid;
        const land = r.context.terrain.landMask;
        const src: Float32Array[] = [];
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          const f = new Float32Array(grid.cellCount);
          for (let i = 0; i < grid.cellCount; i++)
            f[i] = land[i] ? (et[m]?.[i] ?? 0) : (ev.monthlyOceanEvapMm[m]?.[i] ?? 0);
          src.push(f);
        }
        const E = means(r, src);
        const closure = E.global > 0 ? ((P.global - E.global) / E.global) * 100 : NaN;
        const sh = majorShares(r);
        const conv = mode === 1 && CONSERVATIVE_STATS.nonConverged > 0 ? '×' : ' ';
        console.log(
          `${lv.label.padEnd(18)} ${mode === 0 ? '非保存' : '保存 '}${conv} ` +
            `${closure.toFixed(1).padStart(6)}%  ${meanTempC(r).toFixed(2).padStart(6)}  ` +
            `${Math.round(P.land).toString().padStart(5)}   ` +
            sh.map((x) => x.toFixed(1).padStart(5)).join(' '),
        );
      }
    }
  }
  console.log(
    '\n読み方: **正解は無い**(観測が無い)。見るのは 2 つ。\n' +
      '  1. 保存型で軸を振っても閉包が 0 のままか（0 でなければ実装が地球に依存している）\n' +
      '  2. 保存型と非保存で応答の**符号**が違う軸はどれか（違えば片方は架空惑星で嘘をつく）',
  );
}

void main();
