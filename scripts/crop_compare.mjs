// out/compare の全球 PNG から地域を切り出す(報告図の作成用)。
//
// 対応 spec: なし(可視化の補助)。
//
// 全球 PNG はケッペン(1°×3 倍)も場(2°×6 倍)も 1080×540 px で、
// x = (lon+180)/360*1080、y = (90-lat)/180*540 の同じ写像になっている。
// したがって切り出しは 1 つの関数で両方に効く。
//
// 実行: node scripts/crop_compare.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';

const SRC = path.join(process.cwd(), 'out', 'compare');
const DST = path.join(SRC, 'crop');
fs.mkdirSync(DST, { recursive: true });

const W = 1080;
const H = 540;

/** @type {{id:string, latMax:number, latMin:number, lonMin:number, lonMax:number}[]} */
const REGIONS = [
  { id: 'southern', latMax: -35, latMin: -90, lonMin: -180, lonMax: 180 },
  { id: 'arabia', latMax: 42, latMin: 0, lonMin: 25, lonMax: 95 },
  { id: 'eastasia', latMax: 55, latMin: 10, lonMin: 90, lonMax: 150 },
  { id: 'namerica', latMax: 60, latMin: 20, lonMin: -130, lonMax: -65 },
];

const LAYERS = [
  'koppen_obs',
  'koppen_model',
  'koppen_agree',
  'temp_diff',
  'range_diff',
  'precip_diff',
];

function crop(src, r, zoom) {
  const x0 = Math.round(((r.lonMin + 180) / 360) * W);
  const x1 = Math.round(((r.lonMax + 180) / 360) * W);
  const y0 = Math.round(((90 - r.latMax) / 180) * H);
  const y1 = Math.round(((90 - r.latMin) / 180) * H);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const out = new PNG({ width: cw * zoom, height: ch * zoom });
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4;
      for (let dy = 0; dy < zoom; dy++) {
        for (let dx = 0; dx < zoom; dx++) {
          const di = ((y * zoom + dy) * cw * zoom + x * zoom + dx) * 4;
          out.data[di] = src.data[si];
          out.data[di + 1] = src.data[si + 1];
          out.data[di + 2] = src.data[si + 2];
          out.data[di + 3] = 255;
        }
      }
    }
  }
  return out;
}

for (const layer of LAYERS) {
  const p = path.join(SRC, `${layer}.png`);
  if (!fs.existsSync(p)) {
    console.log(`欠: ${layer}`);
    continue;
  }
  const src = PNG.sync.read(fs.readFileSync(p));
  if (src.width !== W || src.height !== H) {
    console.log(`寸法が想定外: ${layer} ${src.width}x${src.height}`);
    continue;
  }
  for (const r of REGIONS) {
    const zoom = r.id === 'southern' ? 1 : 2;
    const out = crop(src, r, zoom);
    const name = `${r.id}_${layer}.png`;
    fs.writeFileSync(path.join(DST, name), PNG.sync.write(out));
    console.log(`${name} ${out.width}x${out.height}`);
  }
}
console.log(`出力: ${DST}`);
