// 診断: 雲底下再蒸発(virga)の外側反復は、なぜ 6 回で収束しないのか。その**形**を見る。
//
// 事前登録: docs/事前登録_乾いた端_2026-08-15.md
//
// なぜ要るか:
//   段 22 の掃引で `subCloudEvapCoef = 1` を測ったところ、外側反復が
//   **216 か月ぶん未収束**になり、事前登録の判定 1(5 系統すべて未収束 0)で
//   行が丸ごと適用範囲外になった。
//
//   `VIRGA_OUTER_ITERATIONS = 6` が足りるかは**一度も確かめられていない**。
//   コメント自身が「反復数と減衰は**答えを決めてはならない** — 収束を
//   確かめたうえで使う」と書いているのに、確かめた記録が無い。
//   **反復の打ち切りが答えを決めていた例を EBM で 3 件、結合反復で 1 件
//   踏んでいる**(docs/教訓.md)。同じ型である。
//
//   **道具の欠陥を物理の結論として記録しない。** 6 回で足りないだけなら
//   上限を上げれば済む。壊れ方によって効く手が逆になるので、形を見る:
//     単調に縮小（比 < 1）→ 上限を上げれば届く
//     緩慢（比が 1 へ近づく）→ 上限を上げる。緩和 α<1 は**逆効果**
//     停滞・振動（比 ≈ 1 で固定）→ 緩和 α を下げるのが効く
//     単調に拡大 → 写像が拡大的。緩和で救えるか、救えないか
//
// 実行: npx tsx scripts/diag_virga_ratio.ts [係数,係数,...] [反復上限]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { VIRGA_OVERRIDE } from '../src/sim/step06_precipitation';
import { EBM_SOLVER, EBM_FULL_CAPACITY_YEARS } from '../src/sim/step05_temperature';

// **テストと同じ安い条件で測る**(diag_crh_coupling_ratio.ts と同じ理由)。
// 見たいのは外側反復の残差列の形であって、EBM の精度ではない。
EBM_SOLVER.sweeps = 8;
EBM_FULL_CAPACITY_YEARS.years = 2;

const VALUES = (process.argv[2] ?? '1,3,6,12').split(',').map(Number);
const MAX_IT = Number(process.argv[3] ?? 40);
const RES = Number(process.argv[4] ?? 4);
/** 緩和の上書き(0 = 既定の 0.6)。**不動点を変えないので答えは同じ** */
const ALPHA = Number(process.argv[5] ?? 0);
/** 許容差(step06 の VIRGA_TOLERANCE と同じ値) */
const TOL = 5e-3;

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const base = K['subCloudEvapCoef'] ?? 0;
  console.log(
    `格子 ${RES}°、外側反復の上限 ${MAX_IT}、許容差 ${TOL}、EBM は短縮` +
      `、緩和 ${ALPHA > 0 ? `固定 ${ALPHA}` : '適応（既定）'}`,
  );
  console.log('各水準について、外側反復の maxChange の列と隣接比を出す。\n');

  for (const c of VALUES) {
    K['subCloudEvapCoef'] = c;
    VIRGA_OVERRIDE.maxIterations = MAX_IT;
    VIRGA_OVERRIDE.relaxation = ALPHA;
    VIRGA_OVERRIDE.trace = true;
    VIRGA_OVERRIDE.series = [];
    await runPipeline({ ...EARTH_PARAMS, gridResolutionDeg: RES });
    const series = VIRGA_OVERRIDE.series;
    VIRGA_OVERRIDE.trace = false;
    VIRGA_OVERRIDE.maxIterations = 0;
    VIRGA_OVERRIDE.relaxation = 0;

    // **最も収束しにくかった呼び出し**を代表に採る。平均を採ると
    // 「ほとんどの月は 2 回で収束する」に埋もれて、落ちている月が見えない
    let worst: number[] = [];
    let converged = 0;
    for (const s of series) {
      if (s.length > 0 && (s[s.length - 1] ?? 1) < TOL) converged++;
      if (s.length > worst.length) worst = s;
    }
    console.log(`── subCloudEvapCoef = ${c}`);
    console.log(
      `   呼び出し ${series.length} 件のうち収束 ${converged} 件 / 未収束 ${series.length - converged} 件`,
    );
    if (worst.length === 0) {
      console.log('   （外側反復が一度も回っていない。係数 0 か、降水が無い）\n');
      continue;
    }
    const head = worst.slice(0, 14);
    console.log(`   最悪の列: ${head.map((v) => v.toExponential(2)).join(' ')}${worst.length > 14 ? ' …' : ''}`);
    const ratios: number[] = [];
    for (let i = 1; i < Math.min(worst.length, 15); i++) {
      ratios.push((worst[i] ?? 0) / Math.max(1e-30, worst[i - 1] ?? 1));
    }
    console.log(`   隣接比 :  ${ratios.map((v) => v.toFixed(3)).join(' ')}`);
    const tail = ratios.slice(-4);
    const meanTail = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
    const first = worst[0] ?? 0;
    const last = worst[worst.length - 1] ?? 0;
    let shape: string;
    if (last < TOL) shape = `収束（${worst.length} 回）`;
    else if (meanTail < 0.9) shape = '縮小しているが上限が足りない → **上限を上げれば届く**';
    else if (meanTail < 1.02 && last < first) shape = '緩慢（比が 1 へ）→ 上限を上げる。緩和は逆効果';
    else if (meanTail < 1.02) shape = '停滞 → **緩和 α を下げる**のが効く';
    else shape = '拡大 → 緩和が要る（救えるかは比による）';
    console.log(
      `   末尾 4 回の平均比 ${meanTail.toFixed(3)}   初項 ${first.toExponential(2)} → 末項 ${last.toExponential(2)}`,
    );
    console.log(`   判定: ${shape}\n`);
  }
  K['subCloudEvapCoef'] = base;
  console.log(
    '読み: 「上限が足りない」なら VIRGA_OUTER_ITERATIONS を上げて測り直す。\n' +
      '  費用は増えるが、**未収束の解に成績をつけるよりはるかにまし**である。\n' +
      '  停滞なら VIRGA_RELAXATION を下げる。どちらも**答えを決めてはならない量**なので、\n' +
      '  収束を確かめたうえで固定すること。',
  );
}

void main();
