// R1 降水内部要因の地域診断(地域降水 FB §5)。
// 実行: npx tsx scripts/precip_diag.ts
// 6 地域(scoring_regions の DIAG_REGIONS)の月別平均を機械可読 JSON へ出す。
// 出力: out/experiments/r1-precip-diag/precip_factors.json(標準成果物は不変更)
// 集計: 1° 陸セル・面積重み(cos 緯度)。供給は無次元、倍率は 1 = 中立。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { latDegOfRow } from '../src/domain/grid';
import { DIAG_REGIONS } from './scoring_regions';

const OUT_DIR = path.join(process.cwd(), 'out', 'experiments', 'r1-precip-diag');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('パイプライン実行中(実在地球 1°、R1 診断つき)…');
const { result, precipDiag, soil } = runPipelineWithPrecipDiag(EARTH_PARAMS);
const grid = result.context.grid;
const land = result.context.terrain.landMask;

// ---- 統合水収支(第四 FB P0-3): 面積重み付き全球陸 ----
// 土壌無効時は null(ゼロ収支を成功したように見せない)
const waterBudget = (() => {
  if (!soil) return { status: 'disabled' as const };
  let wsum = 0;
  let p = 0;
  let et = 0;
  let ro = 0;
  let ds = 0;
  let absRes = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      if (!land[i]) continue;
      let cp = 0;
      let cet = 0;
      let cro = 0;
      for (let m = 0; m < 12; m++) {
        cp += result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        cet += soil.actualEtMm[m]?.[i] ?? 0;
        cro += soil.runoffMm[m]?.[i] ?? 0;
      }
      const cds = soil.storageChangeMm[i] ?? 0;
      wsum += w;
      p += w * cp;
      et += w * cet;
      ro += w * cro;
      ds += w * cds;
      absRes += w * Math.abs(cp - cet - cro - cds);
    }
  }
  const n = Math.max(1e-9, wsum);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    status: 'ok' as const,
    note: '面積重み付き全球陸の年収支(mm/年)。P − ET − 流出 − ΔS = 残差',
    precipMmPerYear: r3(p / n),
    evapotranspirationMmPerYear: r3(et / n),
    runoffMmPerYear: r3(ro / n),
    storageChangeMmPerYear: r3(ds / n),
    signedResidualMmPerYear: r3((p - et - ro - ds) / n),
    meanAbsResidualMmPerYear: r3(absRes / n),
    soilSpinupYears: soil.spinupYears,
    soilMeanAnnualDriftMm: r3(soil.meanAnnualStorageDriftMm),
    soilMaxAnnualDriftMm: r3(soil.maxAnnualStorageDriftMm),
    soilConverged: soil.converged,
    coupling: result.precipitation.coupling,
  };
})();

const FIELDS = [
  ['supplyOcean', '海洋由来供給'],
  ['supplyLand', '陸面再循環由来供給'],
  ['supplyStorm', 'ストームトラック由来供給'],
  ['liftItcz', 'ITCZ 持上げ倍率'],
  ['liftFrontal', '前線持上げ倍率'],
  ['liftOrographic', '地形性持上げ倍率'],
  ['liftConvergence', '湿潤収束持上げ倍率(R4)'],
  ['convergenceIndex', '水蒸気フラックス収束指数(供給単位、正=収束)'],
  ['subsidenceResidual', '亜熱帯沈降の残存倍率'],
  ['upwindBlock', '風上山脈の遮蔽倍率'],
  ['liftOther', 'その他倍率(ストーム帯持上げ×寒流×対流)'],
  ['preAdjustMm', '再配分前降水 mm/月'],
  ['postAdjustDeltaMm', '後処理差分(冬季床+月ブレンド) mm/月'],
] as const;

interface RegionRow {
  id: string;
  label: string;
  landCells: number;
  monthly: Record<string, number[]>;
  finalPrecipMm: number[];
}

