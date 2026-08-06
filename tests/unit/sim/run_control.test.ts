// 実行制御(キャンセル・進捗・収束予算・段キャッシュ)の性質。
//
// ここで守りたいのは 1 点に尽きる:
// **進捗とキャンセルの配線は物理結果を変えない**。
// 進捗は書込のみの受け皿(降水診断 PrecipDiagBox と同じ扱い)であり、
// 渡しても渡さなくても結果はビット一致しなければならない。

import { describe, expect, it } from 'vitest';
import { runPipeline } from '@/sim/pipeline';
import { EARTH_PARAMS } from '@/domain/planetParams';
import {
  ComputeCancelledError,
  isCancelled,
  yieldToEventLoop,
  throwIfCancelled,
  type RunProgress,
} from '@/sim/run_control';
import { PipelineCache } from '@/worker/pipelineCache';

/** 2° の全海惑星。性質を見るだけなので一番安い設定にする */
const CHEAP = {
  ...EARTH_PARAMS,
  gridResolutionDeg: 2,
  terrain: { kind: 'preset', preset: 'aquaplanet' } as const,
};

function fieldsOf(r: Awaited<ReturnType<typeof runPipeline>>): number[] {
  const out: number[] = [];
  for (const a of r.temperature.monthlyTemperatureC) out.push(...a);
  for (const a of r.precipitation.monthlyPrecipMm) out.push(...a);
  out.push(...r.temperature.annualMeanC, ...r.precipitation.annualPrecipMm);
  out.push(...r.koppen.classId);
  return out;
}

describe('実行制御が物理結果を変えないこと', () => {
  it('進捗の受け皿を渡しても結果がビット一致する', async () => {
    const bare = await runPipeline(CHEAP);
    const events: RunProgress[] = [];
    const watched = await runPipeline(CHEAP, { onProgress: (p) => events.push(p) });

    const a = fieldsOf(bare);
    const b = fieldsOf(watched);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      // Object.is 語義の厳密比較(教訓 §3 の決定性規約)
      expect(Object.is(b[i], a[i])).toBe(true);
    }
    // 受け皿が実際に呼ばれていること(空振りのテストにしない)
    expect(events.length).toBeGreaterThan(0);
  }, 300_000);

  it('中断していない signal を渡しても結果がビット一致する', async () => {
    const bare = await runPipeline(CHEAP);
    const withSignal = await runPipeline(CHEAP, { signal: { cancelled: false } });
    const a = fieldsOf(bare);
    const b = fieldsOf(withSignal);
    for (let i = 0; i < a.length; i++) expect(Object.is(b[i], a[i])).toBe(true);
  }, 300_000);
});

describe('進捗の中身', () => {
  it('全体進捗は 0〜1 に収まり、段のラベルが付く', async () => {
    const events: RunProgress[] = [];
    await runPipeline(CHEAP, { onProgress: (p) => events.push(p) });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.overall).toBeGreaterThanOrEqual(0);
      expect(e.overall).toBeLessThanOrEqual(1);
      expect(typeof e.detail).toBe('string');
    }
    // 費用の 98% は気温なので、気温の段の通知が必ず含まれる
    expect(events.some((e) => e.stage === 'temperature')).toBe(true);
    // 最後は必ず最終段まで到達している
    expect(events[events.length - 1]?.overall).toBeGreaterThan(0.5);
  }, 300_000);
});

describe('キャンセル', () => {
  it('最初から中断済みなら計算に入る前に ComputeCancelledError で抜ける', async () => {
    await expect(runPipeline(CHEAP, { signal: { cancelled: true } })).rejects.toBeInstanceOf(
      ComputeCancelledError,
    );
  });

  it('途中で立てた中断が効き、結果は返らない', async () => {
    const token = { cancelled: false };
    // 気温の段に入ったら中断を立てる
    const p = runPipeline(CHEAP, {
      signal: token,
      onProgress: (ev) => {
        if (ev.stage === 'temperature') token.cancelled = true;
      },
    });
    await expect(p).rejects.toSatisfy(isCancelled);
  }, 300_000);

  it('throwIfCancelled は signal が無ければ何もしない', () => {
    expect(() => throwIfCancelled(undefined)).not.toThrow();
    expect(() => throwIfCancelled({ cancelled: false })).not.toThrow();
    expect(() => throwIfCancelled({ cancelled: true }, 'EBM')).toThrow(ComputeCancelledError);
  });

  it('yieldToEventLoop は保留中のメッセージ配送を挟む(中断要求を受け取れる)', async () => {
    // これが中断の成立条件そのもの: Worker の onmessage は JS が走っている
    // あいだ発火しないので、計算ループが yield して初めて「キャンセル」が届く。
    // setTimeout ではなく MessageChannel で測るのは、Node と ブラウザで
    // タイマーとメッセージの実行フェーズが違い、タイマーでは Node で成立
    // しないため(実測 2026-08-02)。届いてほしいのはメッセージのほう。
    const ch = new MessageChannel();
    let delivered = false;
    ch.port1.onmessage = (): void => {
      delivered = true;
    };
    ch.port2.postMessage(0);

    // マイクロタスクだけを消化しても配送されない
    await Promise.resolve();
    expect(delivered).toBe(false);

    await yieldToEventLoop();
    expect(delivered).toBe(true);

    ch.port1.close();
    ch.port2.close();
  });
});

