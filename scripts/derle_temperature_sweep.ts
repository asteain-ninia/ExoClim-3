// デーレ(出界)の設定整合性が最大になる天文値を探す。
//
// 前提の訂正(利用者裁定 2026-08-01):
//   「陸平均降水 690mm は無根拠。正典は土地々々の気候。全球平均 8°C は
//     それを満たすための手段であり以前の推定値。天文値も変えてよい」
// したがって固定するのは**地域気候(正典)**のみで、気温も天文値も従属変数。
//
// 判定は derle-climate の consistency_audit と同一(config/v11_shukkai.json)。
// 彼らの arid_pct は砂漠 + ステップ = ケッペン B と同一定義なので直接比較できる。
//
// 探索は段階式(全探索は高価なため):
//   段階 1: 温室効果で気温を走査 → 整合が最大の温度帯を特定
//   段階 2: その温度帯で地軸傾斜を走査(季節性 → 温帯/熱帯の範囲)
//   段階 3: 自転周期を走査(ハドレー循環の幅 → 乾燥帯の位置と広さ)
//   段階 4: 最良点の周辺を細かく詰める
//
// 実行: npx tsx scripts/derle_temperature_sweep.ts

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  DERLE_BASE,
  LORE_CHECKS,
  insolationWm2,
  runDerle,
  type DerleOverrides,
} from './derle_common';

const OUT_DIR = path.join(process.cwd(), 'out', 'derle');
fs.mkdirSync(OUT_DIR, { recursive: true });

interface Row extends DerleOverrides {
  stage: string;
  globalMeanC: number;
  landMeanC: number;
  landPrecipMm: number;
  score: number;
  checks: Record<string, boolean>;
  metrics: Record<string, number>;
}

const rows: Row[] = [];

async function evaluate(stage: string, o: DerleOverrides): Promise<Row> {
  const { lore } = await runDerle(o);
  const row: Row = {
    stage,
    ...o,
    globalMeanC: lore.globalMeanC,
    landMeanC: lore.landMeanC,
    landPrecipMm: lore.landPrecipMm,
    score: lore.score,
    checks: lore.checks,
    metrics: lore.metrics,
  };
  rows.push(row);
  const failed = Object.entries(lore.checks)
    .filter(([, v]) => !v)
    .map(([k]) => LORE_CHECKS[k]?.label ?? k);
  const desc = [
    o.greenhouse !== undefined ? `温室 ${o.greenhouse.toFixed(2)}` : '',
    o.axialTiltDeg !== undefined ? `傾斜 ${o.axialTiltDeg}°` : '',
    o.rotationPeriodHours !== undefined ? `自転 ${o.rotationPeriodHours}h` : '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(
    `[${stage}] ${desc} → 全球 ${lore.globalMeanC.toFixed(2)}°C / 陸 ${lore.landMeanC.toFixed(1)}°C / ` +
      `${Math.round(lore.landPrecipMm)}mm / 整合 ${lore.score}/7` +
      (failed.length ? ` / 未達 ${failed.join('・')}` : ' / 全達成'),
  );
  return row;
}

// ---- 段階 1: 気温(温室効果) ----
console.log('=== 段階 1: 気温の走査 ===');
for (const g of [1.35, 1.5, 1.65, 1.8, 1.95, 2.1, 2.25, 2.4, 2.6]) {
  await evaluate('温度', { greenhouse: g });
}
let best = rows.reduce((a, b) => (b.score > a.score ? b : a));
const bestG = best.greenhouse ?? 1.8;
console.log(`→ 最良の温室効果 ${bestG}(整合 ${best.score}/7、全球 ${best.globalMeanC}°C)\n`);

