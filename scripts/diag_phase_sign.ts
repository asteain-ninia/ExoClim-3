// 診断: **降水位相 72 日ずれの符号と分布 — 「天文直結」仮説の検定。**
//
// なぜ要るか(2026-08-18):
//   降水位相は 56 定数のどれでも動かない剛体と確定した(v5 較正でも
//   precipMonthBlend の全域掃引でも 72 日 ±0.2)。
//   仮説: モデルの雨の暦は ITCZ が**赤緯を遅れゼロで追う**ため天文に直結し、
//   実物の雨季(熱慣性で夏至から 1〜2 か月遅れる)より**一様に早い**のではないか。
//
//   検定: セルごとの位相差(モデルのピーク月 − 観測のピーク月)の**符号つき**
//   分布を出す。仮説が正しければ分布は「モデルが早い」側に偏る
//   (符号が揃う = 系統誤差 = 構造で直せる)。ばらけていれば別の原因。
//
// 実行: npx tsx scripts/diag_phase_sign.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';

import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

/** scoring.ts と同じ年調和解析(peak は月単位 0..12) */
function annualHarmonic(series: number[]): { amp: number; peak: number } {
  let a = 0;
  let b = 0;
  const n = series.length;
  for (let m = 0; m < n; m++) {
    const th = (2 * Math.PI * m) / n;
    a += (series[m] ?? 0) * Math.cos(th);
    b += (series[m] ?? 0) * Math.sin(th);
  }
  const amp = (2 / n) * Math.hypot(a, b);
  let peak = (Math.atan2(b, a) * n) / (2 * Math.PI);
  while (peak < 0) peak += n;
  return { amp, peak };
}

