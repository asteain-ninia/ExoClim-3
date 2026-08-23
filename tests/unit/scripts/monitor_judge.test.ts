// 自走モニタの判定ロジック(docs/道具_自走モニタ_2026-08-24.md)。
//
// この道具の値打ちは「AI が計算の完了で起こされる状態か」を**口先ではなく
// 機械で**判定するところにある。判定が静かに壊れると、寝落ちを見逃す側へ
// 倒れる(誤って「追跡あり」と言う)。そこを固定する。

import { describe, expect, it } from 'vitest';
import { classifyProc, clusterProcs, judge } from '../../../scripts/monitor_server.mjs';

const NOW = Date.UTC(2026, 7, 24, 0, 0, 0); // 判定は現在時刻を見ないので固定してよい
const agoMs = (sec: number) => NOW - sec * 1000;
const iso = (sec: number) => new Date(agoMs(sec)).toISOString();

/** 追跡タスクの札。birth = 生まれた時刻、mtime = 最後に書かれた時刻。 */
const task = (id: string, birthSec: number, mtimeSec: number) => ({
  id,
  birthMs: agoMs(birthSec),
  mtimeMs: agoMs(mtimeSec),
  size: 0,
});

const session = (
  short: string,
  lastAgeSec: number,
  tasks: ReturnType<typeof task>[],
  stopReason = 'end_turn',
) => ({
  id: short + '-full-id',
  short,
  lastAt: agoMs(lastAgeSec),
  lastAgeSec,
  lastType: 'assistant',
  stopReason,
  recentTasks: tasks,
  taskNewestMs: tasks.length ? Math.max(...tasks.map((t) => t.mtimeMs)) : null,
  taskNewestAgeSec: tasks.length ? Math.round((NOW - Math.max(...tasks.map((t) => t.mtimeMs))) / 1000) : null,
  flag: null as string | null,
});

const flagsNone = { halt: false, pending: null, guardCount: 0 };

/** tsx 経由の 1 ジョブは node が 3 本立つ。それを 1 件に畳んだものを作る。 */
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
    // 実際に踏んだ形: コミットメッセージに optimize_lib.ts の語が入っていた
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
    // bash はそもそも計算プロセスに数えない
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
    const procs = [
      ...jobProcs('diag_dead_constants.ts', '0 999 --write', 2800, [1, 2, 3]),
      ...jobProcs('diag_dead_constants.ts', '0 999 --write', 1300, [4, 5, 6]),
    ];
    const cs = clusterProcs(procs);
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.duplicate)).toBe(true);
    expect(cs[0]!.pids).toHaveLength(3);
  });

  it('起動が数秒差のラッパは 1 ジョブに畳まれる', () => {
    const procs = [
      ...jobProcs('validate.ts', '', 100, [1]),
      ...jobProcs('validate.ts', '', 99, [2]),
      ...jobProcs('validate.ts', '', 98, [3]),
    ];
    const cs = clusterProcs(procs);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.duplicate).toBe(false);
  });
});

describe('judge — AI が起こされるかの判定', () => {
  it('札の誕生がジョブ起動と一致すれば「追跡あり」', () => {
    const cs = clusterProcs(jobProcs('optimize.ts', '--run v34', 600, [1, 2]));
    const ss = [session('aaa', 30, [task('t1', 605, 5)])];
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.tracked).toBe(true);
    expect(cs[0]!.trackedHow).toBe('起動が一致');
    expect(v.level).toBe('ok');
  });

  it('札が無ければ「投げっぱなし」— 前景実行の孤児化', () => {
    const cs = clusterProcs(jobProcs('diag_dead_constants.ts', '0 999', 1300, [1, 2]));
    // 札はあるが、ジョブよりずっと後に生まれたもの(別件)
    const ss = [session('aaa', 30, [task('t1', 60, 5)])];
    const v = judge(cs, ss, flagsNone);
    expect(cs[0]!.tracked).toBe(false);
    expect(v.level).toBe('danger');
    expect(v.headline).toContain('投げっぱなし');
  });

  it('二重起動のとき、1 枚の札を 2 件の証拠に使い回さない', () => {
    const cs = clusterProcs([
      ...jobProcs('diag_dead_constants.ts', '0 999', 2800, [1, 2]),
      ...jobProcs('diag_dead_constants.ts', '0 999', 1300, [3, 4]),
    ]);
    // 札は 1 枚だけ(1 本目の起動時に生まれ、いまも書かれている)
    const ss = [session('aaa', 30, [task('t1', 2805, 5)])];
    const v = judge(cs, ss, flagsNone);
    const tracked = cs.filter((c) => c.tracked);
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.startedMs).toBe(agoMs(2800));
    expect(v.level).toBe('danger');
  });

  it('計算が終わっているのに AI が反応していない状態を捕まえる', () => {
    // 走っているジョブは無い。札は AI の最終発話より後に書かれている。
    const ss = [session('aaa', 1800, [task('t1', 3600, 900)])];
    const v = judge([], ss, flagsNone);
    expect(ss[0]!.flag).toBe('完了通知に未反応');
    expect(v.level).toBe('danger');
    expect(v.headline).toContain('反応していない');
  });

  it('AI が直前まで書いているなら、札が新しくても未反応とは言わない', () => {
    const ss = [session('aaa', 10, [task('t1', 3600, 5)], 'tool_use')];
    const v = judge([], ss, flagsNone);
    expect(ss[0]!.flag).toBeNull();
    expect(v.level).toBe('ok');
  });

  it('裁定待ちの札があれば、それが最優先で「正当な停止」', () => {
    const ss = [session('aaa', 3600, [task('t1', 3600, 100)])];
    const v = judge([], ss, { halt: false, pending: { text: '問い', ageSec: 60 }, guardCount: 3 });
    expect(v.level).toBe('ask');
    expect(v.headline).toContain('裁定待ち');
  });

  it('走っている計算も AI の動きも無ければ「静止中」', () => {
    const ss = [session('aaa', 7200, [task('t1', 9000, 8000)])];
    const v = judge([], ss, flagsNone);
    expect(v.level).toBe('idle');
    expect(v.headline).toContain('静止中');
  });

  it('二重起動は、追跡できていても警告へ落とす', () => {
    const cs = clusterProcs([
      ...jobProcs('sweep_lever.ts', '--x', 600, [1]),
      ...jobProcs('sweep_lever.ts', '--x', 300, [2]),
    ]);
    const ss = [session('aaa', 30, [task('t1', 605, 5), task('t2', 305, 5)])];
    const v = judge(cs, ss, flagsNone);
    expect(cs.every((c) => c.tracked)).toBe(true);
    expect(v.level).toBe('warn');
    expect(v.headline).toContain('二重起動');
  });
});
