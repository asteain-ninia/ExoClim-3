// 診断: 冷帯(D)の詳細一致が 19.7% しかない理由を、文字を決める量まで割る。
//
// 対応 spec: なし(採点の解釈)。
//
// なぜ要るか(2026-08-06):
//   大分類ごとの内訳で D 冷帯だけ「大分類 78.0% / 詳細 19.7%」と乖離が異常。
//   面積シェア 24.5% と最大の分類なので、**ここが全体の詳細一致を押し下げている**。
//   ケッペンの D の第 3 文字は気温だけで決まる:
//     a = 最暖月 ≥ 22°C / b = 最暖月 < 22 かつ 10°C 以上が 4 か月以上
//     c = 10°C 以上が 1〜3 か月 / d = 最寒月 ≤ −38°C
//   つまり**どの量がどれだけずれて文字を変えているか**が測れる。
//
//   Beck(1°)と気候値(2°)の格子違いを避けるため、**すべて 2° の気候値の上で**
//   計算する。観測の文字も気候値から起こすので、比較は同じ土俵になる。
//
// 実行: npx tsx scripts/diag_boreal_letters.ts

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { getClimObs } from './scoring';
import { openAccel } from './accel_cli';
import type { PipelineResult } from '../src/sim/types';

interface Cell {
  tMax: number;
  tMin: number;
  nWarm: number; // 10°C 以上の月数
  annual: number;
}

function summarize(monthly: number[]): Cell {
  return {
    tMax: Math.max(...monthly),
    tMin: Math.min(...monthly),
    nWarm: monthly.filter((t) => t >= 10).length,
    annual: monthly.reduce((a, b) => a + b, 0) / 12,
  };
}

/** D の第 3 文字(気温だけで決まる) */
function thirdLetter(c: Cell): string {
  if (c.tMin <= -38) return 'd';
  if (c.tMax >= 22) return 'a';
  if (c.nWarm >= 4) return 'b';
  return 'c';
}

