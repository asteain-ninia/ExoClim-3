#!/usr/bin/env node
// ExoClim-3 自走モニタ — 依存ゼロのローカル GUI サーバ。
//
// 目的(利用者指示 2026-08-24):
//   「いま自動実行が動いているか・どこまで進んだか・どういう状況かを一目で見る。
//     パラメータと評価値は裁定にも要る。修正のたびの追従は最小に。
//     AI を消費しない機械的動作で。AI が現状を監視しているか(計算の完了で
//     自動的に次へ進める状態か)も判別したい。」
//
// 設計の原則 — **スキーマを持たない**。
//   ここに書いてあるのは「どこを見るか」だけで、「何という指標があるか」は
//   書かない。評価値は report.json を、パラメータは best_*.json を、
//   進捗は log_*.jsonl を**そのまま**読んで機械的に並べる。指標や定数が
//   増減しても、このファイルもUIも直さなくてよい。見出しに昇格させたい
//   ものだけ下の HEADLINE に一行足す(欠けていれば黙って飛ばす)。
//
// AI は一切関与しない。node の標準モジュールのみ。
//   起動: npm run monitor   (既定 http://127.0.0.1:7420)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ───────────────────────── 設定(修正が要るとしたらここだけ)─────────────────────────

const CFG = {
  port: Number(process.env.EXOCLIM_MONITOR_PORT ?? 7420),
  host: process.env.EXOCLIM_MONITOR_HOST ?? '127.0.0.1',

  /** 状態を拾うディレクトリ。増えたら足す。 */
  optimizeDir: path.join(ROOT, 'out', 'optimize'),
  validateReport: path.join(ROOT, 'out', 'validate', 'report.json'),
  spaceFile: path.join(ROOT, 'scripts', 'optimize_lib.ts'),
  ledgerGlob: /^積み残し一覧_.*\.md$/,

  /** 見出しへ昇格させる評価値。パスが無ければ黙って飛ばす。 */
  headline: [
    { label: '大分類一致', p: 'koppen.majorAccuracyPct', u: '%', better: 'high', ref: 'regression.baseline.majorPctMin' },
    { label: '詳細一致', p: 'koppen.detailedAccuracyPct', u: '%', better: 'high', ref: 'regression.baseline.detailPctMin' },
    { label: '気温年 RMSE', p: 'temperature.annualRmseC', u: '°C', better: 'low', ref: 'regression.baseline.tempRmseMaxC' },
    { label: '降水年 RMSE', p: 'precipitation.annualRmseMm', u: 'mm', better: 'low', ref: 'regression.baseline.precipRmseMaxMm' },
    { label: 'ITCZ RMSE', p: 'itcz.lineRmseRainWeightedDeg', u: '°', better: 'low', ref: 'regression.baseline.itczRmseMaxDeg' },
    { label: '降水位相 RMSE', p: 'precipitation.phaseRmseDays', u: '日', better: 'low' },
    { label: '気温位相 RMSE', p: 'temperature.phaseRmseDays', u: '日', better: 'low' },
    { label: 'log 相関', p: 'precipitation.logCorrelation', better: 'high' },
    { label: '分位対数誤差', p: 'precipitation.quantileLogErr', better: 'low' },
    { label: '水収支の閉じ', p: 'waterBudget.closureRelative', better: 'low' },
  ],

  /**
   * 計算とみなすプロセス名。bash や claude 本体のラッパは数えない。
   * ラッパを数えると、コマンド文字列(git のコミットメッセージなど)を
   * スクリプト名と誤読する — 実際に踏んだ。
   */
  procNames: ['node.exe', 'python.exe', 'pythonw.exe', 'pwsh.exe', 'powershell.exe'],

  /**
   * 種別の判定。**スクリプト名(ファイル名)にだけ**当てる。
   * コマンド行全体に当てると、引数やコミット文の中の語を拾う。
   */
  procKinds: [
    { re: /^monitor_server\.mjs$/i, kind: 'self' },
    { re: /^optimize/i, kind: '較正' },
    { re: /^sweep_/i, kind: '掃引' },
    { re: /^diag_/i, kind: '診断' },
    { re: /^exp_/i, kind: '実験' },
    { re: /^validate\.ts$/i, kind: '検証' },
    { re: /holdout/i, kind: '保留検証' },
    { re: /^(check|score|render|preview|prof|bench|stress)_/i, kind: '補助' },
    { re: /^build_/i, kind: '素材生成' },
  ],
  /** スクリプト名が取れないときに、コマンド行から拾う種別。 */
  procKindsByCmd: [
    { re: /[\\/]vitest[\\/]|vitest\.mjs/i, kind: 'テスト' },
    { re: /[\\/]vite[\\/]bin[\\/]|vite\.js/i, kind: '開発サーバ' },
    { re: /playwright/i, kind: 'E2E' },
    { re: /tsc\.js|typescript[\\/]bin/i, kind: '型検査' },
  ],

  /** 追跡タスクが「そのジョブのもの」とみなす時間の余裕(秒)。 */
  trackSlackSec: 180,
  /** AI が黙っていても「作業中」とみなす秒数。 */
  aiLiveSec: 180,
  /** 直近セッションとして拾う範囲(時間)。 */
  sessionWindowH: 48,
};

