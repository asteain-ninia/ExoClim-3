// Web Worker 本体: パイプラインを実行して結果を返す。

import type { PlanetParams } from '@/domain/planetParams';
import { runPipeline } from '@/sim/pipeline';

self.onmessage = (ev: MessageEvent<{ id: number; params: PlanetParams }>) => {
  const { id, params } = ev.data;
  try {
    const payload = runPipeline(params);
    self.postMessage({ id, ok: true, payload });
  } catch (e) {
    self.postMessage({ id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
};
