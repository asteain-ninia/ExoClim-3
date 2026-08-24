// 自走モニタの判定ロジック(docs/道具_自走モニタ_2026-08-24.md)。
//
// この道具の値打ちは「AI が計算の完了で起こされる状態か」を**口先ではなく
// 機械で**判定するところにある。誤りの向きは非対称:
//   ・本当は起きないのに「見守られている」と言う = 寝落ちの見逃し = 最悪
//   ・本当は起きるのに「投げっぱなし」と言う     = 狼少年(2026-08-24 に実害)
// どちらも実際に踏んだので、両方を場面として固定する。

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attributeJobs, classifyProc, clusterProcs, judge, parseSpace } from '../../../scripts/monitor_server.mjs';
import { createTranscriptWatcher } from '../../../scripts/monitor_transcript.mjs';

const NOW = Date.UTC(2026, 7, 24, 0, 0, 0); // 判定は現在時刻を見ないので固定してよい
const agoMs = (sec: number) => NOW - sec * 1000;
const iso = (sec: number) => new Date(agoMs(sec)).toISOString();

/** 生きている追跡 1 件。alive=false なら見張りが死んでいる。 */
const track = (
  id: string,
  kind: 'background' | 'monitor' | 'workflow' | 'agent',
  startedSec: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind,
  what: kind === 'monitor' ? '見張り(発火のたびに起こされる)' : '背景ジョブ',
  atMs: agoMs(startedSec),
  ageSec: startedSec,
  label: '',
  command: '',
  eventCount: 0,
  lastEventAgeSec: null,
  alive: true,
  nextCheckSec: null,
  ...extra,
});

const session = (
  short: string,
  lastAgeSec: number,
  outstanding: ReturnType<typeof track>[],
  launches: { atMs: number; tool: string; command: string }[] = [],
  /** 受け取ったのに返事をしていない完了通知。 */
  unansweredDone: { atMs: number; ageSec: number; status: string; summary: string }[] = [],
) => {
  const row = {
    id: short + '-full-id',
    short,
    lastAt: agoMs(lastAgeSec),
    lastAgeSec,
    // AI が自分で書いた最後の時刻(通知の到着は含めない)
    lastActAt: agoMs(lastAgeSec),
    lastActAgeSec: lastAgeSec,
    unansweredDone,
    lastType: 'assistant',
    stopReason: 'end_turn',
    outstanding,
    armedCount: outstanding.length,
    doneCount: 0,
    taskCount: outstanding.length,
    taskNewestMs: null as number | null,
    taskNewestAgeSec: null as number | null,
    truncated: false,
    flag: null as string | null,
  };
  Object.defineProperty(row, 'launches', { value: launches, enumerable: false });
  return row;
};

const flagsNone = { halt: false, pending: null, guardCount: 0 };

/** tsx 経由の 1 ジョブは node が複数立つ。それを畳んだものを作る。 */
function jobProcs(script: string, args: string, startedSec: number, pids: number[]) {
  return pids.map((pid) =>
    classifyProc(
      {
        pid,
        ppid: 9999,
        name: 'node.exe',
        started: iso(startedSec),
        cpuSec: 10,
        memMB: 100,
        cmd: `"C:\\Program Files\\nodejs\\node.exe" --import file:///E:/WORKSPACE/ExoClim-3/node_modules/tsx/dist/loader.mjs scripts/${script} ${args}`,
      },
      NOW,
    ),
  );
}

