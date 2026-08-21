// 診断: **件 2「ITCZ 吸引規則の一般化」(itczMoistLandPullDeg)は、線をどちらへ動かすか。**
//
// docs/事前登録_v31物理バッチ_2026-08-21.md 件 2 /
// docs/所見_計算順デバッグFB_2026-08-21.md Step1(利用者の目視):
//   - マダガスカルへ観測の ITCZ は強く収束するが、モデルは素通り(→ 夏に南下すべき)
//   - メキシコへの張り出しが観測にはあるがモデルに無い(→ 夏に北上すべき)
//   - チリ沖への冬の張り出しはモデルにしか無い(SST 連動は今回見送りのため
//     悪化しないことだけ見る)
//
// 何を出すか: 3 つの経度帯の月別 ITCZ 中心緯度(帯内平均)を、
// itczMoistLandPullDeg = 0(基準)と --pull 値(既定 4)で比較する。
// 観測との突き合わせはしない — **位置が動く向き**だけを見る診断。
//
// 実行: npx tsx scripts/diag_itcz_pull_general.ts [--res 1] [--pull 4]
//       DIAG_OVERRIDE=名前=値,... で他定数の上書き(組の実験用)も可

import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { MODEL_CONSTANTS } from '../src/sim/constants';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MONTHS_PER_YEAR } from '../src/domain/insolation';
import { colOfLonDeg } from '../src/domain/grid';

// 定数の上書き(組の実験用)。未知の名前は例外
if (process.env['DIAG_OVERRIDE']) {
  const K0 = MODEL_CONSTANTS as unknown as Record<string, number>;
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [name, raw] = part.split('=');
    const key = (name ?? '').trim();
    const v = Number(raw);
    if (!key || !(key in K0)) throw new Error(`DIAG_OVERRIDE: 未知の定数 '${key}'`);
    if (!Number.isFinite(v)) throw new Error(`DIAG_OVERRIDE: '${key}' の値が数値でない`);
    K0[key] = v;
    console.log(`[上書き] ${key} = ${v}`);
  }
}

const argNum = (flag: string, dflt: number): number => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : dflt;
  if (!Number.isFinite(v)) throw new Error(`${flag} の値が数値でない`);
  return v;
};
const RES = argNum('--res', 1);
const PULL = argNum('--pull', 4);

// 月 0 = 北半球冬至起点(src/domain/insolation.ts)。赤緯 < 0 が南半球夏
const REGIONS: { name: string; lon0: number; lon1: number; expect: string }[] = [
  { name: 'マダガスカル帯', lon0: 44, lon1: 50, expect: '赤緯 < 0(南半球夏)で南へ(Δ 負)' },
  { name: 'メキシコ西岸帯', lon0: -110, lon1: -100, expect: '赤緯 > 0(北半球夏)で北へ(Δ 正)' },
  { name: 'チリ沖', lon0: -75, lon1: -70, expect: '南下が増えない(SST 連動は見送り)' },
];

const params = { ...EARTH_PARAMS, gridResolutionDeg: RES };
const ctx = buildSimContext(params);
const K = MODEL_CONSTANTS as unknown as Record<string, number>;

// 基準(0)と比較値(--pull)。DIAG_OVERRIDE で基準側を組ませる実験もできる
// よう、この定数だけはここで両走行分を明示的に据える
K['itczMoistLandPullDeg'] = 0;
const itczBase = computeItcz(ctx);
K['itczMoistLandPullDeg'] = PULL;
const itczPull = computeItcz(ctx);
K['itczMoistLandPullDeg'] = 0;

const meanCenter = (itcz: { monthlyCenterLatDegByCol: Float32Array[] }, m: number, c0: number, c1: number): number => {
  const centers = itcz.monthlyCenterLatDegByCol[m];
  if (!centers) return NaN;
  let sum = 0;
  let n = 0;
  for (let c = c0; c <= c1; c++) {
    sum += centers[c] ?? 0;
    n++;
  }
  return n > 0 ? sum / n : NaN;
};

console.log(`格子 ${RES}°、itczMoistLandPullDeg: 0(基準)対 ${PULL}(比較)`);
console.log('月別 ITCZ 中心緯度の帯内平均(度、北が正)。Δ = 比較 − 基準');
for (const r of REGIONS) {
  const c0 = colOfLonDeg(ctx.grid, r.lon0 + 0.001);
  const c1 = colOfLonDeg(ctx.grid, r.lon1 - 0.001);
  console.log(`\n== ${r.name}(lon ${r.lon0}..${r.lon1}、col ${c0}..${c1})— 期待: ${r.expect}`);
  console.log('月   赤緯     基準     比較       Δ   (月 0 = 北半球冬至起点)');
  for (let m = 0; m < MONTHS_PER_YEAR; m++) {
    const decl = ctx.insolation.monthlyDeclinationDeg[m] ?? 0;
    const a = meanCenter(itczBase, m, c0, c1);
    const b = meanCenter(itczPull, m, c0, c1);
    const d = b - a;
    console.log(
      `${String(m).padStart(2)}  ${decl.toFixed(1).padStart(6)}  ${a.toFixed(2).padStart(7)}  ${b.toFixed(2).padStart(7)}  ${d >= 0 ? '+' : ''}${d.toFixed(3)}`,
    );
  }
}
