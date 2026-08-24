// 会話ログから「ハーネスが何を追跡しているか」を取り出す。
//
// なぜこれが要るか(2026-08-24 の誤検知):
//   最初の実装は「タスクの札(.output)の誕生時刻 ≒ ジョブの起動時刻」と仮定した。
//   **これは誤り。** 札は「最初の出力が出た時刻」に作られる。30 分なにも
//   出力しない見張りでは 30 分ずれ、正しく運用しているスレを「投げっぱなし」
//   と誤報した(実害)。時刻の近さで推測してはいけない。
//
//   本当の根拠はハーネス自身の記録の中にある。会話ログには
//     ・何を追跡し始めたか(tool_result の文言)
//     ・何が終わったか(task-notification の <status>)
//   がそのまま書かれている。ここを読む。
//
// 語彙(2026-08-24 に実データで確認):
//   arming
//     "Command running in background with ID: <id>. Output is being written to: <path>"
//     "Monitor started (task <id>, persistent — runs until TaskStop or session end)"
//   通知(queue-operation.content と user メッセージの両方に同じものが載る)
//     <task-notification><task-id>X</task-id> ... <status>completed|failed</status>
//       → そのタスクは終わった(= 追跡が 1 つ解ける)
//     <task-notification><task-id>X</task-id><summary>Monitor event: "…"</summary><event>…</event>
//       → **status が無い。見張りは撃っただけで、まだ生きている。**
//         見張りは TaskStop かセッション終了まで armed のまま。
//
// **AI の発話(assistant の text)には同じ文言が引用として現れる**ので、
// tool_result の中だけを読む。地の文を拾うと、語った瞬間に「追跡あり」に
// なってしまう。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 追跡が始まる形。**行頭に錨を打つ**(^)。
 *
 * 錨が要る理由: これらの文言は、ログを grep した**コマンドの出力**として
 * tool_result の中に平気で現れる。実際、この道具を作っている最中に自分の
 * grep 出力を読んで「追跡 4 件」と誤検知した。文字列が現れたかではなく、
 * **ハーネスがその結果を返したか**を見なければならない。
 * だから錨に加えて、呼び出した道具の種類(requires)まで照合する。
 */
const ARMINGS = [
  {
    kind: 'background',
    re: /^Command running in background with ID:\s*([A-Za-z0-9_-]+)/,
    requires: (tu) => tu && tu.background === true,
    what: '背景ジョブ',
  },
  {
    kind: 'monitor',
    re: /^Monitor started \(task\s+([A-Za-z0-9_-]+)/,
    requires: (tu) => tu && tu.name === 'Monitor',
    what: '見張り(発火のたびに起こされる)',
  },
  {
    kind: 'workflow',
    re: /^Workflow launched in background\.\s*Task ID:\s*([A-Za-z0-9_-]+)/,
    requires: (tu) => tu && tu.name === 'Workflow',
    what: '作業列',
  },
  {
    kind: 'agent',
    re: /^Async agent launched successfully[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/,
    requires: (tu) => tu && tu.name === 'Agent',
    what: '下請けの作業者',
  },
];

const RE = {
  taskId: /<task-id>([A-Za-z0-9_-]+)<\/task-id>/,
  status: /<status>(\w+)<\/status>/,
  monitorEvent: /<summary>Monitor event:\s*"([^"]*)"/,
  summary: /<summary>([\s\S]*?)<\/summary>/,
  outputPath: /Output is being written to:\s*(\S+)/,
};

/** tool_result のテキストだけを取り出す(AI の地の文は返さない)。 */
function toolResultTexts(o) {
  const out = [];
  if (o.type !== 'user' || !o.message || !Array.isArray(o.message.content)) return out;
  for (const b of o.message.content) {
    if (!b || b.type !== 'tool_result') continue;
    const c = b.content;
    if (typeof c === 'string') out.push({ id: b.tool_use_id, text: c });
    else if (Array.isArray(c))
      for (const x of c) if (x && x.type === 'text') out.push({ id: b.tool_use_id, text: x.text });
  }
  return out;
}

/** その行に載っている task-notification の本文(あれば)。 */
function notificationText(o) {
  if (o.type === 'queue-operation') {
    const c = String(o.content ?? '');
    return c.includes('<task-notification>') ? c : null;
  }
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    if (typeof c === 'string') return c.includes('<task-notification>') ? c : null;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'text' && String(b.text).includes('<task-notification>')) return b.text;
      }
    }
  }
  return null;
}

