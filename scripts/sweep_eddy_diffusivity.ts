// 掃引: **渦拡散が降水分布の両端を潰しているか。**
//
// 事前登録: docs/事前登録_渦拡散が分布の両端を潰しているか_2026-08-16.md
//   予測を先に固定してある。結果を見てから条件を動かさないこと。
//
// 疑い(独立な 3 つの観察が同じ向きを指している):
//   1. 降水分布の両端が潰れている(1% 分位 7.11 倍・99% 分位 0.89 倍)
//   2. 較正が `moistureEddyDiffusivityM2PerS` を上限 3.0e6 に張り付かせた
//   3. 較正が構造を作る定数 2 つ(収束持上げ・高温湿潤の対流)を 0 へ落とした
//
//   拡散は勾配を均す演算子なので、強めれば分布は必ず中央へ寄る。
//   **「均して合わせる」ほうが目的関数の得点が高かった**のではないか。
//
// 予測(事前登録より):
//   1. 拡散を下げると 1% 分位は下がる(66 → 30 前後)
//   2. 同時に中位も下がる(545 → 480 前後)。**すでに観測 596 より低いので悪化**
//   3. したがって分布形の誤差は下がるが大分類は下がり、**目的関数では相殺する**
//   4. 数値的健全性は保たれる
//
//   予測 3 が当たるなら「拡散を下げる」は単独では手にならず、
//   失われた輸送を**構造のある機構**で置き換える組の設計へ進む。
//
// **比較は `continuousV3`(ゲート項を除いた連続部分)で行う。**
// fitness の絶対値は目的関数の版で意味が変わる。
//
// 実行: npx tsx scripts/sweep_eddy_diffusivity.ts [--parallel N]
//       **v24 較正の終了後に走らせること**(GPU の競合を避ける)

import { MODEL_CONSTANTS } from '../src/sim/constants';
import {
  formatHeader,
  resolveParallel,
  resolveTargets,
  runSweep,
} from './sweep_lib';

const KEY = 'moistureEddyDiffusivityM2PerS';

// 事前登録した水準。現在値(= 探索空間の上限)から 1/5 まで。
// **等間隔で下げる**のは、効き方が線形かどうかを見るため
// (どこかで急に壊れるなら、その手前が使える範囲)
const VALUES = [3.0e6, 2.4e6, 1.8e6, 1.2e6, 0.6e6];

async function main(): Promise<void> {
  const targets = resolveTargets();
  const parallel = resolveParallel(VALUES.length);
  const base = (MODEL_CONSTANTS as unknown as Record<string, number>)[KEY] ?? 0;
  console.log(formatHeader(KEY, base, targets));
  console.log(
    `\n事前登録: docs/事前登録_渦拡散が分布の両端を潰しているか_2026-08-16.md\n` +
      `並列度 ${parallel}\n`,
  );
  const reports = await runSweep(KEY, VALUES, targets, parallel);

  // ---- 予測の答え合わせに要る 3 点だけを、最後にまとめて出す ----
  console.log('\n===== 予測の答え合わせ用のまとめ =====');
  console.log('値        1%分位  50%分位  99%分位  分布誤差  連続部分  大分類  数値健全');
  for (const p of reports) {
    const q = (pct: number): string => {
      const hit = p.quantiles.find((x) => x[0] === pct);
      return hit ? hit[1].toFixed(0).padStart(6) : '     —';
    };
    const sound =
      p.transportNonConverged + p.virgaNonConverged === 0 &&
      p.coupling.converged &&
      (p.soil?.converged ?? true) &&
      p.ebmCapHits === 0;
    console.log(
      `${p.value.toExponential(1).padEnd(9)} ${q(1)} ${q(50)} ${q(99)}` +
        `  ${p.quantileLogErr.toFixed(3).padStart(7)}` +
        `  ${p.continuousV3.toFixed(3).padStart(8)}` +
        `  ${p.majorPct.toFixed(2).padStart(6)}  ${sound ? '○' : '**×**'}`,
    );
  }
  const first = reports[0];
  const last = reports[reports.length - 1];
  if (first && last) {
    console.log(
      `\n観測の分位: 1% 9 / 50% 596 / 99% 3393 mm/年\n` +
        `予測 1(1% 分位が下がる)   : ${first.quantiles[0]?.[1].toFixed(0)} → ${last.quantiles[0]?.[1].toFixed(0)}\n` +
        `予測 2(中位も下がる)       : ${first.quantiles.find((x) => x[0] === 50)?.[1].toFixed(0)} → ${last.quantiles.find((x) => x[0] === 50)?.[1].toFixed(0)}\n` +
        `予測 3(連続部分で相殺)     : ${first.continuousV3.toFixed(3)} → ${last.continuousV3.toFixed(3)}`,
    );
  }
}

void main();