// ---- 段階 2: 地軸傾斜 ----
console.log('=== 段階 2: 地軸傾斜の走査 ===');
for (const tilt of [10, 15, 19.505, 25, 30, 35]) {
  if (tilt === DERLE_BASE.axialTiltDeg) continue; // 段階 1 で計測済み
  await evaluate('傾斜', { greenhouse: bestG, axialTiltDeg: tilt });
}
best = rows.reduce((a, b) => (b.score > a.score ? b : a));
const bestTilt = best.axialTiltDeg ?? DERLE_BASE.axialTiltDeg;
console.log(`→ 最良の傾斜 ${bestTilt}°(整合 ${best.score}/7)\n`);

// ---- 段階 3: 自転周期(ハドレー循環の幅) ----
console.log('=== 段階 3: 自転周期の走査 ===');
for (const rot of [16, 20, 24, 28.4698, 34, 40, 48]) {
  if (rot === DERLE_BASE.rotationPeriodHours && bestTilt === DERLE_BASE.axialTiltDeg) continue;
  await evaluate('自転', {
    greenhouse: bestG,
    axialTiltDeg: bestTilt,
    rotationPeriodHours: rot,
  });
}
best = rows.reduce((a, b) => (b.score > a.score ? b : a));
console.log(
  `→ 最良: 温室 ${best.greenhouse} / 傾斜 ${best.axialTiltDeg ?? DERLE_BASE.axialTiltDeg}° / ` +
    `自転 ${best.rotationPeriodHours ?? DERLE_BASE.rotationPeriodHours}h(整合 ${best.score}/7)\n`,
);

// ---- 段階 4: 最良点の周辺を温度で詰める ----
console.log('=== 段階 4: 最良構成での温度の詰め ===');
const around = best;
for (const dg of [-0.1, -0.05, 0.05, 0.1]) {
  await evaluate('詰め', {
    greenhouse: Math.round(((around.greenhouse ?? bestG) + dg) * 100) / 100,
    axialTiltDeg: around.axialTiltDeg ?? DERLE_BASE.axialTiltDeg,
    rotationPeriodHours: around.rotationPeriodHours ?? DERLE_BASE.rotationPeriodHours,
  });
}
best = rows.reduce((a, b) => (b.score > a.score ? b : a));

// ---- 天文値への翻訳 ----
// 温室効果を上げる代わりに、軌道を近づける / 主星を明るくすることでも同じ
// エネルギー入力が作れる。ExoClim-3 の OLR は A − ΔA·log2(g) なので、
// 温室 g の効果は日射の増分に換算できる(下は等価な日射の目安)。
const baseInsolation = insolationWm2(DERLE_BASE.starLuminositySolar, DERLE_BASE.semiMajorAxisAu);
const summary = {
  generatedAt: new Date().toISOString(),
  gitCommit: (() => {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })(),
  note:
    'デーレの正典(土地々々の気候)への整合が最大になる天文値の探索。' +
    '全球平均気温も陸平均降水も固定しない。判定は derle-climate の ' +
    'consistency_audit と同一。天文値は利用者裁定により可変',
  baseline: { ...DERLE_BASE, insolationWm2: Math.round(baseInsolation) },
  loreChecks: LORE_CHECKS,
  rows,
  best,
};
fs.writeFileSync(path.join(OUT_DIR, 'parameter_sweep.json'), JSON.stringify(summary, null, 2));

console.log('\n===== 最良構成 =====');
console.log(
  `温室効果 ${best.greenhouse} / 傾斜 ${best.axialTiltDeg ?? DERLE_BASE.axialTiltDeg}° / ` +
    `自転 ${best.rotationPeriodHours ?? DERLE_BASE.rotationPeriodHours}h`,
);
console.log(
  `全球平均 ${best.globalMeanC}°C / 陸平均 ${best.landMeanC}°C / 陸降水 ${Math.round(best.landPrecipMm)}mm / 整合 ${best.score}/7`,
);
for (const [k, v] of Object.entries(best.checks)) {
  console.log(`  ${v ? '○' : '✗'} ${LORE_CHECKS[k]?.label}: ${best.metrics[k]?.toFixed(1)}%`);
}
console.log(`出力: ${path.join(OUT_DIR, 'parameter_sweep.json')}`);
