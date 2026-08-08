// 診断: 湿潤温帯の降水が観測の 1/5 しかない件を、降水の乗数まで割る。
//
// 対応 spec: なし(原因の切り分け)。R5 の入口。
// 前提: docs/実験記録_温帯の乾燥化_2026-08-07.md
//
// なぜ要るか:
//   観測が C 温帯の 2° セル 466 個のうち 181 個が B 乾燥へ落ちる。
//   その 181 個は年降水が観測 1213mm に対しモデル 259mm(−79%)で、
//   しきい値(気温側)は 5% 以内で一致している。**降水の一変数の問題**である。
//
//   降水は「供給 × 持上げ × 抑制の積」で作られており、診断の受け皿
//   (runPipelineWithPrecipDiag)が各因子を分解して返す。
//   **落ちたセルと当たったセルで各因子を比べれば、どれが殺しているかが分かる。**
//   地域名(中国東部・ラプラタ)ではなく**症状で群を作る**ので地理中立。
//
// 実行: npx tsx scripts/diag_temperate_factors.ts
//   (較正の後に回すこと — 気温が変われば C の判定も動く)

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { classifyKoppenCell } from '../src/sim/step07_koppen';
import { majorClassOf } from '../src/domain/koppen';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PrecipDiagnostics } from '../src/sim/step06_precipitation';

/** 見る因子(すべて月別セル別)。供給は絶対量、他は倍率 */
const FACTORS: Array<[keyof PrecipDiagnostics, string, 'sum' | 'mean']> = [
  ['supplyOcean', '海洋供給', 'sum'],
  ['supplyLand', '陸再循環供給', 'sum'],
  ['supplyStorm', 'ストーム供給', 'sum'],
  ['liftItcz', 'ITCZ 持上げ', 'mean'],
  ['liftFrontal', '前線持上げ', 'mean'],
  ['liftOrographic', '地形持上げ', 'mean'],
  ['liftConvergence', '収束持上げ', 'mean'],
  ['subsidenceResidual', '沈降の残存', 'mean'],
  ['upwindBlock', '風上遮蔽', 'mean'],
  ['liftOther', 'その他の持上げ', 'mean'],
];

async function main(): Promise<void> {
  const accel = await openAccel();
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const { result, precipDiag: d } = out;

  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);

  /** 観測 C のセルを、モデルの答えで 2 群に分ける(1° セルの番号を集める) */
  const fell: number[] = []; // モデルが B 乾燥と答えた
  const kept: number[] = []; // モデルも C 温帯と答えた

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 90 - (cr + 0.5) * 2;
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const tObs: number[] = [];
      const pObs: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (t === -9999 || p === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
        pObs.push(p);
      }
      if (!ok) continue;
      if (majorClassOf(classifyKoppenCell(tObs, pObs, lat >= 0)) !== 2) continue;

      const tM = new Array<number>(12).fill(0);
      const pM = new Array<number>(12).fill(0);
      const cells: number[] = [];
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          cells.push(gi);
          for (let m = 0; m < 12; m++) {
            tM[m] = (tM[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
            pM[m] = (pM[m] ?? 0) + (result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
          }
        }
      }
      if (cells.length === 0) continue;
      for (let m = 0; m < 12; m++) {
        tM[m] = (tM[m] ?? 0) / cells.length;
        pM[m] = (pM[m] ?? 0) / cells.length;
      }
      const mo = majorClassOf(classifyKoppenCell(tM, pM, lat >= 0));
      if (mo === 1) fell.push(...cells);
      else if (mo === 2) kept.push(...cells);
    }
  }

  console.log(
    `観測 C のうち、モデルが B と答えた 1° セル ${fell.length} 個 / ` +
      `C と答えた ${kept.length} 個\n`,
  );

  const stat = (
    cellsIdx: number[],
    key: keyof PrecipDiagnostics,
    mode: 'sum' | 'mean',
  ): number => {
    const monthly = d[key] as unknown as Float32Array[];
    let acc = 0;
    for (const gi of cellsIdx) {
      let v = 0;
      for (let m = 0; m < 12; m++) v += monthly[m]?.[gi] ?? 0;
      acc += mode === 'sum' ? v : v / 12;
    }
    return cellsIdx.length > 0 ? acc / cellsIdx.length : NaN;
  };

  console.log('因子              落ちた群    当たった群   比(落/当)');
  const rows: Array<{ name: string; a: number; b: number; r: number }> = [];
  for (const [key, name, mode] of FACTORS) {
    const a = stat(fell, key, mode);
    const b = stat(kept, key, mode);
    const r = b !== 0 ? a / b : NaN;
    rows.push({ name, a, b, r });
    console.log(
      `${name.padEnd(16)} ${a.toFixed(3).padStart(10)} ${b.toFixed(3).padStart(12)} ` +
        `${r.toFixed(3).padStart(11)}`,
    );
  }

  console.log('\n比が小さい順(落ちた群で強く効いている抑制 / 足りていない供給)');
  for (const r of [...rows].sort((a, b) => a.r - b.r).slice(0, 5)) {
    console.log(`  ${r.name.padEnd(16)} ${r.r.toFixed(3)}`);
  }
  console.log(
    '\n読み方: 供給(sum)は絶対量なので比が小さければ「水が届いていない」。' +
      '\n        倍率(mean)は比が小さければ「その抑制が落ちた群で強く効いている」。',
  );

  // 参考: 最終降水そのものの比
  const pmm = (cellsIdx: number[]): number => {
    let acc = 0;
    for (const gi of cellsIdx) {
      let v = 0;
      for (let m = 0; m < 12; m++) v += result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0;
      acc += v;
    }
    return cellsIdx.length > 0 ? acc / cellsIdx.length : NaN;
  };
  console.log(
    `\n参考: 年降水 落ちた群 ${pmm(fell).toFixed(0)}mm / 当たった群 ${pmm(kept).toFixed(0)}mm`,
  );
}

void main();
