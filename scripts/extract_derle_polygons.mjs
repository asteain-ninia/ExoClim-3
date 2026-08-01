// デーレの国境ポリゴンを derle-map-visualizer からヘッドレス抽出する。
//
// 国境は「線」のベクターであり、derle-map-visualizer の logic.js が
// 線群 → 交点分割 → グラフ → 面(ポリゴン)の順で領域を復元する。
// その処理は SVG の実測(getPointAtLength / getCTM)を使うためブラウザが要る。
// ここでは Playwright(E2E で導入済み)で最小の実行ページを組み立てて回す。
//
// 出力: out/derle/country_polygons.json
//   { widthPx, heightPx, polygons: [{ id, area, points: [[x,y], ...] }] }
//   座標は SVG のページ座標。緯度経度への変換は後段で行う
//   (ページ全体 = 360×180 度の等距円筒 — map_labels_extracted.json の注記)。
//
// 実行: node scripts/extract_derle_polygons.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIS_DIR = 'E:/WORKSPACE/derle-map-visualizer';
const OUT_DIR = path.join(HERE, '..', 'out', 'derle');

const SAMPLE_STEP = 1.2;
const SNAP = 1;
const DASH_SNAP_MULTIPLIER = 3;
const MIN_AREA = 50; // 微小な面を捨てる(px²)

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const svg = fs.readFileSync(path.join(VIS_DIR, 'イラレ出界図.svg'), 'utf8');
  const logic = fs.readFileSync(path.join(VIS_DIR, 'logic.js'), 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [page error]', m.text());
  });

  await page.setContent(
    `<!doctype html><html><body>
       <div id="host" style="position:absolute;left:-99999px;top:0"></div>
       <svg id="measure" width="0" height="0"></svg>
     </body></html>`,
  );
  await page.addScriptTag({ content: logic });
  await page.evaluate((svgText) => {
    const host = document.getElementById('host');
    host.innerHTML = svgText;
    const svgEl = host.querySelector('svg');
    window.__svg = svgEl;
    window.DerleLogic.setMeasureSvg(svgEl);
  }, svg);

  const info = await page.evaluate(() => {
    const svgEl = window.__svg;
    const vb = svgEl.viewBox?.baseVal;
    const ids = [...svgEl.querySelectorAll('[id]')].map((e) => e.id).filter((id) => id.startsWith('_'));
    return {
      viewBox: vb ? { x: vb.x, y: vb.y, w: vb.width, h: vb.height } : null,
      width: svgEl.getAttribute('width'),
      height: svgEl.getAttribute('height'),
      layerIds: ids.slice(0, 30),
    };
  });
  console.log('SVG:', JSON.stringify(info.viewBox), info.width, 'x', info.height);
  console.log('レイヤー候補:', info.layerIds.join(', '));

  console.log('国境線と海岸線を抽出中(数分かかります)…');
  const result = await page.evaluate(
    async ({ step, snap, dashMul, minArea }) => {
      const L = window.DerleLogic;
      const svgEl = window.__svg;
      const getLayer = (id) => svgEl.querySelector(`#${CSS.escape(id)}`);
      const borderLayer = getLayer('_国境界');
      if (!borderLayer) return { error: '_国境界 レイヤーが見つからない' };
      const isDashedElement = (el) => {
        const v = el.getAttribute('stroke-dasharray') || getComputedStyle(el).strokeDasharray;
        return !!v && v !== 'none' && v !== '0';
      };
      const border = await L.extractSegmentsFromLayer(borderLayer, step, 'border', null, {
        isDashed: isDashedElement,
        dashSnap: snap * dashMul,
      });
      let segments = border.slice();
      const landIds = ['_第一分高面', '_第二分高面', '_第三分高面', '_第四分高面', '_第五分高面'];
      let coastCount = 0;
      for (const id of landIds) {
        const layer = getLayer(id);
        if (!layer) continue;
        const coast = await L.extractSegmentsFromLayer(layer, step, 'coast', null);
        segments = segments.concat(coast);
        coastCount = coast.length;
        break; // 第一分高面(海岸線)のみ
      }
      const split = await L.splitSegmentsAtIntersections(segments, 64, snap, null);
      const graph = await L.buildGraphFromSegments(split, snap, null);
      const { polygons } = L.extractPolygonsFromGraph(graph, minArea);
      // polygons[].points はグラフ節点の「添字」配列。実座標へ解決する
      const nodes = graph.points;
      return {
        borderSegments: border.length,
        coastSegments: coastCount,
        splitSegments: split.length,
        nodes: nodes ? nodes.length : 0,
        polygons: polygons.map((p, i) => ({
          id: i,
          area: p.area ?? null,
          points: p.points.map((idx) => [
            Math.round(nodes[idx].x * 100) / 100,
            Math.round(nodes[idx].y * 100) / 100,
          ]),
        })),
      };
    },
    { step: SAMPLE_STEP, snap: SNAP, dashMul: DASH_SNAP_MULTIPLIER, minArea: MIN_AREA },
  );

  await browser.close();

  if (result.error) {
    console.error('失敗:', result.error);
    process.exit(1);
  }
  console.log(
    `国境線 ${result.borderSegments} / 海岸線 ${result.coastSegments} / ` +
      `分割後 ${result.splitSegments} / 節点 ${result.nodes} → ポリゴン ${result.polygons.length} 個`,
  );
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'derle-map-visualizer/イラレ出界図.svg + logic.js',
    note:
      '国境線(線ベクター)から復元した面。座標は SVG ページ座標。' +
      'ページ全体 = 360×180 度の等距円筒として緯度経度へ変換する',
    viewBox: info.viewBox,
    // 点の座標は viewBox 単位ではなく width/height 属性の単位(AI のページ座標)。
    // 緯度経度への変換はこちらで割ること(viewBox で割ると 10 倍ずれる)。
    pageSize: [parseFloat(info.width), parseFloat(info.height)],
    params: { sampleStep: SAMPLE_STEP, snap: SNAP, dashSnapMultiplier: DASH_SNAP_MULTIPLIER, minArea: MIN_AREA },
    polygons: result.polygons,
  };
  const outPath = path.join(OUT_DIR, 'country_polygons.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`出力: ${outPath}(${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
