// P0-2(FB 2026-07-31): 自動較正の再開整合性。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadStateStrict,
  nextEvalNumber,
  readEvalLog,
  saveStateAtomic,
} from '../../../scripts/optimize_store';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const row = (i: number) => JSON.stringify({ i, tag: 't', fit: 1 });

describe('再開整合性(P0-2)', () => {
  it('state.evals=363・ログ最大 366 からの次番号は 367', () => {
    const p = path.join(dir, 'log.jsonl');
    fs.writeFileSync(p, [row(364), row(365), row(366)].join('\n') + '\n');
    const log = readEvalLog(p);
    expect(log.maxEval).toBe(366);
    expect(nextEvalNumber(363, log.maxEval)).toBe(367);
  });

  it('ログが無ければ state から採番', () => {
    expect(nextEvalNumber(10, 0)).toBe(11);
  });

  it('途中で切れた最終行は警告つきで無視', () => {
    const p = path.join(dir, 'log.jsonl');
    fs.writeFileSync(p, row(1) + '\n' + row(2) + '\n' + '{"i":3,"ta');
    const log = readEvalLog(p);
    expect(log.rows.length).toBe(2);
    expect(log.maxEval).toBe(2);
    expect(log.warnings.some((w) => w.includes('最終行'))).toBe(true);
  });

  it('中間行の破損は明示エラー', () => {
    const p = path.join(dir, 'log.jsonl');
    fs.writeFileSync(p, row(1) + '\n' + '{"broken' + '\n' + row(3) + '\n');
    expect(() => readEvalLog(p)).toThrow(/破損/);
  });

  it('評価番号の重複を検知して警告する', () => {
    const p = path.join(dir, 'log.jsonl');
    fs.writeFileSync(p, [row(364), row(365), row(364)].join('\n') + '\n');
    const log = readEvalLog(p);
    expect(log.duplicates).toContain(364);
    expect(log.warnings.some((w) => w.includes('重複'))).toBe(true);
  });

  it('状態の原子的保存: 一時ファイルの途中書き込みでは本体が壊れない', () => {
    const p = path.join(dir, 'state.json');
    saveStateAtomic(p, { evals: 10 });
    // 途中書き込みを模擬(一時ファイルにだけ不完全な内容が残る)
    fs.writeFileSync(path.join(dir, '.state.json.tmp'), '{"evals": 1');
    const s = loadStateStrict<{ evals: number }>(p);
    expect(s?.evals).toBe(10);
  });

  it('state 本体の破損は黙って初期化せず明示エラー', () => {
    const p = path.join(dir, 'state.json');
    fs.writeFileSync(p, '{"evals": 1');
    expect(() => loadStateStrict(p)).toThrow(/破損/);
  });
});