/** 起動したコマンドの原文(帰属の照合に使う)。 */
function commandOf(input) {
  if (!input || typeof input !== 'object') return '';
  return String(input.command ?? input.prompt ?? input.script ?? '').slice(0, 2000);
}

/**
 * 1 セッション分の追跡状態。増分で更新する。
 * 会話ログは 62MB に達するので、初回だけ末尾を読み、以後は増えた分だけ読む。
 */
class SessionReader {
  constructor(file, id, opts) {
    this.file = file;
    this.id = id;
    this.short = id.slice(0, 8);
    this.initialTailBytes = opts.initialTailBytes ?? 4 * 1024 * 1024;
    this.maxLaunches = opts.maxLaunches ?? 300;
    this.offset = null; // null = 未読
    this.armed = new Map(); // taskId -> { kind, atMs, label, command }
    this.done = new Map(); // taskId -> { atMs, status, summary }
    this.events = new Map(); // taskId -> { atMs, label, text }  見張りが最後に撃った内容
    this.launches = []; // { atMs, tool, command }  切り離し起動の帰属に使う
    this.toolUses = new Map(); // tool_use_id -> { atMs, name, command, description }
    this.lastTs = null;
    /**
     * **AI が最後に何かを書いた時刻。** lastTs とは違う —
     * lastTs には完了通知(queue-operation)も含まれるので、
     * 「通知は来たが AI は動いていない」を見分けるにはこちらが要る。
     */
    this.lastAssistantAt = null;
    this.lastAssistantText = null;
    this.lastStopReason = null;
    this.lastType = null;
    this.lastUserTs = null;
    this.slug = null;
    this.truncated = false; // 末尾しか読めていない = 取りこぼしの可能性
    this.bytesRead = 0;
  }

