// 診断: 「季節性」は湿らせたい地域と乾かしたい地域を判別できるか。
//
// 対応 spec: なし(R5 の設計判断)。
//
// なぜ要るか:
//   2026-08-01 の R4(水蒸気フラックス収束)は、**アラビアの実効収束が
//   中国東部の 2 倍**だったために棄却された。供給場 q が水蒸気量ではなく
//   「湿潤源への到達可能性」で、暑い海を長く辿るほど大きくなるためである。
//   相対飽和度で温度スケールを割り戻しても逆転は解けなかった。
//
//   ただし**当時の解析はすべて年平均だった**。2026-08-07 の R3 診断は
//   「観測が夏型のセル 108 → モデル 67」と、**季節配分の失敗**を示している。
//   中国東部・ラプラタは「年中乾いている」のではなく「夏が足りない」。
//   一方アラビア・サハラは年間を通じて乾いている。
//
//   **季節の差を取れば、セルごとの『到達可能性のスケール』は共通因子として
//   割れる**ので、型の不一致が部分的に相殺されるはずである。
//   これが成り立たなければ R4 と同じ壁なので、実装より先にここで確かめる。
//
// 測る量(地域ゲートの枠ごと、陸セルの面積重み平均):
//   夏率      = 夏 3 か月の降水 / 年降水       … 観測とモデルの両方
//   供給の季節比 = 夏の供給 / 年平均の供給      … **これが判別量の候補**
//   沈降の残存  = 夏の平均                     … いま何が効いているか
//
// 実行: npx tsx scripts/diag_monsoon_index.ts

import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { latDegOfRow, lonDegOfCol } from '../src/domain/grid';
import { getClimObs, REGION_GATES } from './scoring';
import { openAccel } from './accel_cli';

/** 北半球の夏 = 6〜8 月、南半球 = 12〜2 月(月は 0 起点) */
const summerOf = (lat: number): number[] => (lat >= 0 ? [5, 6, 7] : [11, 0, 1]);

/** 湿らせたい / 乾かしたい / 維持したい の別(判別できているかを見るため) */
const WANT: Record<string, string> = {
  east_asia_humid: '湿らせたい',
  india_tropical: '湿らせたい',
  us_southeast_humid: '維持(湿)',
  amazon_tropical: '維持(湿)',
  congo_tropical: '維持(湿)',
  sahara_arid: '乾燥維持',
  arabia_arid: '乾燥維持',
  australia_interior_arid: '乾燥維持',
  patagonia_rainshadow: '乾かしたい',
  mediterranean_cs_present: '夏乾燥',
  california_cs_present: '夏乾燥',
  west_europe_temperate: '維持(湿)',
};

async function main(): Promise<void> {
  const accel = await openAccel();
  let out;
  try {
    out = await runPipelineWithPrecipDiag(EARTH_PARAMS, accel.opts);
  } finally {
    accel.close();
  }
  const { result, precipDiag: d } = out;
  const clim = getClimObs();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;

  console.log('地域ごとの季節性(陸セルの面積重み平均)\n');
  console.log(
    '地域                     狙い        夏率(観測)  夏率(モデル)  差    供給の季節比  夏の沈降残存',
  );

  for (const g of REGION_GATES) {
    const latC = (g.latMin + g.latMax) / 2;
    const sm = summerOf(latC);
    let w = 0;
    let obsSummer = 0;
    let obsYear = 0;
    let mdlSummer = 0;
    let mdlYear = 0;
    let qSummer = 0;
    let qYear = 0;
    let subsSummer = 0;

    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < g.latMin || lat > g.latMax) continue;
      const cw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = lonDegOfCol(grid, col);
        if (lon < g.lonMin || lon > g.lonMax) continue;
        const i = row * grid.widthCells + col;
        if (!land[i]) continue;

        // 観測(2° 気候値の最寄りセル)
        const cr = Math.min(clim.heightCells - 1, Math.max(0, Math.floor((90 - lat) / 2)));
        const cc = Math.min(clim.widthCells - 1, Math.max(0, Math.floor((lon + 180) / 2)));
        const ci = cr * clim.widthCells + cc;
        let oy = 0;
        let os = 0;
        let ok = true;
        for (let m = 0; m < 12; m++) {
          const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
          if (p === -9999) {
            ok = false;
            break;
          }
          oy += p;
          if (sm.includes(m)) os += p;
        }
        if (!ok || oy <= 0) continue;

        let my = 0;
        let ms = 0;
        let qy = 0;
        let qs = 0;
        let ss = 0;
        for (let m = 0; m < 12; m++) {
          const p = result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
          const q =
            (d.supplyOcean[m]?.[i] ?? 0) + (d.supplyLand[m]?.[i] ?? 0) + (d.supplyStorm[m]?.[i] ?? 0);
          my += p;
          qy += q;
          if (sm.includes(m)) {
            ms += p;
            qs += q;
            ss += d.subsidenceResidual[m]?.[i] ?? 1;
          }
        }
        w += cw;
        obsSummer += cw * os;
        obsYear += cw * oy;
        mdlSummer += cw * ms;
        mdlYear += cw * my;
        qSummer += cw * (qs / 3);
        qYear += cw * (qy / 12);
        subsSummer += cw * (ss / 3);
      }
    }
    if (w <= 0) continue;
    const fo = obsSummer / Math.max(1e-9, obsYear);
    const fm = mdlSummer / Math.max(1e-9, mdlYear);
    const qRatio = qSummer / Math.max(1e-9, qYear);
    console.log(
      `${g.id.padEnd(24)} ${(WANT[g.id] ?? '—').padEnd(10)} ` +
        `${(fo * 100).toFixed(1).padStart(8)}%  ${(fm * 100).toFixed(1).padStart(9)}%  ` +
        `${((fm - fo) * 100 >= 0 ? '+' : '') + ((fm - fo) * 100).toFixed(1).padStart(5)}  ` +
        `${qRatio.toFixed(3).padStart(10)}  ${(subsSummer / w).toFixed(3).padStart(11)}`,
    );
  }

  console.log(
    '\n読み方:\n' +
      '  夏率の差が大きく負 = **夏の降水が足りない**(モンスーンを取り逃している)。\n' +
      '  供給の季節比が大きい = 夏に供給が増える = モンスーン的な流入がある。\n' +
      '  **湿らせたい地域で季節比が大きく、乾燥維持したい地域で小さければ判別できる。**\n' +
      '  R4 が年平均の実効収束で失敗した(アラビアが中国東部の 2 倍)のと同じ形に\n' +
      '  なっていないかを、ここで確かめる。',
  );
}

void main();
