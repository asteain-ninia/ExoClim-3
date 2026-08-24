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
import { createTranscriptWatcher } from './monitor_transcript.mjs';

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
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -like '*ExoClim-3*' -or
  $_.CommandLine -match '(scripts|tests|out)[\\\\/][\\w.\\-]+\\.(ts|mjs|cjs|js|py|ps1)'
} | ForEach-Object {
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
/** そのスクリプトがこのリポジトリのものか(既定は実ファイルの有無で見る)。 */
function scriptIsOurs(dir, script) {
  return !!script && exists(path.join(ROOT, dir, script));
}

export function classifyProc(p, now = Date.now(), ownedBy = scriptIsOurs) {
  const cmd = String(p.cmd ?? '');
  const name = String(p.name ?? '');
  // リポジトリ内のスクリプトを**最後の出現**で拾う。node_modules の
  // ローダやラッパ(tsx/dist/cli.mjs 等)はこの型に当たらない。
  const hits = [...cmd.matchAll(/(?:^|[\s"'/\\])(scripts|tests|out)[/\\]([\w.-]+\.(?:ts|mjs|cjs|js|py|ps1))/gi)];
  const last = hits.length ? hits[hits.length - 1] : null;
  const script = last ? last[2] : null;

  /**
   * このリポジトリのものか。
   *
   * コマンド行に絶対パスが載らない起動(リポジトリの中で `node scripts/x.mjs`)
   * があるので、プロセスの絞り込みを `*ExoClim-3*` だけにしてはいけない —
   * **走っているのに「計算 0 件」と報告する**という最悪の外し方をする
   * (2026-08-24 に実測。モニタ自身すら見えていなかった)。
   * 代わりに `scripts/…` の形も拾い、**実ファイルがこのリポジトリに在るか**で
   * 他プロジェクトのものを弾く(例: 別プロジェクトの scripts/session_check.js)。
   * 作業ディレクトリは Win32_Process から取れないので、これが実用的な上限。
   */
  const marked = /exoclim-3/i.test(cmd);
  const ours = marked || (last ? ownedBy(last[1], script) : false);

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
    isJob: ours && CFG.procNames.includes(name.toLowerCase()) && kind != null && kind !== 'self',
    isSelf: kind === 'self',
    /** このリポジトリのものと判断できたか。false = 他プロジェクトの同名スクリプト等。 */
    ours,
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

/**
 * 会話ログの追跡状態を増分で読む。**同じ番人を使い回す**(位置を覚えている)。
 * 初回だけ末尾 4MB を読む(実測: 忙しいセッションで約 90 時間ぶんまで遡れる)。
 */
const transcripts = createTranscriptWatcher({
  dir: transcriptsDir(),
  windowH: CFG.sessionWindowH,
  initialTailBytes: 4 * 1024 * 1024,
});

/**
 * セッションごとに「いま追跡が生きているか」と「札の一覧」をまとめる。
 *
 * 追跡の有無は**会話ログの記録**から取る(札の時刻から推測しない)。
 * 札(.output)は表示のためだけに読む — 札は最初の出力が出た時刻に
 * 生まれるので、起動時刻の証拠にはならない(2026-08-24 の誤検知の原因)。
 */
function collectSessions(procs) {
  const tbase = tasksBase();
  const { sessions } = transcripts.read();
  const out = [];
  for (const r of sessions) {
    const tdirS = path.join(tbase, r.id, 'tasks');
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
    const outstanding = r.outstanding().map((t) => {
      // 見張り・背景ジョブは OS プロセスとして見えるはず。
      // 追跡の開始時刻とプロセスの誕生時刻はほぼ一致する(実測 0.1 秒差)。
      // 対応するプロセスが居なければ、その見張りは死んでいる可能性がある。
      let alive = null;
      if (t.kind === 'background' || t.kind === 'monitor') {
        alive = procs.some((p) => p.startedMs && t.atMs && Math.abs(p.startedMs - t.atMs) <= 15_000);
      }
      const mark = taskFiles.find((y) => y.f === t.id + '.output');
      // 見張りの点検間隔。`sleep N` が読めれば「次に気づくのはいつか」が言える。
      const sl = /(?:^|[;&\s])sleep\s+(\d+)/.exec(t.command || '');
      const pollSec = sl ? Number(sl[1]) : null;
      return {
        id: t.id,
        kind: t.kind,
        what: t.what,
        atMs: t.atMs,
        ageSec: ageSec(t.atMs),
        label: t.label || '',
        command: (t.command || '').replace(/\s+/g, ' ').slice(0, 240),
        eventCount: t.eventCount ?? 0,
        lastEventAgeSec: t.lastEventMs ? ageSec(t.lastEventMs) : null,
        alive,
        markSize: mark ? mark.st.size : null,
        markAgeSec: mark ? ageSec(mark.st.mtimeMs) : null,
        pollSec,
        nextCheckSec:
          pollSec && t.lastEventMs ? Math.max(0, Math.round((t.lastEventMs + pollSec * 1000 - nowMs()) / 1000)) : null,
      };
    });
    const row = {
      id: r.id,
      short: r.short,
      slug: r.slug ?? null,
      transcriptMB: r.sizeMB ?? null,
      truncated: !!r.truncated,
      quotedArmings: r.quotedArmings ?? 0,
      lastAt: r.lastTs,
      lastAgeSec: ageSec(r.lastTs),
      lastType: r.lastType ?? null,
      stopReason: r.lastStopReason ?? null,
      lastText: r.lastAssistantText ?? null,
      lastUserAt: r.lastUserTs ?? null,
      lastUserAgeSec: ageSec(r.lastUserTs),
      outstanding,
      armedCount: outstanding.length,
      doneCount: r.done.size,
      taskCount: taskFiles.length,
      taskNewestMs: taskFiles.length ? taskFiles[0].st.mtimeMs : null,
      taskNewestAgeSec: taskFiles.length ? ageSec(taskFiles[0].st.mtimeMs) : null,
      launchCount: r.launches.length,
      flag: null,
    };
    // 起動コマンドの原文は帰属の照合にだけ使う。応答には載せない
    // (重いうえに画面では使わない)。列挙不可にして JSON から外す。
    Object.defineProperty(row, 'launches', { value: r.launches, enumerable: false });
    out.push(row);
  }
  out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
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
  const empty = { space: {}, disabled: [] };
  if (!t) return empty;
  const start = t.indexOf('export const SPACE');
  if (start < 0) return empty;
  const body = t.slice(start, t.indexOf('\n];', start) + 3);

  const re = /\[\s*'([A-Za-z0-9_]+)'\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\]/g;
  const pick = (text) => {
    const out = {};
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const lo = Number(m[2]);
      const hi = Number(m[3]);
      if (Number.isFinite(lo) && Number.isFinite(hi)) out[m[1]] = { lo, hi };
    }
    return out;
  };

  // **コメント行を先に落とす。** この literal には理由を書いた注記が多く、
  // 無効化した定数がタプルの形のまま残っている(死んだ機構の記録)。
  // 生のまま拾うと、掃引されていない定数を「探索対象」に数えてしまう。
  const live = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const space = pick(live);
  const disabled = Object.keys(pick(body)).filter((n) => !(n in space));
  return { space, disabled };
}

export function analyzeParams(params, sensitivity) {
  const { space, disabled } = parseSpace();
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
    /** SPACE の中でコメントアウトされている = 掃引から外した定数。 */
    disabled,
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
 * 走っている計算を、それを起動したセッションへ結びつける。
 *
 * 根拠は**起動時に AI が打ったコマンドの原文**。会話ログに残っている
 * tool_use の入力に、いま走っているプロセスのコマンド行の一部が
 * そのまま含まれている。時刻の近さではなく文字列で照合するので、
 * 切り離し起動(PowerShell の Start-Process 等)でも帰属できる。
 */
export function attributeJobs(clusters, sessions) {
  const norm = (x) => String(x || '').toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  for (const c of clusters) {
    c.owner = null;
    c.ownerLaunchMs = null;
    c.ownerTool = null;
    if (c.parent) continue;
    const needle = norm(`${c.script ?? ''} ${c.args ?? ''}`);
    if (!needle) continue;
    let best = null;
    for (const s of sessions) {
      for (const l of s.launches ?? []) {
        if (!norm(l.command).includes(needle)) continue;
        // 起動はプロセスの誕生より前(わずかな前後は許す)
        if (c.startedMs && l.atMs && l.atMs > c.startedMs + CFG.trackSlackSec * 1000) continue;
        if (!best || (l.atMs ?? 0) > (best.l.atMs ?? 0)) best = { s, l };
      }
    }
    if (best) {
      c.owner = best.s.short;
      c.ownerId = best.s.id;
      c.ownerLaunchMs = best.l.atMs;
      c.ownerTool = best.l.tool;
    }
  }
}

/**
 * 「AI は起こされるか」の判定。
 *
 * **問いの立て方を 2026-08-24 に改めた。** 以前は「計算プロセス 1 件ごとに
 * 札(.output)が対応するか」を時刻で見ていたが、これは二重に間違っていた:
 *   ・札は「最初の出力が出た時刻」に作られる。30 分黙る見張りでは 30 分ずれる。
 *   ・そもそも見張りは、計算とは**別に、あとから**装着してよい。
 *     切り離し起動(Start-Process)+ Monitor という正しい運用を
 *     「投げっぱなし」と誤報した。
 *
 * 正しい問いは **「その計算を抱えているセッションが armed か」**。
 * armed = 会話ログ上、開始が記録されていて終了通知が来ていない追跡タスクを
 * 1 つ以上持っている。ハーネスはそれが動くかぎり AI を呼び戻す。
 * これは Stop フックの逃げ道 3 と同じ考えであり、矛盾しない。
 *
 * 誤りの向きは非対称に扱う。「本当は起きないのに追跡ありと言う」= 寝落ちの
 * 見逃し = 最悪。「本当は起きるのに投げっぱなしと言う」= 狼少年。
 * どちらも避けられないときは **「判定不能」と正直に出す**。
 */
export function judge(clusters, sessions, flags, results = []) {
  const jobs = clusters.filter((c) => !c.parent && c.kind !== '開発サーバ');

  // セッションが armed か。死んだ見張り(対応するプロセスが居ない)は数えない。
  for (const s of sessions) {
    s.liveTracks = (s.outstanding ?? []).filter((t) => t.alive !== false);
    s.deadTracks = (s.outstanding ?? []).filter((t) => t.alive === false);
    s.armed = s.liveTracks.length > 0;
  }
  const armedSessions = sessions.filter((s) => s.armed);

  for (const c of jobs) {
    const owner = c.owner ? sessions.find((s) => s.short === c.owner) : null;
    if (owner && owner.armed) {
      const t = owner.liveTracks[0];
      c.watch = 'ok';
      c.watchBy = owner.short;
      c.watchWhy = `${owner.short} が${t.what ?? '追跡'}「${t.label || t.id}」で待っている`;
      c.watchTask = t.id;
    } else if (owner && !owner.armed) {
      c.watch = 'orphan';
      c.watchBy = owner.short;
      c.watchWhy = `起動した ${owner.short} に生きている追跡が 1 つも無い`;
      c.watchTask = null;
    } else if (armedSessions.length) {
      // 誰が起動したか分からないが、armed なセッションは居る。狼少年にしない。
      c.watch = 'unknown';
      c.watchBy = null;
      c.watchWhy = `起動元を特定できない(armed なセッションは ${armedSessions.map((s) => s.short).join(', ')})`;
      c.watchTask = null;
    } else {
      c.watch = 'orphan';
      c.watchBy = null;
      c.watchWhy = 'どのセッションにも生きている追跡が無い';
      c.watchTask = null;
    }
  }
  for (const c of clusters) {
    if (!c.parent) continue;
    const p = clusters.find((x) => x.id === c.parent);
    c.watch = p ? p.watch : null;
    c.watchBy = p ? p.watchBy : null;
    c.watchWhy = '親ジョブに従う';
  }

  /**
   * 「計算は終わったのに AI が反応していない」。
   * 追跡が最後に何かを書いたのが AI の最終発話より後で、しかも
   * いま走っている計算が無い = 受け取るものが来たのに冷えている。
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

  /**
   * 「結果はもう出ているのに、AI がまだ知らない」。
   * 成果物(較正の状態ファイル・検証レポート)が AI の最終発話より後に
   * 書かれていて、いま走っている計算が無い状態。見張りが生きていても、
   * 次の点検が 30 分後なら AI はそれまで気づかない — それを見せる。
   */
  const newestResult = results.filter((r) => r.atMs).sort((a, b) => b.atMs - a.atMs)[0] ?? null;
  const unseen = [];
  if (newestResult && !jobs.length) {
    for (const s of sessions) {
      if (!s.armed) continue;
      if (s.lastAt && newestResult.atMs > s.lastAt + 60_000) {
        const next = Math.min(
          ...s.liveTracks.map((t) => (t.nextCheckSec == null ? Infinity : t.nextCheckSec)),
        );
        unseen.push({ session: s, nextCheckSec: Number.isFinite(next) ? next : null });
      }
    }
  }

  const orphans = jobs.filter((c) => c.watch === 'orphan');
  const unknowns = jobs.filter((c) => c.watch === 'unknown');
  const newest = sessions[0] ?? null;
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
  } else if (orphans.length) {
    level = 'danger';
    headline = `計算中 ${jobs.length} 件 — うち ${orphans.length} 件が投げっぱなし`;
    for (const c of orphans) reasons.push(`投げっぱなし: ${c.script ?? c.kind}(${c.watchWhy})`);
  } else if (jobs.length && unknowns.length === jobs.length) {
    level = 'warn';
    headline = `計算中 ${jobs.length} 件 — 起動元を特定できない`;
    reasons.push('コマンドの原文が会話ログの読み取り範囲に無い。利用者が端末で直に起動した可能性もある。');
    reasons.push(`armed なセッション: ${armedSessions.map((s) => s.short).join(', ') || 'なし'}`);
  } else if (jobs.length) {
    level = 'ok';
    const ok = jobs.filter((c) => c.watch === 'ok');
    headline = `計算中 ${jobs.length} 件 — 見守られている(完了・進捗で AI が起こされる)`;
    for (const c of ok) reasons.push(`${c.script ?? c.kind}: ${c.watchWhy}`);
    if (unknowns.length) reasons.push(`ただし ${unknowns.length} 件は起動元を特定できていない。`);
  } else if (unseen.length) {
    const u = unseen[0];
    level = 'warn';
    headline = `結果は出ているのに AI はまだ知らない(${newestResult.what} が ${fmtDur(ageSec(newestResult.atMs))}前に確定)`;
    reasons.push(
      `${u.session.short} は ${fmtDur(u.session.lastAgeSec)}前から黙っている。追跡は生きているので、いずれ起こされる。`,
    );
    if (u.nextCheckSec != null) {
      reasons.push(`見張りの次の点検まで約 ${fmtDur(u.nextCheckSec)}(点検間隔から算出)。急ぐなら声をかける。`);
    } else {
      reasons.push('見張りの点検間隔は読み取れなかった。いつ気づくかは不明。');
    }
  } else if (stalled.length > 0) {
    level = 'danger';
    headline = `計算は終わっているのに AI が ${fmtDur(stalled[0].lastAgeSec)} 反応していない`;
    reasons.push('追跡が AI の最終発話より後に書かれ、いま走っている計算は無い。');
    for (const s of stalled) reasons.push(`未反応: ${s.short}(最終発話 ${fmtDur(s.lastAgeSec)}前)`);
  } else if (newest && newest.lastAgeSec != null && newest.lastAgeSec < CFG.aiLiveSec) {
    level = 'ok';
    headline = 'AI が作業中(計算プロセスは無し)';
    reasons.push(`最新セッション ${newest.short} が ${newest.lastAgeSec} 秒前まで書いている。`);
  } else if (newest && armedSessions.length) {
    level = 'ok';
    headline = `AI は待機中 — 追跡 ${armedSessions.reduce((a, s) => a + s.liveTracks.length, 0)} 件が生きている`;
    reasons.push(`${armedSessions.map((s) => s.short).join(', ')} が待っている。完了で呼び戻される。`);
  } else if (newest) {
    level = 'idle';
    headline = `静止中 — 計算なし・AI は ${fmtDur(newest.lastAgeSec)} 無音`;
    reasons.push(`最後の発話は ${newest.stopReason ?? newest.lastType ?? '不明'}。`);
  }

  const dup = jobs.filter((c) => c.duplicate);
  if (dup.length) {
    reasons.push(`同一コマンドの二重起動が ${dup.length} 件ある(${dup[0].script ?? ''} — 同じ出力を取り合う恐れ)。`);
    if (level === 'ok') {
      level = 'warn';
      headline = `計算中 ${jobs.length} 件 — ただし二重起動 ${dup.length} 件`;
    }
  }
  const dead = sessions.filter((s) => (s.deadTracks ?? []).length);
  for (const s of dead) {
    reasons.push(
      `${s.short}: 追跡 ${s.deadTracks.length} 件に対応するプロセスが居ない(見張りが死んでいる疑い)。`,
    );
    if (level === 'ok') level = 'warn';
  }
  if (level !== 'danger' && stalled.length) {
    if (level === 'ok') level = 'warn';
    reasons.push(`完了通知に未反応のセッション ${stalled.length} 本(${stalled.map((s) => s.short).join(', ')})。`);
  }
  if (flags.guardCount > 0) reasons.push(`Stop フックの差し戻し ${flags.guardCount} 回(利用者の発話で 0 に戻る)。`);
  const truncated = sessions.filter((s) => s.truncated && s.armedCount === 0 && s.lastAgeSec < 3600);
  if (truncated.length) {
    reasons.push(`会話ログを末尾だけしか読めていないセッションが ${truncated.length} 本(古い追跡を取りこぼす可能性)。`);
  }

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
  const sessions = collectSessions(procs);
  const flags = collectFlags();
  attributeJobs(clusters, sessions);
  const runs = collectRuns();
  const validate = collectValidate();
  // 成果物が出た時刻(「結果は出ているのに AI が知らない」の判定に使う)
  const results = [
    ...runs.map((r) => ({ what: `較正 ${r.name}`, atMs: r.lastWriteMs })),
    validate ? { what: '検証レポート', atMs: nowMs() - (validate.ageSec ?? 0) * 1000 } : null,
  ].filter(Boolean);
  const verdict = judge(clusters, sessions, flags, results);
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
      others: procs
        .filter((p) => !p.isJob && !p.isSelf)
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          elapsedSec: p.elapsedSec,
          why: p.ours === false ? 'このリポジトリのスクリプトではない' : 'シェル・道具・素性不明',
          cmd: p.cmd.slice(0, 160),
        })),
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
