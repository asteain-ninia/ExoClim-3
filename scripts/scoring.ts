// 採点定義の一元化(FB 2026-07-31 P0-3)。docs/要件.md §6
// scripts/validate.ts(標準レポート)と scripts/optimize_lib.ts(自動較正の
// 目的関数)は必ずこのモジュールの同一関数を呼ぶ。採点ループの複製は禁止。
//
// 正本の重み付け: 全球・陸域の集計指標(ケッペン一致率・気温 RMSE・降水 RMSE・
// 陸平均降水・log 相関)はすべて面積重み(cos 緯度)付き。
// セル単純平均を残す場合は「非面積重み」と明示した診断値としてのみ扱う
// (validate.ts 側に残置。正本と混同しない)。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { latDegOfRow, areaWeightOfRow } from '../src/domain/grid';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';
import type { PipelineResult } from '../src/sim/types';

// ---- 教師データ(単一の読込点) ----
export interface KoppenFixture {
  widthCells: number;
  heightCells: number;
  classes?: string[];
  classRaster: number[];
}
export interface ClimateFixture {
  widthCells: number;
  heightCells: number;
  monthlyTemperatureDeciC: number[][];
  monthlyPrecipitationMm: number[][];
}

/**
 * セルフィルタ(P1-1 空間ホールドアウト用)。セル中心の緯度経度を受け取り、
 * false のセルは採点から除外する。undefined = 全セル採点(既定・従来どおり)
 */
export type CellFilter = (latDeg: number, lonDeg: number) => boolean;

let koppenObsCache: KoppenFixture | null = null;
let climObsCache: ClimateFixture | null = null;

export function getKoppenObs(): KoppenFixture {
  koppenObsCache ??= JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_koppen_1deg.json'), 'utf8'),
  ) as KoppenFixture;
  return koppenObsCache;
}

export function getClimObs(): ClimateFixture {
  climObsCache ??= JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/earth_climate_2deg.json'), 'utf8'),
  ) as ClimateFixture;
  return climObsCache;
}

// ---- 地域ゲート(検証側にのみ置く地球の地理。計算層には一切入れない) ----
export interface RegionGate {
  id: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  /** 'major' = 大分類の過半、'present' = 指定クラス群が10%以上 */
  mode: 'major' | 'present';
  expect: string; // 大分類 'A'|'B'|'C'|'D'|'E' または 'Cs' などの接頭辞
}

export const REGION_GATES: RegionGate[] = [
  {
    id: 'sahara_arid',
    latMin: 18,
    latMax: 30,
    lonMin: -15,
    lonMax: 30,
    mode: 'major',
    expect: 'B',
  },
  { id: 'arabia_arid', latMin: 15, latMax: 30, lonMin: 35, lonMax: 55, mode: 'major', expect: 'B' },
  {
    id: 'australia_interior_arid',
    latMin: -30,
    latMax: -20,
    lonMin: 120,
    lonMax: 145,
    mode: 'major',
    expect: 'B',
  },
  {
    id: 'amazon_tropical',
    latMin: -10,
    latMax: 5,
    lonMin: -75,
    lonMax: -50,
    mode: 'major',
    expect: 'A',
  },
  {
    id: 'congo_tropical',
    latMin: -5,
    latMax: 5,
    lonMin: 12,
    lonMax: 30,
    mode: 'major',
    expect: 'A',
  },
  {
    id: 'india_tropical',
    latMin: 18,
    latMax: 26,
    lonMin: 73,
    lonMax: 87,
    mode: 'major',
    expect: 'A',
  },
  {
    id: 'us_southeast_humid',
    latMin: 30,
    latMax: 37,
    lonMin: -95,
    lonMax: -78,
    mode: 'major',
    expect: 'C',
  },
  {
    id: 'east_asia_humid',
    latMin: 25,
    latMax: 35,
    lonMin: 105,
    lonMax: 122,
    mode: 'major',
    expect: 'C',
  },
  {
    id: 'west_europe_temperate',
    latMin: 47,
    latMax: 59,
    lonMin: -5,
    lonMax: 15,
    mode: 'major',
    expect: 'C',
  },
  {
    id: 'europe_russia_continental',
    latMin: 50,
    latMax: 65,
    lonMin: 35,
    lonMax: 55,
    mode: 'major',
    expect: 'D',
  },
  {
    id: 'west_siberia_continental',
    latMin: 55,
    latMax: 65,
    lonMin: 60,
    lonMax: 90,
    mode: 'major',
    expect: 'D',
  },
  {
    id: 'east_siberia_continental',
    latMin: 55,
    latMax: 68,
    lonMin: 100,
    lonMax: 140,
    mode: 'major',
    expect: 'D',
  },
  {
    id: 'mediterranean_cs_present',
    latMin: 31,
    latMax: 44,
    lonMin: -10,
    lonMax: 35,
    mode: 'present',
    expect: 'Cs',
  },
  {
    id: 'california_cs_present',
    latMin: 33,
    latMax: 40,
    lonMin: -124,
    lonMax: -118,
    mode: 'present',
    expect: 'Cs',
  },
  {
    id: 'tibet_cold_highland',
    latMin: 28,
    latMax: 36,
    lonMin: 80,
    lonMax: 95,
    mode: 'present',
    expect: 'ET',
  },
  {
    id: 'patagonia_rainshadow',
    latMin: -50,
    latMax: -40,
    lonMin: -72,
    lonMax: -65,
    mode: 'major',
    expect: 'B',
  },
  {
    id: 'antarctica_ice',
    latMin: -90,
    latMax: -75,
    lonMin: -180,
    lonMax: 180,
    mode: 'major',
    expect: 'E',
  },
];

