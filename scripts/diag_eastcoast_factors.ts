// 診断: 理想化大陸の亜熱帯東岸(25〜35°)で何が雨を殺しているか(台帳 項目 15)。
// 45d で「東岸 25-35° が B 87%・291mm」と地球の中国東部と同型の欠けが出た。
// 保存型の P = λ·G·W を因子に分け、東岸・西岸・内陸で比べる。
// 実行: npx tsx scripts/diag_eastcoast_factors.ts [--earth]
import { runPipelineWithPrecipDiag } from '../src/sim/pipeline';
import { EARTH_PARAMS, type PlanetParams } from '../src/domain/planetParams';
import { latDegOfRow } from '../src/domain/grid';
import { openAccel } from './accel_cli';
import { MODEL_CONSTANTS } from '../src/sim/constants';
const K = MODEL_CONSTANTS as unknown as Record<string, number>;
if (process.env['DIAG_OVERRIDE']) {
  for (const part of process.env['DIAG_OVERRIDE'].split(',')) {
    const [n, v] = part.split('=');
    if (n && n.trim() in K) { K[n.trim()] = Number(v); console.log(`[上書き] ${n.trim()} = ${v}`); }
  }
}

const EARTH = process.argv.includes('--earth');
async function main(): Promise<void> {
  const params: PlanetParams = EARTH
    ? EARTH_PARAMS
    : { ...EARTH_PARAMS, gridResolutionDeg: 2, terrain: { kind: 'preset', preset: 'idealized_continent' } };
  const accel = await openAccel(true);
  let out;
  try { out = await runPipelineWithPrecipDiag(params, accel.opts); } finally { accel.close(); }
  const r = out.result; const d = out.precipDiag;
  const grid = r.context.grid; const W = grid.widthCells; const land = r.context.terrain.landMask;
  const dirE = r.context.params.body.rotationDirection >= 0 ? 1 : -1;
  // 陸セルの「大陸内の東西位置」: 同じ行で西端・東端までのセル数から
  type Acc = { w: number; p: number; wat: number; G: number; subs: number; desc: number; eastRel: number; itcz: number; front: number; other: number; supply: number; n: number };
  const mk = (): Acc => ({ w: 0, p: 0, wat: 0, G: 0, subs: 0, desc: 0, eastRel: 0, itcz: 0, front: 0, other: 0, supply: 0, n: 0 });
  const groups: Record<string, Acc> = { '西岸 0-20%': mk(), '内陸 40-60%': mk(), '東岸 80-100%': mk() };
  for (let row = 0; row < grid.heightCells; row++) {
    const lat = latDegOfRow(grid, row);
    if (Math.abs(lat) < 25 || Math.abs(lat) > 35) continue;
    const cw = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!land[i]) continue;
      let wc = 0, ec = 0;
      for (let dd = 1; dd < W; dd++) { if (land[row * W + (((col - dirE * dd) % W) + W) % W]) wc++; else break; }
      for (let dd = 1; dd < W; dd++) { if (land[row * W + (((col + dirE * dd) % W) + W) % W]) ec++; else break; }
      const width = wc + ec + 1;
      if (width < 5) continue;
      const frac = wc / (width - 1);
      const key = frac <= 0.2 ? '西岸 0-20%' : frac >= 0.8 ? '東岸 80-100%' : (frac >= 0.4 && frac <= 0.6 ? '内陸 40-60%' : '');
      if (!key) continue;
      const a = groups[key]!;
      // 年合計 / 12 か月平均
      let p = 0, wat = 0, G = 0, subs = 0, desc = 0, eastRel = 0, itcz = 0, front = 0, other = 0, supply = 0;
      for (let m = 0; m < 12; m++) {
        p += r.precipitation.monthlyPrecipMm[m]?.[i] ?? 0;
        wat += d.waterMm[m]?.[i] ?? 0;
        G += d.condRateG[m]?.[i] ?? 0;
        subs += d.subsidenceResidual[m]?.[i] ?? 0;
        desc += d.subsDescW[m]?.[i] ?? 0;
        eastRel += d.subsEastRel[m]?.[i] ?? 0;
        itcz += d.liftItcz[m]?.[i] ?? 0;
        front += d.liftFrontal[m]?.[i] ?? 0;
        other += d.liftOther[m]?.[i] ?? 0;
        supply += (d.supplyOcean[m]?.[i] ?? 0) + (d.supplyLand[m]?.[i] ?? 0) + (d.supplyStorm[m]?.[i] ?? 0);
      }
      a.w += cw; a.n++; a.p += cw * p; a.wat += cw * wat / 12; a.G += cw * G / 12; a.subs += cw * subs / 12;
      a.desc += cw * desc / 12; a.eastRel += cw * eastRel / 12; a.itcz += cw * itcz / 12; a.front += cw * front / 12; a.other += cw * other / 12; a.supply += cw * supply / 12;
    }
  }
  console.log(`${EARTH ? '地球' : '理想化大陸'} 亜熱帯 25〜35° の陸(年降水・月平均の因子)`);
  console.log('帯            n   年降水   W(mm)   G    沈降残存 descW  東岸緩和  liftItcz  liftFront  liftOther  供給');
  for (const [k, a] of Object.entries(groups)) {
    if (a.w === 0) continue;
    const f = (x: number, dgt = 2): string => (x / a.w).toFixed(dgt).padStart(7);
    console.log(`${k.padEnd(12)} ${String(a.n).padStart(3)} ${f(a.p, 0)} ${f(a.wat)} ${f(a.G)} ${f(a.subs)} ${f(a.desc)} ${f(a.eastRel)} ${f(a.itcz)} ${f(a.front)} ${f(a.other)} ${f(a.supply, 3)}`);
  }
  console.log('読み: 東岸の G が西岸並みに低ければ沈降(残存率)が主犯。W が低ければ供給/輸送が主犯。');
}
void main();
