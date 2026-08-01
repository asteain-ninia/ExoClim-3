// Web Worker 本体: パイプラインを実行して結果を返す。

import type { PlanetParams } from '@/domain/planetParams';
import { runPipelineTimed } from '@/sim/pipeline';

self.onmessage = (ev: MessageEvent<{ id: number; params: PlanetParams }>) => {
  const { id, params } = ev.data;
  // パイプラインは非同期(GPU 加速器を await できるようにするため)。
  // ブラウザでは加速器を渡さないので実質同期に走るが、await は必要
  void runPipelineTimed(params)
    .then((payload) => {
      self.postMessage({ id, ok: true, payload });
    })
    .catch((e: unknown) => {
      self.postMessage({ id, ok: false, message: e instanceof Error ? e.message : String(e) });
    });
};