describe('途中結果(表示用の部分結果)', () => {
  it('段が終わるたびに、その段の出力が届く', async () => {
    const seen = new Set<string>();
    await runPipeline(CHEAP, {
      onProgress: (p) => {
        for (const k of Object.keys(p.partial ?? {})) seen.add(k);
      },
    });
    // 表示に要る場が一通り、段の完了時に流れてくること
    for (const key of [
      'context',
      'itcz',
      'windBelt',
      'ocean',
      'airflow',
      'temperature',
      'precipitation',
      'koppen',
    ]) {
      expect(seen.has(key)).toBe(true);
    }
  }, 300_000);

  it('context が最初に届く(格子が無いと何も描けない)', async () => {
    const order: string[] = [];
    await runPipeline(CHEAP, {
      onProgress: (p) => {
        for (const k of Object.keys(p.partial ?? {})) order.push(k);
      },
    });
    expect(order[0]).toBe('context');
  }, 300_000);

  it('途中の降水は結合反復の途中でも届き、負にならない', async () => {
    const precipSnapshots: number[] = [];
    await runPipeline(CHEAP, {
      onProgress: (p) => {
        const precip = p.partial?.precipitation;
        if (!precip) return;
        precipSnapshots.push(precip.coupling.iterations);
        for (const v of precip.annualPrecipMm) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      },
    });
    // 反復ごとに 1 回以上は流れてくる(最後の段完了ぶんを含む)
    expect(precipSnapshots.length).toBeGreaterThan(1);
  }, 300_000);

  it('途中の気温は 12 か月そろってから届く(穴のある季節サイクルを出さない)', async () => {
    const monthCounts: number[] = [];
    await runPipeline(CHEAP, {
      onProgress: (p) => {
        const t = p.partial?.temperature;
        if (!t) return;
        monthCounts.push(t.monthlyTemperatureC.length);
        for (const v of t.annualMeanC) expect(Number.isFinite(v)).toBe(true);
      },
    });
    expect(monthCounts.length).toBeGreaterThan(0);
    for (const n of monthCounts) expect(n).toBe(12);
  }, 300_000);
});

describe('段キャッシュ', () => {
  it('依存が同じなら再計算せず、同じ参照を返す', async () => {
    const cache = new PipelineCache();
    let calls = 0;
    const dep = { v: 1 };
    const a = await cache.getOrCompute('s', [dep], () => {
      calls++;
      return { out: calls };
    });
    const b = await cache.getOrCompute('s', [dep], () => {
      calls++;
      return { out: calls };
    });
    expect(calls).toBe(1);
    expect(b).toBe(a);
  });

  it('依存の参照が変われば再計算する', async () => {
    const cache = new PipelineCache();
    let calls = 0;
    await cache.getOrCompute('s', [{ v: 1 }], () => ++calls);
    await cache.getOrCompute('s', [{ v: 1 }], () => ++calls);
    expect(calls).toBe(2);
  });

  it('ヒット/ミスを段の名前で集計できる', async () => {
    const cache = new PipelineCache();
    const dep = {};
    await cache.getOrCompute('step1', [dep], () => 1);
    await cache.getOrCompute('step1', [dep], () => 1);
    const stats = cache.takeStats();
    expect(stats.misses).toEqual(['step1']);
    expect(stats.hits).toEqual(['step1']);
    // 取り出したら空になる(次の実行のぶんと混ざらない)
    expect(cache.takeStats().hits).toEqual([]);
  });

  it('パイプライン全体で: 2 回目は全段ヒットして同じ結果を返す(教訓 §4 F5)', async () => {
    const cache = new PipelineCache();
    const first = await runPipeline(CHEAP, { cache });
    const statsFirst = cache.takeStats();
    expect(statsFirst.hits).toEqual([]);
    expect(statsFirst.misses.length).toBeGreaterThan(5);

    const second = await runPipeline(CHEAP, { cache });
    const statsSecond = cache.takeStats();
    expect(statsSecond.misses).toEqual([]);
    expect(statsSecond.hits.length).toBe(statsFirst.misses.length);
    // 参照ごと再利用されている
    expect(second.temperature).toBe(first.temperature);
    expect(second.koppen).toBe(first.koppen);
  }, 300_000);
});
