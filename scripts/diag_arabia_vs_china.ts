// 診断: **アラビア(正しく乾燥)と華中型 C→B(誤って乾燥)を分ける量はどれか。**
//
// なぜ要るか(2026-08-17):
//   C→B の主因は「夏も沈降帯の芯にいる」(descW 0.999)と確定した。
//   実物では夏の大陸のモンスーン域は沈降がトラフに置き換わるので、
//   モンスーンセクターで沈降を緩める設計になるが、**同緯度のアラビアも
//   陸の多い経度・ITCZ 変位ありの条件を満たしてしまう**。
//   利用者の問いそのもの:「アラビアは南端まで乾燥、同緯度の中華は湿潤、なんで?」
//
//   定説(Rodwell–Hoskins 1996)は「モンスーン加熱の**西側**に下降流が立つ」。
//   アラビアはインドの加熱の西で沈降が強化され、華中は自分の加熱の中にいる。
//
//   では**モデル内のどの量が**この 2 群を分けるか。候補を全部並べて測る:
//     W(輸送された水蒸気)/ 供給 / 東海洋の暖かさゲート(subsEastRel)/
//     自列の熱帯陸割合 × ITCZ 変位(= 加熱 H)/ **東方の加熱 eastH**(R-H 位相)
//
// 実行: npx tsx scripts/diag_arabia_vs_china.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { MAJOR, majorClassOf } from '../src/domain/koppen';
import { getKoppenObs } from './scoring';
import { openAccel } from './accel_cli';

interface Cell {
  w: number;
  waterMm: number;
  supply: number;
  eastRel: number;
  hOwn: number;
  hEast: number;
}

function wmean(cells: Cell[], f: (c: Cell) => number): number {
  const ws = cells.reduce((a, c) => a + c.w, 0);
  return cells.reduce((a, c) => a + c.w * f(c), 0) / Math.max(1e-9, ws);
}

