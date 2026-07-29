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
  return null;
}