export interface RegionGateResult {
  id: string;
  /**
   * 合否(**セル数**で判定、2026-07 以来の定義のまま凍結)。
   * 2026-08-16 に目的関数から外したので、以後は報告のみの参考値である。
   * 面積重みへ直さないのは、過去の全実験記録の「ゲート n/17」と
   * 比べられなくすることの害のほうが大きいため。判断には `share` を使う。
   */
  pass: boolean;
  /**
   * **期待する気候帯がその地域の陸面積に占める割合**(0〜1、面積重み)。
   * 2026-08-16 追加。`pass` の離散判定(過半 / 10% 以上)を連続量に直したもの。
   *
   * なぜ要るか: 外部監査(2026-08-15)に「ゲートは 50%・10% に離散的な崖を
   * 持ち、崖を一つ越えただけの解が『改善』として採用される」と指摘された。
   * 実際 v23 は連続指標が約 −0.031 悪化しているのにゲート +1 で採用されている。
   * 割合そのものを見れば崖は消え、**近づいたぶんだけ報われる**。
   */
  share: number;
  detail: string;
}

/**
 * ゲートの失敗が**降水由来か気温由来か**を分ける診断。
 *
 * なぜ要るか(2026-08-09 の外部レビュー):
 *   `patagonia_rainshadow` は「雨陰の乾燥」と命名されているが、実際の失敗は
 *   ET 49%(ツンドラ)である。ケッペンは B の乾燥閾値が年平均気温とともに
 *   下がり、その後に最暖月 10°C 未満なら E になる。つまり**寒すぎる**という
 *   気温の失敗を、雨陰の名前で追いかけていた。
 *
 * 観測と比べた年降水比・年平均気温差・最暖月差を併記して、
 * **どちらを直せばよいか**をゲートの出力自体に持たせる。
 */
function gateComponents(
  result: PipelineResult,
  g: RegionGate,
  clim: ClimateFixture,
): string {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  let n = 0;
  let pM = 0;
  let pO = 0;
  let tM = 0;
  let tO = 0;
  let wM = 0;
  let wO = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (lat < g.latMin || lat > g.latMax) continue;
    for (let col = 0; col < grid.widthCells; col++) {
      const lon = -180 + (col + 0.5) * grid.resolutionDeg;
      if (lon < g.lonMin || lon > g.lonMax) continue;
      const i = row * grid.widthCells + col;
      if (!land[i]) continue;
      const cr = Math.min(clim.heightCells - 1, Math.max(0, Math.floor((90 - lat) / 2)));
      const cc = Math.min(clim.widthCells - 1, Math.max(0, Math.floor((lon + 180) / 2)));
      const ci = cr * clim.widthCells + cc;
      let po = 0;
      let to = 0;
      let woM = -1e9;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const t = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        const p = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (t === -9999 || p === -9999) {
          ok = false;
          break;
        }
        po += p;
        to += t / 10;
        woM = Math.max(woM, t / 10);
      }
      if (!ok) continue;
      let pm = 0;
      let tm = 0;
      let wmM = -1e9;
      for (let m = 0; m < 12; m++) {
        pm += result.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        const t = result.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
        tm += t;
        wmM = Math.max(wmM, t);
      }
      n++;
      pM += pm;
      pO += po;
      tM += tm / 12;
      tO += to / 12;
      wM += wmM;
      wO += woM;
    }
  }
  if (n === 0) return '';
  const ratio = pO > 0 ? pM / pO : NaN;
  const dT = tM / n - tO / n;
  const dW = wM / n - wO / n;
  return (
    `[降水 ${(ratio * 100).toFixed(0)}% / 年平均気温 ${dT >= 0 ? '+' : ''}${dT.toFixed(1)}°C / ` +
    `最暖月 ${dW >= 0 ? '+' : ''}${dW.toFixed(1)}°C]`
  );
}