async function main(): Promise<void> {
  const accel = await openAccel(true);
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const { result: r, precipDiag: d } = out;
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const H = grid.heightCells;
  const land = r.context.terrain.landMask;
  const kobs = getKoppenObs();
  const dir = r.context.params.body.rotationDirection >= 0 ? 1 : -1;

  // 経度列の熱帯陸割合(|lat| ≤ 30°)
  const rowN30 = Math.max(0, Math.round((90 - 30) / grid.resolutionDeg) - 1);
  const rowS30 = Math.min(H - 1, Math.round((90 + 30) / grid.resolutionDeg));
  const colLandFrac = new Float64Array(WC);
  for (let col = 0; col < WC; col++) {
    let n = 0;
    let nl = 0;
    for (let row = rowN30; row <= rowS30; row++) {
      n++;
      if (land[row * WC + col]) nl++;
    }
    colLandFrac[col] = n > 0 ? nl / n : 0;
  }

  // 月別の加熱 H(col) = min(1, |itczLat|/15) × min(1, frac/0.3)
  // eastH(col) = 東(自転方向)5〜60° の H の距離減衰つき最大
  const degPerCol = 360 / WC;
  const monthlyH: Float64Array[] = [];
  const monthlyEastH: Float64Array[] = [];
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const centers = r.itcz.monthlyCenterLatDegByCol[m];
    const h = new Float64Array(WC);
    for (let col = 0; col < WC; col++) {
      const itczLat = centers?.[col] ?? 0;
      const disp = Math.min(1, Math.abs(itczLat) / 15);
      const gate = Math.min(1, (colLandFrac[col] ?? 0) / 0.3);
      h[col] = disp * gate;
    }
    const eh = new Float64Array(WC);
    const maxD = Math.round(60 / degPerCol);
    const minD = Math.round(5 / degPerCol);
    for (let col = 0; col < WC; col++) {
      let best = 0;
      for (let dd = minD; dd <= maxD; dd++) {
        const c2 = (((col + dir * dd) % WC) + WC) % WC;
        const decay = Math.exp(-(dd * degPerCol) / 30);
        best = Math.max(best, (h[c2] ?? 0) * decay);
      }
      eh[col] = best;
    }
    monthlyH.push(h);
    monthlyEastH.push(eh);
  }

  const groups: Record<string, Cell[]> = { 'C→B(華中型・救う対象)': [], 'B→B(アラビア型・守る対象)': [] };
  for (let row = 0; row < H; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) < 15 || Math.abs(lat) > 35) continue;
    const north = lat >= 0;
    const cw = Math.cos((lat * Math.PI) / 180);
    const summer = north ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    for (let col = 0; col < WC; col++) {
      const i = row * WC + col;
      if (!land[i]) continue;
      const obsId = kobs.classRaster[i] ?? 0;
      if (obsId === 0) continue;
      const obsMajor = majorClassOf(obsId);
      const modMajor = majorClassOf(r.koppen.classId[i] ?? 0);
      let key: string | null = null;
      if (obsMajor === MAJOR.C && modMajor === MAJOR.B) key = 'C→B(華中型・救う対象)';
      else if (obsMajor === MAJOR.B && modMajor === MAJOR.B) key = 'B→B(アラビア型・守る対象)';
      if (!key) continue;

      let waterMm = 0;
      let supply = 0;
      let eastRel = 0;
      let hOwn = 0;
      let hEast = 0;
      for (const m of summer) {
        waterMm += d.waterMm[m]?.[i] ?? 0;
        supply +=
          (d.supplyOcean?.[m]?.[i] ?? 0) + (d.supplyLand?.[m]?.[i] ?? 0) + (d.supplyStorm[m]?.[i] ?? 0);
        eastRel += d.subsEastRel[m]?.[i] ?? 1;
        hOwn += monthlyH[m]?.[col] ?? 0;
        hEast += monthlyEastH[m]?.[col] ?? 0;
      }
      groups[key]?.push({
        w: cw,
        waterMm: waterMm / 6,
        supply: supply / 6,
        eastRel: eastRel / 6,
        hOwn: hOwn / 6,
        hEast: hEast / 6,
      });
    }
  }

  console.log('|lat| 15〜35° の陸、夏半年平均(面積重み)\n');
  console.log('量                          C→B(救う)   B→B(守る)   比(C→B/B→B)');
  const rows: Array<[string, (c: Cell) => number]> = [
    ['可降水量 W (mm)', (c) => c.waterMm],
    ['供給(無次元)', (c) => c.supply],
    ['東岸緩和後の残り(小=緩和大)', (c) => c.eastRel],
    ['自列の加熱 H(陸×ITCZ変位)', (c) => c.hOwn],
    ['東方の加熱 eastH(R-H 位相)', (c) => c.hEast],
    ['H − eastH(正=自分が加熱源)', (c) => c.hOwn - c.hEast],
  ];
  const a = groups['C→B(華中型・救う対象)'] ?? [];
  const b = groups['B→B(アラビア型・守る対象)'] ?? [];
  console.log(`  (セル数: C→B ${a.length} / B→B ${b.length})`);
  for (const [name, f] of rows) {
    const va = wmean(a, f);
    const vb = wmean(b, f);
    console.log(
      `${name.padEnd(26)} ${va.toFixed(3).padStart(9)} ${vb.toFixed(3).padStart(10)}  ${(va / Math.max(1e-9, Math.abs(vb)) * Math.sign(vb || 1)).toFixed(2).padStart(8)}`,
    );
  }
  console.log(
    '\n読み: 比が 1 から最も離れている量が、2 群を分けるゲートに使える。\n' +
      '  W・供給が分かれるなら「湿りゲート」で足りる(ただし乾いた平衡に注意)。\n' +
      '  H−eastH が分かれるなら Rodwell–Hoskins の位相規則が地理中立に書ける。',
  );
}

void main();
