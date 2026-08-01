// デーレ: 国境ポリゴンによる居住可能性ベンチの報告。
//
// 利用者裁定(2026-08-01): 「全土がアネクメーネの国が無いこと」を惑星設定の
// 妥当性ベンチとする。ただし国名ラベルを持たない面は実在自体が怪しい
// スタブなので、全土アネクメーネのペナルティを 0.25 に減衰させる。
//
// 実行: npx tsx scripts/derle_habitability_report.ts [気圧] [温室]

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runDerle, STUB_PENALTY_WEIGHT, type DerleOverrides } from './derle_common';

const pressure = Number(process.argv[2] ?? 3);
const greenhouse = Number(process.argv[3] ?? 1.65);
const o: DerleOverrides = { surfacePressureBar: pressure, greenhouse };

const { lore, habit, polyHabit } = runDerle(o);

console.log(`構成: 気圧 ${pressure} bar / 温室 ${greenhouse}`);
console.log(
  `全球 ${lore.globalMeanC}°C / 陸 ${lore.landMeanC.toFixed(1)}°C / ` +
    `陸降水 ${Math.round(lore.landPrecipMm)}mm / 正典整合 ${lore.score}/7`,
);
console.log(
  `\n国境ポリゴン: 評価対象 ${polyHabit.evaluated} 面 ` +
    `(名前つき ${polyHabit.countries.filter((c) => !c.isStub).length} / ` +
    `スタブ ${polyHabit.countries.filter((c) => c.isStub).length})`,
);
console.log(
  `全土アネクメーネ: 名前つき ${polyHabit.namedAllAnecumeneCount} 国 / ` +
    `スタブ ${polyHabit.stubAllAnecumeneCount} 面 ` +
    `→ 重みつきペナルティ ${polyHabit.penalty} (スタブ重み ${STUB_PENALTY_WEIGHT})`,
);
console.log(`名前つきの国の最小エクメーネ率: ${polyHabit.minNamedEcumenePct}%`);

const named = polyHabit.countries
  .filter((c) => !c.isStub)
  .sort((a, b) => a.ecumenePct - b.ecumenePct);
console.log('\n名前つきの国(エクメーネ率の低い順):');
for (const c of named) {
  console.log(
    `  ${(c.name ?? '?').padEnd(12, '　')} エクメーネ ${String(c.ecumenePct).padStart(5)}% ` +
      `(優占 ${c.topClass}, 陸 ${c.landCells} セル)`,
  );
}

console.log('\n参考: アンカー近似(半径 5°)による旧ベンチ');
console.log(`  全土アネクメーネ ${habit.allAnecumeneCount} 国 / 最小 ${habit.minEcumenePct}%`);

const OUT_DIR = path.join(process.cwd(), 'out', 'derle');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'habitability.json'),
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
      config: o,
      lore,
      polygonHabitability: polyHabit,
      anchorHabitability: habit,
    },
    null,
    2,
  ),
);
console.log(`\n出力: ${path.join(OUT_DIR, 'habitability.json')}`);