/** D 帯かどうか(最寒月 ≤ 0°C かつ 最暖月 ≥ 10°C。第 1 文字の条件) */
function isD(c: Cell): boolean {
  return c.tMin <= 0 && c.tMax >= 10;
}

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

  const pairs: Array<{ obs: Cell; mdl: Cell; lat: number }> = [];
  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 90 - (cr + 0.5) * 2;
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const ci = cr * clim.widthCells + cc;
      // 観測(欠測があれば捨てる)
      const tObs: number[] = [];
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (t === -9999) {
          ok = false;
          break;
        }
        tObs.push(t / 10);
      }
      if (!ok) continue;
      // モデル(採点と同じ 2° 集約)
      const tMdl = new Array<number>(12).fill(0);
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          for (let m = 0; m < 12; m++)
            tMdl[m] = (tMdl[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) tMdl[m] = (tMdl[m] ?? 0) / n;
      pairs.push({ obs: summarize(tObs), mdl: summarize(tMdl), lat });
    }
  }

  // 観測が D 帯のセルだけ見る
  const dCells = pairs.filter((p) => isD(p.obs));
  console.log(`観測が D 帯(最寒月 ≤ 0°C, 最暖月 ≥ 10°C)の 2° セル: ${dCells.length} 個\n`);

  // 文字ごとの混同
  const letters = ['a', 'b', 'c', 'd'];
  const conf: Record<string, Record<string, number>> = {};
  for (const l of letters) conf[l] = { a: 0, b: 0, c: 0, d: 0, 外: 0 };
  for (const p of dCells) {
    const lo = thirdLetter(p.obs);
    const lm = isD(p.mdl) ? thirdLetter(p.mdl) : '外';
    conf[lo]![lm] = (conf[lo]![lm] ?? 0) + 1;
  }
  console.log('第 3 文字の混同(行=観測、列=モデル。「外」はモデルが D 帯から外れた)');
  console.log('観測\\モデル      a      b      c      d      外    一致率');
  for (const lo of letters) {
    const row = conf[lo]!;
    const tot = Object.values(row).reduce((a, b) => a + b, 0);
    if (tot === 0) continue;
    const cells = [...letters, '外'].map((lm) => String(row[lm] ?? 0).padStart(6)).join(' ');
    console.log(`  D_${lo}      ${cells}   ${(((row[lo] ?? 0) / tot) * 100).toFixed(1).padStart(6)}%`);
  }

  // 文字を決める量のずれ
  console.log('\n文字を決める 3 つの量のずれ(観測の文字ごと、モデル − 観測の平均)');
  console.log('観測    個数   最暖月      最寒月     10°C 以上の月数');
  for (const lo of letters) {
    const g = dCells.filter((p) => thirdLetter(p.obs) === lo);
    if (g.length === 0) continue;
    const d = (sel: (c: Cell) => number): string => {
      const v = g.reduce((a, p) => a + (sel(p.mdl) - sel(p.obs)), 0) / g.length;
      return (v >= 0 ? '+' : '') + v.toFixed(2);
    };
    const obsAvg = (sel: (c: Cell) => number): string =>
      (g.reduce((a, p) => a + sel(p.obs), 0) / g.length).toFixed(1);
    console.log(
      `  D_${lo}  ${String(g.length).padStart(5)}   ` +
        `${d((c) => c.tMax).padStart(7)}°C (観測 ${obsAvg((c) => c.tMax).padStart(5)})   ` +
        `${d((c) => c.tMin).padStart(7)}°C (観測 ${obsAvg((c) => c.tMin).padStart(6)})   ` +
        `${d((c) => c.nWarm).padStart(6)} (観測 ${obsAvg((c) => c.nWarm)})`,
    );
  }

  // 「最暖月だけ観測に差し替えたら文字は何点当たるか」= 上限の見積り
  let hitNow = 0;
  let hitIfMax = 0;
  let hitIfMin = 0;
  let hitIfBoth = 0;
  for (const p of dCells) {
    const lo = thirdLetter(p.obs);
    if (isD(p.mdl) && thirdLetter(p.mdl) === lo) hitNow++;
    const swapMax: Cell = { ...p.mdl, tMax: p.obs.tMax, nWarm: p.obs.nWarm };
    const swapMin: Cell = { ...p.mdl, tMin: p.obs.tMin };
    const swapBoth: Cell = { ...p.obs };
    if (isD(swapMax) && thirdLetter(swapMax) === lo) hitIfMax++;
    if (isD(swapMin) && thirdLetter(swapMin) === lo) hitIfMin++;
    if (isD(swapBoth) && thirdLetter(swapBoth) === lo) hitIfBoth++;
  }
  const pct = (n: number): string => ((n / dCells.length) * 100).toFixed(1) + '%';
  console.log('\n仮想実験: どの量を観測に差し替えると文字が当たるようになるか');
  console.log(`  現状                        ${pct(hitNow)}`);
  console.log(`  最暖月と 10°C 以上の月数を観測に  ${pct(hitIfMax)}`);
  console.log(`  最寒月だけ観測に              ${pct(hitIfMin)}`);
  console.log(`  全部観測に(上限の検算)        ${pct(hitIfBoth)}`);

  // 緯度帯ごとの夏のずれ(どこで暑すぎるのか)
  console.log('\n観測 D 帯の緯度帯ごと、最暖月のずれ(モデル − 観測)');
  console.log('緯度帯    個数   最暖月ずれ   最寒月ずれ');
  for (let lo = 30; lo < 80; lo += 10) {
    const g = dCells.filter((p) => Math.abs(p.lat) >= lo && Math.abs(p.lat) < lo + 10);
    if (g.length === 0) continue;
    const dMax = g.reduce((a, p) => a + (p.mdl.tMax - p.obs.tMax), 0) / g.length;
    const dMin = g.reduce((a, p) => a + (p.mdl.tMin - p.obs.tMin), 0) / g.length;
    console.log(
      `  ${lo}〜${lo + 10}°  ${String(g.length).padStart(5)}   ` +
        `${(dMax >= 0 ? '+' : '') + dMax.toFixed(2)}°C     ${(dMin >= 0 ? '+' : '') + dMin.toFixed(2)}°C`,
    );
  }
}

void main();
