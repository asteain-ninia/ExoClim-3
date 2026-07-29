// 凡例。表示中のオーバーレイに応じて切り替える。

import { KOPPEN_CLASSES, KOPPEN_COLORS } from '@/domain/koppen';
import { useUiStore } from '@/store/ui';

const KOPPEN_GROUPS: Array<{ title: string; ids: number[] }> = [
  { title: 'A 熱帯', ids: [1, 2, 3] },
  { title: 'B 乾燥', ids: [4, 5, 6, 7] },
  { title: 'C 温帯', ids: [8, 9, 10, 11, 12, 13, 14, 15, 16] },
  { title: 'D 冷帯', ids: [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28] },
  { title: 'E 寒帯', ids: [29, 30] },
];

export function Legend() {
  const overlay = useUiStore((s) => s.overlay);
  if (overlay === 'koppen') {
    return (
      <div className="legend" data-testid="legend">
        {KOPPEN_GROUPS.map((g) => (
          <div key={g.title} className="legend-group">
            <span className="legend-group__title">{g.title}</span>
            {g.ids.map((id) => {
              const [r, gg, b] = KOPPEN_COLORS[id] ?? [0, 0, 0];
              return (
                <span key={id} className="legend-chip">
                  <span className="legend-swatch" style={{ background: `rgb(${r},${gg},${b})` }} />
                  {KOPPEN_CLASSES[id]}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    );
  }
  if (overlay === 'temperature') {
    return (
      <div className="legend">
        <span className="legend-gradient legend-gradient--temp" />
        <span className="legend-caption">−45°C 〜 +45°C</span>
      </div>
    );
  }
  if (overlay === 'precipitation') {
    return (
      <div className="legend">
        <span className="legend-gradient legend-gradient--precip" />
        <span className="legend-caption">0 〜 4000mm/年(対数)</span>
      </div>
    );
  }
  if (overlay === 'currents') {
    return (
      <div className="legend">
        <span className="legend-gradient legend-gradient--currents" />
        <span className="legend-caption">
          海面温度偏差 −3.5 〜 +3.5°C(青 = 寒流、赤 = 暖流。海盆の西縁 = 暖流、東縁 = 寒流、
          高緯度東側 = 暖流吹送域)
        </span>
      </div>
    );
  }
  if (overlay === 'pressure') {
    return (
      <div className="legend">
        <span className="legend-gradient legend-gradient--pressure" />
        <span className="legend-caption">
          気圧偏差 −8(橙 = 低圧)〜 +8 hPa(青 = 高圧)・ H/L = 高低気圧中心 ・
          水色破線 = 亜熱帯高圧帯(ハドレー端)・ 紫破線 = 極前線 ・「風」で地表風を重畳
        </span>
      </div>
    );
  }
  return null;
}
