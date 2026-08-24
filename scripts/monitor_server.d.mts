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
  /** どのセッションが起動したか(コマンドの原文で照合。判定後に入る)。 */
  owner?: string | null;
  ownerId?: string | null;
  ownerLaunchMs?: number | null;
  ownerTool?: string | null;
  /**
   * 見守られているか。
   *   ok      = 持ち主に生きている追跡がある(完了・進捗で AI が起こされる)
   *   orphan  = 誰も起こされない(投げっぱなし)
   *   unknown = 持ち主を特定できない。armed なセッションは居るので断じない
   */
  watch?: 'ok' | 'orphan' | 'unknown' | null;
  watchBy?: string | null;
  watchTask?: string | null;
  watchWhy?: string | null;
}

/**
 * 生きている追跡 1 件。
 * **札(.output)の時刻ではなく、会話ログの記録から作る。**
 * 札は「最初の出力が出た時刻」に生まれるので起動の証拠にならない
 * (2026-08-24 の誤検知の原因)。
 */
export interface Track {
  id: string;
  kind: 'background' | 'monitor' | 'workflow' | 'agent';
  what: string;
  atMs: number | null;
  ageSec: number | null;
  label: string;
  command: string;
  eventCount: number;
  lastEventAgeSec: number | null;
  /** 対応する OS プロセスが居るか。null = 判定できない種類。 */
  alive: boolean | null;
  /** 見張りの点検間隔(コマンドの sleep から読む)。 */
  pollSec?: number | null;
  /** 次に見張りが気づくまでの秒数。 */
  nextCheckSec?: number | null;
  markSize?: number | null;
  markAgeSec?: number | null;
}

/** AI のセッション 1 本。 */
export interface Session {
  id: string;
  short: string;
  lastAt: number;
  lastAgeSec: number | null;
  lastType?: string | null;
  stopReason?: string | null;
  /** 終了通知の来ていない追跡。これがある間、セッションは呼び戻される。 */
  outstanding: Track[];
  armedCount?: number;
  doneCount?: number;
  taskCount?: number;
  taskNewestMs?: number | null;
  taskNewestAgeSec?: number | null;
  /** 会話ログを末尾しか読めていない。 */
  truncated?: boolean;
  /** 判定後に入る。「完了通知に未反応」など。 */
  flag?: string | null;
  /** 判定後に入る。生きている追跡・死んだ追跡・armed か。 */
  liveTracks?: Track[];
  deadTracks?: Track[];
  armed?: boolean;
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
/**
 * 走っている計算を、起動コマンドの原文で持ち主のセッションへ結びつける。
 * 副作用あり: clusters に owner* を書き込む。
 */
export function attributeJobs(clusters: Cluster[], sessions: Session[]): void;
/**
 * 副作用あり: clusters に watch*、sessions に flag / liveTracks / armed を書き込む。
 * results = 成果物が出た時刻(「結果は出ているのに AI が知らない」の判定に使う)。
 */
export function judge(
  clusters: Cluster[],
  sessions: Session[],
  flags: Flags,
  results?: { what: string; atMs: number | null }[],
): Verdict;
export function parseSpace(): {
  /** いま掃引されている定数の範囲。 */
  space: Record<string, { lo: number; hi: number }>;
  /** SPACE の中でコメントアウトされている = 掃引から外した定数。 */
  disabled: string[];
};
export function analyzeParams(
  params: Record<string, unknown> | null,
  sensitivity: Record<string, number> | null,
): {
  count: number;
  spaceCount: number;
  atBound: { name: string; value: number; side: 'lo' | 'hi'; lo: number | null; hi: number | null }[];
  outsideSpace: number;
  missing: string[];
  disabled: string[];
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