// ───────────────────────── 小道具 ─────────────────────────

const nowMs = () => Date.now();
const ageSec = (ms) => (ms ? Math.max(0, Math.round((nowMs() - ms) / 1000)) : null);

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function statOr(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readTextOr(p, max = 1 << 20) {
  try {
    const st = fs.statSync(p);
    if (st.size <= max) return fs.readFileSync(p, 'utf8');
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(max);
    fs.readSync(fd, buf, 0, max, st.size - max);
    fs.closeSync(fd);
    // 先頭が壊れた行になるので落とす
    const s = buf.toString('utf8');
    return s.slice(s.indexOf('\n') + 1);
  } catch {
    return null;
  }
}

function readJsonOr(p) {
  const t = readTextOr(p, 8 << 20);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function dig(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 一定時間だけ結果を使い回す。外部コマンドを毎回叩かないため。 */
function memo(ttlMs, fn) {
  let at = 0;
  let val = null;
  let inflight = null;
  return async () => {
    if (nowMs() - at < ttlMs && val !== null) return val;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        val = await fn();
        at = nowMs();
      } finally {
        inflight = null;
      }
      return val;
    })();
    return inflight;
  };
}

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    } catch {
      return resolve({ code: -1, out: '', err: 'spawn failed' });
    }
    const t = setTimeout(() => {
      if (!done) {
        try {
          child.kill();
        } catch {
          /* 無視 */
        }
      }
    }, timeout);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', () => {
      done = true;
      clearTimeout(t);
      resolve({ code: -1, out, err });
    });
    child.on('close', (code) => {
      done = true;
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

// ───────────────────────── 1. プロセス(実物が走っているか)─────────────────────────

const PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$inv=[Globalization.CultureInfo]::InvariantCulture
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*ExoClim-3*' } | ForEach-Object {
  [pscustomobject]@{
    pid     = $_.ProcessId
    ppid    = $_.ParentProcessId
    name    = $_.Name
    started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o',$inv) } else { $null })
    cpuSec  = [math]::Round((($_.KernelModeTime + $_.UserModeTime) / 1e7), 1)
    memMB   = [math]::Round($_.WorkingSetSize / 1MB, 1)
    cmd     = $_.CommandLine
  }
} | ConvertTo-Json -Compress -Depth 3
`;

const getProcs = memo(3000, async () => {
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT]);
  let list = [];
  try {
    const parsed = JSON.parse(r.out.trim() || 'null');
    list = parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    list = [];
  }
  return list.map((p) => classifyProc(p));
});

/**
 * 生のプロセス 1 件を、種別・スクリプト名・引数へ機械的にほどく。
 * コマンド行全体を種別の正規表現に当ててはいけない — git のコミット文に
 * 含まれる語をスクリプト名と誤読する(2026-08-24 に実際に踏んだ)。
 */
export function classifyProc(p, now = Date.now()) {
  const cmd = String(p.cmd ?? '');
  const name = String(p.name ?? '');
  // リポジトリ内のスクリプトを**最後の出現**で拾う。node_modules の
  // ローダやラッパ(tsx/dist/cli.mjs 等)はこの型に当たらない。
  const hits = [...cmd.matchAll(/(?:^|[\s"'/\\])(scripts|tests|out)[/\\]([\w.-]+\.(?:ts|mjs|cjs|js|py|ps1))/gi)];
  const last = hits.length ? hits[hits.length - 1] : null;
  const script = last ? last[2] : null;

  let kind = null;
  if (script) {
    for (const k of CFG.procKinds)
      if (k.re.test(script)) {
        kind = k.kind;
        break;
      }
    if (!kind) kind = 'スクリプト';
  } else {
    for (const k of CFG.procKindsByCmd)
      if (k.re.test(cmd)) {
        kind = k.kind;
        break;
      }
  }

  // 引数はスクリプト名の直後だけ。リダイレクトや連結より先で切る。
  let args = '';
  if (last) {
    args = cmd.slice(last.index + last[0].length).trim();
    args = args.split(/[\n\r]|>|&&|;|\|/)[0].trim().slice(0, 200);
  }

  const startedMs = p.started ? Date.parse(p.started) : null;
  return {
    pid: p.pid,
    ppid: p.ppid,
    name,
    kind: kind ?? 'その他',
    /** 計算ジョブとして数えるか。ラッパや素性不明は数えない。 */
    isJob: CFG.procNames.includes(name.toLowerCase()) && kind != null && kind !== 'self',
    isSelf: kind === 'self',
    script,
    args,
    cmd: cmd.slice(0, 500),
    startedMs,
    elapsedSec: startedMs ? Math.round((now - startedMs) / 1000) : null,
    cpuSec: p.cpuSec,
    memMB: p.memMB,
  };
}

/**
 * ラッパの三段重ね(npx → tsx cli → loader)を 1 ジョブに畳む。
 * 同じスクリプト・同じ引数でも起動時刻が離れていれば別ジョブ(= 二重起動)。
 */
export function clusterProcs(procs) {
  const work = procs.filter((p) => p.isJob);
  const clusters = [];
  for (const p of work) {
    const key = `${p.script ?? p.kind}|${p.args}`;
    let c = clusters.find(
      (x) => x.key === key && Math.abs((x.startedMs ?? 0) - (p.startedMs ?? 0)) <= 120_000,
    );
    if (!c) {
      c = {
        // key は「同じコマンドか」の照合用。二重起動では重複するので、
        // 親子の指し先には使えない。id は 1 クラスタに 1 つ。
        id: `c${clusters.length}`,
        key,
        kind: p.kind,
        script: p.script,
        args: p.args,
        startedMs: p.startedMs,
        pids: [],
        ppids: [],
        cpuSec: 0,
        memMB: 0,
      };
      clusters.push(c);
    }
    c.pids.push(p.pid);
    c.ppids.push(p.ppid);
    c.cpuSec += p.cpuSec ?? 0;
    c.memMB += p.memMB ?? 0;
    if (p.startedMs && (!c.startedMs || p.startedMs < c.startedMs)) c.startedMs = p.startedMs;
  }
  // 親子: ワーカー(optimize が産む batch worker 等)を親のジョブにぶら下げる。
  const owner = new Map();
  for (const c of clusters) for (const pid of c.pids) owner.set(pid, c);
  for (const c of clusters) {
    c.parent = null;
    for (const pp of c.ppids) {
      const o = owner.get(pp);
      if (o && o !== c) {
        c.parent = o.id;
        break;
      }
    }
  }
  for (const c of clusters) {
    c.elapsedSec = c.startedMs ? Math.round((nowMs() - c.startedMs) / 1000) : null;
    c.cpuSec = Math.round(c.cpuSec * 10) / 10;
    c.memMB = Math.round(c.memMB * 10) / 10;
    c.workerCount = clusters.filter((x) => x.parent === c.id).reduce((a, x) => a + x.pids.length, 0);
  }
  clusters.sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0));
  // 二重起動の検出: 同じ key のクラスタが複数(同じ出力ファイルを取り合う)
  const byKey = new Map();
  for (const c of clusters) byKey.set(c.key, (byKey.get(c.key) ?? 0) + 1);
  for (const c of clusters) c.duplicate = byKey.get(c.key) > 1;
  return clusters;
}

// ───────────────────────── 2. AI のセッションと追跡タスク ─────────────────────────

function projectSlug() {
  // Claude Code の投影規則: 区切りをすべて '-' に潰す
  return ROOT.replace(/[\\/:.]/g, '-');
}

function transcriptsDir() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const want = projectSlug();
  if (exists(path.join(base, want))) return path.join(base, want);
  try {
    const hit = fs.readdirSync(base).find((d) => d.toLowerCase() === want.toLowerCase());
    if (hit) return path.join(base, hit);
  } catch {
    /* 無視 */
  }
  return path.join(base, want);
}

function tasksBase() {
  const tmp = process.env.TEMP || process.env.TMP || os.tmpdir();
  const want = projectSlug();
  const base = path.join(tmp, 'claude');
  if (exists(path.join(base, want))) return path.join(base, want);
  try {
    const hit = fs.readdirSync(base).find((d) => d.toLowerCase() === want.toLowerCase());
    if (hit) return path.join(base, hit);
  } catch {
    /* 無視 */
  }
  return path.join(base, want);
}

/** 会話ログの末尾だけ読む(62MB の実績があるので全読みしない)。 */
function readTranscriptTail(file, bytes = 512 * 1024) {
  const st = statOr(file);
  if (!st) return null;
  const start = Math.max(0, st.size - bytes);
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));

  const info = {
    mtimeMs: st.mtimeMs,
    sizeMB: Math.round((st.size / 1048576) * 10) / 10,
    lastAt: null,
    lastType: null,
    stopReason: null,
    lastText: null,
    lastToolNames: [],
    lastUserAt: null,
    lastAssistantAt: null,
    slug: null,
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (!info.lastAt && ts) {
      info.lastAt = ts;
      info.lastType = o.type;
    }
    if (!info.slug && o.slug) info.slug = o.slug;
    if (o.type === 'user' && !info.lastUserAt && ts && o.userType !== 'external') info.lastUserAt = ts;
    if (o.type === 'assistant' && o.message) {
      if (!info.lastAssistantAt && ts) {
        info.lastAssistantAt = ts;
        info.stopReason = o.message.stop_reason ?? null;
      }
      if (info.lastText == null && Array.isArray(o.message.content)) {
        const texts = o.message.content.filter((b) => b && b.type === 'text').map((b) => b.text);
        const tools = o.message.content.filter((b) => b && b.type === 'tool_use').map((b) => b.name);
        if (tools.length && !info.lastToolNames.length) info.lastToolNames = tools;
        if (texts.length) info.lastText = texts.join('\n').trim().slice(0, 600);
      }
    }
    if (info.lastText != null && info.lastUserAt != null) break;
  }
  return info;
}

function collectSessions() {
  const tdir = transcriptsDir();
  const tbase = tasksBase();
  let files = [];
  try {
    files = fs
      .readdirSync(tdir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, p: path.join(tdir, f), st: statOr(path.join(tdir, f)) }))
      .filter((x) => x.st)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  } catch {
    files = [];
  }
  const cutoff = nowMs() - CFG.sessionWindowH * 3600_000;
  const out = [];
  for (const x of files) {
    if (x.st.mtimeMs < cutoff) continue;
    const id = x.f.replace(/\.jsonl$/, '');
    const info = readTranscriptTail(x.p) ?? { mtimeMs: x.st.mtimeMs };
    const tdirS = path.join(tbase, id, 'tasks');
    let taskFiles = [];
    try {
      taskFiles = fs
        .readdirSync(tdirS)
        .map((f) => ({ f, st: statOr(path.join(tdirS, f)) }))
        .filter((y) => y.st)
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    } catch {
      taskFiles = [];
    }
    // 直近の追跡タスクは「生まれた時刻」と「最後に書かれた時刻」の両方を持つ。
    // 出力を out/*.log へ逃がしたジョブは .output が空のまま古びるので、
    // 更新時刻だけでは追跡の有無を判定できない(2026-08-14 に実害)。
    const recentTasks = taskFiles.slice(0, 60).map((y) => ({
      id: y.f.replace(/\.output$/, ''),
      birthMs: y.st.birthtimeMs || y.st.ctimeMs || y.st.mtimeMs,
      mtimeMs: y.st.mtimeMs,
      size: y.st.size,
    }));
    out.push({
      id,
      short: id.slice(0, 8),
      slug: info.slug ?? null,
      isSelf: id === process.env.CLAUDE_SESSION_ID,
      transcriptMB: info.sizeMB ?? null,
      lastAt: info.lastAt ?? x.st.mtimeMs,
      lastAgeSec: ageSec(info.lastAt ?? x.st.mtimeMs),
      lastType: info.lastType ?? null,
      stopReason: info.stopReason ?? null,
      lastText: info.lastText ?? null,
      lastToolNames: info.lastToolNames ?? [],
      lastUserAt: info.lastUserAt ?? null,
      lastUserAgeSec: ageSec(info.lastUserAt),
      taskCount: taskFiles.length,
      taskNewestMs: taskFiles.length ? taskFiles[0].st.mtimeMs : null,
      taskNewestAgeSec: taskFiles.length ? ageSec(taskFiles[0].st.mtimeMs) : null,
      recentTasks,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out;
}

// ───────────────────────── 3. 較正・掃引 run の進捗 ─────────────────────────

function pickSeries(lines) {
  // 全行に共通して現れる数値キーを勝手に見つける(指標が増えても直さない)
  const counts = new Map();
  for (const o of lines) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && Number.isFinite(v)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const keys = [...counts.entries()].filter(([, c]) => c >= lines.length * 0.5).map(([k]) => k);
  const MAX = 500;
  const step = Math.max(1, Math.ceil(lines.length / MAX));
  const series = {};
  for (const k of keys) series[k] = [];
  const idx = [];
  for (let i = 0; i < lines.length; i += step) {
    idx.push(i + 1);
    for (const k of keys) {
      const v = lines[i][k];
      series[k].push(typeof v === 'number' ? v : null);
    }
  }
  return { keys, idx, series };
}

/**
 * @param {{detail?: number, only?: string}} opt
 *   detail: 新しい順に何件まで中身(系列・パラメータ)を積むか。
 *           残りは一覧に出すだけ。毎回の応答を軽く保つため。
 */
function collectRuns(opt = {}) {
  const detailN = opt.detail ?? 2;
  const dir = CFG.optimizeDir;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  // run 名は log_<name>.jsonl / state_<name>.json / best_<name>.json / run_<name>.meta.json
  const runNames = new Set();
  for (const f of names) {
    let m;
    if ((m = f.match(/^log_(.+)\.jsonl$/))) runNames.add(m[1]);
    else if ((m = f.match(/^state_(.+)\.json$/))) runNames.add(m[1]);
    else if ((m = f.match(/^run_(.+)\.meta\.json$/))) runNames.add(m[1]);
  }
  // 新しい順に並べてから、上位だけ中身を読む
  const ordered = [...runNames]
    .map((name) => {
      const t = Math.max(
        statOr(path.join(dir, `log_${name}.jsonl`))?.mtimeMs ?? 0,
        statOr(path.join(dir, `state_${name}.json`))?.mtimeMs ?? 0,
        statOr(path.join(dir, `best_${name}.json`))?.mtimeMs ?? 0,
      );
      return { name, t };
    })
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t);

  const runs = [];
  for (const { name } of ordered) {
    const wantDetail = opt.only ? name === opt.only : runs.length < detailN;
    const logP = path.join(dir, `log_${name}.jsonl`);
    const stateP = path.join(dir, `state_${name}.json`);
    const bestP = path.join(dir, `best_${name}.json`);
    const metaP = path.join(dir, `run_${name}.meta.json`);
    const consoleP = path.join(dir, `${name}.console.log`);

    const meta = readJsonOr(metaP);
    const state = readJsonOr(stateP);
    const logSt = statOr(logP);
    const stateSt = statOr(stateP);
    const newest = Math.max(logSt?.mtimeMs ?? 0, stateSt?.mtimeMs ?? 0, statOr(bestP)?.mtimeMs ?? 0);
    if (!newest) continue;

    let lines = [];
    if (logSt) {
      const text = readTextOr(logP, 4 << 20) ?? '';
      lines = text
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
    const last = lines.length ? lines[lines.length - 1] : null;
    // 直近 20 件から 1 反復あたりの秒を見る
    const recent = lines.slice(-20).map((o) => o.sec).filter((v) => typeof v === 'number');
    const perIterSec = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;

    // 進捗: state に cursor/screenCursor があれば使う(無ければ出さない)
    let progress = null;
    if (state && typeof state.cursor === 'number' && typeof state.screenCursor === 'number' && state.screenCursor > 0) {
      progress = {
        cursor: state.cursor,
        total: state.screenCursor,
        frac: Math.min(1, state.cursor / state.screenCursor),
        etaSec: perIterSec ? Math.round((state.screenCursor - state.cursor) * perIterSec) : null,
      };
    }

    const startedMs = meta?.startedAt ? Date.parse(meta.startedAt) : null;
    const seriesInfo = wantDetail && lines.length ? pickSeries(lines) : { keys: [], idx: [], series: {} };

    runs.push({
      name,
      detail: wantDetail,
      meta,
      startedMs,
      startedAgeSec: ageSec(startedMs),
      lastWriteMs: newest,
      lastWriteAgeSec: ageSec(newest),
      evals: state?.evals ?? (lines.length || null),
      logLines: lines.length,
      phase: state?.phase ?? null,
      sweep: state?.sweep ?? null,
      progress,
      perIterSec: perIterSec ? Math.round(perIterSec) : null,
      lastRow: last,
      bestFit: state?.bestFit ?? null,
      bestScores: wantDetail ? (state?.bestScores ?? null) : null,
      sensitivity: wantDetail ? (state?.sensitivity ?? null) : null,
      bestParams: wantDetail ? (readJsonOr(bestP) ?? state?.best ?? null) : null,
      bestFile: exists(bestP) ? path.relative(ROOT, bestP).replace(/\\/g, '/') : null,
      consoleTail: (readTextOr(consoleP, 8192) ?? '').trim().split('\n').slice(-5).join('\n') || null,
      series: seriesInfo,
    });
  }
  return runs;
}

// ───────────────────────── 4. 評価値(検証レポート)─────────────────────────

function collectValidate() {
  const st = statOr(CFG.validateReport);
  const r = readJsonOr(CFG.validateReport);
  if (!r) return null;
  const headline = [];
  for (const h of CFG.headline) {
    const v = dig(r, h.p);
    if (typeof v !== 'number') continue;
    const ref = h.ref ? dig(r, h.ref) : undefined;
    let ok = null;
    if (typeof ref === 'number') ok = h.better === 'high' ? v >= ref : v <= ref;
    headline.push({ label: h.label, value: v, unit: h.u ?? '', ref: typeof ref === 'number' ? ref : null, ok, better: h.better });
  }
  const gates = Array.isArray(r.regionGates)
    ? {
        total: r.regionGates.length,
        pass: r.regionGates.filter((g) => g.pass).length,
        items: r.regionGates.map((g) => ({ id: g.id, pass: !!g.pass, share: g.share, detail: g.detail })),
      }
    : null;
  return {
    file: path.relative(ROOT, CFG.validateReport).replace(/\\/g, '/'),
    generatedAt: r.generatedAt ?? null,
    ageSec: ageSec(st?.mtimeMs),
    runLabel: r.runLabel ?? null,
    gitCommit: r.gitCommit ?? null,
    gitDirty: r.gitDirty ?? null,
    verdicts: {
      regression: { pass: r.regression?.pass ?? r.regressionPass ?? null, failures: r.regression?.failures ?? [] },
      interim: { pass: r.interimTarget?.pass ?? r.interimTargetPass ?? null, failures: r.interimTarget?.failures ?? [] },
      acceptance: { pass: r.acceptance?.pass ?? r.acceptancePass ?? null, failures: r.acceptance?.failures ?? [] },
    },
    diagnostics: r.diagnostics ?? null,
    stepTimingsMs: r.stepTimingsMs ?? null,
    headline,
    gates,
    raw: r,
  };
}

// ───────────────────────── 5. パラメータと探索空間の端 ─────────────────────────

export function parseSpace() {
  const t = readTextOr(CFG.spaceFile, 1 << 20);
  if (!t) return {};
  const start = t.indexOf('export const SPACE');
  if (start < 0) return {};
  const body = t.slice(start, t.indexOf('\n];', start) + 3);
  const out = {};
  const re = /\[\s*'([A-Za-z0-9_]+)'\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\]/g;
  let m;
  while ((m = re.exec(body))) {
    const lo = Number(m[2]);
    const hi = Number(m[3]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) out[m[1]] = { lo, hi };
  }
  return out;
}

export function analyzeParams(params, sensitivity) {
  const space = parseSpace();
  if (!params) return null;
  const rows = [];
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'number') continue;
    const b = space[name];
    let frac = null;
    let atBound = null;
    if (b && b.hi > b.lo) {
      frac = (value - b.lo) / (b.hi - b.lo);
      const eps = 1e-6;
      if (frac <= 0.001 + eps) atBound = 'lo';
      else if (frac >= 0.999 - eps) atBound = 'hi';
    }
    rows.push({
      name,
      value,
      lo: b?.lo ?? null,
      hi: b?.hi ?? null,
      inSpace: !!b,
      frac,
      atBound,
      sens: sensitivity && typeof sensitivity[name] === 'number' ? sensitivity[name] : null,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  // 空間にはあるのに、この最良点に値が無い定数(名前が変わった等の取りこぼし)
  const missing = Object.keys(space).filter((n) => !(n in params));
  return {
    count: rows.length,
    spaceCount: Object.keys(space).length,
    atBound: rows.filter((r) => r.atBound).map((r) => ({ name: r.name, value: r.value, side: r.atBound, lo: r.lo, hi: r.hi })),
    outsideSpace: rows.filter((r) => !r.inSpace).length,
    missing,
    rows,
  };
}

// ───────────────────────── 6. 台帳・git・最近書かれたファイル ─────────────────────────

function collectLedger() {
  let file = null;
  try {
    const cands = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => CFG.ledgerGlob.test(f)).sort();
    if (cands.length) file = path.join(ROOT, 'docs', cands[cands.length - 1]);
  } catch {
    /* 無視 */
  }
  if (!file) return null;
  const t = readTextOr(file, 512 * 1024) ?? '';
  const items = [];
  const counts = {};
  const re = /^\s*(\d+)\.\s*\*\*\[(.)\]\s*(.+?)\*\*/gm;
  let m;
  while ((m = re.exec(t))) {
    const state = m[2];
    counts[state] = (counts[state] ?? 0) + 1;
    items.push({ no: Number(m[1]), state, title: m[3].replace(/\*\*/g, '').slice(0, 120) });
  }
  return {
    file: path.relative(ROOT, file).replace(/\\/g, '/'),
    ageSec: ageSec(statOr(file)?.mtimeMs),
    counts,
    items,
  };
}

const getGit = memo(15000, async () => {
  const [head, status] = await Promise.all([
    run('git', ['log', '-1', '--format=%h|%s|%cI']),
    run('git', ['status', '--porcelain']),
  ]);
  const [hash, subject, when] = (head.out.trim() || '||').split('|');
  const changed = status.out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return { hash, subject, when, dirty: changed.length > 0, changed: changed.slice(0, 40), changedCount: changed.length };
});

function collectRecentFiles(limit = 20) {
  const roots = [path.join(ROOT, 'out'), path.join(ROOT, 'docs'), path.join(ROOT, 'out', 'validate'), CFG.optimizeDir];
  const seen = new Map();
  for (const r of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const p = path.join(r, e.name);
      const st = statOr(p);
      if (!st) continue;
      seen.set(p, { path: path.relative(ROOT, p).replace(/\\/g, '/'), mtimeMs: st.mtimeMs, sizeKB: Math.round(st.size / 1024) });
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((f) => ({ ...f, ageSec: ageSec(f.mtimeMs) }));
}

function collectFlags() {
  const d = path.join(ROOT, '.claude');
  const halt = path.join(d, '停止');
  const pending = path.join(d, '裁定待ち.md');
  const counter = path.join(d, '.自走カウンタ');
  return {
    halt: exists(halt),
    pending: exists(pending) ? { text: (readTextOr(pending, 65536) ?? '').slice(0, 4000), ageSec: ageSec(statOr(pending)?.mtimeMs) } : null,
    guardCount: exists(counter) ? Number((readTextOr(counter, 64) ?? '0').trim()) || 0 : 0,
  };
}

// ───────────────────────── 7. 自走の判定 ─────────────────────────

/**
 * 「AI が現状を監視しているか」= 計算が終わったときに AI が呼び戻されるか。
 *
 * 機械的な根拠は 1 つだけ: ハーネスが追跡している背景ジョブ(tasks/*.output)。
 * run_in_background で投げたジョブは .output が**起動時に作られる**ので、
 * 出力を out/*.log へ逃がしていても起動時刻の印は残る。よって
 *   「そのジョブの開始以降に作られた/更新された .output があるか」
 * で追跡の有無を判定する。文章で「待っています」と書いても、ここは動かない。
 */
export function judge(clusters, sessions, flags) {
  const work = clusters.filter((c) => c.kind !== '開発サーバ' && !c.parent);
  const slack = CFG.trackSlackSec * 1000;

  // ジョブ ↔ 追跡タスクの対応づけ。**1 対 1 で取り合う**。
  // 同じコマンドを二重起動したとき、札 1 枚を両方の証拠にしてはいけない。
  const pairs = [];
  for (const c of clusters) {
    if (c.parent) continue;
    const t0 = c.startedMs ?? nowMs();
    for (const s of sessions) {
      for (const t of s.recentTasks ?? []) {
        // (a) 札の誕生がジョブ起動と一致する = そのジョブのために作られた
        const near = Math.abs(t.birthMs - t0) <= slack;
        // (b) ジョブ起動より前に生まれた札が、いまも書かれている = その出力を受けている
        const appending = t.birthMs <= t0 + slack && t.mtimeMs >= t0;
        if (!near && !appending) continue;
        pairs.push({
          c,
          s,
          t,
          near,
          score: near ? Math.abs(t.birthMs - t0) : slack + Math.abs(t.mtimeMs - t0),
        });
      }
    }
    c.tracked = false;
    c.trackedBy = null;
    c.trackedTask = null;
    c.trackedHow = null;
  }
  pairs.sort((a, b) => a.score - b.score);
  const usedTask = new Set();
  for (const p of pairs) {
    const tk = p.s.id + '/' + p.t.id;
    if (p.c.tracked || usedTask.has(tk)) continue;
    usedTask.add(tk);
    p.c.tracked = true;
    p.c.trackedBy = p.s.short;
    p.c.trackedTask = p.t.id;
    p.c.trackedHow = p.near ? '起動が一致' : '出力が更新中';
  }
  for (const c of clusters) {
    if (!c.parent) continue;
    const p = clusters.find((x) => x.id === c.parent);
    c.tracked = p ? p.tracked : null;
    c.trackedBy = p ? p.trackedBy : null;
    c.trackedHow = '親ジョブに従う';
  }

  /**
   * 「計算は終わったのに AI が反応していない」の検出。
   * 追跡タスクが AI の最後の発話より後に書かれ、しかもいま走っている
   * ジョブが無い = 完了の通知を受け取れる状態にないまま冷えている。
   * これが利用者の言う「待つふりをして待っていない」の実体。
   */
  for (const s of sessions) s.flag = null;
  const stalled = sessions.filter(
    (s) =>
      s.lastAgeSec != null &&
      s.lastAgeSec < 12 * 3600 &&
      s.lastAgeSec > CFG.aiLiveSec &&
      s.taskNewestMs &&
      s.lastAt &&
      s.taskNewestMs > s.lastAt + 60_000,
  );
  for (const s of stalled) s.flag = '完了通知に未反応';

  for (const c of clusters) {
    if (!c.parent) continue;
    const p = clusters.find((x) => x.id === c.parent);
    c.tracked = p ? p.tracked : null;
    c.trackedBy = p ? p.trackedBy : null;
    c.trackedHow = '親ジョブに従う';
  }
  const newest = sessions[0] ?? null;
  const untracked = work.filter((c) => !c.tracked);
  const reasons = [];
  let level = 'idle';
  let headline = '静止中';

  if (flags.halt) {
    level = 'halt';
    headline = '停止札あり(.claude/停止)';
    reasons.push('利用者が停止を指示。フックは停止を許可する。');
  } else if (flags.pending) {
    level = 'ask';
    headline = '裁定待ち — 利用者の判断が要る';
    reasons.push('.claude/裁定待ち.md がある。AI はここで正当に止まっている。');
  } else if (work.length > 0 && untracked.length === 0) {
    level = 'ok';
    headline = `計算中 ${work.length} 件 — 追跡あり(完了で AI が呼び戻される)`;
    reasons.push('走っているジョブすべてに、ハーネスの追跡タスクが 1 対 1 で対応している。');
  } else if (work.length === 0 && stalled.length > 0) {
    level = 'danger';
    headline = `計算は終わっているのに AI が ${fmtDur(stalled[0].lastAgeSec)} 反応していない`;
    reasons.push(
      '追跡タスクが AI の最後の発話より後に書かれ、いま走っているジョブは無い。完了を受け取れないまま冷えている。',
    );
    for (const s of stalled) reasons.push(`未反応: ${s.short}(最終発話 ${fmtDur(s.lastAgeSec)}前 / 出力 ${fmtDur(s.taskNewestAgeSec)}前)`);
  } else if (work.length > 0 && untracked.length > 0) {
    level = 'danger';
    headline = `計算中 ${work.length} 件 — うち ${untracked.length} 件が投げっぱなしの疑い`;
    reasons.push(
      '追跡タスク(tasks/*.output)がジョブ開始以降に一つも無い。完了しても AI は呼び戻されない可能性が高い。',
    );
    for (const c of untracked) reasons.push(`未追跡: ${c.script ?? c.kind} ${c.args} (${fmtDur(c.elapsedSec)} 経過)`);
  } else if (newest && newest.lastAgeSec != null && newest.lastAgeSec < CFG.aiLiveSec) {
    level = 'ok';
    headline = 'AI が作業中(計算プロセスは無し)';
    reasons.push(`最新セッション ${newest.short} が ${newest.lastAgeSec} 秒前まで書いている。`);
  } else if (newest) {
    level = 'idle';
    headline = `静止中 — 計算なし・AI は ${fmtDur(newest.lastAgeSec)} 無音`;
    reasons.push(`最後の発話は ${newest.stopReason ?? newest.lastType ?? '不明'}。`);
  }

  const dup = work.filter((c) => c.duplicate);
  if (dup.length) {
    reasons.push(
      `同一コマンドの二重起動が ${dup.length} 件ある(${dup[0].script ?? ''} — 同じ出力ファイルを取り合う恐れ)。`,
    );
    if (level === 'ok') {
      level = 'warn';
      headline = `計算中 ${work.length} 件 — ただし二重起動 ${dup.length} 件`;
    }
  }
  if (level !== 'danger' && stalled.length) {
    if (level === 'ok') level = 'warn';
    reasons.push(`完了通知に未反応のセッション ${stalled.length} 本(${stalled.map((s) => s.short).join(', ')})。`);
  }
  if (flags.guardCount > 0) reasons.push(`Stop フックの差し戻し ${flags.guardCount} 回(利用者の発話で 0 に戻る)。`);

  return { level, headline, reasons };
}

function fmtDur(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間${Math.floor((sec % 3600) / 60)}分`;
  return `${Math.floor(sec / 86400)}日${Math.floor((sec % 86400) / 3600)}時間`;
}

