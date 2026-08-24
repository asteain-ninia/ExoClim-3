// 会話ログの読み取り(scripts/monitor_transcript.mjs)の型。
// 本体は node で直に走らせる素の JS。

/** 追跡タスク 1 件(開始が記録され、終了通知が来ていないもの)。 */
export interface Track {
  id: string;
  /** background = 背景ジョブ / monitor = 見張り / workflow = 作業列 / agent = 下請け */
  kind: 'background' | 'monitor' | 'workflow' | 'agent' | 'wakeup' | 'cron';
  /** 日本語の説明(画面に出す)。 */
  what: string;
  /** 追跡が始まった時刻。**プロセスの誕生時刻とほぼ一致する。** */
  atMs: number | null;
  /** 起動時の説明(道具の description)。 */
  label: string;
  /** 起動時のコマンドの原文。 */
  command: string;
  /** 見張りが撃った回数。 */
  eventCount: number;
  /** 最後に撃った時刻。 */
  lastEventMs: number | null;
}

/** 起動された道具呼び出しの原文(切り離し起動の帰属に使う)。 */
export interface Launch {
  atMs: number | null;
  tool: string;
  command: string;
}

/** 1 セッション分の読み取り結果。 */
export interface SessionRead {
  id: string;
  short: string;
  slug: string | null;
  sizeMB?: number;
  mtimeMs?: number;
  /** 末尾しか読めていない = それより古い追跡は取りこぼしうる。 */
  truncated: boolean;
  /** 読めた範囲のいちばん古い時刻。 */
  firstTs: number | null;
  /** 文字列は現れたが、その道具の結果ではなかったので捨てた件数(ログの引用)。 */
  quotedArmings?: number;
  /** 構造化フィールド(toolUseResult)から拾った追跡の件数。 */
  structuredArmings?: number;
  lastTs: number | null;
  /** AI が自分で書いた最後の時刻(通知の到着は含めない)。 */
  lastAssistantAt: number | null;
  lastType: string | null;
  lastStopReason: string | null;
  lastAssistantText: string | null;
  lastUserTs: number | null;
  armed: Map<string, Omit<Track, 'id'>>;
  done: Map<string, { atMs: number | null; status: string; summary: string }>;
  launches: Launch[];
  bytesRead: number;
  outstanding(): Track[];
}

/**
 * プロジェクトの全セッションを増分で読む番人を作る。
 * **同じインスタンスを使い回すこと** — 読んだ位置を覚えているので、
 * 2 回目以降は増えた分しか読まない(実測 1〜2ms)。
 */
export function createTranscriptWatcher(opts?: {
  dir?: string;
  /** 何時間前まで遡ってセッションを拾うか。 */
  windowH?: number;
  /** 初回に読む末尾のバイト数(既定 4MB ≒ 忙しいセッションで 90 時間ぶん)。 */
  initialTailBytes?: number;
}): {
  read(): { dir: string; sessions: SessionRead[]; error?: string };
};