export function scoreRegionGates(result: PipelineResult): RegionGateResult[] {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const gates: RegionGateResult[] = [];
  for (const g of REGION_GATES) {
    const counts = new Map<string, number>();
    const majorCounts = new Array<number>(5).fill(0);
    let total = 0;
    // 連続版(share)は面積重み。cos(lat) を掛けて数える
    const wCounts = new Map<string, number>();
    const wMajor = new Array<number>(5).fill(0);
    let wTotal = 0;
    for (let row = 0; row < grid.heightCells; row++) {
      const lat = latDegOfRow(grid, row);
      if (lat < g.latMin || lat > g.latMax) continue;
      const aw = Math.cos((lat * Math.PI) / 180);
      for (let col = 0; col < grid.widthCells; col++) {
        const lon = -180 + (col + 0.5) * grid.resolutionDeg;
        if (lon < g.lonMin || lon > g.lonMax) continue;
        const i = row * grid.widthCells + col;
        if (!land[i]) continue;
        const id = result.koppen.classId[i] ?? 0;
        if (id === 0) continue;
        total++;
        wTotal += aw;
        const sym = KOPPEN_CLASSES[id] ?? '?';
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
        wCounts.set(sym, (wCounts.get(sym) ?? 0) + aw);
        const mj = majorClassOf(id);
        if (mj >= 0) {
          majorCounts[mj] = (majorCounts[mj] ?? 0) + 1;
          wMajor[mj] = (wMajor[mj] ?? 0) + aw;
        }
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const detail = top
      .map(([s, c]) => `${s} ${Math.round((c / Math.max(1, total)) * 100)}%`)
      .join(', ');
    let pass = false;
    let share = 0;
    if (total === 0) {
      pass = false;
    } else if (g.mode === 'major') {
      const majorIdx = 'ABCDE'.indexOf(g.expect);
      pass = (majorCounts[majorIdx] ?? 0) / total > 0.5;
      share = (wMajor[majorIdx] ?? 0) / Math.max(1e-9, wTotal);
    } else {
      let matched = 0;
      let wMatched = 0;
      for (const [sym, c] of counts.entries()) if (sym.startsWith(g.expect)) matched += c;
      for (const [sym, c] of wCounts.entries()) if (sym.startsWith(g.expect)) wMatched += c;
      pass = matched / total >= 0.1;
      share = wMatched / Math.max(1e-9, wTotal);
    }
    // **失敗の由来を併記する。** 記号だけでは降水と気温のどちらを直せばよいか
    // 分からず、名前(rainshadow など)に引きずられて誤った場所を掘ることになる
    const comp = gateComponents(result, g, getClimObs());
    gates.push({ id: g.id, pass, share, detail: comp ? `${detail} ${comp}` : detail });
  }
  return gates;
}

// ---- ケッペン一致率 + 面積表 + 混同行列(面積重み付き、共通陸セルのみ) ----
export interface KoppenScore {
  /** 大分類一致率 %(丸めなし) */
  majorPct: number;
  /** 詳細一致率 %(丸めなし) */
  detailPct: number;
  /** 面積重みの総和(% 換算の分母) */
  wTotal: number;
  /** [classId] 面積重み(モデル / 観測) */
  areaModelW: number[];
  areaObsW: number[];
  /** [majorClass] 面積重み(モデル / 観測) */
  majorAreaModelW: number[];
  majorAreaObsW: number[];
  /** [観測 major][モデル major] 面積重み */
  confusionW: number[][];
}

export function koppenScore(
  result: PipelineResult,
  obs: KoppenFixture = getKoppenObs(),
  keep?: CellFilter,
): KoppenScore {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const model = result.koppen.classId;
  let wTotal = 0;
  let wDetailHit = 0;
  let wMajorHit = 0;
  const areaModelW = new Array<number>(31).fill(0);
  const areaObsW = new Array<number>(31).fill(0);
  const majorAreaModelW = new Array<number>(5).fill(0);
  const majorAreaObsW = new Array<number>(5).fill(0);
  const confusionW: number[][] = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));

  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    const lat = latDegOfRow(grid, row);
    for (let col = 0; col < grid.widthCells; col++) {
      if (keep && !keep(lat, -180 + (col + 0.5) * grid.resolutionDeg)) continue;
      const i = row * grid.widthCells + col;
      const o = obs.classRaster[i] ?? 0;
      if (!land[i] || o === 0) continue; // 共通陸セル(モデル陸 ∩ 観測陸)のみ採点
      const mdl = model[i] ?? 0;
      if (mdl === 0) continue;
      wTotal += w;
      if (mdl === o) wDetailHit += w;
      const mM = majorClassOf(mdl);
      const mO = majorClassOf(o);
      if (mM === mO) wMajorHit += w;
      areaModelW[mdl] = (areaModelW[mdl] ?? 0) + w;
      areaObsW[o] = (areaObsW[o] ?? 0) + w;
      if (mM >= 0 && mO >= 0) {
        majorAreaModelW[mM] = (majorAreaModelW[mM] ?? 0) + w;
        majorAreaObsW[mO] = (majorAreaObsW[mO] ?? 0) + w;
        const rowC = confusionW[mO];
        if (rowC) rowC[mM] = (rowC[mM] ?? 0) + w;
      }
    }
  }
  return {
    majorPct: (wMajorHit / wTotal) * 100,
    detailPct: (wDetailHit / wTotal) * 100,
    wTotal,
    areaModelW,
    areaObsW,
    majorAreaModelW,
    majorAreaObsW,
    confusionW,
  };
}

// ---- 気温・降水の場の指標(2° 平年値と比較、面積重み付き、陸セルのみ) ----
// モデルは観測 2° セルに対応する f×f ブロックの陸セル平均へ集約して比べる。
export interface FieldScore {
  /** 年平均気温 RMSE °C(面積重み付き) */
  tempRmseC: number;
  /** 1月・7月の気温 RMSE °C(面積重み付き) */
  tempJanRmseC: number;
  tempJulRmseC: number;
  /** 年降水 RMSE mm(面積重み付き) */
  precipRmseMm: number;
  /** 陸平均年降水 mm(面積重み付き、モデル / 観測) */
  landMeanModelMm: number;
  landMeanObsMm: number;
  /** log1p 年降水の相関(面積重み付き) */
  logCorrelation: number;

  // ---- 季節指標(2026-08-02 追加)----
  // 旧採点は気温も降水も**年平均/年合計しか見ていなかった**。
  // ケッペンの第 3 文字は最暖月、第 2 文字は最少月/最多月で決まるので、
  // 季節を測らない物差しで季節に依る分類の一致率を上げようとしていた。
  // 実際「季節振幅が観測に近づいたのに一致率が下がる」ことが起きた
  // (docs/提案_目的関数の盲点_2026-08-02.md)。
  //
  // 指標は惑星一般の手続きだけで作る(月別系列の最大/最小と調和解析)。
  // 地球固有の座標補正や地域別の例外規則は使わない。

