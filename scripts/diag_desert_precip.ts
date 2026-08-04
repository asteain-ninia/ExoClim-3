// 診断: 亜熱帯砂漠の過大降水は、**どの項**が入れているのか。
//
// 対応 spec: docs/spec/01-06_降水.md。
//
// なぜ measure するか(2026-08-04):
//   比較画像でサハラ・アラビア・豪州内陸の降水が過大に見え、姉妹プロジェクト
//   derle-climate でも手法が違うのに同じ方向へ外れている(教訓 §8.2)。
//   「簡易モデルが構造的に落としている物理がある」と考えているが、
//   **どの項が水を入れているかを見ないまま物理を足すのは当てずっぽう**である。
//
//   降水は 供給(海洋 + 陸面再循環 + ストーム)× 倍率(ITCZ・前線・地形・収束・
//   沈降残存・風上遮蔽・その他)× 変換係数 で組み立てられており、R1 診断が
//   その因子分解を持っている。乾燥域だけ取り出して寄与を並べる。
//
// 何が分かれば次へ進めるか:
//   - 供給が入っているのか(= 水蒸気が届きすぎ)、倍率が緩いのか(= 抑制不足)
//   - 供給なら海洋・陸面再循環・ストームのどれか
//   - 倍率なら沈降抑制が緩いのか、他の持上げが打ち消しているのか
//
// 実行: npx tsx scripts/diag_desert_precip.ts [パラメータJSON]

import * as fs from 'node:fs';
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

const PARAM_PATH = process.argv[2];
const MONTHS = 12;