// ───────────────────────── 状態の組み立て ─────────────────────────

async function buildState() {
  const t0 = nowMs();
  const [procs, git] = await Promise.all([getProcs(), getGit()]);
  const clusters = clusterProcs(procs);
  const sessions = collectSessions();
  const flags = collectFlags();
  const verdict = judge(clusters, sessions, flags);
  const runs = collectRuns();
  const validate = collectValidate();
  const newestRun = runs[0] ?? null;
  const params = analyzeParams(newestRun?.bestParams ?? null, newestRun?.sensitivity ?? null);

  return {
    now: new Date().toISOString(),
    root: ROOT.replace(/\\/g, '/'),
    buildMs: nowMs() - t0,
    verdict,
    flags,
    compute: {
      procCount: procs.filter((p) => p.isJob).length,
      jobCount: clusters.filter((c) => !c.parent).length,
      clusters,
      others: procs.filter((p) => !p.isJob && !p.isSelf).map((p) => ({ pid: p.pid, name: p.name, elapsedSec: p.elapsedSec, cmd: p.cmd.slice(0, 160) })),
    },
    ai: { sessions, transcriptsDir: transcriptsDir().replace(/\\/g, '/'), tasksBase: tasksBase().replace(/\\/g, '/') },
    runs,
    validate,
    params,
    paramSource: newestRun ? `${newestRun.name}(${newestRun.bestFile ?? 'state'})` : null,
    git,
    ledger: collectLedger(),
    recentFiles: collectRecentFiles(),
  };
}

