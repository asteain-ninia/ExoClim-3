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

/**
 * 状態の保存: 一時ファイルへ書き、rename で置換。
 *
 * 保証範囲(変更レビュー FB P2-4 で明確化): これは**プロセス中断に対する
 * 原子的置換**である — 書込み途中でプロセスが死んでも既存本体は壊れない。
 * fsync は行わないため、**電源断・OS クラッシュ直後の永続化は保証しない**
 * (最悪、直近バッチの state 更新が失われるが、評価番号の正本はログ側
 * [readEvalLog] にあり、再開時に nextEvalNumber が整合させる)。
 * 一時ファイルが残った場合は無視され、次回保存で上書きされる
 * (loadStateStrict は本体のみ読む)。
 */
export function saveStateAtomic(statePath: string, state: unknown): void {
  const tmp = path.join(path.dirname(statePath), `.${path.basename(statePath)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, statePath);
}

/**
 * 保留較正の最良定数を読む(validate --holdout-fold の未見評価用)。
 * state が無い・best が空なら明示エラー(未較正の fold を未見評価と
 * 誤表示しないため)
 */
export function loadFoldBest(statePath: string): Record<string, number> {
  const state = loadStateStrict<{ best?: Record<string, number>; bestFit?: number }>(statePath);
  if (!state || !state.best || Object.keys(state.best).length === 0) {
    throw new Error(
      `保留較正の状態が読めない(${statePath})。先に npx tsx scripts/optimize.ts --holdout-fold N で較正すること`,
    );
  }
  return state.best;
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
