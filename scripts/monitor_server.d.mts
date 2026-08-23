// 自走モニタ(scripts/monitor_server.mjs)の型。
// 本体は node で直に走らせる素の JS。ここには**テストが触る純関数だけ**を書く。
// 収集系(プロセス一覧・ファイル走査・HTTP)は副作用があるので公開しない。

/** Win32_Process から拾った 1 プロセス(PowerShell が返す生の形)。 */
export interface RawProc {
  pid: number;
  ppid: number;
  name: string;
  /** ISO 8601(UTC)。取れなければ null。 */
  started: string | null;
  cpuSec: number;
  memMB: number;
  cmd: string;
}

/** 種別とスクリプト名をほどいた 1 プロセス。 */
export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  kind: string;
  /** 計算ジョブとして数えるか(ラッパ・シェル・モニタ自身は false)。 */
  isJob: boolean;
  isSelf: boolean;
  script: string | null;
  args: string;
  cmd: string;
  startedMs: number | null;
  elapsedSec: number | null;
  cpuSec: number;
  memMB: number;
}

/** ラッパの多段を 1 件に畳んだ「ジョブ」。 */
export interface Cluster {
  /** クラスタ固有。親子の指し先はこれ(key は二重起動で重複する)。 */
  id: string;
  /** 同じコマンドかの照合用。二重起動では重複する。 */
  key: string;
  kind: string;
  script: string | null;
  args: string;
  startedMs: number | null;
  elapsedSec: number | null;
  pids: number[];
  ppids: number[];
  cpuSec: number;
  memMB: number;
  /** 親ジョブの id。ワーカーのときだけ入る。 */
  parent: string | null;
  workerCount: number;
  /** 同じコマンドが別時刻にも走っているか。 */
  duplicate: boolean;
  /** ハーネスの追跡タスクに対応づいたか(判定後に入る)。 */
  tracked?: boolean | null;
  trackedBy?: string | null;
  trackedTask?: string | null;
  trackedHow?: string | null;
}

/** ハーネスの背景ジョブ台帳の札 1 枚。 */
export interface TaskMark {
  id: string;
  /** 札が生まれた時刻 = ジョブが投げられた時刻。 */
  birthMs: number;
  /** 最後に書かれた時刻 = 出力が届いた時刻。 */
  mtimeMs: number;
  size: number;
}

/** AI のセッション 1 本。 */
export interface Session {
  id: string;
  short: string;
  lastAt: number;
  lastAgeSec: number | null;
  lastType?: string | null;
  stopReason?: string | null;
  recentTasks?: TaskMark[];
  taskNewestMs?: number | null;
  taskNewestAgeSec?: number | null;
  /** 判定後に入る。「完了通知に未反応」など。 */
  flag?: string | null;
}

/** .claude/ に置かれた札の状態。 */
export interface Flags {
  halt: boolean;
  pending: { text: string; ageSec: number | null } | null;
  guardCount: number;
}

export interface Verdict {
  level: 'ok' | 'warn' | 'danger' | 'ask' | 'halt' | 'idle';
  headline: string;
  reasons: string[];
}

export function classifyProc(p: RawProc, now?: number): Proc;
export function clusterProcs(procs: Proc[]): Cluster[];
/** 副作用あり: clusters と sessions に判定結果(tracked / flag)を書き込む。 */
export function judge(clusters: Cluster[], sessions: Session[], flags: Flags): Verdict;
export function parseSpace(): Record<string, { lo: number; hi: number }>;
export function analyzeParams(
  params: Record<string, unknown> | null,
  sensitivity: Record<string, number> | null,
): {
  count: number;
  spaceCount: number;
  atBound: { name: string; value: number; side: 'lo' | 'hi'; lo: number | null; hi: number | null }[];
  outsideSpace: number;
  missing: string[];
  rows: {
    name: string;
    value: number;
    lo: number | null;
    hi: number | null;
    inSpace: boolean;
    frac: number | null;
    atBound: 'lo' | 'hi' | null;
    sens: number | null;
  }[];
} | null;