  /** 年較差(最暖月 − 最寒月)の RMSE °C。季節振幅 = 熱容量と輸送の物差し */
  tempRangeRmseC: number;
  /** 季節位相のずれの RMS(日)。熱慣性の物差し */
  tempPhaseRmseDays: number;
  /**
   * 降水の季節位相のずれの RMS(日)。**雨季がいつ来るか**の物差し。
   *
   * これが無いと、モンスーンの開始が 2 か月ずれても最多月の「量」が合えば
   * 減点されない。ケッペンの第 2 文字(s/w)は雨季と乾季の**時期**で決まるので、
   * 分類一致率の分散源を測っていないことになる
   * (2026-08-09 の外部レビュー 2 件がそろって指摘)。
   *
   * 気温の位相と同じ手続き(年 1 周期の調和解析 + 月の原点補正)で作る。
   * 季節性の乏しいセルは位相が定義しにくいので、観測の年降水に対する
   * 振幅比が閾値未満なら除く。
   */
  precipPhaseRmseDays: number;
  /** v6: 位相の帯別 RMSE の平均(帯 = |緯度| [0,15)/[15,35)/[35,90])。
   * 全球 RMSE は冬雨型少数派が支配するため、帯別平均を目的関数 v6 の距離にする */
  precipPhaseBandMeanDays: number;
  /** 最少月降水の RMSE mm/月。乾季の深さ = Af/Am/Aw と s/w を決める */
  precipDriestRmseMm: number;
  /** 最多月降水の RMSE mm/月 */
  precipWettestRmseMm: number;

  // ---- 無次元化のための観測側の空間ばらつき(面積重み標準偏差)----
  // **モデルの誤差ではなく観測自身のばらつき**で割ることで、
  // 重みが現状の成績に依存しなくなる(後から都合よく調整する余地を消す)。
  obsSdTempC: number;
  obsSdTempRangeC: number;
  obsSdPrecipMm: number;
  obsSdPrecipDriestMm: number;
  obsSdPrecipWettestMm: number;
  /**
   * **年降水の分布形の誤差**(2026-08-16 追加、面積重み・南極を除く)。
   *
   * なぜ要るか: 2026-08-15 に測って分かった本丸は「**乾いた端が作れない**」
   * ことだった(1% 分位がモデル 64mm 対 観測 9mm)。ところが目的関数は
   * RMSE と平均しか見ておらず、**分布の形をまったく測っていなかった**。
   * 最も乾いたセルを 7 倍も湿らせていても、成績には表れない。
   *
   * 定義: 分位 {1,5,10,25,50,75,90,99}% で `|log((Pm+ε)/(Po+ε))|` の平均、ε=1mm。
   * 対数なので「乾いた端で 7 倍」と「湿った端で 7 倍」が同じ重みになる。
   *
   * **ε の訂正(同日)**: 事前登録では ε=10mm としたが、実測すると
   * 観測の 1% 分位は **9mm/年**で、**ε のほうが大きかった**。
   * 「砂漠の年降水より十分小さい」と書いたのは誤りで、
   * 7 倍のずれ(64 対 9)が 3.9 倍に圧縮され、**測りたい対象そのものを
   * 潰していた**。ε は 0 割り回避のための数値上の配慮であって
   * 評価の強さを決める量ではないので、1mm へ直す。重み 3 は据え置く。
   *
   * 南極を除くのは、観測もモデルも一律 EF で成績に出ないのに
   * セル数の 28.3% を占め、分位を買い占めるため
   * (`docs/診断_枯渇しているのは南極だけ_2026-08-15.md`)。
   */
  precipQuantileLogErr: number;
  /** 上の内訳(報告用)。[分位%, モデル mm, 観測 mm] */
  precipQuantiles: Array<[number, number, number]>;
}

/** 面積重みつき分位(pairs は [値, 重み]) */
function weightedQuantile(sorted: Array<[number, number]>, total: number, p: number): number {
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= p * total) return v;
  }
  return sorted[sorted.length - 1]?.[0] ?? 0;
}

/** 分布形を測る分位(%)。事前登録 2026-08-16 で凍結 */
export const PRECIP_QUANTILES = [1, 5, 10, 25, 50, 75, 90, 99] as const;

/**
 * 分位の対数誤差の 0 割り回避項(mm/年)。
 * **1mm。** 事前登録時は 10mm としたが、観測の 1% 分位が 9mm/年なので
 * ε のほうが大きく、乾いた端のずれを 7 倍から 3.9 倍へ圧縮していた
 * (2026-08-16 に実測して同日訂正)。
 */
export const PRECIP_QUANTILE_EPS_MM = 1;

/**
 * 観測(暦月、1 月始まり)とモデル(北半球冬至起点)の月の原点の差。
 * 冬至(12/21 頃)から 1 月 1 日までが約 11 日 = 0.355 か月。
 * **これは観測データ側の暦の都合**であり、モデルには持ち込まない
 * (モデルの月は惑星の軌道で定義される)。位相を比べるときだけ補正する。
 */
const OBS_MONTH_ORIGIN_OFFSET = 0.355;

/** 季節位相を比べる下限振幅(°C)。これ未満の熱帯は位相が定義しにくい */
const PHASE_MIN_AMPLITUDE_C = 2;

/**
 * 降水の位相を比べる下限(年 1 周期の振幅 / 年平均月降水)。
 * 季節性の乏しい場所は位相が定義しにくいので除く
 */
const PRECIP_PHASE_MIN_RATIO = 0.3;

