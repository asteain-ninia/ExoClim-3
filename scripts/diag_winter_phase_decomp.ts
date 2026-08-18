// 診断: **冬雨型セルの位相はどの因子の暦が決めているか(段 46c の判定後)。**
//
// なぜ要るか(2026-08-18):
//   冬雨型(観測ピークが冬半年、亜熱帯 22%・中緯度 25%)はモデルが 2.4 か月
//   早く、位相 RMSE の支配者。ITCZ 遅れ(46)は効かず、冬ゲート遅れ(46c)も
//   −1.2 日しか動かなかった。残る容疑者は「帯の被覆 × 供給の秋ピーク」。
//   保存型では P = λ·G·W なので、位相は G(持上げ・沈降の積)と W(輸送が
//   解いた水)の積で決まる。**どちらの暦が早いのか**を、冬雨型セル上の
//   月別平均系列の調和ピークで直接測る。
//
// 使い方: npx tsx scripts/diag_winter_phase_decomp.ts
//   DIAG_OVERRIDE='circulationLagMonths=1' などで定数上書き可。
//
// 出力: 冬雨型セル(帯別)上の面積重み平均系列の調和ピーク月
//   (北半球の暦へ揃える — 南半球セルは 6 か月回して合算)。
//   観測降水 / モデル降水 / 供給計 / 海洋供給 / liftOther(帯×冬ゲート) /
//   condRateG / waterMm。

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';

import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';

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
const PRECIP_PHASE_MIN_RATIO = 0.25;

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

/** 12 か月系列に月数を足して回す(南半球→北半球暦の変換用) */
function rotate(series: number[], by: number): number[] {
  const out = new Array<number>(12);
  for (let m = 0; m < 12; m++) out[m] = series[(m + by + 12) % 12] ?? 0;
  return out;
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const r = out.result;
  const d = out.precipDiag;
  const grid = r.context.grid;
  const clim = getClimObs();
  const land = r.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const W = grid.widthCells;

  const BANDS: Array<[string, number, number]> = [
    ['亜熱帯 15〜35', 15, 35],
    ['中緯度 35〜60', 35, 60],
  ];

  // 各帯の冬雨型セル上の面積重み平均系列(北半球暦)。
  // series[名前][month] を積み上げる
  const NAMES = ['観測降水', 'モデル降水', '供給計', '海洋供給', 'liftOther', 'condRateG', 'waterMm'] as const;
  const acc = BANDS.map(() => ({
    w: 0,
    s: NAMES.map(() => new Array<number>(12).fill(0)),
  }));

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const bi = BANDS.findIndex(([, lo, hi]) => Math.abs(lat) >= lo && Math.abs(lat) < hi);
    if (bi < 0) continue;
    const wCos = Math.cos((lat * Math.PI) / 180);
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
      const meanObs = pObsMon.reduce((x, y) => x + y, 0) / 12;
      const ho = annualHarmonic(pObsMon);
      if (!(meanObs > 0) || ho.amp / meanObs < PRECIP_PHASE_MIN_RATIO) continue;
      // 冬雨型の判定(diag_phase_sign と同じ): 観測ピークが冬半年
      let peakCal = ho.peak + OBS_MONTH_ORIGIN_OFFSET;
      while (peakCal >= 12) peakCal -= 12;
      const distToSolstice = Math.min(Math.abs(peakCal - 6), 12 - Math.abs(peakCal - 6));
      const isSummerPeak = lat >= 0 ? distToSolstice <= 3 : distToSolstice > 3;
      if (isSummerPeak) continue;

      // モデル側のセル平均系列(2° ブロックの陸平均)
      const series = NAMES.map(() => new Array<number>(12).fill(0));
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * W + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            series[1]![m]! += r.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0;
            const sO = d.supplyOcean[m]?.[gi] ?? 0;
            const sL = d.supplyLand[m]?.[gi] ?? 0;
            const sS = d.supplyStorm[m]?.[gi] ?? 0;
            series[2]![m]! += sO + sL + sS;
            series[3]![m]! += sO;
            series[4]![m]! += d.liftOther[m]?.[gi] ?? 0;
            series[5]![m]! += d.condRateG[m]?.[gi] ?? 0;
            series[6]![m]! += d.waterMm[m]?.[gi] ?? 0;
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) {
        series[0]![m] = pObsMon[m] ?? 0;
        for (let k = 1; k < NAMES.length; k++) series[k]![m]! /= n;
      }
      // 南半球は 6 か月回して北半球暦に揃える
      const rot = lat >= 0 ? 0 : 6;
      const a = acc[bi];
      if (!a) continue;
      a.w += wCos;
      for (let k = 0; k < NAMES.length; k++) {
        const rs = rotate(series[k]!, rot);
        for (let m = 0; m < 12; m++) a.s[k]![m]! += wCos * (rs[m] ?? 0);
      }
    }
  }

  console.log('冬雨型セル上の月別平均系列の調和ピーク(北半球暦、月 0=1月)');
  console.log('  観測の位相起点補正は「観測降水」行にのみ適用(モデル系列は素の月)\n');
  for (let bi = 0; bi < BANDS.length; bi++) {
    const a = acc[bi];
    if (!a || a.w <= 0) continue;
    console.log(`--- ${BANDS[bi]?.[0]} (重み ${a.w.toFixed(1)}) ---`);
    console.log('系列          ピーク月   振幅/平均    月別(1〜12月)');
    for (let k = 0; k < NAMES.length; k++) {
      const s = a.s[k]!.map((x) => x / a.w);
      const h = annualHarmonic(s);
      const mean = s.reduce((x, y) => x + y, 0) / 12;
      // 観測は冬至起点なので暦月へ補正。モデル系列は month=0 が 1 月
      const peakCal = k === 0 ? (h.peak + OBS_MONTH_ORIGIN_OFFSET) % 12 : h.peak;
      const vals = s.map((x) => (mean !== 0 ? (x / mean).toFixed(2) : '0')).join(' ');
      console.log(
        `${NAMES[k]!.padEnd(10)} ${(peakCal + 1).toFixed(1).padStart(7)}` +
          ` ${(mean !== 0 ? h.amp / mean : 0).toFixed(2).padStart(9)}    ${vals}`,
      );
    }
    console.log('');
  }
  console.log(
    '読み: モデル降水のピーク月と、供給計 / liftOther / waterMm のピーク月を比べる。\n' +
      '  供給や W のピークが秋(9〜10 月)にあり降水がそれに引かれていれば、\n' +
      '  「供給の暦」が犯人。liftOther が至点(12〜1 月)ピークなら帯×ゲートは正しい暦。',
  );
}

void main();
