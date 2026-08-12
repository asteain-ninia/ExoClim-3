// 診断: 周極海峡(遮られない緯度行)の判定が、どの緯度に掛かっているか。
//
// パタゴニアの最暖月が 6°C 低い件で、標高は犯人でないと分かった
// (相関 0.10、むしろ低標高セルのほうが誤差が大きい)。
//
// 次に疑うのは周極海峡の判定である。陸割合 < channelLandFracMax(0.04)の行は
//   - 南北拡散を circumpolarChannelFactor(0.48)倍に落とす
//   - 海上の雲を channelCloudBoost(0.54)増やす
//   - 海洋混合層を channelMixedLayerBoost(3.0)倍に深くする
// の 3 つを同時に受ける。**南米南部は細いので、その行が海峡と判定されている
// 可能性がある。**3 つとも冷やす向きに効く。
//
// 実行: npx tsx scripts/diag_channel_rows.ts

import { createGrid, latDegOfRow } from '../src/domain/grid';
import { resolveTerrain } from '../src/domain/terrain';
import { EARTH_PARAMS } from '../src/domain/planetParams';
import { MODEL_CONSTANTS as K } from '../src/sim/constants';

const g = createGrid(1);
const t = resolveTerrain(g, EARTH_PARAMS.terrain);
console.log(
  `周極海峡の判定: 陸割合 < ${K.channelLandFracMax}（|lat| <= ${K.channelMaxAbsLatDeg}）\n`,
);
console.log('緯度    陸割合   海峡判定');
for (let row = 0; row < g.heightCells; row++) {
  const lat = latDegOfRow(g, row);
  if (lat > -35 || lat < -65) continue;
  let n = 0;
  for (let c = 0; c < g.widthCells; c++) if (t.landMask[row * g.widthCells + c]) n++;
  const f = n / g.widthCells;
  const isCh = f < K.channelLandFracMax && Math.abs(lat) <= K.channelMaxAbsLatDeg;
  console.log(
    `${lat.toFixed(1).padStart(6)} ${(f * 100).toFixed(2).padStart(7)}%  ${isCh ? '← 海峡扱い' : ''}`,
  );
}