  update() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return;
    }
    let start;
    if (this.offset == null) {
      start = Math.max(0, st.size - this.initialTailBytes);
      this.truncated = start > 0;
    } else {
      if (st.size <= this.offset) return; // 増えていない
      start = this.offset;
    }
    let text;
    try {
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      this.bytesRead += buf.length;
      text = buf.toString('utf8');
    } catch {
      return;
    }
    // 先頭が行の途中なら落とす(初回の切り出しのみ)
    if (this.offset == null && start > 0) {
      const i = text.indexOf('\n');
      if (i >= 0) text = text.slice(i + 1);
    }
    // 末尾が書きかけの行なら次回へ回す
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) return;
    const usable = text.slice(0, lastNl + 1);
    this.offset = st.size - Buffer.byteLength(text.slice(lastNl + 1), 'utf8');

    for (const line of usable.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      this.#ingest(o);
    }
    this.sizeMB = Math.round((st.size / 1048576) * 10) / 10;
    this.mtimeMs = st.mtimeMs;
  }

  #ingest(o) {
    const ts = o.timestamp ? Date.parse(o.timestamp) : null;
    if (ts && (!this.lastTs || ts > this.lastTs)) {
      this.lastTs = ts;
      this.lastType = o.type;
    }
    if (o.slug) this.slug = o.slug;

    // 1. AI の道具呼び出し(帰属と、追跡タスクの中身の説明に使う)
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      if (ts) {
        this.lastAssistantAt = ts;
        this.lastStopReason = o.message.stop_reason ?? this.lastStopReason;
      }
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === 'text' && b.text && b.text.trim()) this.lastAssistantText = b.text.trim().slice(0, 800);
        if (b.type === 'tool_use') {
          const cmd = commandOf(b.input);
          const inp = b.input && typeof b.input === 'object' ? b.input : {};
          this.toolUses.set(b.id, {
            atMs: ts,
            name: b.name,
            command: cmd,
            background: inp.run_in_background === true,
            description: String(inp.description ?? ''),
          });
          if (this.toolUses.size > 4000) {
            // 際限なく貯めない(古いものから捨てる)
            const first = this.toolUses.keys().next().value;
            this.toolUses.delete(first);
          }
          if (cmd) {
            this.launches.push({ atMs: ts, tool: b.name, command: cmd });
            if (this.launches.length > this.maxLaunches) this.launches.shift();
          }
          // TaskStop は追跡を解く
          if (b.name === 'TaskStop' && b.input) {
            const tid = String(b.input.taskId ?? b.input.task_id ?? b.input.id ?? '');
            if (tid && this.armed.has(tid)) {
              this.done.set(tid, { atMs: ts, status: 'stopped', summary: 'TaskStop で停止' });
              this.armed.delete(tid);
            }
          }
        }
      }
    }

    // 2. 追跡の開始(tool_result の中だけ・行頭に錨・道具の種類も照合)
    for (const r of toolResultTexts(o)) {
      const head = String(r.text).trimStart();
      const tu = r.id ? this.toolUses.get(r.id) : null;
      for (const a of ARMINGS) {
        const m = a.re.exec(head);
        if (!m) continue;
        if (!a.requires(tu)) {
          // 文字列はあるが、その道具の結果ではない = ログの引用や grep の出力。
          this.quotedArmings = (this.quotedArmings ?? 0) + 1;
          continue;
        }
        // 出力先の道が別セッションを指しているなら、それは他人の札の引用。
        const op = RE.outputPath.exec(head);
        if (op && !op[1].includes(this.id)) {
          this.quotedArmings = (this.quotedArmings ?? 0) + 1;
          continue;
        }
        this.#arm(m[1], a.kind, ts, tu, a.what);
        break;
      }
    }

    // 3. 通知(終了 or 見張りの発火)
    const note = notificationText(o);
    if (note) {
      const idm = RE.taskId.exec(note);
      if (idm) {
        const tid = idm[1];
        const stm = RE.status.exec(note);
        const evm = RE.monitorEvent.exec(note);
        if (stm) {
          // status がある = そのタスクは終わった
          const sum = RE.summary.exec(note);
          this.done.set(tid, {
            atMs: ts,
            status: stm[1],
            summary: sum ? sum[1].trim().slice(0, 200) : '',
          });
          this.armed.delete(tid);
        } else if (evm) {
          // Monitor の発火。**status が無いので追跡は解けない**(撃っただけ)。
          const ev = /<event>([\s\S]*?)<\/event>/.exec(note);
          this.events.set(tid, {
            atMs: ts,
            label: evm[1],
            text: ev ? ev[1].trim().slice(0, 300) : '',
          });
          const a = this.armed.get(tid);
          if (a) {
            a.lastEventMs = ts;
            a.label = a.label || evm[1];
            a.eventCount = (a.eventCount ?? 0) + 1;
          }
        }
      }
    }

    // 4. 利用者の発話(参考)
    if (o.type === 'user' && ts && o.userType !== 'external' && !note) {
      const c = o.message && o.message.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      if (!isToolResult) this.lastUserTs = ts;
    }
  }

  #arm(taskId, kind, atMs, tu, what) {
    if (this.done.has(taskId)) return; // すでに終わったものを蘇らせない
    this.armed.set(taskId, {
      kind,
      what,
      atMs,
      label: tu ? tu.description : '',
      command: tu ? tu.command : '',
      eventCount: 0,
      lastEventMs: null,
    });
  }

  /** いま追跡が生きているタスク。 */
  outstanding() {
    return [...this.armed.entries()].map(([id, a]) => ({ id, ...a }));
  }
}

/**
 * プロジェクトの全セッションを増分で読む。
 * 同じインスタンスを使い回すこと(offset を覚えているので 2 回目以降は安い)。
 */
export function createTranscriptWatcher({ dir, windowH = 48, initialTailBytes = 4 * 1024 * 1024 } = {}) {
  const readers = new Map();
  return {
    /** @returns {ReturnType<typeof snapshot>} */
    read() {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return { dir, sessions: [], error: 'ログの置き場が見つからない' };
      }
      const cutoff = Date.now() - windowH * 3600e3;
      const sessions = [];
      for (const f of files) {
        const p = path.join(dir, f);
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) {
          readers.delete(f); // 窓から外れたら状態も捨てる
          continue;
        }
        const id = f.replace(/\.jsonl$/, '');
        let r = readers.get(f);
        if (!r) {
          r = new SessionReader(p, id, { initialTailBytes });
          readers.set(f, r);
        }
        r.update();
        sessions.push(r);
      }
      sessions.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
      return { dir, sessions };
    },
  };
}

export const _internal = { RE, toolResultTexts, notificationText, SessionReader };
