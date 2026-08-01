// デーレ(出界): 気圧 × 気温の 2 次元探索 + 居住可能性ベンチ。
//
// 前提(利用者裁定 2026-08-01): 正典は土地々々の気候。全球平均気温・陸平均降水・
// 天文値はいずれも従属変数。加えて「全土がアネクメーネ(居住不能)の国が
// 無いこと」を惑星設定の妥当性ベンチとする。
//
// 気圧を振る理由: 天文値(日射・傾斜・自転)の探索では整合 3/7 が上限で、
// 未達 4 件のうち 3 件が「乾きすぎ」だった。表面気圧は水蒸気の輸送距離と
// 降水効率・熱容量に効くため、乾湿の全体水準を動かせる可能性がある。
//
// 実行: npx tsx scripts/derle_pressure_sweep.ts

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DERLE_BASE, LORE_CHECKS, runDerle, type DerleOverrides } from './derle_common';

const OUT_DIR = path.join(process.cwd(), 'out', 'derle');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PRESSURES = [0.7, 1.0, 1.4, 2.0, 3.0];
// 気圧を上げると熱容量と輸送が変わり気温も動くため、各気圧で温室効果も振る
const GREENHOUSES = [1.5, 1.65, 1.8, 2.0];

interface Row extends DerleOverrides {
  globalMeanC: number;
  landMeanC: number;
  landPrecipMm: number;
  score: number;
  checks: Record<string, boolean>;
  metrics: Record<string, number>;
  /** 全土アネクメーネの国の数(0 が望ましい) */
  allAnecumeneCountries: number;
  minEcumenePct: number;
  /** 正典整合 + 居住可能性の総合(整合 7 点満点 + 居住 1 点) */
  totalScore: number;
}

const rows: Row[] = [];
console.log('気圧 | 温室 | 全球 | 陸平均 | 陸降水 | 整合 | 全土アネク国 | 最小エクメーネ');
for (const p of PRESSURES) {
  for (const g of GREENHOUSES) {
    const o: DerleOverrides = { surfacePressureBar: p, greenhouse: g };
    const { lore, habit } = runDerle(o);
    const totalScore = lore.score + (habit.allAnecumeneCount === 0 ? 1 : 0);
    rows.push({
      ...o,
      globalMeanC: lore.globalMeanC,
      landMeanC: lore.landMeanC,
      landPrecipMm: lore.landPrecipMm,
      score: lore.score,
      checks: lore.checks,
      metrics: lore.metrics,
      allAnecumeneCountries: habit.allAnecumeneCount,
      minEcumenePct: habit.minEcumenePct,
      totalScore,
    });
    console.log(
      `${p.toFixed(1)} bar | ${g.toFixed(2)} | ${lore.globalMeanC.toFixed(1)}°C | ` +
        `${lore.landMeanC.toFixed(1)}°C | ${Math.round(lore.landPrecipMm)}mm | ${lore.score}/7 | ` +
        `${habit.allAnecumeneCount} 国 | ${habit.minEcumenePct.toFixed(1)}%`,
    );
  }
}

const best = rows.reduce((a, b) =>
  b.totalScore > a.totalScore || (b.totalScore === a.totalScore && b.score > a.score) ? b : a,
);
console.log('\n===== 最良構成 =====');
console.log(
  `気圧 ${best.surfacePressureBar} bar / 温室 ${best.greenhouse} / ` +
    `傾斜 ${DERLE_BASE.axialTiltDeg}° / 自転 ${DERLE_BASE.rotationPeriodHours}h`,
);
console.log(
  `全球 ${best.globalMeanC}°C / 陸 ${best.landMeanC}°C / ${Math.round(best.landPrecipMm)}mm / ` +
    `整合 ${best.score}/7 / 全土アネクメーネ国 ${best.allAnecumeneCountries}`,
);
for (const [k, v] of Object.entries(best.checks)) {
  const metricKey = k === 'derle_not_tropical' ? 'derle_tropical' : k === 'shanteriya_not_arid' ? 'shanteriya_dry' : k === 'global_not_overdry' ? 'global_dry' : k;
  console.log(`  ${v ? '○' : '✗'} ${LORE_CHECKS[k]?.label}: ${(best.metrics[metricKey] ?? 0).toFixed(1)}%`);
}

// 最良構成での国別居住可能性
const bestOverrides: DerleOverrides = {};
if (best.surfacePressureBar !== undefined) bestOverrides.surfacePressureBar = best.surfacePressureBar;
if (best.greenhouse !== undefined) bestOverrides.greenhouse = best.greenhouse;
const { habit } = runDerle(bestOverrides);
const worst = [...habit.countries].sort((a, b) => a.ecumenePct - b.ecumenePct).slice(0, 8);
console.log('\n居住可能率が低い国(下位 8):');
for (const c of worst) {
  console.log(`  ${c.name}: エクメーネ ${c.ecumenePct}% (優占 ${c.topClass}, 陸 ${c.landCells} セル)`);
}

fs.writeFileSync(
  path.join(OUT_DIR, 'pressure_sweep.json'),
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
      note:
        'デーレの気圧 × 気温 2 次元探索。正典整合(7 項目)に加え、' +
        '「全土がアネクメーネの国が無いこと」を居住可能性ベンチとして評価。' +
        'アネクメーネ = 氷雪 EF・ツンドラ ET・砂漠 BW(ステップ BS は牧畜可でエクメーネ)',
      rows,
      best,
      countriesAtBest: habit.countries,
    },
    null,
    2,
  ),
);
console.log(`\n出力: ${path.join(OUT_DIR, 'pressure_sweep.json')}`);