describe('classifyProc — コマンド行の誤読を防ぐ', () => {
  it('ラッパの三段重ねでも同じスクリプト名・引数になる', () => {
    const procs = jobProcs('diag_dead_constants.ts', '0 999 --write', 100, [1, 2, 3]);
    for (const p of procs) {
      expect(p.script).toBe('diag_dead_constants.ts');
      expect(p.args).toBe('0 999 --write');
      expect(p.kind).toBe('診断');
      expect(p.isJob).toBe(true);
    }
  });

  it('bash が抱えたコミット文の中の語をスクリプト名にしない', () => {
    const p = classifyProc(
      {
        pid: 9,
        ppid: 9999,
        name: 'bash.exe',
        started: iso(100),
        cpuSec: 0,
        memMB: 10,
        cmd: `"C:\\Program Files\\Git\\bin\\bash.exe" -c "git commit -F - <<EOF\n範囲を scripts/optimize_lib.ts で引き直した\nEOF\nnpx tsx scripts/diag_dead_constants.ts 0 999 --write > out/liveness.txt"`,
      },
      NOW,
    );
    expect(p.isJob).toBe(false);
  });

  it('引数はリダイレクトや連結の手前で切る', () => {
    const p = classifyProc(
      {
        pid: 9,
        ppid: 9999,
        name: 'node.exe',
        started: iso(10),
        cpuSec: 0,
        memMB: 10,
        cmd: 'node scripts/sweep_lever.ts --lever=x > out/sweep.txt 2>&1; grep foo',
      },
      NOW,
    );
    expect(p.script).toBe('sweep_lever.ts');
    expect(p.args).toBe('--lever=x');
    expect(p.kind).toBe('掃引');
  });

  it('回帰: 絶対パスを含まない起動も計算として見える', () => {
    // 2026-08-24 実測: `*ExoClim-3*` だけで絞ると合致 0 件になり、
    // 走っているのに「計算 0 件」と報告する — 最悪の外し方。
    const p = classifyProc(
      { pid: 9, ppid: 9999, name: 'node.exe', started: iso(10), cpuSec: 0, memMB: 10, cmd: 'node scripts/optimize.ts --run v34' },
      NOW,
      () => true,
    );
    expect(p.isJob).toBe(true);
    expect(p.ours).toBe(true);
    expect(p.kind).toBe('較正');
  });

  it('他プロジェクトの同名スクリプトは弾く(実ファイルがこのリポジトリに無い)', () => {
    const p = classifyProc(
      { pid: 9, ppid: 9999, name: 'node.exe', started: iso(10), cpuSec: 0, memMB: 10, cmd: 'node scripts/session_check.js' },
      NOW,
      () => false,
    );
    expect(p.ours).toBe(false);
    expect(p.isJob).toBe(false);
  });

  it('自分自身(モニタ)は計算に数えない', () => {
    const p = classifyProc(
      { pid: 9, ppid: 1, name: 'node.exe', started: iso(10), cpuSec: 0, memMB: 10, cmd: 'node scripts/monitor_server.mjs' },
      NOW,
    );
    expect(p.isSelf).toBe(true);
    expect(p.isJob).toBe(false);
  });
});

describe('clusterProcs — ラッパを 1 ジョブに畳み、二重起動を見分ける', () => {
  it('同じコマンドでも起動時刻が離れていれば別ジョブ(= 二重起動)', () => {
    const cs = clusterProcs([
      ...jobProcs('diag_dead_constants.ts', '0 999 --write', 2800, [1, 2, 3]),
      ...jobProcs('diag_dead_constants.ts', '0 999 --write', 1300, [4, 5, 6]),
    ]);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.duplicate)).toBe(true);
    expect(cs[0]!.pids).toHaveLength(3);
  });

  it('起動が数秒差のラッパは 1 ジョブに畳まれる', () => {
    const cs = clusterProcs([
      ...jobProcs('validate.ts', '', 100, [1]),
      ...jobProcs('validate.ts', '', 99, [2]),
      ...jobProcs('validate.ts', '', 98, [3]),
    ]);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.duplicate).toBe(false);
  });

  it('二重起動でも親子の指し先を取り違えない(key ではなく id で指す)', () => {
    const cs = clusterProcs([
      ...jobProcs('optimize.ts', '--run v34', 600, [10, 11]),
      ...jobProcs('optimize.ts', '--run v34', 60, [20, 21]),
    ]);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.parent === null)).toBe(true);
  });
});

