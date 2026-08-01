// デーレ: 気圧 × 温室効果の精査探索(国境ポリゴンの居住可能性ベンチ込み)。
//
// 前段(derle_pressure_sweep)で 3 bar / 温室 1.65 が正典整合 4/7 と最良だったが、
// 3 bar は探索格子の端だったため上側を延長して精査する。
//
// 目的関数(事前に固定・結果を見てから変えない):
//   総合 = 正典整合(0..7) + 2 × 居住可能性得点(0..1)
// 居住可能性得点は「全土アネクメーネの国の割合」から作る。名前の無い面は
// 実在が怪しいスタブとして重み 0.25(利用者裁定 2026-08-01)。
//
// 実行: npx tsx scripts/derle_refine_sweep.ts

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DERLE_BASE, LORE_CHECKS, runDerle, type DerleOverrides } from './derle_common';

const OUT_DIR = path.join(process.cwd(), 'out', 'derle');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PRESSURES = [2.0, 3.0, 4.0, 5.0, 6.0];
const GREENHOUSES = [1.6, 1.7, 1.8, 1.9];
/** 居住可能性ベンチの重み(整合 7 点に対して 2 点ぶん) */
const HABIT_WEIGHT = 2;

interface Row {
  surfacePressureBar: number;
  greenhouse: number;
  globalMeanC: number;
  landMeanC: number;
  landPrecipMm: number;
  loreScore: number;
  checks: Record<string, boolean>;
  metrics: Record<string, number>;
  namedDead: number;
  stubDead: number;
  habitScore01: number;
  total: number;
}

const rows: Row[] = [];
console.log('気圧 | 温室 | 全球 | 陸降水 | 整合 | 死国(名/スタブ) | 居住 | 総合');
for (const p of PRESSURES) {
  for (const g of GREENHOUSES) {
    const o: DerleOverrides = { surfacePressureBar: p, greenhouse: g };
    const { lore, polyHabit } = await runDerle(o);
    const total = Math.round((lore.score + HABIT_WEIGHT * polyHabit.habitScore01) * 1000) / 1000;
    rows.push({
      surfacePressureBar: p,
      greenhouse: g,
      globalMeanC: lore.globalMeanC,
      landMeanC: Math.round(lore.landMeanC * 100) / 100,
      landPrecipMm: Math.round(lore.landPrecipMm),
      loreScore: lore.score,
      checks: lore.checks,
      metrics: lore.metrics,
      namedDead: polyHabit.namedAllAnecumeneCount,
      stubDead: polyHabit.stubAllAnecumeneCount,
      habitScore01: polyHabit.habitScore01,
      total,
    });
    console.log(
      `${p.toFixed(1)} bar | ${g.toFixed(2)} | ${lore.globalMeanC.toFixed(1)}°C | ` +
        `${Math.round(lore.landPrecipMm)}mm | ${lore.score}/7 | ` +
        `${polyHabit.namedAllAnecumeneCount}/${polyHabit.stubAllAnecumeneCount} | ` +
        `${polyHabit.habitScore01.toFixed(3)} | ${total.toFixed(2)}`,
    );
  }
}

const best = rows.reduce((a, b) => (b.total > a.total ? b : a));
console.log('\n===== 最良構成 =====');
console.log(
  `気圧 ${best.surfacePressureBar} bar / 温室 ${best.greenhouse} / ` +
    `傾斜 ${DERLE_BASE.axialTiltDeg}° / 自転 ${DERLE_BASE.rotationPeriodHours}h`,
);
console.log(
  `全球 ${best.globalMeanC}°C / 陸 ${best.landMeanC}°C / ${best.landPrecipMm}mm / ` +
    `整合 ${best.loreScore}/7 / 居住 ${best.habitScore01} / 総合 ${best.total}`,
);
for (const [k, v] of Object.entries(best.checks)) {
  const mk =
    k === 'derle_not_tropical'
      ? 'derle_tropical'
      : k === 'shanteriya_not_arid'
        ? 'shanteriya_dry'
        : k === 'global_not_overdry'
          ? 'global_dry'
          : k;
  console.log(`  ${v ? '○' : '✗'} ${LORE_CHECKS[k]?.label}: ${(best.metrics[mk] ?? 0).toFixed(1)}%`);
}

fs.writeFileSync(
  path.join(OUT_DIR, 'refine_sweep.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      gitCommit: (() => {
        try {
          return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
        } catch {
          return 'unknown';
        }
      })(),
      objective: '正典整合(0..7) + 2 × 居住可能性得点(0..1)。事前固定',
      habitWeight: HABIT_WEIGHT,
      rows,
      best,
    },
    null,
    2,
  ),
);
console.log(`\n出力: ${path.join(OUT_DIR, 'refine_sweep.json')}`);
