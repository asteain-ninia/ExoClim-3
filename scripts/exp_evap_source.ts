// 検証: 保存則の源泉(海面蒸発 + 陸面蒸発散)は物理的に妥当な大きさか。
//
// 対応 spec: docs/事前登録_保存則への移行_2026-08-09.md の S2。
//
// なぜこれが関門なのか(利用者の警告、2026-08-09):
//   「保存ということは、もとの量を見誤れば誤差が非常に大きくなる」
//   非保存の乗数方式なら局所に留まる誤差が、保存則の下では下流へ運ばれて
//   非局所になる。**源泉が正しいことを、輸送を繋ぐ前に単独で確かめる。**
//
// **事前に登録した判定**(結果を見る前に固定済み):
//   主判定   … 全球平均の蒸発が 900〜1100 mm/年
//              （実地球の全球平均蒸発 ≒ 全球平均降水 ≒ 1000mm/年）
//   副判定 1 … 海の平均が陸の平均の 1.5〜3 倍（実地球は 1150 対 500 前後）
//   副判定 2 … 緯度分布の最大が**亜熱帯**に来る（赤道ではない）
//              ここを外すと循環の駆動が逆になる
//   副判定 3 … 現行の降水（陸平均 742mm/年）と桁が合う
//   棄却     … C_E 1.0〜1.5e-3 / RH 0.75〜0.85 の範囲で振っても主判定に
//              入らないなら、バルク式では源泉を作れないと結論して S3 を中止
//
// 実行: npx tsx scripts/exp_evap_source.ts [C_E,...]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { computeOceanEvaporation } from '../src/sim/evaporation';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { openAccel } from './accel_cli';

const COEFS = (process.argv[2] ?? '1.0e-3,1.2e-3,1.5e-3').split(',').map(Number);

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const accel = await openAccel();
  try {
    const result = await runPipeline(EARTH_PARAMS, accel.opts);
    const grid = result.context.grid;
    const land = result.context.terrain.landMask;

    // 陸面蒸発散(土壌バケツの実測値)は係数に依らないので先に集計
    let landW = 0;
    let landE = 0;
    const surf = result.precipitation.land;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5) * grid.resolutionDeg;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const i = row * grid.widthCells + col;
        if (!land[i]) continue;
        let e = 0;
        for (let m = 0; m < MONTHS_PER_YEAR; m++) e += surf?.monthlyEtMm[m]?.[i] ?? 0;
        landW += w;
        landE += w * e;
      }
    }
    const landMean = landW > 0 ? landE / landW : 0;

    // 陸海の面積比(面積重み)
    let wAll = 0;
    let wLand = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = 90 - (row + 0.5) * grid.resolutionDeg;
      const w = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        wAll += w;
        if (land[row * grid.widthCells + col]) wLand += w;
      }
    }
    const landFrac = wLand / wAll;

    console.log(`陸面蒸発散(土壌バケツ、係数に依らない): 陸平均 ${landMean.toFixed(0)} mm/年`);
    console.log(`陸の面積比 ${(landFrac * 100).toFixed(1)}%\n`);
    console.log('C_E        海の平均   陸の平均   全球平均   海/陸   亜熱帯最大?  主判定');

    for (const ce of COEFS) {
      K.evapBulkCoef = ce;
      const ev = computeOceanEvaporation(result.context, result.temperature, result.airflow);
      const oceanMean = ev.oceanMeanMmPerYear;
      const globalMean = landFrac * landMean + (1 - landFrac) * oceanMean;
      const ratio = landMean > 0 ? oceanMean / landMean : NaN;

      // 緯度帯ごとの海面蒸発(10° 帯)。最大がどこに来るか
      const band = new Map<number, { s: number; w: number }>();
      for (let row = 0; row < grid.heightCells; row++) {
        const lat = 90 - (row + 0.5) * grid.resolutionDeg;
        const w = Math.cos((lat * Math.PI) / 180);
        const b = Math.round(lat / 10) * 10;
        for (let col = 0; col < grid.widthCells; col++) {
          const i = row * grid.widthCells + col;
          if (land[i]) continue;
          let e = 0;
          for (let m = 0; m < MONTHS_PER_YEAR; m++) e += ev.monthlyOceanEvapMm[m]?.[i] ?? 0;
          const a = band.get(b) ?? { s: 0, w: 0 };
          a.s += w * e;
          a.w += w;
          band.set(b, a);
        }
      }
      let peak = 0;
      let peakLat = 0;
      for (const [b, a] of band) {
        const v = a.w > 0 ? a.s / a.w : 0;
        if (v > peak) {
          peak = v;
          peakLat = b;
        }
      }
      const subtropical = Math.abs(peakLat) >= 10 && Math.abs(peakLat) <= 40;
      const main = globalMean >= 900 && globalMean <= 1100;
      console.log(
        `${ce.toExponential(1).padStart(8)}  ${oceanMean.toFixed(0).padStart(8)}  ` +
          `${landMean.toFixed(0).padStart(8)}  ${globalMean.toFixed(0).padStart(8)}  ` +
          `${ratio.toFixed(2).padStart(5)}   ${(peakLat >= 0 ? peakLat + '°N' : -peakLat + '°S').padStart(6)} ` +
          `${subtropical ? '○' : '×'}      ${main ? '○' : '×'}`,
      );
    }

    console.log('\n===== 事前登録の判定 =====');
    console.log('  主判定   全球平均 900〜1100 mm/年');
    console.log('  副判定1  海/陸 が 1.5〜3');
    console.log('  副判定2  緯度分布の最大が亜熱帯(|10〜40°|)');
    console.log(`  副判定3  現行の降水（陸平均 742mm/年）と桁が合う`);
    console.log(
      '\n主判定を外し、C_E を 1.0〜1.5e-3 で振っても入らないなら、\n' +
        'バルク式では源泉を作れないと結論して保存則への接続(S3)を中止する。',
    );
  } finally {
    accel.close();
  }
}

void main();
