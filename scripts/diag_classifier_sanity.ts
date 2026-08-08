// 診断: 「日本・朝鮮で夏雨型 w が夏乾燥型 s に化ける」のは分類器の不具合か、
//        それとも降水不足の症状か。
//
// 対応 spec: なし。外部 AI の差分診断メモ(お手紙_ファイル図鑑屋より_2026-08-02.md §2)
//            が「最優先で疑うべきは分類器側」と指摘した件の検証。
//
// やること: **観測の月別気温・降水をそのまま分類器へ通す。**
//   1) 素通し … 観測どおりなら観測の記号(Cfa など)が出るはず。
//               出なければ**分類器そのものの不具合**である。
//   2) 降水だけ一様に縮める … R3 で測った「湿潤温帯の降水はモデルで観測の 21%」を
//               観測データに人工的に適用する。ここで s へ化けるなら、
//               **分類器ではなく降水不足の症状**だと確定する。
//
// GPU もモデルも使わない(観測フィクスチャと分類器だけ)。費用ゼロ。
//
// 実行: npx tsx scripts/diag_classifier_sanity.ts

import { classifyKoppenCell } from '../src/sim/step07_koppen';
import { KOPPEN_CLASSES } from '../src/domain/koppen';
import { getClimObs, getKoppenObs } from './scoring';

/** 見る地点(手紙が名指しした場所を中心に) */
const SPOTS: Array<{ name: string; lat: number; lon: number }> = [
  { name: '東京あたり', lat: 35.5, lon: 139.5 },
  { name: 'ソウルあたり', lat: 37.5, lon: 127.5 },
  { name: '上海あたり', lat: 31.5, lon: 121.5 },
  { name: 'モスクワあたり', lat: 55.5, lon: 37.5 },
  { name: 'ワルシャワあたり', lat: 52.5, lon: 21.5 },
  { name: 'アトランタあたり', lat: 33.5, lon: -84.5 },
];

const SCALES = [1.0, 0.5, 0.21];

function main(): void {
  const clim = getClimObs();
  const obsK = getKoppenObs();

  console.log('観測の月別値をそのまま分類器へ通す(降水を一様に縮めた場合も併記)\n');
  console.log(
    '地点            Beck の記号   素通し   降水 50%   降水 21%   (夏最少/冬最多 mm、素通し)',
  );

  for (const s of SPOTS) {
    // 2° 気候値の行列番号
    const cr = Math.min(clim.heightCells - 1, Math.max(0, Math.floor((90 - s.lat) / 2)));
    const cc = Math.min(clim.widthCells - 1, Math.max(0, Math.floor((s.lon + 180) / 2)));
    const ci = cr * clim.widthCells + cc;

    const t: number[] = [];
    const p: number[] = [];
    let ok = true;
    for (let m = 0; m < 12; m++) {
      const tt = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
      const pp = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
      if (tt === -9999 || pp === -9999) {
        ok = false;
        break;
      }
      t.push(tt / 10);
      p.push(pp);
    }
    if (!ok) {
      console.log(`${s.name.padEnd(14)} 観測が欠測`);
      continue;
    }

    // Beck の記号(1° 格子から最寄りを引く)
    const kr = Math.min(179, Math.max(0, Math.floor(90 - s.lat)));
    const kc = Math.min(359, Math.max(0, Math.floor(s.lon + 180)));
    const beckId = obsK.classRaster[kr * 360 + kc] ?? 0;

    const isNorth = s.lat >= 0;
    const syms = SCALES.map((k) =>
      KOPPEN_CLASSES[classifyKoppenCell(t, p.map((x) => x * k), isNorth)],
    );

    const summer = isNorth ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
    const winter = isNorth ? [9, 10, 11, 0, 1, 2] : [3, 4, 5, 6, 7, 8];
    const pSummerDriest = Math.min(...summer.map((m) => p[m] ?? 0));
    const pWinterWettest = Math.max(...winter.map((m) => p[m] ?? 0));

    console.log(
      `${s.name.padEnd(14)} ${(KOPPEN_CLASSES[beckId] ?? '—').padEnd(11)}  ` +
        `${(syms[0] ?? '—').padEnd(8)} ${(syms[1] ?? '—').padEnd(10)} ${(syms[2] ?? '—').padEnd(10)} ` +
        `(${pSummerDriest.toFixed(0)} / ${pWinterWettest.toFixed(0)})`,
    );
  }

  console.log(
    '\n読み方:\n' +
      '  素通しが Beck とほぼ一致 → 分類器そのものは正しい。\n' +
      '  降水を縮めると s へ化ける → 「夏乾燥型が多すぎる」は**降水不足の症状**であって\n' +
      '  分類器の不具合ではない(s の条件は「夏の最少月 < 40mm」なので、\n' +
      '  全体を 1/5 にすれば自動的に成立してしまう)。',
  );
}

main();