/** 観測が乾燥している 2° セルを選び、対応する 1° 陸セルの一覧にする */
function drySelection(
  climW: number,
  climH: number,
  obsAnnual: Float32Array,
  gridW: number,
  gridH: number,
  land: Uint8Array,
  f: number,
  maxMm: number,
): number[] {
  const out: number[] = [];
  for (let cr = 0; cr < climH; cr++) {
    for (let cc = 0; cc < climW; cc++) {
      const ci = cr * climW + cc;
      const p = obsAnnual[ci] ?? -1;
      if (p < 0 || p > maxMm) continue;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= gridH || gc >= gridW) continue;
          const gi = gr * gridW + gc;
          if (land[gi]) out.push(gi);
        }
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  if (PARAM_PATH) {
    const patch = JSON.parse(fs.readFileSync(PARAM_PATH, 'utf8')) as Record<string, number>;
    const target = MODEL_CONSTANTS as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(patch)) if (k in target) target[k] = v;
    console.log(`パラメータ: ${PARAM_PATH}`);
  }
  const accel = await openAccel();
  const { result, precipDiag: d } = await (async () => {
    try {
      return await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
    } finally {
      accel.close();
    }
  })();

  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);

  const obsAnnual = new Float32Array(clim.widthCells * clim.heightCells).fill(-1);
  const obsMonthly: Float32Array[] = [];
  for (let m = 0; m < MONTHS; m++) obsMonthly.push(new Float32Array(obsAnnual.length).fill(-1));
  for (let ci = 0; ci < obsAnnual.length; ci++) {
    let sum = 0;
    let ok = true;
    for (let m = 0; m < MONTHS; m++) {
      const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
      if (p === -9999) {
        ok = false;
        break;
      }
      obsMonthly[m]![ci] = p;
      sum += p;
    }
    if (ok) obsAnnual[ci] = sum;
  }

  for (const [label, maxMm] of [
    ['最乾(観測 < 100mm/年)', 100],
    ['乾燥(観測 < 250mm/年)', 250],
  ] as const) {
    const cells = drySelection(
      clim.widthCells,
      clim.heightCells,
      obsAnnual,
      grid.widthCells,
      grid.heightCells,
      land,
      f,
      maxMm,
    );
    if (cells.length === 0) continue;

    // モデルと観測の年降水(同じセル集合で)
    let modelAnnual = 0;
    for (const gi of cells) modelAnnual += result.precipitation.annualPrecipMm[gi] ?? 0;
    modelAnnual /= cells.length;
    // 観測は 2° 側で平均を取り直す
    let obsSum = 0;
    let obsN = 0;
    for (let ci = 0; ci < obsAnnual.length; ci++) {
      const p = obsAnnual[ci] ?? -1;
      if (p >= 0 && p <= maxMm) {
        obsSum += p;
        obsN++;
      }
    }
    const obsMean = obsN > 0 ? obsSum / obsN : 0;

    console.log(`\n===== ${label} — 1° 陸セル ${cells.length} 個 =====`);
    console.log(`  年降水  モデル ${modelAnnual.toFixed(0)} mm / 観測 ${obsMean.toFixed(0)} mm`);

    // 因子の平均(月平均・セル平均)。供給は無次元、倍率は 1 が「抑制なし」。
    // **月を絞れるようにする**のが要点 — 年平均で見ると夏の異常が冬に薄められて
    // 消える(2026-08-04: 年合計は観測 44 に対し 61 で +39% だが、6 月だけ見ると
    // 観測 3.0 に対し 8.1 で 2.7 倍だった)
    const meanOn = (arrs: Float32Array[], months: number[]): number => {
      let s = 0;
      let n = 0;
      for (const m of months) {
        const a = arrs[m];
        if (!a) continue;
        for (const gi of cells) {
          s += a[gi] ?? 0;
          n++;
        }
      }
      return n > 0 ? s / n : 0;
    };
    const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const mean = (arrs: Float32Array[]): number => meanOn(arrs, ALL);
    const so = mean(d.supplyOcean);
    const sl = mean(d.supplyLand);
    const ss = mean(d.supplyStorm);
    const tot = so + sl + ss;
    console.log(
      `  供給(無次元)  海洋 ${so.toFixed(4)} (${((100 * so) / (tot || 1)).toFixed(0)}%) / ` +
        `陸面再循環 ${sl.toFixed(4)} (${((100 * sl) / (tot || 1)).toFixed(0)}%) / ` +
        `ストーム ${ss.toFixed(4)} (${((100 * ss) / (tot || 1)).toFixed(0)}%)  合計 ${tot.toFixed(4)}`,
    );
    console.log(
      `  倍率(1 = 素通し)  ITCZ ${mean(d.liftItcz).toFixed(3)} / 前線 ${mean(d.liftFrontal).toFixed(3)} / ` +
        `地形 ${mean(d.liftOrographic).toFixed(3)} / 収束 ${mean(d.liftConvergence).toFixed(3)}`,
    );
    console.log(
      `                    沈降残存 ${mean(d.subsidenceResidual).toFixed(3)} / ` +
        `風上遮蔽 ${mean(d.upwindBlock).toFixed(3)} / その他 ${mean(d.liftOther).toFixed(3)}`,
    );
    console.log(
      `  変換前 ${mean(d.preAdjustMm).toFixed(2)} mm/月 → 後処理差分 ` +
        `${mean(d.postAdjustDeltaMm) >= 0 ? '+' : ''}${mean(d.postAdjustDeltaMm).toFixed(2)} mm/月` +
        `  (変換係数 ${d.mmPerSupplyUnit.toFixed(2)} mm/供給単位)`,
    );

    // 月別: 過大がいつ起きているか(観測の最乾月に降っていないか)
    console.log('  月別 mm/月  1  2  3  4  5  6  7  8  9 10 11 12');
    const modelMon: number[] = [];
    for (let m = 0; m < MONTHS; m++) {
      let s = 0;
      for (const gi of cells) s += result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0;
      modelMon.push(s / cells.length);
    }
    const obsMon: number[] = [];
    for (let m = 0; m < MONTHS; m++) {
      let s = 0;
      let n = 0;
      for (let ci = 0; ci < obsAnnual.length; ci++) {
        const p = obsAnnual[ci] ?? -1;
        if (p >= 0 && p <= maxMm) {
          s += obsMonthly[m]![ci] ?? 0;
          n++;
        }
      }
      obsMon.push(n > 0 ? s / n : 0);
    }
    console.log('    モデル  ' + modelMon.map((v) => v.toFixed(1).padStart(5)).join(''));
    console.log('    観測    ' + obsMon.map((v) => v.toFixed(1).padStart(5)).join(''));

    // 過大が起きている季節だけを取り出して因子を並べ直す。
    // 北半球の砂漠が大半なので 6〜8 月と 12〜2 月を比べる
    for (const [seasonName, months] of [
      ['北半球の夏(6〜8月)', [5, 6, 7]],
      ['北半球の冬(12〜2月)', [11, 0, 1]],
    ] as const) {
      const so2 = meanOn(d.supplyOcean, [...months]);
      const sl2 = meanOn(d.supplyLand, [...months]);
      const ss2 = meanOn(d.supplyStorm, [...months]);
      console.log(
        `  ${seasonName}  供給 海洋 ${so2.toFixed(3)} / 陸再循環 ${sl2.toFixed(3)} / ストーム ${ss2.toFixed(3)}`,
      );
      console.log(
        `      倍率  ITCZ ${meanOn(d.liftItcz, [...months]).toFixed(3)} / ` +
          `前線 ${meanOn(d.liftFrontal, [...months]).toFixed(3)} / ` +
          `収束 ${meanOn(d.liftConvergence, [...months]).toFixed(3)} / ` +
          `沈降残存 ${meanOn(d.subsidenceResidual, [...months]).toFixed(3)} / ` +
          `その他 ${meanOn(d.liftOther, [...months]).toFixed(3)}`,
      );
    }
  }
}

void main();
