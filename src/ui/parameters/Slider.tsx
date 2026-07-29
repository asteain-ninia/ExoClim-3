// 数値スライダー(値表示 + 単位つき)。利用者パラメータ専用
// (モデル較正定数はスライダーにしない — docs/方針.md §3)。

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}

export function Slider({ label, value, min, max, step, unit, onChange, format }: SliderProps) {
  return (
    <label className="slider">
      <span className="slider__label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider__value">
        {format ? format(value) : value}
        {unit ?? ''}
      </span>
    </label>
  );
}
