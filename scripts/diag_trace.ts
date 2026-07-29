// 海流トレースのデバッグ: 1 月の北大西洋で環流が欠ける原因を特定する。
// 流線の一覧(種類・起点・終点・長さ)を領域指定で出力する。

import { EARTH_PARAMS } from '../src/domain/planetParams';
import { buildSimContext } from '../src/sim/context';
import { computeItcz } from '../src/sim/step01_itcz';
import { computeWindBelt } from '../src/sim/step02_windbelt';
import { computeOceanCurrent } from '../src/sim/step03_ocean';

const ctx = buildSimContext({ ...EARTH_PARAMS, gridResolutionDeg: 1 });
const itcz = computeItcz(ctx);
const wind = computeWindBelt(ctx, itcz);
const ocean = computeOceanCurrent(ctx, itcz, wind);

const month = Number(process.argv[2] ?? 0);
const lines = ocean.monthlyStreamlines[month] ?? [];
console.log(`月 ${month}: 流線 ${lines.length} 本`);

// 北大西洋領域(lat 0..60, lon -100..0)に始点または終点を持つ流線
for (const [idx, sl] of lines.entries()) {
  const n = sl.points.length / 2;
  const sLat = sl.points[0] ?? 0;
  const sLon = sl.points[1] ?? 0;
  const eLat = sl.points[(n - 1) * 2] ?? 0;
  const eLon = sl.points[(n - 1) * 2 + 1] ?? 0;
  const inNA = (lat: number, lon: number) => lat > -5 && lat < 65 && lon > -100 && lon < 5;
  if (inNA(sLat, sLon) || inNA(eLat, eLon)) {
    console.log(
      `#${idx} ${sl.kind} 点${n} 始(${sLat.toFixed(0)},${sLon.toFixed(0)}) 終(${eLat.toFixed(0)},${eLon.toFixed(0)})`,
    );
  }
}
