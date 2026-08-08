// 検証報告ページ(単一 HTML)を組み立てる。
//
// 対応 spec: なし(可視化・報告)。
//
// out/compare/*.png と out/validate/report.json を読み、画像を data URI で
// 埋め込んだ自己完結の HTML を出す。外部参照は一切しない。
//
// 凡例の色は render_compare.ts の着色関数を**そのまま写して**サンプルする。
// 手で色を決めると図と凡例がずれ、目視判断が使えなくなる。
//
// 実行: node scripts/build_report_page.mjs <出力先.html>

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';

const ROOT = process.cwd();
const CMP = path.join(ROOT, 'out', 'compare');
const OUT = process.argv[2] ?? path.join(ROOT, 'out', 'compare', 'report.html');

const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'validate', 'report.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(CMP, 'compare.json'), 'utf8'));

// ---- 画像の埋め込み ----

/** 2° の場は 6 倍で描かれている。1 セル 3px あれば十分なので 1/2 に間引く(最近傍・完全整数) */
function halve(buf) {
  const src = PNG.sync.read(buf);
  const out = new PNG({ width: src.width >> 1, height: src.height >> 1 });
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const si = (y * 2 * src.width + x * 2) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}

const FIELD_LAYERS = new Set(['temp', 'range', 'precip', 'driest']);
let embedded = 0;
let bytes = 0;

