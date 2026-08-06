// 診断: 冷帯の夏が 4〜5°C 暑すぎる。水が届いていないのか、放射なのか。
//
// 対応 spec: なし(原因の切り分け)。
//
// なぜ要るか(2026-08-06、diag_boreal_letters.ts の続き):
//   D の第 3 文字の一致は、最暖月と 10°C 以上の月数を観測に差し替えるだけで
//   31.3% → 84.8% へ跳ねた。**冷帯の詳細一致の失敗はほぼ全部「夏が暑い」の一変数**。
//   ずれは 40〜60°N で +4.8〜+5.4°C。
//
//   仮説は 2 つあり、打ち手が正反対になる:
//     (H1) 大陸内部へ水が届いていない → 土壌が乾く → 蒸発散が小さい →
//          潜熱で冷えず夏が暑い。中国東部が砂漠になる件と同じ根。
//          打ち手は水輸送。
//     (H2) 水は届いているが、地表エネルギー収支の側(蒸発冷却の係数・夏の雲・
//          OLR の温度依存)が足りない。打ち手は放射と地表収支。
//
//   切り分けは簡単で、**観測 D 帯の夏の降水がモデルで合っているか**を見ればよい。
//   合っていて夏が暑いなら H2。乾いているなら H1。
//
// 実行: npx tsx scripts/diag_boreal_summer.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

/** 北半球の夏 = 6〜8 月、南半球 = 12〜2 月(月は 0 起点) */
const summerMonths = (lat: number): number[] => (lat >= 0 ? [5, 6, 7] : [11, 0, 1]);

async function main(): Promise<void> {
  const accel = await openAccel();
  let result: PipelineResult;
  try {
    result = await runPipeline(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }

  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const surf = result.precipitation.land;
  if (!surf) console.log('注意: 陸面の水の状態が無効(土壌水分オフ)。ET と湿りは出ない\n');

  interface Row {
    lat: number;
    dTmax: number;
    pSumObs: number;
    pSumMdl: number;
    etSum: number;
    wet: number;
    tMaxObs: number;
  }
  const rows: Row[] = [];

  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 90 - (cr + 0.5) * 2;
    const sm = summerMonths(lat);
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
      const tMaxObs = Math.max(...tObs);
      const tMinObs = Math.min(...tObs);
      if (!(tMinObs <= 0 && tMaxObs >= 10)) continue; // 観測 D 帯だけ

      const tM = new Array<number>(12).fill(0);
      const pM = new Array<number>(12).fill(0);
      const etM = new Array<number>(12).fill(0);
      const wetM = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++) {
            tM[m] = (tM[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
            pM[m] = (pM[m] ?? 0) + (result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
            if (surf) {
              etM[m] = (etM[m] ?? 0) + (surf.monthlyEtMm[m]?.[gi] ?? 0);
              wetM[m] = (wetM[m] ?? 0) + (surf.monthlyWetness01[m]?.[gi] ?? 0);
            }
          }
        }
      }
      if (n === 0) continue;
      const avg = (a: number[], m: number): number => (a[m] ?? 0) / n;
      rows.push({
        lat,
        dTmax: Math.max(...tM.map((_, m) => avg(tM, m))) - tMaxObs,
        pSumObs: sm.reduce((a, m) => a + (pObs[m] ?? 0), 0),
        pSumMdl: sm.reduce((a, m) => a + avg(pM, m), 0),
        etSum: sm.reduce((a, m) => a + avg(etM, m), 0),
        wet: sm.reduce((a, m) => a + avg(wetM, m), 0) / 3,
        tMaxObs,
      });
    }
  }

  console.log(`観測 D 帯の 2° セル ${rows.length} 個。夏 = 6〜8 月(南半球は 12〜2 月)\n`);
  console.log('緯度帯     個数  最暖月ずれ   夏の降水(観測→モデル)   夏の蒸発散  夏の湿り  蒸発散/降水');
  const bands = [
    [30, 40],
    [40, 50],
    [50, 60],
    [60, 70],
    [70, 80],
  ];
  for (const [lo, hi] of bands) {
    const g = rows.filter((r) => Math.abs(r.lat) >= lo! && Math.abs(r.lat) < hi!);
    if (g.length === 0) continue;
    const mean = (sel: (r: Row) => number): number => g.reduce((a, r) => a + sel(r), 0) / g.length;
    const pO = mean((r) => r.pSumObs);
    const pM = mean((r) => r.pSumMdl);
    const et = mean((r) => r.etSum);
    console.log(
      `  ${lo}〜${hi}°  ${String(g.length).padStart(5)}   ` +
        `${(mean((r) => r.dTmax) >= 0 ? '+' : '') + mean((r) => r.dTmax).toFixed(2)}°C     ` +
        `${pO.toFixed(0).padStart(4)} → ${pM.toFixed(0).padStart(4)} mm (${((pM / pO - 1) * 100 >= 0 ? '+' : '') + ((pM / pO - 1) * 100).toFixed(0)}%)   ` +
        `${et.toFixed(0).padStart(5)} mm   ${mean((r) => r.wet).toFixed(3)}   ${(et / pM).toFixed(2)}`,
    );
  }

  // 降水が合っているセルだけに絞って、それでも夏が暑いかを見る(切り分けの核心)
  const close = rows.filter((r) => r.pSumObs > 0 && Math.abs(r.pSumMdl / r.pSumObs - 1) < 0.25);
  const dry = rows.filter((r) => r.pSumObs > 0 && r.pSumMdl / r.pSumObs < 0.75);
  const wet = rows.filter((r) => r.pSumObs > 0 && r.pSumMdl / r.pSumObs > 1.25);
  const m = (g: Row[]): string =>
    g.length === 0 ? '—' : ((g.reduce((a, r) => a + r.dTmax, 0) / g.length) >= 0 ? '+' : '') +
      (g.reduce((a, r) => a + r.dTmax, 0) / g.length).toFixed(2) + '°C';
  console.log('\n切り分け: 夏の降水の当たり具合ごとに、最暖月のずれを見る');
  console.log(`  降水が乾きすぎ(−25% 超)  ${String(dry.length).padStart(5)} 個   最暖月 ${m(dry)}`);
  console.log(`  降水がほぼ合っている(±25%) ${String(close.length).padStart(5)} 個   最暖月 ${m(close)}`);
  console.log(`  降水が湿りすぎ(+25% 超)  ${String(wet.length).padStart(5)} 個   最暖月 ${m(wet)}`);
  console.log(
    '\n  → 降水が合っているセルでも夏が同じだけ暑ければ、原因は水輸送ではなく地表収支・放射(H2)。',
  );
}

void main();