/** 12 点の周期系列から年 1 周期の振幅と位相(月単位)を取り出す */
function annualHarmonic(series: number[]): { amp: number; peak: number } {
  let a = 0;
  let b = 0;
  for (let m = 0; m < 12; m++) {
    const th = (2 * Math.PI * (m + 0.5)) / 12;
    a += (series[m] ?? 0) * Math.cos(th);
    b += (series[m] ?? 0) * Math.sin(th);
  }
  a = (2 * a) / 12;
  b = (2 * b) / 12;
  let phi = Math.atan2(b, a);
  if (phi < 0) phi += 2 * Math.PI;
  return { amp: Math.hypot(a, b), peak: (phi / (2 * Math.PI)) * 12 };
}

export function fieldScore(
  result: PipelineResult,
  clim: ClimateFixture = getClimObs(),
  keep?: CellFilter,
): FieldScore {
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  let se = 0;
  let wsum = 0;
  let seJan = 0;
  let seJul = 0;
  let pse = 0;
  let pw = 0;
  let pModelSum = 0;
  let pObsSum = 0;
  // ---- 季節指標の積算 ----
  let seRange = 0;
  let wRange = 0;
  let sePhase = 0;
  let wPhase = 0;
  let sePPhase = 0;
  let wPPhase = 0;
  const sePPhaseBand = [0, 0, 0];
  const wPPhaseBand = [0, 0, 0];
  let seDry = 0;
  let seWet = 0;
  let wDryWet = 0;
  // 観測側の空間ばらつき(面積重み平均と 2 乗平均から標準偏差を出す)
  let oT = 0;
  let oT2 = 0;
  let oR = 0;
  let oR2 = 0;
  let oP = 0;
  let oP2 = 0;
  let oD = 0;
  let oD2 = 0;
  let oW = 0;
  let oW2 = 0;
  let wObs = 0;
  // 年降水の分布形(南極を除く。[年降水 mm, 面積重み])
  const qModel: Array<[number, number]> = [];
  const qObs: Array<[number, number]> = [];
  // 面積重み付き log 相関の積算
  let cw = 0,
    cx = 0,
    cy = 0,
    cxx = 0,
    cyy = 0,
    cxy = 0;
  for (let cr = 0; cr < clim.heightCells; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < clim.widthCells; cc++) {
      if (keep && !keep(lat, -179 + cc * 2)) continue;
      const ci = cr * clim.widthCells + cc;
      let tObsSum = 0;
      let ok = true;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyTemperatureDeciC[m]?.[ci] ?? -9999;
        if (v === -9999) {
          ok = false;
          break;
        }
        tObsSum += v / 10;
      }
      let tSum = 0;
      let tJanSum = 0;
      let tJulSum = 0;
      let pSum = 0;
      let n = 0;
      // 粗セル内の陸セルを平均した月別系列(季節指標はここから作る)
      const tMon = new Array<number>(12).fill(0);
      const pMon = new Array<number>(12).fill(0);
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          n++;
          tSum += result.temperature.annualMeanC[gi] ?? 0;
          tJanSum += result.temperature.monthlyTemperatureC[0]?.[gi] ?? 0;
          tJulSum += result.temperature.monthlyTemperatureC[6]?.[gi] ?? 0;
          pSum += result.precipitation.annualPrecipMm[gi] ?? 0;
          for (let m = 0; m < 12; m++) {
            tMon[m] = (tMon[m] ?? 0) + (result.temperature.monthlyTemperatureC[m]?.[gi] ?? 0);
            pMon[m] = (pMon[m] ?? 0) + (result.precipitation.monthlyPrecipMm[m]?.[gi] ?? 0);
          }
        }
      }
      if (n === 0) continue;
      for (let m = 0; m < 12; m++) {
        tMon[m] = (tMon[m] ?? 0) / n;
        pMon[m] = (pMon[m] ?? 0) / n;
      }
      if (ok) {
        const d = tSum / n - tObsSum / 12;
        se += w * d * d;
        wsum += w;
        const dJan = tJanSum / n - (clim.monthlyTemperatureDeciC[0]?.[ci] ?? 0) / 10;
        const dJul = tJulSum / n - (clim.monthlyTemperatureDeciC[6]?.[ci] ?? 0) / 10;
        seJan += w * dJan * dJan;
        seJul += w * dJul * dJul;

        // ---- 季節指標(気温)----
        const tObsMon: number[] = [];
        for (let m = 0; m < 12; m++) {
          tObsMon.push((clim.monthlyTemperatureDeciC[m]?.[ci] ?? 0) / 10);
        }
        const obsRange = Math.max(...tObsMon) - Math.min(...tObsMon);
        const modRange = Math.max(...tMon) - Math.min(...tMon);
        const dR = modRange - obsRange;
        seRange += w * dR * dR;
        wRange += w;
        oT += w * (tObsSum / 12);
        oT2 += w * (tObsSum / 12) * (tObsSum / 12);
        oR += w * obsRange;
        oR2 += w * obsRange * obsRange;
        wObs += w;

        // 位相は季節性のあるセルだけ(熱帯は位相が定義しにくい)
        const ho = annualHarmonic(tObsMon);
        if (ho.amp >= PHASE_MIN_AMPLITUDE_C) {
          const hm = annualHarmonic(tMon);
          let dp = hm.peak - ho.peak - OBS_MONTH_ORIGIN_OFFSET;
          while (dp > 6) dp -= 12;
          while (dp < -6) dp += 12;
          const days = dp * 30.44;
          sePhase += w * days * days;
          wPhase += w;
        }
      }
      let pObs = 0;
      let pOk = true;
      for (let m = 0; m < 12; m++) {
        const v = clim.monthlyPrecipitationMm[m]?.[ci] ?? -9999;
        if (v === -9999) {
          pOk = false;
          break;
        }
        pObs += v;
      }
      if (pOk) {
        const dp = pSum / n - pObs;
        pse += w * dp * dp;
        pw += w;
        // ---- 季節指標(降水)----
        const pObsMon: number[] = [];
        for (let m = 0; m < 12; m++) {
          pObsMon.push(Math.max(0, clim.monthlyPrecipitationMm[m]?.[ci] ?? 0));
        }
        const obsDry = Math.min(...pObsMon);
        const obsWet = Math.max(...pObsMon);
        const modDry = Math.min(...pMon);
        const modWet = Math.max(...pMon);
        const dDry = modDry - obsDry;
        const dWet = modWet - obsWet;
        // 降水の季節位相(雨季の時期)。気温と同じ調和解析・同じ原点補正を使う
        {
          const mean = pObsMon.reduce((x, y) => x + y, 0) / 12;
          const ho = annualHarmonic(pObsMon);
          if (mean > 0 && ho.amp / mean >= PRECIP_PHASE_MIN_RATIO) {
            const hm = annualHarmonic(pMon);
            let dp = hm.peak - ho.peak - OBS_MONTH_ORIGIN_OFFSET;
            while (dp > 6) dp -= 12;
            while (dp < -6) dp += 12;
            const days = dp * 30.44;
            sePPhase += w * days * days;
            wPPhase += w;
            // v6: 帯別(0-15 / 15-35 / 35-90)
            const bi = Math.abs(lat) < 15 ? 0 : Math.abs(lat) < 35 ? 1 : 2;
            sePPhaseBand[bi] = (sePPhaseBand[bi] ?? 0) + w * days * days;
            wPPhaseBand[bi] = (wPPhaseBand[bi] ?? 0) + w;
          }
        }
        seDry += w * dDry * dDry;
        seWet += w * dWet * dWet;
        wDryWet += w;
        oP += w * pObs;
        oP2 += w * pObs * pObs;
        oD += w * obsDry;
        oD2 += w * obsDry * obsDry;
        oW += w * obsWet;
        oW2 += w * obsWet * obsWet;
        pModelSum += (w * pSum) / n;
        pObsSum += w * pObs;
        // 分布形のため、南極を除いて (年降水, 面積重み) を溜める
        if (lat > -60) {
          qModel.push([pSum / n, w]);
          qObs.push([pObs, w]);
        }
        const lx = Math.log1p(pObs);
        const ly = Math.log1p(pSum / n);
        cw += w;
        cx += w * lx;
        cy += w * ly;
        cxx += w * lx * lx;
        cyy += w * ly * ly;
        cxy += w * lx * ly;
      }
    }
  }
  const logCorrelation =
    (cw * cxy - cx * cy) / Math.sqrt(Math.max(1e-9, (cw * cxx - cx * cx) * (cw * cyy - cy * cy)));
  /** 面積重みの標準偏差(観測側のばらつき) */
  const sd = (sum: number, sum2: number, wt: number): number => {
    if (wt <= 1e-9) return 1;
    const mean = sum / wt;
    return Math.max(1e-6, Math.sqrt(Math.max(0, sum2 / wt - mean * mean)));
  };
  // ---- 年降水の分布形(2026-08-16)----
  qModel.sort((a, b) => a[0] - b[0]);
  qObs.sort((a, b) => a[0] - b[0]);
  const qTotal = qModel.reduce((s, [, w]) => s + w, 0);
  const precipQuantiles: Array<[number, number, number]> = [];
  let qErrSum = 0;
  for (const p of PRECIP_QUANTILES) {
    const vm = weightedQuantile(qModel, qTotal, p / 100);
    const vo = weightedQuantile(qObs, qTotal, p / 100);
    precipQuantiles.push([p, vm, vo]);
    qErrSum += Math.abs(Math.log((vm + PRECIP_QUANTILE_EPS_MM) / (vo + PRECIP_QUANTILE_EPS_MM)));
  }

  return {
    precipQuantileLogErr: qErrSum / PRECIP_QUANTILES.length,
    precipQuantiles,
    tempRmseC: Math.sqrt(se / Math.max(1e-9, wsum)),
    tempJanRmseC: Math.sqrt(seJan / Math.max(1e-9, wsum)),
    tempJulRmseC: Math.sqrt(seJul / Math.max(1e-9, wsum)),
    precipRmseMm: Math.sqrt(pse / Math.max(1e-9, pw)),
    landMeanModelMm: pModelSum / Math.max(1e-9, pw),
    landMeanObsMm: pObsSum / Math.max(1e-9, pw),
    logCorrelation,
    tempRangeRmseC: Math.sqrt(seRange / Math.max(1e-9, wRange)),
    tempPhaseRmseDays: Math.sqrt(sePhase / Math.max(1e-9, wPhase)),
    precipPhaseRmseDays: Math.sqrt(sePPhase / Math.max(1e-9, wPPhase)),
    precipPhaseBandMeanDays:
      (Math.sqrt((sePPhaseBand[0] ?? 0) / Math.max(1e-9, wPPhaseBand[0] ?? 0)) +
        Math.sqrt((sePPhaseBand[1] ?? 0) / Math.max(1e-9, wPPhaseBand[1] ?? 0)) +
        Math.sqrt((sePPhaseBand[2] ?? 0) / Math.max(1e-9, wPPhaseBand[2] ?? 0))) / 3,
    precipDriestRmseMm: Math.sqrt(seDry / Math.max(1e-9, wDryWet)),
    precipWettestRmseMm: Math.sqrt(seWet / Math.max(1e-9, wDryWet)),
    obsSdTempC: sd(oT, oT2, wObs),
    obsSdTempRangeC: sd(oR, oR2, wObs),
    obsSdPrecipMm: sd(oP, oP2, wDryWet),
    obsSdPrecipDriestMm: sd(oD, oD2, wDryWet),
    obsSdPrecipWettestMm: sd(oW, oW2, wDryWet),
  };
}