function img(rel, { shrink = false } = {}) {
  const p = path.join(CMP, rel);
  let buf = fs.readFileSync(p);
  if (shrink) buf = halve(buf);
  embedded++;
  bytes += buf.length;
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** 全球の場(2°)は間引く。ケッペン(1°)と地域切り出しはそのまま */
function fieldImg(tag, side) {
  return img(`${tag}_${side}.png`, { shrink: FIELD_LAYERS.has(tag) });
}

// ---- 凡例(render_compare.ts の着色関数の写し)----

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function tempColor(t) {
  const x = clamp(t, -45, 45) / 45;
  return [
    x > 0 ? 255 : Math.round(255 * (1 + x)),
    Math.round(200 * (1 - Math.abs(x))),
    x < 0 ? 255 : Math.round(255 * (1 - x)),
  ];
}
function rangeColor(dt) {
  const x = clamp(dt, 0, 60) / 60;
  return [Math.round(250 - 90 * x), Math.round(248 - 200 * x), Math.round(252 - 60 * x)];
}
function precipColor(mm) {
  const x = Math.min(1, Math.log1p(Math.max(0, mm)) / Math.log1p(4000));
  return [Math.round(250 - 210 * x), Math.round(245 - 120 * x), Math.round(220 - 60 * x)];
}
function diffColor(d, half) {
  const x = clamp(d / half, -1, 1);
  if (x >= 0) return [255, Math.round(255 * (1 - x)), Math.round(255 * (1 - x))];
  return [Math.round(255 * (1 + x)), Math.round(255 * (1 + x)), 255];
}
const rgb = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/** 着色関数を N 点で刻んで CSS グラデーションにする */
function ramp(fn, lo, hi, n = 24) {
  const stops = [];
  for (let i = 0; i <= n; i++) {
    const v = lo + ((hi - lo) * i) / n;
    stops.push(`${rgb(fn(v))} ${((i / n) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// ケッペンの記号と色は src/domain/koppen.ts から取り出す(手写しにすると図とずれる)
function koppenTable() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'koppen.ts'), 'utf8');
  const symRaw = /KOPPEN_CLASSES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  const colRaw = /KOPPEN_COLORS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!symRaw || !colRaw) throw new Error('koppen.ts から記号・色を取り出せない');
  // 0 番は空文字(海)なので `*` で拾う。`+` だとここだけ落ちて全体が 1 つずれる
  const symbols = [...symRaw[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const colors = [...colRaw[1].matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g)].map((m) => [
    +m[1],
    +m[2],
    +m[3],
  ]);
  if (symbols.length !== colors.length) throw new Error(`記号 ${symbols.length} 色 ${colors.length}`);
  return { symbols, colors };
}

/** 大分類ごとに束ねたケッペンの凡例(0 番は海なので飛ばす) */
function koppenLegend() {
  const { symbols, colors } = koppenTable();
  const groups = [
    { name: 'A 熱帯', from: 1, to: 3 },
    { name: 'B 乾燥', from: 4, to: 7 },
    { name: 'C 温帯', from: 8, to: 16 },
    { name: 'D 冷帯', from: 17, to: 28 },
    { name: 'E 寒帯', from: 29, to: 30 },
  ];
  return (
    `<div class="klegend">` +
    groups
      .map((g) => {
        let items = '';
        for (let i = g.from; i <= g.to; i++) {
          items += `<span><i style="background:${rgb(colors[i])}"></i>${symbols[i]}</span>`;
        }
        return `<div class="kgroup"><b>${g.name}</b><div class="kitems">${items}</div></div>`;
      })
      .join('') +
    `</div>`
  );
}

function legend(gradient, ticks) {
  const marks = ticks.map((t) => `<span>${t}</span>`).join('');
  return `<div class="legend"><div class="ramp" style="background:${gradient}"></div><div class="ticks">${marks}</div></div>`;
}

const LEG = {
  temp: legend(ramp(tempColor, -45, 45), ['−45°C', '−22', '0', '22', '45°C']),
  range: legend(ramp(rangeColor, 0, 60), ['0°C', '15', '30', '45', '60°C']),
  precip: legend(ramp(precipColor, 0, 4000), ['0mm', '100', '450', '1600', '4000mm']),
  driest: legend(ramp(precipColor, 0, 4000), ['0mm', '100', '450', '1600', '4000mm']),
  dTemp: legend(ramp((d) => diffColor(d, 8), -8, 8), ['−8°C 冷', '−4', '一致', '+4', '+8°C 暖']),
  dRange: legend(ramp((d) => diffColor(d, 12), -12, 12), ['−12°C 小', '−6', '一致', '+6', '+12°C 大']),
  dPrecip: legend(
    ramp((d) => diffColor(d, 800), -800, 800),
    ['−800mm 乾', '−400', '一致', '+400', '+800mm 湿'],
  ),
  dDriest: legend(
    ramp((d) => diffColor(d, 40), -40, 40),
    ['−40mm 乾', '−20', '一致', '+20', '+40mm 湿'],
  ),
};

// ---- 帯状平均のグラフ ----

const zonal = report.temperature.nonAreaWeighted.zonalAnnual;

function zonalChart(obsKey, modelKey, title) {
  const W = 560;
  const H = 300;
  const M = { t: 26, r: 14, b: 34, l: 46 };
  const pts = zonal.slice().sort((a, b) => a.lat - b.lat);
  const lats = pts.map((p) => p.lat);
  const vals = pts.flatMap((p) => [p[obsKey], p[modelKey]]);
  const vMin = Math.floor(Math.min(...vals) / 10) * 10;
  const vMax = Math.ceil(Math.max(...vals) / 10) * 10;
  const x = (lat) => M.l + ((lat - Math.min(...lats)) / (Math.max(...lats) - Math.min(...lats))) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - (v - vMin) / (vMax - vMin)) * (H - M.t - M.b);

  const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.lat).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const band =
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.lat).toFixed(1)} ${y(p[obsKey]).toFixed(1)}`).join(' ') +
    ' ' +
    pts
      .slice()
      .reverse()
      .map((p) => `L${x(p.lat).toFixed(1)} ${y(p[modelKey]).toFixed(1)}`)
      .join(' ') +
    ' Z';

  // 最大乖離の帯を印す
  let worst = pts[0];
  for (const p of pts) if (Math.abs(p[modelKey] - p[obsKey]) > Math.abs(worst[modelKey] - worst[obsKey])) worst = p;
  const gap = worst[modelKey] - worst[obsKey];

  const gridLines = [];
  for (let v = vMin; v <= vMax; v += 20) {
    gridLines.push(
      `<line class="grid" x1="${M.l}" y1="${y(v).toFixed(1)}" x2="${W - M.r}" y2="${y(v).toFixed(1)}"/>` +
        `<text class="ax" x="${M.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`,
    );
  }
  const latTicks = [-90, -60, -30, 0, 30, 60, 80]
    .map(
      (l) =>
        `<text class="ax" x="${x(l).toFixed(1)}" y="${H - M.b + 18}" text-anchor="middle">${
          l === 0 ? '赤道' : Math.abs(l) + (l < 0 ? '°S' : '°N')
        }</text>`,
    )
    .join('');

  return `<figure class="chart">
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}の帯状平均気温、観測とモデル">
    <text class="ttl" x="${M.l}" y="16">${title}</text>
    ${gridLines.join('')}
    <path class="band" d="${band}"/>
    <path class="obs" d="${line(obsKey)}"/>
    <path class="mdl" d="${line(modelKey)}"/>
    <circle class="worst" cx="${x(worst.lat).toFixed(1)}" cy="${y(worst[modelKey]).toFixed(1)}" r="4"/>
    <text class="worstlbl" x="${(x(worst.lat) + 8).toFixed(1)}" y="${(y(worst[modelKey]) + 4).toFixed(1)}">${
      worst.lat < 0 ? Math.abs(worst.lat) + '°S' : worst.lat + '°N'
    } ${gap > 0 ? '+' : ''}${gap.toFixed(1)}°C</text>
    ${latTicks}
  </svg>
</figure>`;
}

// ---- 部品 ----

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plate(n, title, lead, panels, note) {
  const cells = panels
    .map(
      (p) =>
        `<figure class="panel"><img src="${p.src}" alt="${esc(p.alt)}" loading="lazy"><figcaption><b>${esc(
          p.cap,
        )}</b>${p.sub ? `<span>${esc(p.sub)}</span>` : ''}</figcaption>${p.legend ?? ''}</figure>`,
    )
    .join('\n');
  return `<section class="plate">
  <header class="plate-h"><span class="pnum">図版 ${n}</span><h2>${esc(title)}</h2></header>
  <p class="lead">${lead}</p>
  <div class="panels p${panels.length}">${cells}</div>
  ${note ? `<div class="note">${note}</div>` : ''}
</section>`;
}

// ---- 中身 ----

const s = meta.scores;
const agree = meta.koppenAgreement;
const nCells = agree.detail + agree.majorOnly + agree.miss;

const stats = [
  { v: s.majorPct.toFixed(1) + '%', k: 'ケッペン大分類の一致', n: '基準 73.4% / 途中目標 70%' },
  { v: s.detailPct.toFixed(1) + '%', k: 'ケッペン詳細の一致', n: '基準 42.2%' },
  { v: s.tempRmse.toFixed(2), k: '年平均気温 RMSE (°C)', n: '観測の空間 SD 18.06°C' },
  { v: Math.round(s.precipRmse) + '', k: '年降水 RMSE (mm)', n: '観測の空間 SD 773mm' },
  { v: s.tempRangeRmse.toFixed(2), k: '年較差 RMSE (°C)', n: '観測の空間 SD 12.86°C' },
  { v: '14 / 17', k: '地域ゲートの通過', n: 'インド・東アジア・パタゴニアが不通過' },
];

const gates = report.regionGates;
const GATE_JA = {
  sahara_arid: 'サハラ — 乾燥',
  arabia_arid: 'アラビア — 乾燥',
  australia_interior_arid: 'オーストラリア内陸 — 乾燥',
  amazon_tropical: 'アマゾン — 熱帯雨林',
  congo_tropical: 'コンゴ — 熱帯雨林',
  india_tropical: 'インド — 熱帯',
  us_southeast_humid: '米国南東部 — 湿潤温帯',
  east_asia_humid: '東アジア — 湿潤温帯',
  west_europe_temperate: '西ヨーロッパ — 海洋性',
  europe_russia_continental: 'ロシア西部 — 大陸性',
  west_siberia_continental: '西シベリア — 大陸性',
  east_siberia_continental: '東シベリア — 大陸性',
  mediterranean_cs_present: '地中海 — 夏乾燥',
  california_cs_present: 'カリフォルニア — 夏乾燥',
  tibet_cold_highland: 'チベット — 高地寒冷',
  patagonia_rainshadow: 'パタゴニア — 雨陰',
  antarctica_ice: '南極 — 氷雪',
};

const MAJOR = ['A 熱帯', 'B 乾燥', 'C 温帯', 'D 冷帯', 'E 寒帯'];
const conf = report.koppen.confusionMajorPct;

const confRows = conf
  .map((row, i) => {
    const tds = row
      .map((v, j) => {
        const on = i === j;
        const a = Math.min(1, v / 24);
        return `<td class="${on ? 'diag' : ''}" style="--a:${a.toFixed(3)}">${v.toFixed(1)}</td>`;
      })
      .join('');
    return `<tr><th>${MAJOR[i]}</th>${tds}</tr>`;
  })
  .join('');

const gateRows = gates
  .map(
    (g) =>
      `<tr class="${g.pass ? 'ok' : 'ng'}"><td class="mark">${g.pass ? '通過' : '不通過'}</td><th>${esc(
        GATE_JA[g.id] ?? g.id,
      )}</th><td class="det">${esc(g.detail)}</td></tr>`,
  )
  .join('');

const REGIONS = [
  {
    id: 'southern',
    title: '南大洋と南極 — 最大の残差',
    body: `帯状平均で <b>7 月の 60°S が観測 −11.7°C に対しモデル −38.1°C</b>、乖離 26.4°C。
      最終受入の「帯状平均気温の乖離 ±5°C 以内」に唯一届いていない項目がこれで、しかも桁が違う。
      原因は海氷の双安定で、氷の有無がその場の気温だけで決まるため、
      <b>一度凍ると明るくなって冷え、冷えるからまた凍る</b>という正帰還が閉じている。
      南大洋は一年中 −32〜−40°C で凍りついたまま抜け出せない。`,
    layers: ['koppen_agree', 'temp_diff'],
    caps: ['ケッペンの一致(南緯 35° 以南)', '年平均気温の差(モデル − 観測)'],
  },
  {
    id: 'eastasia',
    title: '東アジア — 湿潤温帯が砂漠になっている',
    body: `観測(左)で黄緑の Cwa/Cfa が広がる中国東部に、モデル(中)は<b>真っ赤な BWh(高温砂漠)</b>を置いている。
      年降水は 340mm(目標 750mm)。地域ゲート <code>east_asia_humid</code> の中身は
      「BWh 47%、BWk 16%、BSh 13%」で、温帯の文字が一つも出てこない。
      モンスーンの水を大陸内部へ運ぶ経路が立っていないと見ている。<b>ここは未診断。</b>`,
    layers: ['koppen_obs', 'koppen_model', 'precip_diff'],
    caps: ['観測(Beck 2023)', 'モデル', '年降水の差(モデル − 観測)'],
  },
  {
    id: 'arabia',
    title: 'アラビアとインド — 亜熱帯の砂漠が湿りすぎる',
    body: `サハラとアラビアの降水差は赤(モデルが湿りすぎ)。乾燥自体は当てられていて
      <code>sahara_arid</code>・<code>arabia_arid</code> は通過しているが、インドは
      「BWh 52%」と<b>逆に乾かしすぎて</b>不通過になる。
      亜熱帯の水収支が全体に鈍く、乾湿のコントラストが足りていない。
      抑制の乗数を保存型の水収支へ置き換える案は<b>実測で棄却済み</b> —
      保存すると水は消えずに移動するだけで、砂漠が別の砂漠を濡らした。`,
    layers: ['koppen_obs', 'koppen_model', 'precip_diff'],
    caps: ['観測', 'モデル', '年降水の差'],
  },
  {
    id: 'namerica',
    title: '北米 — 高緯度が暖かすぎ、内陸の年較差が大きすぎる',
    body: `カナダ北部からアラスカにかけて気温差が赤く飽和している(80°N の 1 月で観測 −30.6°C に対しモデル −16.4°C)。
      北極海の氷が秋に張らず、海が暖かいまま冬へ入るため。
      一方で中西部の年較差は右図が赤く、<b>モデルのほうが大きい</b>。<b>蒸発冷却を実 ET へ繋ぎ替えて年較差 RMSE は 9.77 → 8.97°C まで戻した</b>が、
      内陸の夏が暑い傾向はまだ残る。`,
    layers: ['koppen_agree', 'temp_diff', 'range_diff'],
    caps: ['ケッペンの一致', '年平均気温の差', '年較差の差'],
  },
];

const regionSections = REGIONS.map((r) => {
  const cells = r.layers
    .map((l, i) => {
      const src = img(`crop/${r.id}_${l}.png`);
      return `<figure class="panel"><img src="${src}" alt="${esc(r.title)} ${esc(r.caps[i])}" loading="lazy"><figcaption><b>${esc(
        r.caps[i],
      )}</b></figcaption></figure>`;
    })
    .join('\n');
  return `<article class="region">
    <h3>${esc(r.title)}</h3>
    <p>${r.body}</p>
    <div class="panels p${r.layers.length} ${r.id === 'southern' ? 'wide' : ''}">${cells}</div>
  </article>`;
}).join('\n');

// ---- 図版 ----

const plates = [
  plate(
    1,
    'ケッペン気候区',
    `分類そのものは採点の対象ではない。<b>気温と降水という物理量を先に出し、
     ケッペンはそれを外から採点する物差しとして後から当てている。</b>
     観測は Beck ほか(2023)の 1° 格子。`,
    [
      { src: fieldImg('koppen', 'obs'), cap: '観測', sub: 'Beck 2023', alt: '観測のケッペン気候区' },
      { src: fieldImg('koppen', 'model'), cap: 'モデル', sub: 'ExoClim-3', alt: 'モデルのケッペン気候区' },
    ],
    koppenLegend(),
  ),
  plate(
    2,
    'どこが当たり、どこが外れているか',
    `濃緑は詳細(第 3 文字まで)一致、黄は大分類だけ一致、赤は大分類から外れ。
     全 ${nCells.toLocaleString('ja-JP')} セル中、詳細 ${agree.detail.toLocaleString('ja-JP')} /
     大分類のみ ${agree.majorOnly.toLocaleString('ja-JP')} / 不一致 ${agree.miss.toLocaleString('ja-JP')}。`,
    [
      {
        src: fieldImg('koppen', 'agree'),
        cap: '一致マップ',
        sub: '緑=詳細一致 / 黄=大分類のみ / 赤=不一致',
        alt: 'モデルと観測の一致マップ',
        legend: `<div class="legend swatches">
          <span><i style="background:rgb(40 130 70)"></i>詳細まで一致</span>
          <span><i style="background:rgb(235 205 80)"></i>大分類のみ一致</span>
          <span><i style="background:rgb(200 60 55)"></i>不一致</span>
        </div>`,
      },
    ],
    `<p><b>正直に言うと、この 75.2% は南極に助けられている。</b>観測の陸セルの 9.5% が
      EF(氷雪)で、その大半が南極大陸。モデルも一様に EF を返すので丸ごと緑になるが、
      これは<b>一切難しくない一致</b>である。<br>
      一方で黄色の帯 — 北ユーラシアと北米の冷帯 — は「D は当てたが第 2・3 文字を外した」失敗。
      観測で 10.4% を占める <b>Dfc</b>(短い夏)はモデルの上位 12 位に一度も出てこず、
      代わりに <b>Dfa</b>(暑い夏)が 10.3% 出ている。<b>冷帯の夏を暑くしすぎている</b>。
      詳細一致が 44.1% に留まる主因のひとつがこれで、
      図版 4 のシベリアが赤い(年較差が大きすぎる)ことと同じ現象である。<br>
      赤が固まっているのは中国東部、パタゴニア、インド、北極海沿岸。
      <b>この 4 か所が次にやるべきことの一覧そのもの</b>になっている。</p>`,
  ),
  plate(
    3,
    '年平均気温',
    `観測は 2° 格子(earth_climate_2deg)。採点と同じ集約で描いているので、
     <b>絵で見える差は点にそのまま出る</b>。灰色は観測の欠測。`,
    [
      { src: fieldImg('temp', 'obs'), cap: '観測', alt: '観測の年平均気温', legend: LEG.temp },
      { src: fieldImg('temp', 'model'), cap: 'モデル', alt: 'モデルの年平均気温', legend: LEG.temp },
      { src: fieldImg('temp', 'diff'), cap: '差(モデル − 観測)', alt: '年平均気温の差', legend: LEG.dTemp },
    ],
    `<p>差の図が語っているのは 2 つだけで、<b>両方とも極域</b>である。
      北半球の高緯度は一様に赤(暖かすぎ)、南極周辺は一様に青(寒すぎ)。
      中低緯度はほぼ白で、陸の内部での誤りはもう小さい。
      RMSE 4.16°C のうち、大半をこの 2 つの極が作っている。</p>`,
  ),
  plate(
    4,
    '年較差(最暖月 − 最寒月)',
    `大陸性か海洋性かを決める量。<b>3 回の較正で一度も動かず、
     この 8 月に初めて動いた指標</b>でもある。`,
    [
      { src: fieldImg('range', 'obs'), cap: '観測', alt: '観測の年較差', legend: LEG.range },
      { src: fieldImg('range', 'model'), cap: 'モデル', alt: 'モデルの年較差', legend: LEG.range },
      { src: fieldImg('range', 'diff'), cap: '差(モデル − 観測)', alt: '年較差の差', legend: LEG.dRange },
    ],
    `<p>シベリアが赤(較差が大きすぎ)、サハラ・アラビア・オーストラリアが青(小さすぎ)。
      <b>この青が「半乾燥の夏が暑すぎる」の裏返し</b>で、蒸発冷却が抜けていたことの跡である。
      実蒸発散へ繋ぎ替えて 9.77 → 8.97°C まで戻したが、砂漠の青はまだ残っている。
      なお陸の熱容量を土壌水分に比例させる案は<b>棄却した</b> —
      3 倍動かしても 0.08°C しか変わらない。陸の気温は熱容量ではなく
      東西の移流結合が支配していて、熱容量は事実上効かない。</p>`,
  ),
  plate(
    5,
    '年降水量',
    `対数目盛。ケッペンの B(乾燥)と A(熱帯)の境目はここで決まる。`,
    [
      { src: fieldImg('precip', 'obs'), cap: '観測', alt: '観測の年降水量', legend: LEG.precip },
      { src: fieldImg('precip', 'model'), cap: 'モデル', alt: 'モデルの年降水量', legend: LEG.precip },
      { src: fieldImg('precip', 'diff'), cap: '差(モデル − 観測)', alt: '年降水量の差', legend: LEG.dPrecip },
    ],
    `<p>陸の平均は ${Math.round(s.landMeanMm)}mm/年、観測 794mm/年 —
      <b>総量は合っている。合っていないのは配り方</b>である。
      アマゾン内部が濃青(乾きすぎ)、その東縁が赤。中国東部が青。
      サハラ・アラビアとヨーロッパ北部が赤。
      対数相関 ${report.precipitation.logCorrelation} は、桁は追えているが分布の細部は外している、という数字。</p>`,
  ),
  plate(
    6,
    '最少月の降水量',
    `乾季の深さ。<b>Aw と Af、Cfa と Cwa を分けるのはこの量</b>で、
     詳細一致 44.1% が伸びない理由の多くがここにある。`,
    [
      { src: fieldImg('driest', 'obs'), cap: '観測', alt: '観測の最少月降水量', legend: LEG.driest },
      { src: fieldImg('driest', 'model'), cap: 'モデル', alt: 'モデルの最少月降水量', legend: LEG.driest },
      { src: fieldImg('driest', 'diff'), cap: '差(モデル − 観測)', alt: '最少月降水量の差', legend: LEG.dDriest },
    ],
    `<p>RMSE ${report.precipitation.driestMonthRmseMm.toFixed(1)}mm に対し、
      観測自身の空間 SD が ${report.precipitation.obsSdDriestMm.toFixed(1)}mm。
      <b>ほぼ同じ大きさ</b>ということは、乾季の深さについてモデルは
      「全球平均を答えているのと大差ない」水準にある。ここは伸びしろが大きい。</p>`,
  ),
];

// ---- HTML ----

const html = `<title>ExoClim-3 — 地球はどこまで再現できているか</title>
<style>
:root{
  --paper:#F5F4F0; --ink:#171B21; --ink-2:#4E555F; --ink-3:#828A95;
  --rule:#DAD8D1; --panel:#FFFFFF; --sea:#0F1E37;
  --accent:#1F6B5C; --accent-soft:#E3EFEB; --alert:#B23E36;
  --mono:ui-monospace,"Cascadia Mono",Consolas,"SFMono-Regular",Menlo,monospace;
  --sans:"Yu Gothic UI","Yu Gothic","Hiragino Kaku Gothic ProN","Noto Sans JP","Meiryo",system-ui,sans-serif;
  --serif:"Yu Mincho","YuMincho","Hiragino Mincho ProN","Noto Serif JP","MS PMincho",serif;
}
@media (prefers-color-scheme:dark){
  :root{
    --paper:#0D1116; --ink:#DFE4EA; --ink-2:#9AA3AE; --ink-3:#6B7480;
    --rule:#242C36; --panel:#141A21; --accent:#4FB39C; --accent-soft:#152B27; --alert:#E0665C;
  }
}
:root[data-theme="dark"]{
  --paper:#0D1116; --ink:#DFE4EA; --ink-2:#9AA3AE; --ink-3:#6B7480;
  --rule:#242C36; --panel:#141A21; --accent:#4FB39C; --accent-soft:#152B27; --alert:#E0665C;
}
:root[data-theme="light"]{
  --paper:#F5F4F0; --ink:#171B21; --ink-2:#4E555F; --ink-3:#828A95;
  --rule:#DAD8D1; --panel:#FFFFFF; --accent:#1F6B5C; --accent-soft:#E3EFEB; --alert:#B23E36;
}

body{background:var(--paper);color:var(--ink);font-family:var(--sans);
  line-height:1.85;font-size:15.5px;-webkit-font-smoothing:antialiased;}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px 96px;}
.col{max-width:44rem;}
b{font-weight:700;color:var(--ink);}
code{font-family:var(--mono);font-size:.88em;background:var(--accent-soft);
  padding:.1em .38em;border-radius:2px;color:var(--ink);}
a{color:var(--accent);}

/* 見出し ― 明朝を大きく、抑えて使う */
h1,h2,h3{font-family:var(--serif);font-weight:600;line-height:1.35;text-wrap:balance;letter-spacing:.01em;}

header.top{padding:72px 0 40px;border-bottom:1px solid var(--rule);}
.eyebrow{font-size:12px;letter-spacing:.22em;color:var(--ink-3);text-transform:none;
  font-family:var(--mono);margin-bottom:22px;}
h1{font-size:clamp(30px,5vw,50px);margin:0 0 22px;}
header.top .col p{color:var(--ink-2);font-size:16.5px;margin:0 0 14px;}
.meta{margin-top:28px;display:flex;flex-wrap:wrap;gap:6px 26px;
  font-family:var(--mono);font-size:12px;color:var(--ink-3);}
.meta span b{color:var(--ink-2);font-weight:400;}

/* 数字の総覧 */
.stats{display:grid;grid-template-columns:repeat(3,1fr);
  gap:1px;background:var(--rule);border:1px solid var(--rule);margin:44px 0 8px;}
@media (max-width:820px){.stats{grid-template-columns:repeat(2,1fr);}}
@media (max-width:520px){.stats{grid-template-columns:1fr;}}
.stat{background:var(--paper);padding:20px 18px 18px;}
.stat .v{font-family:var(--mono);font-size:30px;font-weight:600;letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.1;}
.stat .k{font-size:13px;margin-top:8px;color:var(--ink);}
.stat .n{font-size:11.5px;color:var(--ink-3);margin-top:3px;font-family:var(--mono);}

section{margin-top:76px;}
.plate-h{display:flex;align-items:baseline;gap:16px;border-bottom:1px solid var(--rule);
  padding-bottom:12px;margin-bottom:20px;}
.pnum{font-family:var(--mono);font-size:11.5px;letter-spacing:.18em;color:var(--accent);
  white-space:nowrap;padding-top:4px;}
.plate-h h2{font-size:clamp(21px,2.6vw,27px);margin:0;}
.lead{max-width:44rem;color:var(--ink-2);margin:0 0 26px;}
h3.sub{font-size:19px;margin:44px 0 12px;padding-top:10px;border-top:1px solid var(--rule);}

.panels{display:grid;gap:22px;}
.panels.p2{grid-template-columns:repeat(2,1fr);}
.panels.p3{grid-template-columns:repeat(3,1fr);}
.panels.wide{grid-template-columns:1fr;}
@media (max-width:860px){.panels.p2,.panels.p3{grid-template-columns:1fr;}}
.panel{margin:0;}
.panel img{width:100%;height:auto;display:block;background:var(--sea);
  border:1px solid var(--rule);image-rendering:pixelated;}
.panel figcaption{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;
  margin-top:9px;font-size:12.5px;}
.panel figcaption b{font-weight:600;}
.panel figcaption span{color:var(--ink-3);font-size:11.5px;font-family:var(--mono);}

.legend{margin-top:9px;}
.legend .ramp{height:8px;border:1px solid var(--rule);}
.legend .ticks{display:flex;justify-content:space-between;margin-top:4px;
  font-family:var(--mono);font-size:10.5px;color:var(--ink-3);}
.legend.swatches{display:flex;flex-wrap:wrap;gap:6px 20px;font-size:12px;color:var(--ink-2);}
.legend.swatches i{display:inline-block;width:11px;height:11px;margin-right:7px;
  vertical-align:-1px;border:1px solid rgba(0,0,0,.25);}

.note{max-width:44rem;margin-top:26px;padding-left:18px;border-left:2px solid var(--accent);}
.note p{margin:0;color:var(--ink-2);}
.note:has(.klegend){max-width:none;padding-left:0;border-left:none;}

/* ケッペンの凡例 */
.klegend{display:flex;flex-wrap:wrap;gap:14px 30px;padding-top:18px;
  border-top:1px solid var(--rule);}
.kgroup b{display:block;font-size:11px;font-family:var(--mono);color:var(--ink-3);
  letter-spacing:.1em;margin-bottom:7px;font-weight:400;}
.kitems{display:flex;flex-wrap:wrap;gap:4px 12px;}
.kitems span{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);white-space:nowrap;}
.kitems i{display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px;
  border:1px solid rgba(128,128,128,.4);}

/* グラフ */
.charts{display:grid;grid-template-columns:repeat(2,1fr);gap:26px;}
@media (max-width:860px){.charts{grid-template-columns:1fr;}}
.chart{margin:0;background:var(--panel);border:1px solid var(--rule);padding:6px;}
.chart svg{width:100%;height:auto;display:block;}
.chart .grid{stroke:var(--rule);stroke-width:1;}
.chart .ax,.chart .ttl,.chart .worstlbl{fill:var(--ink-3);font-family:var(--mono);font-size:10px;}
.chart .ttl{fill:var(--ink);font-size:12px;font-family:var(--sans);font-weight:600;}
.chart .worstlbl{fill:var(--alert);font-size:11px;font-weight:600;}
.chart .band{fill:var(--alert);opacity:.14;}
.chart .obs{fill:none;stroke:var(--ink);stroke-width:2;}
.chart .mdl{fill:none;stroke:var(--accent);stroke-width:2;stroke-dasharray:5 3;}
.chart .worst{fill:var(--alert);}
.chartkey{display:flex;gap:22px;font-size:12px;color:var(--ink-2);margin-top:14px;
  font-family:var(--mono);}
.chartkey i{display:inline-block;width:22px;height:0;border-top:2px solid var(--ink);
  vertical-align:4px;margin-right:7px;}
.chartkey .m i{border-top:2px dashed var(--accent);}

/* 地域 */
.region{margin-top:52px;padding-top:36px;border-top:1px solid var(--rule);}
.region:first-of-type{border-top:none;padding-top:0;}
.region h3{font-size:21px;margin:0 0 12px;}
.region p{max-width:44rem;color:var(--ink-2);margin:0 0 22px;}

/* 表 */
.tablewrap{overflow-x:auto;margin-top:22px;}
table{border-collapse:collapse;font-size:13px;min-width:520px;width:100%;}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--rule);}
thead th{font-weight:600;font-size:11.5px;color:var(--ink-3);font-family:var(--mono);
  letter-spacing:.06em;border-bottom:1px solid var(--ink-3);}
tbody th{font-weight:600;white-space:nowrap;}
.conf td{font-family:var(--mono);text-align:right;font-variant-numeric:tabular-nums;
  background:color-mix(in srgb, var(--accent) calc(var(--a) * 55%), transparent);}
.conf td.diag{font-weight:700;}
.conf thead th{text-align:right;}
.gates .mark{font-family:var(--mono);font-size:11px;white-space:nowrap;}
.gates tr.ok .mark{color:var(--accent);}
.gates tr.ng .mark{color:var(--alert);font-weight:700;}
.gates tr.ng th{color:var(--alert);}
.gates .det{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);}

ul.todo{max-width:44rem;padding-left:0;list-style:none;}
ul.todo li{padding:16px 0 16px 0;border-bottom:1px solid var(--rule);color:var(--ink-2);}
/* 見出しになるのは先頭の b だけ。本文中の b まで block にすると行が割れる */
ul.todo li > b:first-child{display:block;margin-bottom:4px;
  font-family:var(--serif);font-size:17px;font-weight:600;color:var(--ink);}
ul.todo li .st{font-family:var(--mono);font-size:11px;color:var(--ink-3);
  display:block;margin-top:6px;}

footer{margin-top:80px;padding-top:26px;border-top:1px solid var(--rule);
  font-family:var(--mono);font-size:11.5px;color:var(--ink-3);}
</style>

<div class="wrap">

<header class="top">
  <div class="col">
    <div class="eyebrow">ExoClim-3 ／ 検証記録 2026-08-08（v15）</div>
    <h1>地球はどこまで再現できているか</h1>
    <p>惑星のパラメータだけを入力し、ITCZ・風帯・海流・気流・気温・降水を順に解いて出した結果を、
      実際の地球の観測とそのまま並べる。<b>ケッペン気候区はモデルの中では使っていない</b> —
      物理量を先に出し、分類は外から採点するための物差しとして後から当てている。</p>
    <p>下の図はすべて<b>同じ 1 回の計算</b>から出ている。地域ごとの補正も、
      緯度帯を決め打ちしたルールも入れていない。合っていないところは、合っていないまま出す。</p>
    <div class="meta">
      <span>コミット <b>8f41e25</b></span>
      <span>定数 <b>v15(64 件・195 評価)</b></span>
      <span>格子 <b>1°(気温・降水の採点は 2°)</b></span>
      <span>観測 <b>Beck 2023 ／ earth_climate_2deg</b></span>
    </div>
  </div>

  <div class="stats">
    ${stats
      .map((x) => `<div class="stat"><div class="v">${x.v}</div><div class="k">${x.k}</div><div class="n">${x.n}</div></div>`)
      .join('')}
  </div>
</header>

<section>
  <div class="plate-h"><span class="pnum">今回</span><h2>この版で何が変わったか</h2></div>
  <p class="lead">前回(v13evap、2026-08-06)からの差分。<b>物理の構造を 2 つ足し、1 つ棄却し、
    実行するまで気づけない不具合を 3 件潰した。</b>下の図はすべて v15 の同じ 1 回の計算から。</p>

  <div class="tablewrap">
    <table>
      <thead><tr><th>指標</th><th>v13evap</th><th>v15</th><th>差</th></tr></thead>
      <tbody>
        <tr><th>目的関数 v3</th><td>85.769</td><td><b>86.190</b></td><td>+0.42</td></tr>
        <tr><th>ケッペン大分類</th><td>75.22%</td><td><b>75.37%</b></td><td>+0.15</td></tr>
        <tr><th>ケッペン詳細</th><td>44.07%</td><td><b>45.01%</b></td><td>+0.94</td></tr>
        <tr><th>年平均気温 RMSE</th><td>4.16°C</td><td><b>3.85°C</b></td><td>−0.31</td></tr>
        <tr><th>地域ゲート</th><td>14 / 17</td><td>14 / 17</td><td>—</td></tr>
      </tbody>
    </table>
  </div>

  <div class="note"><p><b>詳細一致の +0.94 が今回の主産物。</b>面積の 24.5% を占める
    冷帯で第 3 文字が当たらない — その原因が「夏の気温が 40〜60°N で +5°C 高い」の
    <b>一変数</b>だと突き止めたところから始まっている。</p></div>

  <h3 class="sub">足した構造 1 — 陸の対流・前線雲</h3>
  <p class="lead">雲アルベドの変調を読み直したら、<b>ストームトラック雲・層積雲・海峡雲が
    すべて <code>oceanFrac</code> 倍で入っており、陸の雲は ITCZ 近傍しか増えない</b>
    構造になっていた。夏の大陸は月 100mm 以上降っていても雲が基準値のまま。
    しかも「陸では 0.35 残す」と書かれた分岐が、外側の <code>oceanFrac</code> 倍で
    必ず 0 になる<b>死んだ分岐</b>として化石化していた。</p>
  <div class="note"><p>前パスの降水を<b>飽和させて</b>雲に足す(飽和させるのは、降水の誤差が
    そのまま温度の誤差へ増幅されるのを防ぐため)。冷帯の夏は +5.38 → +4.67°C、
    第 3 文字の一致は 27.5% → 33.3% に。<b>砂漠には効かない</b>
    (降水がほぼ 0 なので項が 0)ので、乾燥ゲート 3 件は無傷のまま。</p></div>

  <h3 class="sub">足した構造 2 — 0 層海氷(第 2 版)</h3>
  <p class="lead">氷の量を潜熱と伝導で解き、アルベドと断熱を<b>氷量に連続で</b>結ぶ。
    融解中は表面を凍結点に留める。第 1 版(2026-08-04)は事前登録の判定に不成立だったが、
    それは機構ではなく<b>実装の不具合 3 件</b>のせいだった。</p>
  <div class="note"><p>両極が<b>同時に</b>改善(北極の秋 −0.98°C ／ 南大洋の夏 +0.90°C)。
    第 1 版で +16.8°C まで暴走した北極の 7 月が <b>+1.7°C</b>(実物ほぼ 0°C)に収まった。
    CPU 経路と GPU 経路の一致も検算済み(年平均気温の差は面積重み平均 0.026°C)。</p></div>

  <h3 class="sub">棄却 — 蒸発冷却の陰的化</h3>
  <p class="lead">蒸発冷却を気温に対する負帰還として EBM の対角へ入れる案。
    4 段階すべてで事前登録の主判定に届かず<b>棄却</b>した。</p>
  <div class="note"><p>理由は着想の側にあった。線形化の基準点がパイプラインの
    <b>パス 1 の気温</b>で、そのパス 1 は陸面結合を持たずに呼ばれている。つまりこの項は
    「パス 2 の答えを、陸面結合を持たないパス 1 へ引き戻す」働きをしていた。
    <b>ニュートン法の形をしていても、基準点が別の物理で作られていれば 1 歩目は後退になる。</b></p></div>

  <h3 class="sub">潰した不具合 3 件 — どれも「実行はできるが物理が違う」</h3>
  <div class="tablewrap">
    <table>
      <thead><tr><th>不具合</th><th>見えた症状</th><th>実際の影響</th></tr></thead>
      <tbody>
        <tr><th>残差の測定に反復の外の物理が混ざる</th>
            <td>「なんか遅い」だけ</td>
            <td>適応制御が下がらない残差を追いかけ、費用が <b>25 倍</b>(8 時間 対 23 分)</td></tr>
        <tr><th>ユニフォームの CPU 側だけ小さい</th>
            <td>症状なし</td>
            <td>はみ出した書き込みが例外にならず捨てられ、<b>海氷の物性値が全部 0</b> で GPU へ</td></tr>
        <tr><th>0 層海氷で陸の季節雪が消える</th>
            <td>成績が落ちるだけ</td>
            <td>氷厚は海セルにしか育たないのに <code>iceW</code> を氷厚だけで決めていた</td></tr>
      </tbody>
    </table>
  </div>
  <div class="note"><p><b>片方の経路にしか無い機構・片側にしか掛からない項・
    大きさの合っていないバッファ</b>は、症状ではなく構造として探すしかない。
    結果だけ見ていたら、海氷の機構ごと棄却していた。</p></div>
</section>

${plates.join('\n')}

<section>
  <div class="plate-h"><span class="pnum">図版 7</span><h2>帯状平均気温 — 残差はここに集まっている</h2></div>
  <p class="lead">緯度 10° ごとの陸の平均気温。実線が観測、破線がモデル、赤い帯が両者の差。
    最終受入の条件は<b>この差がどの帯でも ±5°C 以内</b>であること。</p>
  <div class="charts">
    ${zonalChart('obsAnnual', 'modelAnnual', '年平均気温 (°C)')}
    ${zonalChart('obsJul', 'modelJul', '7 月の気温 (°C)')}
  </div>
  <div class="chartkey"><span><i></i>観測</span><span class="m"><i></i>モデル</span></div>
  <div class="note"><p>中低緯度はどの帯も 3°C 以内に収まっている。破綻しているのは
    <b>南緯 50〜70° の一帯だけ</b>で、7 月の 60°S が 26.4°C ずれる。
    ここは陸がほとんど無く南大洋そのものなので、<b>これは陸の気候の誤りではなく海氷の誤り</b>である。
    北の 70〜80°N も冬に 11〜14°C 暖かすぎるが、これも同じ原因(北極海の氷が張るのが遅い)。
    <b>残る最大の課題は一つ、海氷</b>という読みになる。</p></div>
</section>

<section>
  <div class="plate-h"><span class="pnum">難所</span><h2>合っていない 4 か所を近くで見る</h2></div>
  <p class="lead">未見評価(30°×30° ブロックを 5 分割し、外して較正 → 外した側だけで採点)で
    区画 4 だけ成績が 13.7 ポイント落ちた。過剰適合を疑って中身を調べたところ、
    <b>過剰適合ではなく難所が一つの区画に固まっていた</b>。その 4 か所がこれである。</p>
  ${regionSections}
</section>

<section>
  <div class="plate-h"><span class="pnum">内訳</span><h2>大分類の取り違え方</h2></div>
  <p class="lead">行が観測、列がモデル。全陸セルに占める割合(%)。対角が一致。</p>
  <div class="tablewrap">
    <table class="conf">
      <thead><tr><th></th>${MAJOR.map((m) => `<th>${m}</th>`).join('')}</tr></thead>
      <tbody>${confRows}</tbody>
    </table>
  </div>
  <div class="note"><p>いちばん大きな取り違えは <b>C 温帯を B 乾燥と答える 5.4%</b>。
    観測が C 温帯である陸のうち、モデルが C と答えられているのは半分に届かない
    (5.5 / 11.7)。<b>温帯は乾燥に食われている</b> — 中国東部が砂漠になっている件と同じ症状で、
    大陸の内部へ水を運びきれていないことの現れである。
    逆向き(B を C と答える 1.9%)は小さいので、系統的に乾かしすぎている。</p></div>
</section>

<section>
  <div class="plate-h"><span class="pnum">ゲート</span><h2>地域ゲート 14 / 17</h2></div>
  <p class="lead">2026-07-31 に凍結した 17 地域の受入条件。<b>最終合格には全件の通過が要る。</b>
    地域ごとの補正を書くことは禁じているので、通すには物理か定数を動かすしかない。</p>
  <div class="tablewrap">
    <table class="gates"><tbody>${gateRows}</tbody></table>
  </div>
</section>

<section>
  <div class="plate-h"><span class="pnum">次</span><h2>残っている課題</h2></div>
  <ul class="todo">
    <li><b>海氷の双安定</b>
      氷の量が気温だけで決まるため正帰還が閉じている。熱容量側は 0 層模型(潜熱 + 伝導)で壊せて、
      北極の 1 月が −7.7 → −31.2°C(実測 −25°C 前後)まで改善した。
      だが<b>アルベド側の正帰還が手つかず</b>で、氷が融けた瞬間に 0.39 → 0.07 へ跳ぶため
      北極の 7 月が +16.8°C まで走る。南大洋は逆にさらに冷えた。
      <span class="st">事前登録した判定条件(両極が同時に改善)に照らして<b>不成立</b>。アルベドを氷量に連続で結ぶ設計へ差し戻し</span></li>
    <li><b>東アジアへ水を運ぶ経路</b>
      中国東部の年降水 340mm(目標 750mm)。大陸内部へのモンスーンの水輸送が立っていない。
      <span class="st">未診断 — 保存型の水蒸気輸送は別途棄却済みなので、別の機構を探す必要がある</span></li>
    <li><b>亜熱帯の乾湿コントラスト</b>
      砂漠が湿りすぎ、インドは逆に乾きすぎる。抑制の乗数が非保存だからこそ効いている、
      という構造が分かっている(乗数は暗黙に鉛直の水の持ち出しを表している)。
      <span class="st">保存型への置き換えは実測で棄却(砂漠/陸平均 0.122〜0.367 対 現行 0.085、観測 0.055)</span></li>
    <li><b>較正は頭打ち</b>
      座標降下 296 評価で v3 は 85.77 → 85.82。周期定常の許容差 0.05°C が
      目的関数にして 0.02 の揺れに相当するので、<b>この +0.05 は数値的な床の 2〜3 倍しかない</b>。
      <span class="st">定数をいじる余地は尽きた。残りは構造側にある</span></li>
  </ul>
</section>

<footer>
  ExoClim-3 ／ 図はすべて <code>scripts/render_compare.ts</code> の 1 回の実行から生成。
  採点は観測と共通の陸セル、面積重み(cos 緯度)。観測の欠測セルは灰色で除外。
  v3=${s.fitness.toFixed(2)} ／ v2=${s.fitnessV2.toFixed(2)}
</footer>

</div>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`画像 ${embedded} 枚 / ${(bytes / 1024).toFixed(0)} KB`);
console.log(`HTML ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB → ${OUT}`);
