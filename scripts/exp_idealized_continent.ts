// 実験: 理想化大陸で**大陸規模の気候構造が物理から出てくるか**を測る。
//
// 対応 spec: docs/要件.md §6-2
//   「理想化大陸: 西岸海洋性の楔・地中海性帯・内陸乾燥帯・東岸湿潤の
//     出現を自動判定」
//
// なぜ要るか(2026-08-16、外部監査の指摘を受けて):
//   要件に明記されているのに**一度も実装されていなかった**。
//   validate.ts は「§6-2(理想化大陸)は別ハーネスで判定する」と書いたまま、
//   その別ハーネスが存在しない状態が続いていた。
//
//   監査の指摘の核心は「較正がすべて地球で行われたので、地球はモデルにとって
//   恒等変換であり、**地球以外での破綻が成績に現れない**」ことである。
//   理想化大陸は地球の海岸線を持たないので、
//   **地理を覚え込んだのか物理が働いているのか**を分ける。
//
//   これは禁止事項の「地理を決め打ちした強制ルール」とは逆向きの検査である。
//   ルールを入れるのではなく、**ルール無しで構造が出るかを確かめる**。
//
// 何を出すか:
//   1. 大陸の形(緯度ごとの陸の経度範囲)。**見当で西岸・東岸と言わないため**
//   2. 亜熱帯〜温帯(|緯度| 25〜55°)の陸を、大陸内の東西位置で 5 帯に分け、
//      ケッペン詳細分類の内訳と年降水・最乾月降水を並べる
//   3. 期待される構造が出ているかの素の数値
//        西岸(0〜20%)   : Cs / Cfb が出るか(海洋性・地中海性)
//        内陸(40〜60%)  : B が出るか(内陸乾燥)
//        東岸(80〜100%) : Cfa / Cwa が出るか(東岸湿潤)
//
// **判定基準は置かない(2026-08-16 の初版)。**
//   まず測る。何が出るかを見る前に閾値を書くと、実装が対応していないときに
//   「落ちるテスト」を作るだけになる。測ってから、物理として正しい向きだけを
//   テストへ昇格させる(事前登録の作法)。
//
// 実行: npx tsx scripts/exp_idealized_continent.ts [--two] [--res 2]
//       --two で two_continents プリセット、--res で分解能(既定 2°)

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS, type PlanetParams } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { latDegOfRow } from '../src/domain/grid';
import { KOPPEN_CLASSES, majorClassOf } from '../src/domain/koppen';
import { openAccel } from './accel_cli';

const TWO = process.argv.includes('--two');
const resIdx = process.argv.indexOf('--res');
const RES = resIdx >= 0 ? Number(process.argv[resIdx + 1] ?? 2) : 2;

/** 大陸内の東西位置で分ける帯(下限%, 上限%, 名前) */
const BANDS: Array<[number, number, string]> = [
  [0, 20, '西岸 (0-20%)'],
  [20, 40, '西より (20-40%)'],
  [40, 60, '内陸 (40-60%)'],
  [60, 80, '東より (60-80%)'],
  [80, 100, '東岸 (80-100%)'],
];

