// 診断: CRH の指数抑制を強めると結合反復が発散する。その**形**を見る。
//
// 事前登録: docs/事前登録_結合反復の緩和_2026-08-14.md
//
// なぜ要るか:
//   段 20 の再測定で、鋭さ 2 以上は結合反復が上限 24/24 に張り付き、
//   残差が許容 0.2 mm/月 に対し 4.695 / 26.652 / 46.608 になることが分かった
//   (docs/実験記録_凝結率の幅の再測定_2026-08-14.md)。
//
//   結合反復は**素のピカール反復** P(k+1) = F(P(k)) で、緩和が入っていない
//   (virga の外側反復には VIRGA_RELAXATION = 0.6 が入っている)。
//   通常の地球では縮小比 0.79 で 7 回で収束する。指数抑制は降水に対する
//   感度を跳ね上げるので、比が 1 を超えれば素のピカールは必ず発散する。
//
//   **発散が「物理の限界」なのか「反復の作り方の限界」なのかを分ける。**
//   単調に増える  → 写像が拡大的。緩和 α < 2/(1+L) なら救える見込みがある
//   振動して増える → 典型的に緩和がよく効く
//   不規則に暴れる → 写像が滑らかでない。緩和では救えない
//
// 実行: npx tsx scripts/diag_crh_coupling_ratio.ts [鋭さ,鋭さ,...] [反復上限]

import { runPipeline } from '../src/sim/pipeline';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EBM_SOLVER, EBM_FULL_CAPACITY_YEARS } from '../src/sim/step05_temperature';
import { COUPLING_ANDERSON, COUPLING_OVERRIDE, CRH_INNER } from '../src/sim/step06_precipitation';

// **テストと同じ安い条件で測る**(diag_hightilt_coupling.ts と同じ理由)。
// 見たいのは結合反復の残差列の形であって、EBM の精度ではない。
EBM_SOLVER.sweeps = 8;
EBM_FULL_CAPACITY_YEARS.years = 2;

const VALUES = (process.argv[2] ?? '0,1,2,3,4').split(',').map(Number);
const MAX_IT = Number(process.argv[3] ?? 40);
const RES = Number(process.argv[4] ?? 4);
/**
 * Anderson 加速の深さ(段 24)。0 = 無効 = 従来の素のピカール。
 * **加速は不動点を変えない**ので、収束したときの答えは深さに依らない。
 */
const DEPTH = Number(process.argv[5] ?? 0);
COUPLING_ANDERSON.depth = DEPTH;
/** 緩和の固定(0 = 適応)。加速と併用できる — 段 21 の「両方が要る」 */
const ALPHA = Number(process.argv[6] ?? 0);
COUPLING_OVERRIDE.relaxation = ALPHA;
/** CRH を輸送の内部で解く(段 25)。1 で有効 */
const INNER = Number(process.argv[7] ?? 0) > 0;
CRH_INNER.enabled = INNER;