// ---- 観測 ITCZ 代理(月別・2°経度列の熱帯降水重心、雨量重み付き)----
// 乾季列の重心はノイジーなため雨量で重み付けする
let itczObsCache: { centroid: Array<Array<number | null>>; weight: number[][] } | null = null;

function itczObs(clim: ClimateFixture): {
  centroid: Array<Array<number | null>>;
  weight: number[][];
} {
  if (itczObsCache) return itczObsCache;
  const centroid: Array<Array<number | null>> = [];
  const weight: number[][] = [];
  for (let m = 0; m < 12; m++) {
    const cRow: Array<number | null> = [];
    const wRow: number[] = [];
    for (let cc = 0; cc < clim.widthCells; cc++) {
      let s = 0;
      let sw = 0;
      let nValid = 0;
      for (let cr = 0; cr < clim.heightCells; cr++) {
        const lat = 89 - cr * 2;
        if (Math.abs(lat) > 30) continue;
        const p = clim.monthlyPrecipitationMm[m]?.[cr * clim.widthCells + cc] ?? -9999;
        if (p < 0) continue;
        nValid++;
        s += lat * p;
        sw += p;
      }
      if (nValid >= 5 && sw > 10) {
        cRow.push(s / sw);
        wRow.push(sw);
      } else {
        cRow.push(null);
        wRow.push(0);
      }
    }
    centroid.push(cRow);
    weight.push(wRow);
  }
  itczObsCache = { centroid, weight };
  return itczObsCache;
}