async function main(): Promise<void> {
  const params: PlanetParams = {
    ...EARTH_PARAMS,
    gridResolutionDeg: RES,
    terrain: { kind: 'preset', preset: TWO ? 'two_continents' : 'idealized_continent' },
  };
  const accel = await openAccel();
  let r;
  try {
    r = await runPipeline(params, accel.opts);
  } finally {
    accel.close();
  }
  const grid = r.context.grid;
  const WC = grid.widthCells;
  const land = r.context.terrain.landMask;

  console.log(
    `理想化大陸(${TWO ? 'two_continents' : 'idealized_continent'}、${RES}°)\n` +
      `適用域診断: ${JSON.stringify(r.diagnostics)}\n`,
  );

  // ---- 1. 大陸の形。行ごとに陸の連続塊を拾う ----
  // 経度は周期的なので、**経度 0 をまたぐ塊**を取りこぼさないよう
  // 一周ぶん回して境目を探す
  interface Seg {
    row: number;
    lat: number;
    startCol: number;
    len: number;
  }
  const segsOfRow = (row: number): Seg[] => {
    const lat = latDegOfRow(grid, row);
    const out: Seg[] = [];
    let start = -1;
    // 陸でない列から始める(またぎを正しく扱うため)
    let origin = -1;
    for (let c = 0; c < WC; c++) {
      if (!land[row * WC + c]) {
        origin = c;
        break;
      }
    }
    if (origin < 0) return [{ row, lat, startCol: 0, len: WC }]; // 全周が陸
    for (let k = 0; k <= WC; k++) {
      const c = (origin + k) % WC;
      const isLand = k < WC ? !!land[row * WC + c] : false;
      if (isLand && start < 0) start = k;
      if (!isLand && start >= 0) {
        out.push({ row, lat, startCol: (origin + start) % WC, len: k - start });
        start = -1;
      }
    }
    return out;
  };

  console.log('【1】大陸の形(陸のある行だけ、5 行おき)');
  console.log('緯度    塊の数  各塊の 経度範囲(幅セル)');
  for (let row = 0; row < grid.heightCells; row += 5) {
    const segs = segsOfRow(row);
    if (segs.length === 0) continue;
    const lat = latDegOfRow(grid, row);
    const desc = segs
      .map((s) => {
        const lon0 = -180 + (s.startCol + 0.5) * RES;
        const lon1 = -180 + (((s.startCol + s.len - 1) % WC) + 0.5) * RES;
        return `${lon0.toFixed(0)}〜${lon1.toFixed(0)}° (${s.len})`;
      })
      .join('  ');
    console.log(`${lat.toFixed(0).padStart(5)}°  ${String(segs.length).padStart(4)}   ${desc}`);
  }

  // ---- 2. 亜熱帯〜温帯の陸を、大陸内の東西位置で分ける ----
  interface Cell {
    w: number;
    frac: number;
    classId: number;
    annual: number;
    driest: number;
    t: number;
  }
  const cells: Cell[] = [];
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) < 25 || Math.abs(lat) > 55) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    for (const s of segsOfRow(row)) {
      // 幅 3 セル未満の塊は「大陸」と呼べない(島)。東西位置が意味を持たない
      if (s.len < 3) continue;
      for (let k = 0; k < s.len; k++) {
        const c = (s.startCol + k) % WC;
        const i = row * WC + c;
        let annual = 0;
        let driest = Infinity;
        let t = 0;
        for (let m = 0; m < MONTHS_PER_YEAR; m++) {
          const p = r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
          annual += p;
          driest = Math.min(driest, p);
          t += r.temperature.monthlyTemperatureC[m]?.[i] ?? 0;
        }
        cells.push({
          w: cw,
          // 東西位置。0 = 西端、1 = 東端(自転が順行なので風上は西)
          frac: s.len === 1 ? 0.5 : k / (s.len - 1),
          classId: r.koppen.classId[i] ?? 0,
          annual,
          driest,
          t: t / MONTHS_PER_YEAR,
        });
      }
    }
  }

  console.log(`\n【2】亜熱帯〜温帯(|緯度| 25〜55°)の陸 ${cells.length} セルを東西で分ける`);
  if (cells.length === 0) {
    console.log('  この緯度帯に幅 3 セル以上の陸が無い。大陸の配置を確認すること');
    return;
  }
  console.log('帯                年降水  最乾月   気温    上位のケッペン区分');
  for (const [lo, hi, name] of BANDS) {
    const g = cells.filter((c) => c.frac * 100 >= lo && c.frac * 100 <= hi);
    if (g.length === 0) {
      console.log(`${name.padEnd(18)} (該当なし)`);
      continue;
    }
    const wsum = g.reduce((a, c) => a + c.w, 0);
    const wm = (f: (c: Cell) => number): number =>
      g.reduce((a, c) => a + c.w * f(c), 0) / Math.max(1e-9, wsum);
    const counts = new Map<string, number>();
    for (const c of g) {
      const sym = KOPPEN_CLASSES[c.classId] ?? '?';
      counts.set(sym, (counts.get(sym) ?? 0) + c.w);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([s, v]) => `${s} ${((100 * v) / wsum).toFixed(0)}%`)
      .join(', ');
    console.log(
      `${name.padEnd(18)} ${wm((c) => c.annual).toFixed(0).padStart(6)}` +
        ` ${wm((c) => c.driest).toFixed(1).padStart(7)}` +
        ` ${wm((c) => c.t).toFixed(1).padStart(6)}°C   ${top}`,
    );
  }

  // ---- 3. 期待される構造の素の数値(判定はしない) ----
  console.log('\n【3】要件 §6-2 が挙げる 4 つの構造(**判定はせず数値だけ出す**)');
  const share = (pred: (c: Cell) => boolean, lo: number, hi: number): string => {
    const g = cells.filter((c) => c.frac * 100 >= lo && c.frac * 100 <= hi);
    if (g.length === 0) return '該当なし';
    const wsum = g.reduce((a, c) => a + c.w, 0);
    const hit = g.filter(pred).reduce((a, c) => a + c.w, 0);
    return `${((100 * hit) / wsum).toFixed(1)}%`;
  };
  const sym = (c: Cell): string => KOPPEN_CLASSES[c.classId] ?? '?';
  console.log(
    `  西岸海洋性 (西岸 0-20% が Cfb/Cfc)  : ${share((c) => /^Cf[bc]/.test(sym(c)), 0, 20)}`,
  );
  console.log(`  地中海性帯 (西岸 0-20% が Cs*)      : ${share((c) => sym(c).startsWith('Cs'), 0, 20)}`);
  console.log(
    `  内陸乾燥帯 (内陸 40-60% が B 群)     : ${share((c) => majorClassOf(c.classId) === 1, 40, 60)}`,
  );
  console.log(
    `  東岸湿潤   (東岸 80-100% が Cfa/Cwa) : ${share((c) => /^C[fw]a/.test(sym(c)), 80, 100)}`,
  );

  // 東西の非対称そのもの。**構造が出ているかの一番粗い指標**
  const west = cells.filter((c) => c.frac <= 0.2);
  const east = cells.filter((c) => c.frac >= 0.8);
  const inner = cells.filter((c) => c.frac >= 0.4 && c.frac <= 0.6);
  const wm = (g: Cell[], f: (c: Cell) => number): number => {
    const s = g.reduce((a, c) => a + c.w, 0);
    return g.reduce((a, c) => a + c.w * f(c), 0) / Math.max(1e-9, s);
  };
  console.log(
    `\n  年降水 西岸 ${wm(west, (c) => c.annual).toFixed(0)} / 内陸 ${wm(inner, (c) => c.annual).toFixed(0)}` +
      ` / 東岸 ${wm(east, (c) => c.annual).toFixed(0)} mm`,
  );
  console.log(
    '  読み: 内陸が両岸より乾いていれば「内陸乾燥」は出ている。\n' +
      '        東岸が西岸より湿っていれば「東岸湿潤」は出ている。\n' +
      '        どちらも出ていなければ、大陸規模の構造は地球の海岸線に依存していた疑いがある。',
  );
}

void main();
