// 自動較正の進捗グラフ生成: out/optimize/log.jsonl → out/optimize/progress.svg
// 依存なしの素の SVG。いつでも再実行可(夜間走行と並行しても安全な読み取りのみ)。

import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT_DIR = path.join(process.cwd(), 'out', 'optimize');
const LOG_PATH = path.join(OUT_DIR, 'log.jsonl');

interface Row {
  i: number;
  fit: number;
  major: number;
  detail: number;
  gates: number;
  tag: string;
}

const rows: Row[] = fs
  .readFileSync(LOG_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Row);

if (rows.length === 0) {
  console.log('ログが空です');
  process.exit(0);
}

// ベスト到達値(単調)系列
let bestFit = -Infinity;
let bestMajor = 0;
let bestGates = 0;
const fitBest: number[] = [];
const majorAt: number[] = [];
const gatesAt: number[] = [];
for (const r of rows) {
  if (r.fit > bestFit) {
    bestFit = r.fit;
    bestMajor = r.major;
    bestGates = r.gates;
  }
  fitBest.push(bestFit);
  majorAt.push(bestMajor);
  gatesAt.push(bestGates);
}

const W = 900;
const H = 420;
const M = { l: 56, r: 56, t: 40, b: 40 };
const plotW = W - M.l - M.r;
const plotH = H - M.t - M.b;
const n = rows.length;

const fitMin = Math.min(...fitBest) - 0.3;
const fitMax = Math.max(...fitBest) + 0.3;
const x = (i: number) => M.l + (i / Math.max(1, n - 1)) * plotW;
const yFit = (v: number) => M.t + (1 - (v - fitMin) / Math.max(1e-9, fitMax - fitMin)) * plotH;
const yGate = (g: number) => M.t + (1 - (g - 10) / 7) * plotH; // 10〜17 固定スケール

const polyline = (ys: number[], map: (v: number) => number) =>
  ys.map((v, i) => `${x(i).toFixed(1)},${map(v).toFixed(1)}`).join(' ');

// 生の各評価(散布、薄く)とベスト線
const rawDots = rows
  .map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${yFit(Math.max(fitMin, r.fit)).toFixed(1)}" r="1.2" fill="#5b7cae" opacity="0.35"/>`)
  .join('');

const gridLines: string[] = [];
for (let v = Math.ceil(fitMin); v <= fitMax; v += 1) {
  gridLines.push(
    `<line x1="${M.l}" y1="${yFit(v).toFixed(1)}" x2="${W - M.r}" y2="${yFit(v).toFixed(1)}" stroke="#233045" stroke-width="1"/>` +
      `<text x="${M.l - 8}" y="${(yFit(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#8fa0b8">${v}</text>`,
  );
}
for (let g = 10; g <= 17; g++) {
  gridLines.push(
    `<text x="${W - M.r + 8}" y="${(yGate(g) + 4).toFixed(1)}" font-size="11" fill="#caa06a">${g}</text>`,
  );
}

const last = rows[rows.length - 1];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#0e1420">
  <text x="${M.l}" y="24" font-size="15" fill="#dbe4f0" font-family="sans-serif">自動較正の進捗 — 評価 ${n} 回 / ベスト fit ${bestFit.toFixed(2)}(大分類 ${bestMajor.toFixed(2)}%・ゲート ${bestGates})</text>
  ${gridLines.join('\n  ')}
  ${rawDots}
  <polyline points="${polyline(gatesAt, yGate)}" fill="none" stroke="#caa06a" stroke-width="1.6" stroke-dasharray="5,4"/>
  <polyline points="${polyline(fitBest, yFit)}" fill="none" stroke="#6fd08c" stroke-width="2.4"/>
  <text x="${M.l}" y="${H - 12}" font-size="11" fill="#8fa0b8" font-family="sans-serif">横 = 評価回数(各点 = 1 パイプライン実行、薄点 = 個々の試行)・緑 = ベスト fitness(左軸)・破線 = ベスト時のゲート数(右軸 10-17)</text>
</svg>`;

fs.writeFileSync(path.join(OUT_DIR, 'progress.svg'), svg);
console.log(
  `progress.svg 更新: 評価 ${n} 回, ベスト fit ${bestFit.toFixed(2)} (大分類 ${bestMajor.toFixed(2)} / ゲート ${bestGates}), 最新試行 fit ${last?.fit.toFixed(2)}`,
);
