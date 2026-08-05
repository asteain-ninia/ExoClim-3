// 診断: どの区画にどの地域が入っているか(未見評価のばらつきの解釈用)。
//
// 対応 spec: docs/FB_2026-07-31.md P1-1。
//
// なぜ要るか(2026-08-06 の未見評価):
//   区画ごとの未見成績が -13.7 〜 +9.8 と大きくばらついた。平均の差は +0.15 で
//   過剰適合は無いが、**区画 4 だけ未見 64.24 と落ち込む**(訓練側は 77.94)。
//   これは過剰適合ではなく「その区画に残差の大きい土地が集中している」
//   ことを意味する。**どの土地なのかが分かれば、次に直すべき場所が決まる。**
//
// GPU を使わない(区画の割り当てと観測フィクスチャだけで決まる)。
//
// 実行: npx tsx scripts/diag_fold_regions.ts

import { foldOfLatLon, HOLDOUT_BLOCK_DEG, HOLDOUT_FOLDS } from './holdout';
import { getKoppenObs, REGION_GATES } from './scoring';
import { createGrid, latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';

const MAJOR_NAMES = ['A 熱帯', 'B 乾燥', 'C 温帯', 'D 冷帯', 'E 寒帯'];

function main(): void {
  const obs = getKoppenObs();
  const grid = createGrid(1);

  // 区画ごとの陸セル数と大分類の内訳(観測ベース)
  const landCount = new Array<number>(HOLDOUT_FOLDS).fill(0);
  const majorCount = Array.from({ length: HOLDOUT_FOLDS }, () => new Array<number>(5).fill(0));
  const latSum = new Array<number>(HOLDOUT_FOLDS).fill(0);

  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      const i = row * grid.widthCells + col;
      const id = obs.classRaster[i] ?? 0;
      if (id === 0) continue; // 海
      const lon = lonDegOfCol(grid, col);
      const f = foldOfLatLon(lat, lon);
      landCount[f] = (landCount[f] ?? 0) + 1;
      latSum[f] = (latSum[f] ?? 0) + Math.abs(lat);
      const mo = majorClassOf(id);
      if (mo >= 0) majorCount[f]![mo] = (majorCount[f]![mo] ?? 0) + 1;
    }
  }

  console.log(`区画の割り当て(${HOLDOUT_BLOCK_DEG}° ブロック、観測の陸セルで集計)\n`);
  console.log('区画  陸セル数  平均|緯度|   A熱帯   B乾燥   C温帯   D冷帯   E寒帯');
  for (let f = 0; f < HOLDOUT_FOLDS; f++) {
    const n = landCount[f] ?? 1;
    const pct = (k: number): string => (((majorCount[f]![k] ?? 0) / n) * 100).toFixed(1).padStart(6);
    console.log(
      `  ${f}   ${String(n).padStart(7)}   ${((latSum[f] ?? 0) / n).toFixed(1).padStart(7)}°  ` +
        `${pct(0)}  ${pct(1)}  ${pct(2)}  ${pct(3)}  ${pct(4)}`,
    );
  }
  console.log('\n(各大分類は区画内の陸セルに占める割合 %)');

  // 地域ゲートの区画割り当て
  console.log('\n地域ゲートの所属区画');
  const byFold = Array.from({ length: HOLDOUT_FOLDS }, () => [] as string[]);
  for (const g of REGION_GATES) {
    const lat = (g.latMin + g.latMax) / 2;
    const lon = (g.lonMin + g.lonMax) / 2;
    byFold[foldOfLatLon(lat, lon)]!.push(g.id);
  }
  for (let f = 0; f < HOLDOUT_FOLDS; f++) {
    console.log(`  区画 ${f}(${byFold[f]!.length} 件): ${byFold[f]!.join(', ') || '—'}`);
  }

  // 区画ごとに占有率の高い 30° ブロックを列挙(場所の当たりをつける)
  console.log('\n各区画の 30° ブロック(陸セル数の多い順に 6 個)');
  for (let f = 0; f < HOLDOUT_FOLDS; f++) {
    const blocks: Array<{ label: string; n: number }> = [];
    for (let br = 0; br < 180 / HOLDOUT_BLOCK_DEG; br++) {
      for (let bc = 0; bc < 360 / HOLDOUT_BLOCK_DEG; bc++) {
        const latC = 90 - br * HOLDOUT_BLOCK_DEG - HOLDOUT_BLOCK_DEG / 2;
        const lonC = -180 + bc * HOLDOUT_BLOCK_DEG + HOLDOUT_BLOCK_DEG / 2;
        if (foldOfLatLon(latC, lonC) !== f) continue;
        let n = 0;
        for (let row = 0; row < grid.heightCells; row++) {
          const lat = latDegOfRow(grid, row);
          if (lat > 90 - br * HOLDOUT_BLOCK_DEG || lat <= 90 - (br + 1) * HOLDOUT_BLOCK_DEG)
            continue;
          for (let col = 0; col < grid.widthCells; col++) {
            const lon = lonDegOfCol(grid, col);
            const lo = -180 + bc * HOLDOUT_BLOCK_DEG;
            if (lon < lo || lon >= lo + HOLDOUT_BLOCK_DEG) continue;
            if ((obs.classRaster[row * grid.widthCells + col] ?? 0) !== 0) n++;
          }
        }
        if (n > 0)
          blocks.push({
            label: `${latC >= 0 ? Math.round(latC) + 'N' : -Math.round(latC) + 'S'}/${lonC >= 0 ? Math.round(lonC) + 'E' : -Math.round(lonC) + 'W'}`,
            n,
          });
      }
    }
    blocks.sort((a, b) => b.n - a.n);
    console.log(
      `  区画 ${f}: ` + blocks.slice(0, 6).map((b) => `${b.label}(${b.n})`).join(' '),
    );
  }
  void KOPPEN_CLASSES;
  void MAJOR_NAMES;
}

main();