describe('attributeJobs — 切り離し起動でも持ち主を特定する', () => {
  it('PowerShell の Start-Process で投げた計算を、コマンドの原文で辿れる', () => {
    // 2026-08-24 の実例。ハーネスの札は一切付かない起動。
    const cs = clusterProcs(jobProcs('optimize.ts', '--run v33 --minutes 720 --parallel 4', 30000, [1, 2]));
    const ss = [
      session(
        '6051ffad',
        600,
        [track('b9o4affff', 'monitor', 29900)],
        [
          {
            atMs: agoMs(30005),
            tool: 'PowerShell',
            command:
              'Set-Location E:\\WORKSPACE\\ExoClim-3; Start-Process -FilePath "cmd.exe" -ArgumentList \'/c npx tsx scripts/optimize.ts --run v33 --minutes 720 --parallel 4 > out\\optimize\\v33.console.log 2>&1\' -WindowStyle Hidden',
          },
        ],
      ),
    ];
    attributeJobs(cs, ss);
    expect(cs[0]!.owner).toBe('6051ffad');
    expect(cs[0]!.ownerTool).toBe('PowerShell');
  });

  it('プロセスより後に打たれたコマンドを持ち主にしない', () => {
    const cs = clusterProcs(jobProcs('optimize.ts', '--run v34', 3000, [1]));
    const ss = [
      session('aaa', 60, [], [{ atMs: agoMs(10), tool: 'Bash', command: 'npx tsx scripts/optimize.ts --run v34' }]),
    ];
    attributeJobs(cs, ss);
    expect(cs[0]!.owner).toBeNull();
  });
});

describe('judge — AI が起こされるかの判定', () => {
  it('持ち主に生きている追跡があれば「見守られている」', () => {
    const cs = clusterProcs(jobProcs('optimize.ts', '--run v33', 30000, [1, 2]));
    const ss = [
      session(
        '6051ffad',
        600,
        [track('b9o4affff', 'monitor', 29900, { label: 'v33 の見張り' })],
        [{ atMs: agoMs(30005), tool: 'PowerShell', command: 'Start-Process ... scripts/optimize.ts --run v33 ...' }],
      ),
    ];
    attributeJobs(cs, ss);
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.watch).toBe('ok');
    expect(v.level).toBe('ok');
    expect(v.headline).toContain('見守られている');
  });

  it('回帰: 持ち主を特定できなくても、armed なセッションが居れば投げっぱなしと断じない', () => {
    // 2026-08-24 の誤報。正しく運用しているスレを danger にしてはいけない。
    const cs = clusterProcs(jobProcs('optimize.ts', '--run v33', 30000, [1, 2]));
    const ss = [session('6051ffad', 600, [track('b9o4affff', 'monitor', 29900)])]; // launches 無し
    attributeJobs(cs, ss);
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.watch).toBe('unknown');
    expect(v.level).toBe('warn');
    expect(v.headline).not.toContain('投げっぱなし');
  });

  it('持ち主が特定できて、その持ち主に追跡が無ければ投げっぱなし', () => {
    const cs = clusterProcs(jobProcs('diag_dead_constants.ts', '0 999', 1300, [1, 2]));
    const ss = [
      session('aaa', 600, [], [
        { atMs: agoMs(1310), tool: 'Bash', command: 'npx tsx scripts/diag_dead_constants.ts 0 999' },
      ]),
    ];
    attributeJobs(cs, ss);
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.watch).toBe('orphan');
    expect(v.level).toBe('danger');
    expect(v.headline).toContain('投げっぱなし');
  });

  it('どのセッションにも追跡が無ければ、持ち主不明でも投げっぱなし', () => {
    const cs = clusterProcs(jobProcs('sweep_lever.ts', '--x', 900, [1]));
    const ss = [session('aaa', 4000, [])];
    attributeJobs(cs, ss);
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.watch).toBe('orphan');
    expect(v.level).toBe('danger');
  });

  it('見張りが死んでいれば(対応するプロセスが居ない)armed に数えない', () => {
    const cs = clusterProcs(jobProcs('optimize.ts', '--run v34', 900, [1]));
    const ss = [
      session('aaa', 600, [track('bdead', 'monitor', 800, { alive: false })], [
        { atMs: agoMs(905), tool: 'Bash', command: 'npx tsx scripts/optimize.ts --run v34' },
      ]),
    ];
    attributeJobs(cs, ss);
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.watch).toBe('orphan');
    expect(v.level).toBe('danger');
  });

  it('結果が出ているのに AI が黙っていれば、見張りが生きていても知らせる', () => {
    const ss = [session('aaa', 900, [track('bmon', 'monitor', 30000, { nextCheckSec: 1000 })])];
    const v = judge([], ss, flagsNone, [{ what: '較正 v33', atMs: agoMs(300) }]);
    expect(v.level).toBe('warn');
    expect(v.headline).toContain('まだ知らない');
    expect(v.reasons.join(' ')).toContain('次の点検');
  });

  it('AI が直前まで書いていれば、結果が出ていても騒がない', () => {
    const ss = [session('aaa', 10, [track('bmon', 'monitor', 30000)])];
    const v = judge([], ss, flagsNone, [{ what: '較正 v33', atMs: agoMs(300) }]);
    expect(v.level).toBe('ok');
  });

  it('完了通知が来たのに AI が返事をしていなければ danger', () => {
    // 根拠は札の時刻ではなく、会話ログに残る完了通知そのもの。
    const ss = [
      session('aaa', 1800, [], [], [
        { atMs: agoMs(1500), ageSec: 1500, status: 'completed', summary: 'Background command "掃引" completed' },
      ]),
    ];
    const v = judge([], ss, flagsNone);
    expect(ss[0]!.flag).toBe('完了通知に未反応');
    expect(v.level).toBe('danger');
    expect(v.headline).toContain('反応していない');
  });

  it('裁定待ちの札があれば、それが最優先', () => {
    const ss = [session('aaa', 3600, [])];
    const v = judge([], ss, { halt: false, pending: { text: '問い', ageSec: 60 }, guardCount: 3 });
    expect(v.level).toBe('ask');
    expect(v.headline).toContain('裁定待ち');
  });

  it('計算も追跡も無く AI も黙っていれば「静止中」', () => {
    const ss = [session('aaa', 7200, [])];
    const v = judge([], ss, flagsNone);
    expect(v.level).toBe('idle');
    expect(v.headline).toContain('静止中');
  });

  it('二重起動は、見守られていても警告へ落とす', () => {
    const cs = clusterProcs([
      ...jobProcs('sweep_lever.ts', '--x', 600, [1]),
      ...jobProcs('sweep_lever.ts', '--x', 300, [2]),
    ]);
    const ss = [
      session('aaa', 60, [track('bmon', 'monitor', 700)], [
        { atMs: agoMs(650), tool: 'Bash', command: 'npx tsx scripts/sweep_lever.ts --x' },
        { atMs: agoMs(310), tool: 'Bash', command: 'npx tsx scripts/sweep_lever.ts --x' },
      ]),
    ];
    attributeJobs(cs, ss);
    const v = judge(cs, ss, flagsNone);
    expect(v.level).toBe('warn');
    expect(v.headline).toContain('二重起動');
  });
});

