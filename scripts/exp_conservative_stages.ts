// 実験: 段 2〜5 — 「水が保存しないことの補償」だった乗数を 1 つずつ外す。
//
// 対応 spec: docs/計画_保存則の段階的置換_2026-08-09.md
// 前提: 段 1(保存型の接続)が「水が閉じる」を満たしていること
//
// 各段で外すもの(新しい定数は要らない。既存の定数を**無効値**に置くだけ):
//
//   段 2  orographicDepletionM → 巨大値      風上山脈による水蒸気の枯渇
//         保存則があれば「風上で降った分だけ W が減る」で自然に出るはず
//   段 3  upwindBlockFloor → 1               広域の遮蔽(下限を 1 = 遮蔽なし)
//   段 4  eastCoastSubsidenceRelief → 0      東岸で沈降を緩める例外
//         沈降は凝結率 G を下げる形で残るので、東岸の例外は不要になるはず
//   段 5  moistureDecay*Km を長くする        距離減衰 → λ(凝結寿命)へ完全に移す
//
// **各段で「外したのに悪化しない」なら、その乗数は保存の欠落を補っていた**
// ことの証明になる。悪化するなら別の物理を代弁していたので戻す。
//
// 判定の優先順位は段 1 と同じ:
//   1. 水が閉じるか(輸送が収束し、E と P が 5% 以内)
//   2. 成績(落ちるのは想定内。**降水の季節位相**が改善するかを特に見る)
//
// 実行: npx tsx scripts/exp_conservative_stages.ts [開始段,終了段]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { CONSERVATIVE_STATS } from '../src/sim/step06_precipitation';
import { computeOceanEvaporation } from '../src/sim/evaporation';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { evaluateResult } from './optimize_lib';
import { fieldScore, getClimObs, scoreRegionGates } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

const [FROM, TO] = (process.argv[2] ?? '1,5').split(',').map(Number) as [number, number];

/** 段ごとに「無効値へ置く定数」。累積で適用する */
const STAGES: Array<{ n: number; label: string; apply: (K: Record<string, number>) => void }> = [
  { n: 1, label: '段 1 保存型（乗数は全部そのまま）', apply: () => {} },
  {
    n: 2,
    label: '段 2 + 地形の枯渇を外す',
    apply: (K) => {
      K.orographicDepletionM = 1e9;
    },
  },
  {
    n: 3,
    label: '段 3 + 広域の遮蔽を外す',
    apply: (K) => {
      K.upwindBlockFloor = 1;
      K.upwindBlockReliefM = 1e9;
    },
  },
  {
    n: 4,
    label: '段 4 + 東岸の沈降緩和を外す',
    apply: (K) => {
      K.eastCoastSubsidenceRelief = 0;
    },
  },
  {
    n: 5,
    label: '段 5 + 距離減衰を凝結寿命へ完全に移す',
    apply: (K) => {
      K.moistureDecayOceanKm = 1e5;
      K.moistureDecayLandKm = 1e5;
    },
  },
];

function globalMeans(r: PipelineResult, monthly: Float32Array[]): { land: number; global: number } {
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

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const base = { ...K };
  console.log(
    '段                                    閉包    収束   v3      大分類  詳細   位相   陸降水  ゲート',
  );
  for (const st of STAGES) {
    if (st.n < FROM || st.n > TO) continue;
    // 定数を毎回もとへ戻してから、その段までを**累積で**適用する
    for (const [k, v] of Object.entries(base)) K[k] = v as number;
    K.conservativeMoisture = 1;
    for (const s2 of STAGES) if (s2.n <= st.n) s2.apply(K);

    const accel = await openAccel(true);
    let r: PipelineResult;
    try {
      r = await runPipeline(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
    const P = globalMeans(r, r.precipitation.monthlyPrecipMm);
    const ev = computeOceanEvaporation(r.context, r.temperature, r.airflow);
    const et = r.precipitation.land?.monthlyEtMm ?? [];
    const grid = r.context.grid;
    const land = r.context.terrain.landMask;
    const src: Float32Array[] = [];
    for (let m = 0; m < MONTHS_PER_YEAR; m++) {
      const f2 = new Float32Array(grid.cellCount);
      for (let i = 0; i < grid.cellCount; i++)
        f2[i] = land[i] ? (et[m]?.[i] ?? 0) : (ev.monthlyOceanEvapMm[m]?.[i] ?? 0);
      src.push(f2);
    }
    const E = globalMeans(r, src);
    const closure = E.global > 0 ? (P.global - E.global) / E.global : NaN;
    const s = evaluateResult(r);
    const fs2 = fieldScore(r, getClimObs());
    const gates = scoreRegionGates(r).filter((g) => g.pass).length;
    console.log(
      `${st.label.padEnd(36)} ${(closure * 100).toFixed(1).padStart(6)}%  ` +
        `${CONSERVATIVE_STATS.nonConverged === 0 ? ' ○ ' : ' × '}  ` +
        `${s.fitness.toFixed(3)}  ${s.majorPct.toFixed(2)}  ${s.detailPct.toFixed(2)}  ` +
        `${fs2.precipPhaseRmseDays.toFixed(1)}  ${Math.round(fs2.landMeanModelMm).toString().padStart(5)}   ${gates}`,
    );
  }
  console.log(
    '\n読み方: **閉包と収束が先。** 外したのに悪化しない乗数は「保存の欠落を補っていた」。\n' +
      '        悪化するなら別の物理を代弁していたので戻す。位相は段 0 = 77.18 日。',
  );
}

void main();
