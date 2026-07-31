// 自動較正の永続化・ログ整合(P0-2)。純粋な補助関数としてテスト可能に分離。
// 方針(FB 2026-07-31):
//  - 評価番号の正本はログ(有効な最終行の最大番号)。次番号は必ず最大値 + 1。
//  - 状態は一時ファイルへ書いてから置換(途中書き込みで壊れない)。
//  - 途中で切れた JSONL の最終行だけは警告つきで無視。中間行の破損はエラー。

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EvalLogRow {
  i: number;
  tag: string;
  fit: number;
  [k: string]: unknown;
}

export interface LogReadResult {
  rows: EvalLogRow[];
  maxEval: number;
  warnings: string[];
  duplicates: number[];
}

/** JSONL を読む。最終行のみ破損許容(追記中断)、中間行の破損は明示エラー */
export function readEvalLog(logPath: string): LogReadResult {
  if (!fs.existsSync(logPath)) return { rows: [], maxEval: 0, warnings: [], duplicates: [] };
  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const rows: EvalLogRow[] = [];
  const warnings: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    try {
      rows.push(JSON.parse(lines[k] ?? '') as EvalLogRow);
    } catch {
      if (k === lines.length - 1) {
        warnings.push(`最終行が不完全なため無視: ${logPath}`);
      } else {
        throw new Error(`ログ中間行(${k + 1} 行目)が破損: ${logPath}`);
      }
    }
  }
  const seen = new Set<number>();
  const duplicates: number[] = [];
  let maxEval = 0;
  for (const r of rows) {
    if (typeof r.i === 'number') {
      if (seen.has(r.i)) duplicates.push(r.i);
      seen.add(r.i);
      if (r.i > maxEval) maxEval = r.i;
    }
  }
  if (duplicates.length > 0) {
    warnings.push(`評価番号の重複を検知: ${[...new Set(duplicates)].slice(0, 10).join(', ')}`);
  }
  return { rows, maxEval, warnings, duplicates };
}

/** 次の評価番号(ログ最大値と state 記録の大きい方 + 1) */
export function nextEvalNumber(stateEvals: number, logMaxEval: number): number {
  return Math.max(stateEvals, logMaxEval) + 1;
}

/** 状態の原子的保存: 一時ファイルへ書き、置換 */
export function saveStateAtomic(statePath: string, state: unknown): void {
  const tmp = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, statePath);
}

/** 状態の読込。破損時は黙って初期化せず明示エラー */
export function loadStateStrict<T>(statePath: string): T | null {
  if (!fs.existsSync(statePath)) return null;
  const text = fs.readFileSync(statePath, 'utf8');
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`state が破損しています(${statePath})。手動確認が必要: ${String(e)}`);
  }
}