const regions: RegionRow[] = [];
for (const reg of DIAG_REGIONS) {
  const monthly: Record<string, number[]> = {};
  for (const [key] of FIELDS) monthly[key] = [];
  const finalPrecipMm: number[] = [];
  let landCells = 0;
  for (let m = 0; m < 12; m++) {
    const sums = new Map<string, number>();
    let wsum = 0;
    let finalSum = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < reg.latMin || lat > reg.latMax) continue;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < reg.lonMin || lon > reg.lonMax) continue;
        const i = row * grid.widthCells + col;
        if (!land[i]) continue;
        if (m === 0) landCells++;
        wsum += w;
        finalSum += w * (result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0);
        for (const [key] of FIELDS) {
          const arr = precipDiag[key][m];
          sums.set(key, (sums.get(key) ?? 0) + w * (arr?.[i] ?? 0));
        }
      }
    }
    for (const [key] of FIELDS) {
      monthly[key]!.push(Math.round(((sums.get(key) ?? 0) / Math.max(1e-9, wsum)) * 1000) / 1000);
    }
    finalPrecipMm.push(Math.round((finalSum / Math.max(1e-9, wsum)) * 10) / 10);
  }
  regions.push({ id: reg.id, label: reg.label, landCells, monthly, finalPrecipMm });
}

let gitCommit = 'unknown';
let gitDirty = true; // 判定不能時は「汚れている」と保守的に記録する
try {
  gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  gitDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
} catch {
  /* 架空の値を入れない */
}

const output = {
  generatedAt: new Date().toISOString(),
  gitCommit,
  // 未コミット変更がある状態で生成した成果物は、来歴がコードを表さない
  // (R1 レビュー指摘の再発防止)
  gitDirty,
  note:
    'R1 降水内部要因診断(地域降水 FB §5)。1° 陸セル・面積重みの地域月別平均。' +
    '再構成: preAdjustMm ≈ (supplyOcean+supplyLand+supplyStorm) × upwindBlock × ' +
    'liftItcz × liftFrontal × liftOrographic × subsidenceResidual × liftOther × ' +
    `mmPerSupplyUnit(${Math.round(precipDiag.mmPerSupplyUnit * 100) / 100})。` +
    'finalPrecipMm との差は冬季床再配分・月ブレンド(陸のみ)による',
  mmPerSupplyUnit: precipDiag.mmPerSupplyUnit,
  waterBudget,
  fieldLabels: Object.fromEntries(FIELDS),
  regions,
};
fs.writeFileSync(path.join(OUT_DIR, 'precip_factors.json'), JSON.stringify(output, null, 2));

console.log(`出力: ${path.join(OUT_DIR, 'precip_factors.json')}`);
if (waterBudget.status === 'ok') {
  console.log(
    `統合水収支(全球陸・面積重み): 降水 ${waterBudget.precipMmPerYear} = 蒸発散 ${waterBudget.evapotranspirationMmPerYear}` +
      ` + 流出 ${waterBudget.runoffMmPerYear} + 貯水変化 ${waterBudget.storageChangeMmPerYear}` +
      ` / 残差 ${waterBudget.signedResidualMmPerYear}(セル別絶対 ${waterBudget.meanAbsResidualMmPerYear})` +
      ` / 結合反復 ${waterBudget.coupling.iterations} 回・残差 ${waterBudget.coupling.finalResidualMmPerMonth.toFixed(3)}mm/月` +
      `・収束 ${waterBudget.coupling.converged ? 'あり' : '**未達**'}`,
  );
} else {
  console.log('統合水収支: 土壌水分が無効(disabled)');
}
for (const r of regions) {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(
    `${r.label}: 供給 海 ${mean(r.monthly['supplyOcean'] ?? []).toFixed(2)} / 陸 ${mean(r.monthly['supplyLand'] ?? []).toFixed(2)} / 渦 ${mean(r.monthly['supplyStorm'] ?? []).toFixed(2)}` +
      ` ・倍率 ITCZ ${mean(r.monthly['liftItcz'] ?? []).toFixed(2)} 前線 ${mean(r.monthly['liftFrontal'] ?? []).toFixed(2)} 地形 ${mean(r.monthly['liftOrographic'] ?? []).toFixed(2)}` +
      ` 沈降残存 ${mean(r.monthly['subsidenceResidual'] ?? []).toFixed(2)} 遮蔽 ${mean(r.monthly['upwindBlock'] ?? []).toFixed(2)} 他 ${mean(r.monthly['liftOther'] ?? []).toFixed(2)}`,
  );
}