// ───────────────── 会話ログの読み取り ─────────────────

const at = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const toolUse = (sec: number, id: string, name: string, input: unknown) => ({
  type: 'assistant',
  timestamp: at(sec),
  message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (sec: number, id: string, text: string) => ({
  type: 'user',
  timestamp: at(sec),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const notify = (sec: number, xml: string) => ({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: at(sec),
  content: xml,
});

const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

/** 試験用の会話ログを 1 本作り、その番人を返す。 */
function transcriptOf(lines: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'exoclim-monitor-'));
  writeFileSync(join(dir, `${SESSION_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return createTranscriptWatcher({ dir }).read().sessions[0]!;
}

describe('会話ログの読み取り — 追跡の開始と終了', () => {
  it('背景ジョブは開始で armed になる', () => {
    const s = transcriptOf([
      toolUse(300, 'tu1', 'Bash', { command: 'npx tsx scripts/optimize.ts', run_in_background: true, description: '較正' }),
      toolResult(299, 'tu1', `Command running in background with ID: bxxx. Output is being written to: /tmp/${SESSION_ID}/tasks/bxxx.output`),
    ]);
    expect(s.outstanding().map((t) => t.id)).toEqual(['bxxx']);
    expect(s.outstanding()[0]!.label).toBe('較正');
  });

  it('完了通知(status あり)で追跡が解ける', () => {
    const s = transcriptOf([
      toolUse(300, 'tu1', 'Bash', { command: 'x', run_in_background: true }),
      toolResult(299, 'tu1', `Command running in background with ID: bxxx. Output is being written to: /tmp/${SESSION_ID}/tasks/bxxx.output`),
      notify(10, '<task-notification> <task-id>bxxx</task-id> <status>completed</status> <summary>done</summary> </task-notification>'),
    ]);
    expect(s.outstanding()).toHaveLength(0);
  });

  it('見張りの発火(status 無し)では追跡は解けない — 撃っただけで生きている', () => {
    const s = transcriptOf([
      toolUse(300, 'tu1', 'Monitor', { command: 'while true; do :; sleep 1800; done', description: 'v33 の見張り' }),
      toolResult(299, 'tu1', 'Monitor started (task bmon, persistent — runs until TaskStop or session end).'),
      notify(60, '<task-notification> <task-id>bmon</task-id> <summary>Monitor event: "v33 の見張り"</summary> <event>v33: 518 評価</event> </task-notification>'),
    ]);
    const out = s.outstanding();
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('monitor');
    expect(out[0]!.eventCount).toBe(1);
  });

  it('回帰: ログを grep した出力に現れた文字列を追跡と誤読しない', () => {
    // 2026-08-24 に実際に踏んだ。他セッションのログを表示しただけで
    // 「追跡 4 件」になり、armed だと誤判定した。
    const s = transcriptOf([
      toolUse(300, 'tu1', 'Bash', { command: 'grep -o "Command running" other.jsonl', description: 'ログの調査' }),
      toolResult(
        299,
        'tu1',
        'Command running in background with ID: bfake. Output is being written to: /tmp/other/bfake.output\nMonitor started (task bfake2, persistent — runs until TaskStop or session end).',
      ),
    ]);
    expect(s.outstanding()).toHaveLength(0);
    expect(s.quotedArmings).toBeGreaterThan(0);
  });

  it('別セッションを指す出力先の札は自分の追跡にしない', () => {
    const s = transcriptOf([
      toolUse(300, 'tu1', 'Bash', { command: 'x', run_in_background: true }),
      toolResult(299, 'tu1', 'Command running in background with ID: bxxx. Output is being written to: /tmp/claude/repo/OTHER-SESSION/tasks/bxxx.output'),
    ]);
    expect(s.outstanding()).toHaveLength(0);
  });

  it('TaskStop で追跡が解ける', () => {
    const s = transcriptOf([
      toolUse(300, 'tu1', 'Monitor', { command: 'watch', description: '見張り' }),
      toolResult(299, 'tu1', 'Monitor started (task bmon, persistent — runs until TaskStop or session end).'),
      toolUse(100, 'tu2', 'TaskStop', { taskId: 'bmon' }),
    ]);
    expect(s.outstanding()).toHaveLength(0);
  });

  it('起動コマンドの原文を持ち主の照合用に残す', () => {
    const s = transcriptOf([
      toolUse(300, 'tu1', 'PowerShell', { command: "Start-Process cmd.exe -ArgumentList '/c npx tsx scripts/optimize.ts --run v33'" }),
      toolResult(299, 'tu1', 'ok'),
    ]);
    expect(s.launches.some((l) => l.command.includes('optimize.ts --run v33'))).toBe(true);
  });
});

describe('parseSpace — 探索空間の読み取り', () => {
  it('コメントアウトされたタプルを探索対象に数えない', () => {
    const src = readFileSync(new URL('../../../scripts/optimize_lib.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export const SPACE'), src.indexOf('\n];', src.indexOf('export const SPACE')));
    const tuple = /\[\s*'([A-Za-z0-9_]+)'\s*,\s*-?[\d.eE+-]+\s*,\s*-?[\d.eE+-]+\s*\]/;
    const lines = body.split('\n');
    const activeNames = lines.filter((l) => !l.trim().startsWith('//') && tuple.test(l)).map((l) => tuple.exec(l)![1]!);
    const commentedNames = lines.filter((l) => l.trim().startsWith('//') && tuple.test(l)).map((l) => tuple.exec(l)![1]!);

    const { space, disabled } = parseSpace();
    expect(Object.keys(space).sort()).toEqual([...activeNames].sort());
    expect(disabled.sort()).toEqual([...new Set(commentedNames)].filter((n) => !activeNames.includes(n)).sort());
    expect(Object.keys(space).length).toBeGreaterThan(10);
  });

  it('掃引対象と掃引から外した定数は重ならない', () => {
    const { space, disabled } = parseSpace();
    for (const n of disabled) expect(space[n]).toBeUndefined();
  });
});