import { MODEL_CONSTANTS } from '../src/sim/constants';
const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: 値が数値でない '${key}'`);
    K[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

const OBS_MONTH_ORIGIN_OFFSET = 0.355; // scoring.ts と同じ(冬至起点と暦月の差)
const PRECIP_PHASE_MIN_RATIO = 0.25; // scoring.ts の既定と同じ趣旨(季節性のあるセルだけ)

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let r;
  try {
    r = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const clim = getClimObs();
  const land = r.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);

  // 帯ごとの符号つき位相差(日)。正 = モデルが遅い、負 = モデルが早い
  const BANDS: Array<[string, number, number]> = [
    ['熱帯 0〜15', 0, 15],
    ['亜熱帯 15〜35', 15, 35],
    ['中緯度 35〜60', 35, 60],
  ];
  const acc = BANDS.map(() => ({ w: 0, sum: 0, early: 0, late: 0, all: [] as Array<[number, number]> }));
  // 追加(段 46b の切り分け): 観測の雨の季節型ごとの内訳。
  // 夏雨型 = 観測ピークが当該半球の夏半年、冬雨型 = 冬半年。
  // 中緯度が「どの時計で動いているか」(ITCZ 系の夏雨か、前線系の冬雨か)を分ける
  const regimeAcc = BANDS.map(() => ({
    summer: { w: 0, sum: 0 },
    winter: { w: 0, sum: 0 },
  }));

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const bi = BANDS.findIndex(([, lo, hi]) => Math.abs(lat) >= lo && Math.abs(lat) < hi);
    if (bi < 0) continue;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      const pObsMon: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (v <= -9000) { ok = false; break; }
        pObsMon.push(Math.max(0, v));
      }
      if (!ok) continue;
      // 対応するモデルセル(2° ブロックの陸平均)
      const pMon = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) pMon[m] = (pMon[m] ?? 0) + (r.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) pMon[m] = (pMon[m] ?? 0) / n;

      const meanObs = pObsMon.reduce((x, y) => x + y, 0) / 12;
      const ho = annualHarmonic(pObsMon);
      if (!(meanObs > 0) || ho.amp / meanObs < PRECIP_PHASE_MIN_RATIO) continue;
      const hm = annualHarmonic(pMon);
      let dp = hm.peak - ho.peak - OBS_MONTH_ORIGIN_OFFSET;
      while (dp > 6) dp -= 12;
      while (dp < -6) dp += 12;
      const days = dp * 30.44;
      const a = acc[bi];
      if (!a) continue;
      a.w += w;
      a.sum += w * days;
      if (days < -15) a.early += w;
      else if (days > 15) a.late += w;
      a.all.push([days, w]);
      // 季節型: 観測ピーク月(冬至起点 → 暦月へ換算)が夏半年か冬半年か。
      // 北半球の夏半年 ≈ 暦月 5〜10(peak+offset を月 0..12 の環で判定)
      {
        let peakCal = ho.peak + OBS_MONTH_ORIGIN_OFFSET; // 冬至起点の月位置
        while (peakCal >= 12) peakCal -= 12;
        // 冬至起点なので 0 = 12月下旬。夏至は 6.0 付近。
        // 夏半年 = 夏至 ±3 か月(北) / 冬至 ±3 か月(南)
        const distToSolstice = Math.min(Math.abs(peakCal - 6), 12 - Math.abs(peakCal - 6));
        const isSummerPeak = lat >= 0 ? distToSolstice <= 3 : distToSolstice > 3;
        const g = regimeAcc[bi];
        if (g) {
          const slot = isSummerPeak ? g.summer : g.winter;
          slot.w += w;
          slot.sum += w * days;
        }
      }
    }
  }

  console.log('降水位相の符号つき誤差(モデルのピーク − 観測のピーク、日)');
  console.log('  負 = モデルの雨季が早い(天文直結仮説の予測)/ 正 = 遅い\n');
  console.log('帯              平均(日)   早い(>15日)%   遅い(>15日)%   中央値(日)');
  for (let bi = 0; bi < BANDS.length; bi++) {
    const a = acc[bi];
    if (!a || a.w <= 0) continue;
    const sorted = a.all.sort((x, y) => x[0] - y[0]);
    const tot = sorted.reduce((s, [, ww]) => s + ww, 0);
    let acc2 = 0;
    let med = 0;
    for (const [v, ww] of sorted) { acc2 += ww; if (acc2 >= tot / 2) { med = v; break; } }
    console.log(
      `${BANDS[bi]?.[0]?.padEnd(14) ?? ''} ${(a.sum / a.w).toFixed(1).padStart(8)}` +
        ` ${((100 * a.early) / a.w).toFixed(0).padStart(10)} %` +
        ` ${((100 * a.late) / a.w).toFixed(0).padStart(10)} %` +
        ` ${med.toFixed(1).padStart(10)}`,
    );
  }
  console.log('\n季節型ごとの内訳(平均ずれ 日 / 重み比):');
  console.log('帯              夏雨型            冬雨型');
  for (let bi = 0; bi < BANDS.length; bi++) {
    const g = regimeAcc[bi];
    const a = acc[bi];
    if (!g || !a || a.w <= 0) continue;
    const s = g.summer.w > 0 ? `${(g.summer.sum / g.summer.w).toFixed(1)} (${((100 * g.summer.w) / a.w).toFixed(0)}%)` : '—';
    const wtr = g.winter.w > 0 ? `${(g.winter.sum / g.winter.w).toFixed(1)} (${((100 * g.winter.w) / a.w).toFixed(0)}%)` : '—';
    console.log(`${BANDS[bi]?.[0]?.padEnd(14) ?? ''} ${s.padStart(16)} ${wtr.padStart(16)}`);
  }
  console.log(
    '\n読み: 「早い」に大きく偏っていれば天文直結(遅れゼロの暦)が原因で、\n' +
      '  熱慣性の遅れ(ITCZ を気温で駆動 or 明示的な位相遅れ)が処方になる。\n' +
      '  偏りが無ければ位相誤差は地域固有で、別の原因を掘る。',
  );
}

void main();
