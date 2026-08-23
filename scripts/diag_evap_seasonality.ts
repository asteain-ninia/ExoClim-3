// 診断: **蒸発 S の季節性 — W が季節を持てない真因の測定(台帳 項目 3)。**
//
// なぜ要るか(2026-08-23): λ を 1/3 にして τ を 2.5→5.6 日に伸ばしても
// W の月別相対振幅は ±7% のままだった(docs/事前登録_滞留時間λの掃引)。
// W = S/rate の定常なので、W の季節性は**供給 S の季節性**が決める。
// 実物の中緯度・亜熱帯の海は「冬に大気が冷たく海が相対的に暖かい」ため
// 冬の蒸発が強い(海面-大気の湿度差が大きい)。モデルの式は
//   E = ρ · C_E · |V| · q_s(T_s) · (1 − RH)
// で **RH が定数**・T_s は海面温度なので、**冬に q_s が下がって蒸発も下がる**
// = 実物と逆位相になっている疑い。それを場と月で測る。
//
// 実行: npx tsx scripts/diag_evap_seasonality.ts
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow } from '../src/domain/grid';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { computeOceanEvaporation } from '../src/sim/evaporation';
import { openAccel } from './accel_cli';

const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [n, v] = part.split('=');
    if (n && n.trim() in K) { K[n.trim()] = Number(v); console.log(`[上書き] ${n.trim()} = ${v}`); }
  }
}

function harmonicPeak(series: number[]): { amp: number; peak: number; mean: number } {
  let a = 0, b = 0;
  for (let m = 0; m < 12; m++) {
    const th = (2 * Math.PI * (m + 0.5)) / 12;
    a += (series[m] ?? 0) * Math.cos(th);
    b += (series[m] ?? 0) * Math.sin(th);
  }
  a = (2 * a) / 12; b = (2 * b) / 12;
  let phi = Math.atan2(b, a);
  if (phi < 0) phi += 2 * Math.PI;
  const mean = series.reduce((x, y) => x + y, 0) / 12;
  return { amp: Math.hypot(a, b), peak: (phi / (2 * Math.PI)) * 12, mean };
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try { out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts); } finally { accel.close(); }
  const r = out.result;
  const evap = computeOceanEvaporation(r.context, r.temperature, r.airflow);
  const grid = r.context.grid;
  const W = grid.widthCells;
  const land = r.context.terrain.landMask;

  const BANDS: Array<[string, number, number]> = [
    ['熱帯 0〜15', 0, 15], ['亜熱帯 15〜35', 15, 35], ['中緯度 35〜60', 35, 60],
  ];
  // 北半球の海だけを見る(南半球は季節が逆なので混ぜない)
  for (const [name, lo, hi] of BANDS) {
    const evapMon = new Array<number>(12).fill(0);
    const sstMon = new Array<number>(12).fill(0);
    const windMon = new Array<number>(12).fill(0);
    const waterMon = new Array<number>(12).fill(0);
    let wsum = 0;
    for (let m = 0; m < 12; m++) {
      let s = 0, t = 0, wd = 0, wt = 0, ww = 0;
      for (let row = 0; row < grid.heightCells; row++) {
        const lat = latDegOfRow(grid, row);
        if (lat < lo || lat >= hi) continue; // 北半球のみ
        const cw = Math.cos((lat * Math.PI) / 180);
        for (let col = 0; col < W; col++) {
          const i = row * W + col;
          if (land[i]) continue;
          s += cw * (evap.monthlyOceanEvapMm[m]?.[i] ?? 0);
          t += cw * (r.temperature.monthlyTemperatureC[m]?.[i] ?? 0);
          wd += cw * Math.hypot(r.airflow.monthlyWindU[m]?.[i] ?? 0, r.airflow.monthlyWindV[m]?.[i] ?? 0);
          wt += cw * (out.precipDiag.waterMm[m]?.[i] ?? 0);
          ww += cw;
        }
      }
      if (ww === 0) continue;
      evapMon[m] = s / ww; sstMon[m] = t / ww; windMon[m] = wd / ww; waterMon[m] = wt / ww;
      wsum = ww;
    }
    if (wsum === 0) continue;
    const he = harmonicPeak(evapMon), hw = harmonicPeak(waterMon);
    console.log(`\n--- ${name}(北半球の海)---`);
    console.log('月       ' + evapMon.map((_, m) => String(m + 1).padStart(6)).join(''));
    console.log('蒸発mm/月' + evapMon.map((x) => x.toFixed(0).padStart(6)).join(''));
    console.log('海面温度 ' + sstMon.map((x) => x.toFixed(1).padStart(6)).join(''));
    console.log('風速m/s  ' + windMon.map((x) => x.toFixed(1).padStart(6)).join(''));
    console.log('W(mm)   ' + waterMon.map((x) => x.toFixed(1).padStart(6)).join(''));
    console.log(`蒸発: ピーク ${he.peak.toFixed(1)} 月 / 相対振幅 ${(he.amp / Math.max(1e-9, he.mean)).toFixed(3)}`);
    console.log(`W   : ピーク ${hw.peak.toFixed(1)} 月 / 相対振幅 ${(hw.amp / Math.max(1e-9, hw.mean)).toFixed(3)}`);
  }
  console.log(
    '\n読み: 実物の中緯度・亜熱帯の海は**冬に蒸発が強い**(冷たく乾いた大気が' +
      '暖かい海面上を吹くため)。モデルの式は q_s(T_s)×(1−RH 定数) なので' +
      '\n  冬に q_s が下がって蒸発も下がる = **逆位相**になっているはず。' +
      'ピーク月が夏(6〜8)なら逆位相を確認。',
  );
}
void main();