/** "降水の結合反復 3/24(残差 1.234 mm/月)" から残差を取り出す */
function residualOf(detail: string): number | null {
  const m = /残差 ([0-9.eE+-]+)/.exec(detail);
  if (!m || m[1] === undefined) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

async function main(): Promise<void> {
  const K = MODEL_CONSTANTS as unknown as Record<string, number>;
  const base = K['crhSuppressionSharpness'] ?? 0;
  console.log(
    `格子 ${RES}°、反復上限 ${MAX_IT}、EBM は短縮(掃引 8・全熱容量 2 年)` +
      `、Anderson ${DEPTH > 0 ? `深さ ${DEPTH}` : '無効'}、緩和 ${ALPHA > 0 ? ALPHA : '適応'}` +
      `、CRH ${INNER ? '**輸送の内部で解く**' : '外側で代入(従来)'}`,
  );
  console.log('残差列と、隣り合う残差の比(比 < 1 なら縮小、> 1 なら拡大)\n');

  for (const s of VALUES) {
    K['crhSuppressionSharpness'] = s;
    const trail: number[] = [];
    const r = await runPipeline(
      { ...EARTH_PARAMS, gridResolutionDeg: RES },
      {
        budget: { precipCouplingIterations: MAX_IT },
        onProgress: (u) => {
          const v = u.detail ? residualOf(u.detail) : null;
          if (v !== null) trail.push(v);
        },
      },
    );
    const c = r.precipitation.coupling;
    console.log(
      `鋭さ ${s}: ${c.converged ? '収束' : '**未収束**'} ` +
        `${c.iterations}/${c.maxIterations} 回 / 最終残差 ${c.finalResidualMmPerMonth.toFixed(3)}`,
    );
    console.log('  残差: ' + trail.map((v) => v.toFixed(2)).join(' → '));
    const ratios: string[] = [];
    for (let i = 1; i < trail.length; i++) {
      const prev = trail[i - 1] ?? 0;
      const cur = trail[i] ?? 0;
      ratios.push(prev > 0 ? (cur / prev).toFixed(2) : '—');
    }
    console.log('  比  : ' + ratios.join(' '));
    // 形の判定: 比が安定して 1 未満なら縮小、安定して 1 超なら単調拡大、
    // 1 をまたいで暴れるなら不規則
    // 形の分類。**「比が 1 未満」だけでは足りない**(2026-08-14 に踏んだ):
    // 鋭さ 3 は比がちょうど 1.00 で残差が 22.62 に張り付く「停滞」だったのに、
    // 素朴な分類は「単調拡大」と誤ラベルした。停滞・緩慢・拡大は効く手が違う。
    //   縮小(比が明確に 1 未満) → そのまま収束する
    //   緩慢(比が 1 に漸近)     → 上限引き上げか加速。**緩和は逆効果**
    //   停滞(比がほぼ 1 で残差が減らない、2 周期) → **緩和が効く**
    //   拡大(比が明確に 1 超)   → 緩和が効く
    //   不規則                  → 写像が滑らかでない。緩和では救えない
    const tail = ratios.slice(-8).map(Number).filter((v) => Number.isFinite(v) && v < 5);
    if (tail.length > 0 && trail.length > 8) {
      const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
      const spread = Math.max(...tail) - Math.min(...tail);
      // 直近 8 回で残差が何割減ったか。停滞と緩慢を分けるのはこれ
      const last = trail[trail.length - 1] ?? 0;
      const ref = trail[Math.max(0, trail.length - 9)] ?? last;
      const drop = ref > 0 ? 1 - last / ref : 0;
      let 形: string;
      let 手: string;
      if (spread > 0.5) {
        形 = '不規則';
        手 = '写像が滑らかでない。緩和では救えない';
      } else if (mean > 1.02) {
        形 = '拡大';
        手 = `緩和 α < ${(2 / (1 + mean)).toFixed(2)} なら収束しうる`;
      } else if (drop < 0.01) {
        形 = '停滞(2 周期の疑い)';
        手 = '緩和が効く見込み。振動を潰す';
      } else if (mean > 0.95) {
        形 = '緩慢';
        手 =
          `このままでも収束するが、許容 0.2 まであと約 ` +
          `${Math.ceil(Math.log(0.2 / Math.max(1e-9, last)) / Math.log(mean))} 回。` +
          `**緩和は逆効果**。上限引き上げか加速(Aitken/Anderson)`;
      } else {
        形 = '縮小';
        手 = 'そのまま収束する';
      }
      console.log(
        `  末尾 8 回: 比の平均 ${mean.toFixed(3)} / ばらつき ${spread.toFixed(2)} / ` +
          `残差の減り ${(drop * 100).toFixed(1)}% → **${形}**`,
      );
      console.log(`  → ${手}`);
    }
    console.log('');
  }
  K['crhSuppressionSharpness'] = base;
}

void main();