/** ITCZ 線と観測降水重心の雨量重み付き RMSE(度)。keep は観測重心の位置で判定 */
export function itczLineRmse(
  result: PipelineResult,
  clim: ClimateFixture = getClimObs(),
  keep?: CellFilter,
): number {
  const { centroid, weight } = itczObs(clim);
  const grid = result.context.grid;
  const colsPer2 = Math.round(2 / grid.resolutionDeg);
  let se = 0;
  let wsum = 0;
  for (let m = 0; m < 12; m++) {
    const centers = result.itcz.monthlyCenterLatDegByCol[m];
    if (!centers) continue;
    for (let cc = 0; cc < clim.widthCells; cc++) {
      const obs = centroid[m]?.[cc];
      const w = weight[m]?.[cc] ?? 0;
      if (obs === null || obs === undefined || w <= 0) continue;
      if (keep && !keep(obs, -179 + cc * 2)) continue;
      let lineSum = 0;
      let n = 0;
      for (let dc = 0; dc < colsPer2; dc++) {
        const gc = cc * colsPer2 + dc;
        if (gc >= grid.widthCells) continue;
        lineSum += centers[gc] ?? 0;
        n++;
      }
      if (n === 0) continue;
      const d = lineSum / n - obs;
      se += w * d * d;
      wsum += w;
    }
  }
  return Math.sqrt(se / Math.max(1e-9, wsum));
}

// ---- 中間場の係留(目的関数 v7、2026-08-22)----
// 最終地図しか見ない物差しは、途中の場(海流・風)が嘘でも報酬する
// (偽寒流への依存 −0.53 がその帰結)。観測の中間場(NOAA PSL、2°、
// tests/fixtures/obs_intermediate)にモデルの中間場を係留する 2 項。
// 事前登録: docs/事前登録_目的関数v7_中間場の係留_2026-08-22.md

interface ObsGrid2 {
  width: number;
  height: number;
  missing: number;
  values: number[];
}

let obsIntermediateCache: {
  sstAnn: ObsGrid2;
  windSpeedAnn: Float64Array; // 12 か月の |V| 平均(2° 格子、行 0 = 北端)
} | null = null;

function getObsIntermediate(): NonNullable<typeof obsIntermediateCache> {
  if (obsIntermediateCache) return obsIntermediateCache;
  const dir = path.join(process.cwd(), 'tests/fixtures/obs_intermediate');
  const load = (name: string): ObsGrid2 =>
    JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ObsGrid2;
  const sstAnn = load('sst_ann.json');
  const n = sstAnn.width * sstAnn.height;
  const windSpeedAnn = new Float64Array(n);
  for (let m = 1; m <= 12; m++) {
    const u = load(`uwnd10_m${String(m).padStart(2, '0')}.json`);
    const v = load(`vwnd10_m${String(m).padStart(2, '0')}.json`);
    for (let i = 0; i < n; i++) {
      const uu = u.values[i] ?? 0;
      const vv = v.values[i] ?? 0;
      if (uu <= -9000 || vv <= -9000) {
        windSpeedAnn[i] = -9999;
        continue;
      }
      if ((windSpeedAnn[i] ?? 0) <= -9000) continue;
      windSpeedAnn[i] = (windSpeedAnn[i] ?? 0) + Math.hypot(uu, vv) / 12;
    }
  }
  obsIntermediateCache = { sstAnn, windSpeedAnn };
  return obsIntermediateCache;
}

