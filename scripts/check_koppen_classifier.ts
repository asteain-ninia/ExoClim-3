// 分類器そのものを検査する — 物理を一切通さずに。
//
// 発想(利用者の指摘 2026-08-01「物理を較正する前に分類器の夏冬判定・
// 半球反転・月インデックス・s/w 判定を疑え」):
//   気候フィクスチャは **Beck et al. 2023 が分類に使った当の月別平年値**
//   (1991-2020)である。したがってそれを我々の classifyKoppenCell に通せば、
//   Beck の気候区分図が再現されるはず。再現されなければ**分類器が壊れている**。
//   モデルの物理誤差とは完全に切り離して物差しだけを検査できる。
//
// 実行: npx tsx scripts/check_koppen_classifier.ts

import fs from 'node:fs';
import path from 'node:path';
import { classifyKoppenCell } from '../src/sim/step07_koppen';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';

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

const clim = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
) as ClimJson;
const obs = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_koppen_1deg.json'), 'utf8'),
) as KoppenJson;

const CW = clim.widthCells;
const CH = clim.heightCells;
const RES = 360 / CW; // 2°
const OW = obs.widthCells;
const OH = obs.heightCells;
const scale = Math.round(OW / CW); // 1° → 2° なら 2

console.log(`気候値 ${CW}×${CH}(${RES}°)/ 観測区分 ${OW}×${OH}(倍率 ${scale})`);

/** 2° セルに対応する 1° 観測セルの最頻クラス(海 = 0 は除く) */
function obsMajority(row: number, col: number): number {
  const counts = new Map<number, number>();
  for (let dr = 0; dr < scale; dr++) {
    for (let dc = 0; dc < scale; dc++) {
      const r = row * scale + dr;
      const c = col * scale + dc;
      if (r >= OH) continue;
      const id = obs.classRaster[r * OW + (c % OW)] ?? 0;
      if (id === 0) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = id;
    }
  }
  return best;
}

let compared = 0;
let majorHit = 0;
let detailHit = 0;
/** 誤りの内訳: 「観測クラス → 我々のクラス」 */
const confusion = new Map<string, number>();
/** 第 2 文字(s/w/f)の食い違いだけを別に数える — 季節判定の健全性 */
let secondCompared = 0;
let secondHit = 0;
const secondConf = new Map<string, number>();

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
    const truth = obsMajority(row, col);
    if (truth === 0) continue;
    const mine = classifyKoppenCell(t, p, lat >= 0);
    compared++;
    const symTruth = KOPPEN_CLASSES[truth] ?? '?';
    const symMine = KOPPEN_CLASSES[mine] ?? '?';
    if (mine === truth) detailHit++;
    if (majorClassOf(mine) === majorClassOf(truth)) majorHit++;
    else {
      const key = `${symTruth} → ${symMine}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
    // C/D 群だけ第 2 文字を比べる(s/w/f の判定が本題)
    const gT = symTruth[0];
    const gM = symMine[0];
    if ((gT === 'C' || gT === 'D') && gT === gM) {
      secondCompared++;
      if (symTruth[1] === symMine[1]) secondHit++;
      else {
        const key = `${symTruth[1]} → ${symMine[1]}`;
        secondConf.set(key, (secondConf.get(key) ?? 0) + 1);
      }
    }
  }
}

console.log(`\n比較セル ${compared.toLocaleString()}`);
console.log(`  大分類(A/B/C/D/E)一致: ${((majorHit / compared) * 100).toFixed(2)}%`);
console.log(`  詳細クラス一致:        ${((detailHit / compared) * 100).toFixed(2)}%`);
console.log(
  `\nC/D 群で群が一致したセル ${secondCompared.toLocaleString()} のうち、` +
    `第 2 文字(s/w/f)一致 ${((secondHit / secondCompared) * 100).toFixed(2)}%`,
);
if (secondConf.size > 0) {
  console.log('  第 2 文字の食い違い(観測 → 我々):');
  for (const [k, v] of [...secondConf].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${k}: ${v}`);
  }
}
console.log('\n大分類が外れた組合せ 上位 15(観測 → 我々):');
for (const [k, v] of [...confusion].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${k.padEnd(14)} ${v}`);
}
console.log(
  '\n判定: 分類器が正しければ大分類は 90% 以上一致するはず' +
    '(残差は 2°/1° の解像度差と平年値の丸めによる)。',
);
