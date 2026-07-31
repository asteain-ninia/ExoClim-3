// 自動較正の進捗グラフ生成:
//   out/optimize/log_v1.jsonl + out/optimize/log.jsonl → out/optimize/progress.svg
// 依存なしの素の SVG。いつでも再実行可(夜間走行と並行しても安全な読み取りのみ)。

import * as fs from 'node:fs';
import * as path from 'node:path';

const OUT_DIR = path.join(process.cwd(), 'out', 'optimize');
const ITCZ_PENALTY_WEIGHT = 0.3;

interface Row {
  i: number;
  fit: number;
  major: number;
  detail: number;
  gates: number;
  tag: string;
  iRmse?: number;
}

interface RunSpec {
  label: string;
  basis: string;
  logPath: string;
  restoresItczPenalty: boolean;
  bestColor: string;
  rawColor: string;
  dash?: string;
}

interface Run extends RunSpec {
  rows: Row[];
  fitBest: number[];
  majorAt: number[];
  gatesAt: number[];
  bestFit: number;
  bestMajor: number;
  bestGates: number;
}

// run ごとにコードへ系列を足し続けない(第四 FB P1): out/optimize の
// log_<name>.jsonl を自動列挙し、比較基準は run_<name>.meta.json の
// objectiveBasis から決める。メタの無い既存 v1/v2 は互換表で扱う。
interface RunMeta {
  runName?: string;
  label?: string;
  objectiveBasis?: string;
  gitCommit?: string;
  gitDirty?: boolean;
  startedAt?: string;
}

// 共通基準 = v1 目的関数。v2 系(ITCZ 項あり)は fit + 0.3×ITCZ RMSE で換算
const BASIS_RESTORES_ITCZ: Record<string, boolean> = {
  v1: false,
  v2_itcz: true,
};

const LEGACY_RUNS: RunSpec[] = [
  {
    label: 'v1',
    basis: '記録値',
    logPath: path.join(OUT_DIR, 'log_v1.jsonl'),
    restoresItczPenalty: false,
    bestColor: '#7aa2d6',
    rawColor: '#6685ad',
    dash: '7,4',
  },
  {
    label: 'v2',
    basis: 'ITCZ ペナルティ復元',
    logPath: path.join(OUT_DIR, 'log.jsonl'),
    restoresItczPenalty: true,
    bestColor: '#6fd08c',
    rawColor: '#5b7cae',
  },
];

const PALETTE = ['#e0a04a', '#c77dd6', '#5fd0c8', '#d66f6f'];

function discoverRuns(): RunSpec[] {
  const specs = [...LEGACY_RUNS];
  if (!fs.existsSync(OUT_DIR)) return specs;
  const names = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^log_.+\.jsonl$/.test(f))
    .map((f) => f.replace(/^log_(.+)\.jsonl$/, '$1'))
    .filter((n) => n !== 'v1')
    .sort();
  names.forEach((name, idx) => {
    let meta: RunMeta = {};
    const metaPath = path.join(OUT_DIR, `run_${name}.meta.json`);
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RunMeta;
      } catch {
        console.warn(`[chart] ${path.basename(metaPath)} が読めないため既定基準を使う`);
      }
    }
    // メタが無い run は現行の目的関数(v2 系)とみなす
    const basisKey = meta.objectiveBasis ?? 'v2_itcz';
    const restores = BASIS_RESTORES_ITCZ[basisKey] ?? true;
    const color = PALETTE[idx % PALETTE.length] ?? '#e0a04a';
    specs.push({
      label: meta.label ?? name,
      basis: meta.gitCommit ? `${basisKey} @${meta.gitCommit.slice(0, 7)}` : basisKey,
      logPath: path.join(OUT_DIR, `log_${name}.jsonl`),
      restoresItczPenalty: restores,
      bestColor: color,
      rawColor: color,
    });
  });
  return specs;
}

const runSpecs: RunSpec[] = discoverRuns();

function readRows(logPath: string): Row[] {
  if (!fs.existsSync(logPath)) return [];

  const rows = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Row];
      } catch {
        // 学習プロセスが追記している最中の不完全な最終行は次回描画時に拾う。
        return [];
      }
    });
  // P0-2: 評価番号の重複を検知して警告(既存 v1 ログの 364-366 重複の再発監視)
  const seen = new Set<number>();
  const dups = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.i)) dups.add(r.i);
    seen.add(r.i);
  }
  if (dups.size > 0) {
    console.warn(
      `[chart] ${path.basename(logPath)}: 評価番号の重複 ${[...dups].slice(0, 10).join(', ')}${dups.size > 10 ? ' …' : ''}`,
    );
  }
  return rows;
}

function buildRun(spec: RunSpec): Run | null {
  const rows = readRows(spec.logPath);
  if (rows.length === 0) return null;
  if (spec.restoresItczPenalty && rows.some((row) => row.iRmse === undefined)) {
    throw new Error(`${spec.label} のログに iRmse がないため共通基準へ換算できません`);
  }

  let bestFit = -Infinity;
  let bestMajor = 0;
  let bestGates = 0;
  const fitBest: number[] = [];
  const majorAt: number[] = [];
  const gatesAt: number[] = [];
  for (const row of rows) {
    const commonFit =
      row.fit + (spec.restoresItczPenalty ? ITCZ_PENALTY_WEIGHT * (row.iRmse ?? 0) : 0);
    if (commonFit > bestFit) {
      bestFit = commonFit;
      bestMajor = row.major;
      bestGates = row.gates;
    }
    fitBest.push(bestFit);
    majorAt.push(bestMajor);
    gatesAt.push(bestGates);
  }

  return { ...spec, rows, fitBest, majorAt, gatesAt, bestFit, bestMajor, bestGates };
}