// ───────────────────────── HTTP ─────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/state') {
      const state = await buildState();
      const body = JSON.stringify(state);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/run') {
      // 古い run の中身は要求されたときだけ読む(毎回の応答を軽く保つ)
      const name = url.searchParams.get('name') ?? '';
      const one = collectRuns({ only: name }).find((r) => r.name === name) ?? null;
      res.writeHead(one ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(one));
      return;
    }
    if (url.pathname === '/api/file') {
      // レポートの生 JSON など、任意の相対パスを読む(リポジトリ内に限る)
      const rel = url.searchParams.get('p') ?? '';
      const abs = path.resolve(ROOT, rel);
      if (!abs.startsWith(ROOT) || !exists(abs)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await fsp.readFile(abs);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await fsp.readFile(path.join(HERE, 'monitor_ui.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e && e.stack ? e.stack : e));
  }
});

/** 直接起動されたときだけ待ち受ける(テストから import できるように)。 */
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    process.stdout.write(`すでに起動しています: http://${CFG.host}:${CFG.port}\n`);
    process.exit(0);
  }
  throw e;
});

if (IS_MAIN) {
  server.listen(CFG.port, CFG.host, () => {
    const url = `http://${CFG.host}:${CFG.port}`;
    process.stdout.write(`ExoClim-3 自走モニタ: ${url}\n`);
    // 既定でブラウザを開く。開きたくないときは EXOCLIM_MONITOR_OPEN=0。
    if (process.env.EXOCLIM_MONITOR_OPEN !== '0' && process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  });
}
