// 段キャッシュ。教訓 §3(ExoClim-2 で実証済みの PipelineCache + getOrCompute)。
//
// パイプラインの各段の出力を覚えておき、**依存が参照レベルで同一**なら
// 再計算せずに前回の値を返す。上流が不変なら参照が同一になるので、
// ヒットは下流へ連鎖する。
//
// ここはワーカー層(pipeline.ts の冒頭コメントのとおり、キャッシュの寿命は
// 計算層の責務ではない)。計算層は StageCache 型しか知らない。
//
// **効き目について正直に**(2026-08-02 の依存関係の実測):
//   費用の 99% は気温(EBM 約 70%)と降水(約 29%)にあり、この 2 段は
//   上流 1〜4 段すべてに依存する。したがって利用者パラメータをどれか 1 つ
//   動かした場合、このキャッシュが省けるのは全体の **1% 未満**である。
//   実質的に効くのは「依存が何も変わっていない再実行」を丸ごと省く場合
//   (教訓 §4 の F5)と、プレビュー → 確定で 1〜4 段を使い回す場合。
//   気温の再計算そのものを省くにはウォームスタートが要るが、
//   これは決定性規約に触れるため別途判断が要る(2026-08-02 時点では保留)。

import type { StageCache } from '@/sim/run_control';

interface Entry {
  deps: readonly unknown[];
  value: unknown;
}

export interface CacheStats {
  hits: string[];
  misses: string[];
}

export class PipelineCache implements StageCache {
  private readonly entries = new Map<string, Entry>();
  private hits: string[] = [];
  private misses: string[] = [];

  async getOrCompute<T>(
    key: string,
    deps: readonly unknown[],
    compute: () => T | Promise<T>,
  ): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && sameDeps(hit.deps, deps)) {
      this.hits.push(key);
      return hit.value as T;
    }
    this.misses.push(key);
    const value = await compute();
    // deps は**複製して持つ**。呼び出し側が配列を使い回すと、
    // 次回の比較が常に一致して「変えたのに再計算されない」になる
    this.entries.set(key, { deps: [...deps], value });
    return value;
  }

  /** この実行のヒット/ミスを取り出して集計を空にする */
  takeStats(): CacheStats {
    const stats = { hits: this.hits, misses: this.misses };
    this.hits = [];
    this.misses = [];
    return stats;
  }

  clear(): void {
    this.entries.clear();
    this.hits = [];
    this.misses = [];
  }
}

/**
 * 依存の一致判定。**Object.is 語義**(教訓 §3 の決定性規約)で、
 * 上流の出力は参照が同じかどうか、パラメータの数値は値が同じかどうかを見る。
 * NaN 同士は一致、+0 と -0 は不一致 — どちらも「同じ入力か」の判定として正しい。
 */
function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