const runs = runSpecs.map(buildRun).filter((run): run is Run => run !== null);

if (runs.length === 0) {
  console.log('ログが空です');
  process.exit(0);
}

const W = 900;
const H = 480;
const M = { l: 56, r: 56, t: 78, b: 62 };
const plotW = W - M.l - M.r;
const plotH = H - M.t - M.b;
const maxEval = Math.max(...runs.flatMap((run) => run.rows.map((row) => row.i)));

const allBestFit = runs.flatMap((run) => run.fitBest);
const fitMin = Math.min(...allBestFit) - 0.3;
const fitMax = Math.max(...allBestFit) + 0.3;
const x = (evaluation: number) => M.l + ((evaluation - 1) / Math.max(1, maxEval - 1)) * plotW;
const yFit = (value: number) =>
  M.t + (1 - (value - fitMin) / Math.max(1e-9, fitMax - fitMin)) * plotH;
const yGate = (gates: number) => M.t + (1 - (gates - 10) / 7) * plotH; // 10〜17 固定スケール

const polyline = (run: Run, values: number[], map: (value: number) => number) =>
  values
    .map(
      (value, index) => `${x(run.rows[index]?.i ?? index + 1).toFixed(1)},${map(value).toFixed(1)}`,
    )
    .join(' ');

const gridLines: string[] = [];
for (let value = Math.ceil(fitMin); value <= fitMax; value += 1) {
  gridLines.push(
    `<line x1="${M.l}" y1="${yFit(value).toFixed(1)}" x2="${W - M.r}" y2="${yFit(value).toFixed(1)}" stroke="#233045" stroke-width="1"/>` +
      `<text x="${M.l - 8}" y="${(yFit(value) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#8fa0b8">${value}</text>`,
  );
}
for (let gates = 10; gates <= 17; gates++) {
  gridLines.push(
    `<text x="${W - M.r + 8}" y="${(yGate(gates) + 4).toFixed(1)}" font-size="11" fill="#caa06a">${gates}</text>`,
  );
}

const rawDots = runs
  .flatMap((run) =>
    run.rows.map((row) => {
      const commonFit =
        row.fit + (run.restoresItczPenalty ? ITCZ_PENALTY_WEIGHT * (row.iRmse ?? 0) : 0);
      const clippedFit = Math.min(fitMax, Math.max(fitMin, commonFit));
      return `<circle cx="${x(row.i).toFixed(1)}" cy="${yFit(clippedFit).toFixed(1)}" r="1.2" fill="${run.rawColor}" opacity="0.28"/>`;
    }),
  )
  .join('');

const gateLines = runs
  .map(
    (run) =>
      `<polyline points="${polyline(run, run.gatesAt, yGate)}" fill="none" stroke="${run.bestColor}" stroke-width="1.3" stroke-dasharray="2,5" opacity="0.65"/>`,
  )
  .join('\n  ');

const bestLines = runs
  .map(
    (run) =>
      `<polyline points="${polyline(run, run.fitBest, yFit)}" fill="none" stroke="${run.bestColor}" stroke-width="2.4"${run.dash ? ` stroke-dasharray="${run.dash}"` : ''}/>`,
  )
  .join('\n  ');

const legend = runs
  .map((run, index) => {
    const left = M.l;
    const top = 44 + index * 18;
    const dash = run.dash ? ` stroke-dasharray="${run.dash}"` : '';
    return (
      `<line x1="${left}" y1="${top}" x2="${left + 25}" y2="${top}" stroke="${run.bestColor}" stroke-width="2.4"${dash}/>` +
      `<text x="${left + 32}" y="${top + 4}" font-size="12" fill="#dbe4f0" font-family="sans-serif">` +
      `${run.label} (${run.basis}): best ${run.bestFit.toFixed(2)} / 大分類 ${run.bestMajor.toFixed(2)}% / ゲート ${run.bestGates}</text>`
    );
  })
  .join('\n  ');

const counts = runs.map((run) => `${run.label} ${run.rows.length} 回`).join(' / ');
const latest = runs[runs.length - 1];
const latestRow = latest?.rows[latest.rows.length - 1];
const latestCommonFit = latestRow
  ? latestRow.fit + (latest?.restoresItczPenalty ? ITCZ_PENALTY_WEIGHT * (latestRow.iRmse ?? 0) : 0)
  : undefined;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#0e1420">
  <text x="${M.l}" y="24" font-size="15" fill="#dbe4f0" font-family="sans-serif">自動較正の学習曲線（共通基準: v1 目的関数）— ${counts}</text>
  ${legend}
  ${gridLines.join('\n  ')}
  ${rawDots}
  ${gateLines}
  ${bestLines}
  <text x="${M.l}" y="${H - 31}" font-size="11" fill="#8fa0b8" font-family="sans-serif">横 = 各 run の評価回数・実線/長破線 = ベスト fitness (左軸)・薄点 = 個々の試行・短破線 = ベスト時のゲート数 (右軸 10–17)</text>
  <text x="${M.l}" y="${H - 12}" font-size="11" fill="#caa06a" font-family="sans-serif">共通 fitness = v1 目的関数。v2 はログ値 + 0.3 × ITCZ RMSE (ペナルティ復元) で換算。最新 ${latest?.label ?? ''} = ${latestCommonFit?.toFixed(2) ?? '—'}</text>
</svg>`;

fs.writeFileSync(path.join(OUT_DIR, 'progress.svg'), svg);
console.log(
  `progress.svg 更新: ${runs
    .map(
      (run) =>
        `${run.label} ${run.rows.length} 回 / best fit ${run.bestFit.toFixed(2)} (大分類 ${run.bestMajor.toFixed(2)} / ゲート ${run.bestGates})`,
    )
    .join(', ')}`,
);
