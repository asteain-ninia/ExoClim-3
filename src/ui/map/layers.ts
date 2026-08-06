// 表示層と「その層を描くのに要る場」の対応。
//
// 対応 spec: なし(表示)。
//
// **タブと地図の両方がこれを見る**。片方だけが知っていると、
// 「タブは押せるのに地図は別の層を描く」というずれが生まれる
// (2026-08-03 に実際にそうなった — 未計算の層を黙って地形へ退避していたため、
//  降水と気候区分がどちらも地形に見え、「切り替えが効かない」と読めた)。

import type { PartialPipelineResult } from '@/sim/types';
import type { OverlayKind } from '@/store/ui';

/** この層を描くのに必要な場が、いま手元にあるか */
export function hasLayer(r: PartialPipelineResult | null, overlay: OverlayKind): boolean {
  // 観測データはモデルと独立なので、計算前でも描ける
  if (overlay === 'koppenObs') return true;
  if (!r) return false;
  switch (overlay) {
    case 'terrain':
      return true; // context があれば描ける
    case 'koppen':
      return !!r.koppen;
    case 'temperature':
      return !!r.temperature;
    case 'precipitation':
      return !!r.precipitation;
    case 'currents':
      return !!r.ocean;
    case 'pressure':
      return !!r.windBelt;
  }
}

/** その層がいつ現れるかの説明(待たされる側に理由を伝えるため) */
export const LAYER_WAIT_REASON: Partial<Record<OverlayKind, string>> = {
  temperature: 'EBM のモデル内 1 年ぶんが揃うと出ます',
  precipitation: '気温の計算が終わってから始まります',
  koppen: '気温と降水が揃ってから組み立てます',
  currents: '循環の計算(数百 ms)が終わると出ます',
  pressure: '循環の計算(数百 ms)が終わると出ます',
};
