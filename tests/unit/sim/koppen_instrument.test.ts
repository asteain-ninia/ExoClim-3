// 物差し(ケッペン分類器)そのものの検査。
//
// 気候フィクスチャは **Beck et al. 2023 が分類に使った当の月別平年値**
// (1991-2020)。したがってそれを我々の分類器に通せば Beck の区分図が
// 再現されるはず。再現されなければ、モデルの物理ではなく**分類器が壊れている**。
//
// これは「物理を較正する前に物差しを確かめる」ためのテスト(教訓 §1 客観の物差し)。
// 夏冬の月集合・半球反転・s/w 判定・月インデックスを一括で守る。
//
// しきい値は 2026-08-01 の実測(大分類 96.44% / 詳細 92.05% / 第 2 文字 95.67%)を
// 見て決めた**退行防止**の値であり、下げてはならない。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyKoppenCell } from '../../../src/sim/step07_koppen';
import { KOPPEN_CLASSES, majorClassOf } from '../../../src/domain/koppen';

interface ClimJson {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}
interface KoppenJson {
  widthCells: number;
  heightCells: number;
  classRaster: number[];
}

const root = process.cwd();
const clim = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;
const obs = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/earth_koppen_1deg.json'), 'utf8'),
) as KoppenJson;

interface Tally {
  compared: number;
  majorHit: number;
  detailHit: number;
  secondCompared: number;
  secondHit: number;
  /** 観測 f を我々が s と呼んだ数(季節位相のずれの兆候) */
  fToS: number;
  /** 観測 w を我々が s と呼んだ数(同上) */
  wToS: number;
}

function tally(): Tally {
  const CW = clim.widthCells;
  const CH = clim.heightCells;
  const RES = 360 / CW;
  const OW = obs.widthCells;
  const OH = obs.heightCells;
  const scale = Math.round(OW / CW);
  const out: Tally = {
    compared: 0,
    majorHit: 0,
    detailHit: 0,
    secondCompared: 0,
    secondHit: 0,
    fToS: 0,
    wToS: 0,
  };
  for (let row = 0; row < CH; row++) {
    const lat = 90 - (row + 0.5) * RES;
    for (let col = 0; col < CW; col++) {
      const i = row * CW + col;
      const t: number[] = [];
      const p: number[] = [];
      let missing = false;
      for (let m = 0; m < 12; m++) {
        const tv = clim.monthlyTemperatureDeciC[m]?.[i] ?? -9999;
        const pv = clim.monthlyPrecipitationMm[m]?.[i] ?? -9999;
        if (tv <= -9000 || pv <= -9000) {
          missing = true;
          break;
        }
        t.push(tv / 10);
        p.push(Math.max(0, pv));
      }
      if (missing) continue;
      // 対応する 1° 観測セルの最頻クラス
      const counts = new Map<number, number>();
      for (let dr = 0; dr < scale; dr++) {
        for (let dc = 0; dc < scale; dc++) {
          const r = row * scale + dr;
          if (r >= OH) continue;
          const id = obs.classRaster[r * OW + ((col * scale + dc) % OW)] ?? 0;
          if (id !== 0) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
      let truth = 0;
      let bestN = 0;
      for (const [id, n] of counts) {
        if (n > bestN) {
          bestN = n;
          truth = id;
        }
      }
      if (truth === 0) continue;
      const mine = classifyKoppenCell(t, p, lat >= 0);
      out.compared++;
      if (mine === truth) out.detailHit++;
      if (majorClassOf(mine) === majorClassOf(truth)) out.majorHit++;
      const sT = KOPPEN_CLASSES[truth] ?? '';
      const sM = KOPPEN_CLASSES[mine] ?? '';
      if ((sT[0] === 'C' || sT[0] === 'D') && sT[0] === sM[0]) {
        out.secondCompared++;
        if (sT[1] === sM[1]) out.secondHit++;
        if (sT[1] === 'f' && sM[1] === 's') out.fToS++;
        if (sT[1] === 'w' && sM[1] === 's') out.wToS++;
      }
    }
  }
  return out;
}

describe('ケッペン分類器の実地検査(Beck の平年値 → Beck の区分図)', () => {
  const r = tally();

  it('比較対象が十分にある(フィクスチャの取り違えを検出)', () => {
    expect(r.compared).toBeGreaterThan(5000);
    expect(r.secondCompared).toBeGreaterThan(1500);
  });

  it('大分類 A/B/C/D/E を 95% 以上再現する', () => {
    expect((r.majorHit / r.compared) * 100).toBeGreaterThanOrEqual(95);
  });

  it('詳細クラスを 90% 以上再現する', () => {
    expect((r.detailHit / r.compared) * 100).toBeGreaterThanOrEqual(90);
  });

  it('第 2 文字 s/w/f を 94% 以上再現する(夏冬の月集合・半球反転・閾値)', () => {
    expect((r.secondHit / r.secondCompared) * 100).toBeGreaterThanOrEqual(94);
  });

  it('夏乾燥 s を作り出す偏りが無い(季節位相のずれの検出)', () => {
    // 月インデックスや半球反転がずれると、本来 f/w の土地が一斉に s になる。
    // 実測(2026-08-01)は f→s が 3 セル、w→s が 1 セルで、
    // 逆向き(s→f 43・w→f 27)のほうが多い = 2° 平均で季節振幅が鈍るため。
    expect(r.fToS).toBeLessThan(20);
    expect(r.wToS).toBeLessThan(20);
  });
});