export interface IntermediateFieldScore {
  /** SST 偏差(緯度円の海平均からの差)の RMSE °C、海セル |lat| ≤ 60、面積重み */
  sstAnomRmseC: number;
  /** 観測側の SST 偏差の空間 SD(無次元化用) */
  obsSdSstAnomC: number;
  /** 陸上 10m 風速(年平均 |V|)の RMSE m/s、陸率 ≥ 0.5 の 2° セル、面積重み */
  landWindRmseMs: number;
  /** 観測側の陸上風速の空間 SD */
  obsSdLandWindMs: number;
}

export function intermediateFieldScore(result: PipelineResult): IntermediateFieldScore {
  // 合成結果(テストの最小モック)には海流・気流が無いことがある。
  // その場合は項を 0(SD 1)にして目的関数へ影響させない(本番は必ず持つ)
  const ocean = (result as Partial<PipelineResult>).ocean;
  const airflow = (result as Partial<PipelineResult>).airflow;
  if (!ocean?.sstAnomalyC || !airflow?.monthlyWindU) {
    return { sstAnomRmseC: 0, obsSdSstAnomC: 1, landWindRmseMs: 0, obsSdLandWindMs: 1 };
  }
  const obs = getObsIntermediate();
  const grid = result.context.grid;
  const land = result.context.terrain.landMask;
  const f = Math.round(2 / grid.resolutionDeg);
  const OW = obs.sstAnn.width;
  const OH = obs.sstAnn.height;

  // ---- SST 偏差: 2° ブロック平均(海セル)を作り、双方を「行の海平均からの差」にする ----
  const modelBlock = new Float64Array(OW * OH).fill(NaN);
  const obsBlock = new Float64Array(OW * OH).fill(NaN);
  for (let cr = 0; cr < OH; cr++) {
    const lat = 89 - cr * 2;
    if (Math.abs(lat) > 60) continue;
    for (let cc = 0; cc < OW; cc++) {
      const ci = cr * OW + cc;
      const o = obs.sstAnn.values[ci] ?? -9999;
      if (o <= -9000) continue;
      let s = 0;
      let n = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          const gi = gr * grid.widthCells + gc;
          if (land[gi]) continue;
          s += ocean.sstAnomalyC[gi] ?? 0;
          n++;
        }
      }
      if (n === 0) continue;
      modelBlock[ci] = s / n;
      obsBlock[ci] = o;
    }
  }
  let seSst = 0;
  let wSst = 0;
  let oA = 0;
  let oA2 = 0;
  for (let cr = 0; cr < OH; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    let mSum = 0;
    let oSum = 0;
    let n = 0;
    for (let cc = 0; cc < OW; cc++) {
      const ci = cr * OW + cc;
      const mv = modelBlock[ci] ?? NaN;
      if (Number.isNaN(mv)) continue;
      mSum += mv;
      oSum += obsBlock[ci] ?? 0;
      n++;
    }
    if (n < 3) continue;
    const mMean = mSum / n;
    const oMean = oSum / n;
    for (let cc = 0; cc < OW; cc++) {
      const ci = cr * OW + cc;
      const mv = modelBlock[ci] ?? NaN;
      if (Number.isNaN(mv)) continue;
      const mAnom = mv - mMean;
      const oAnom = (obsBlock[ci] ?? 0) - oMean;
      const d = mAnom - oAnom;
      seSst += w * d * d;
      wSst += w;
      oA += w * oAnom;
      oA2 += w * oAnom * oAnom;
    }
  }

  // ---- 陸上風速: 月別 |V| の年平均を陸率 ≥ 0.5 の 2° セルで比べる ----
  let seWind = 0;
  let wWind = 0;
  let oV = 0;
  let oV2 = 0;
  const months = airflow.monthlyWindU.length;
  for (let cr = 0; cr < OH; cr++) {
    const lat = 89 - cr * 2;
    const w = Math.cos((lat * Math.PI) / 180);
    for (let cc = 0; cc < OW; cc++) {
      const ci = cr * OW + cc;
      const ov = obs.windSpeedAnn[ci] ?? -9999;
      if (ov <= -9000) continue;
      let s = 0;
      let nLand = 0;
      let nAll = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const gr = cr * f + dr;
          const gc = cc * f + dc;
          if (gr >= grid.heightCells || gc >= grid.widthCells) continue;
          nAll++;
          const gi = gr * grid.widthCells + gc;
          if (!land[gi]) continue;
          nLand++;
          let sp = 0;
          for (let m = 0; m < months; m++) {
            sp += Math.hypot(airflow.monthlyWindU[m]?.[gi] ?? 0, airflow.monthlyWindV[m]?.[gi] ?? 0);
          }
          s += sp / Math.max(1, months);
        }
      }
      if (nAll === 0 || nLand * 2 < nAll) continue;
      const d = s / nLand - ov;
      seWind += w * d * d;
      wWind += w;
      oV += w * ov;
      oV2 += w * ov * ov;
    }
  }
  const sdOf = (a: number, a2: number, ws: number): number => {
    if (ws <= 0) return 1;
    const mean = a / ws;
    return Math.sqrt(Math.max(1e-12, a2 / ws - mean * mean));
  };
  return {
    sstAnomRmseC: Math.sqrt(seSst / Math.max(1e-9, wSst)),
    obsSdSstAnomC: sdOf(oA, oA2, wSst),
    landWindRmseMs: Math.sqrt(seWind / Math.max(1e-9, wWind)),
    obsSdLandWindMs: sdOf(oV, oV2, wWind),
  };
}
