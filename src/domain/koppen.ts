// ケッペン=ガイガー区分の記号・配色・大分類。番号体系は Beck et al. 2023 に一致
// (1=Af … 30=EF、0=海/未分類)。配色も同論文の標準配色。

export const KOPPEN_CLASSES = [
  '',
  'Af',
  'Am',
  'Aw',
  'BWh',
  'BWk',
  'BSh',
  'BSk',
  'Csa',
  'Csb',
  'Csc',
  'Cwa',
  'Cwb',
  'Cwc',
  'Cfa',
  'Cfb',
  'Cfc',
  'Dsa',
  'Dsb',
  'Dsc',
  'Dsd',
  'Dwa',
  'Dwb',
  'Dwc',
  'Dwd',
  'Dfa',
  'Dfb',
  'Dfc',
  'Dfd',
  'ET',
  'EF',
] as const;

export type KoppenClassId = number; // 0..30

/** Beck et al. 2023 の標準 RGB 配色 */
export const KOPPEN_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [10, 30, 60],
  [0, 0, 255],
  [0, 120, 255],
  [70, 170, 250],
  [255, 0, 0],
  [255, 150, 150],
  [245, 165, 0],
  [255, 220, 100],
  [255, 255, 0],
  [200, 200, 0],
  [150, 150, 0],
  [150, 255, 150],
  [100, 200, 100],
  [50, 150, 50],
  [200, 255, 80],
  [100, 255, 80],
  [50, 200, 0],
  [255, 0, 255],
  [200, 0, 200],
  [150, 50, 150],
  [150, 100, 150],
  [170, 175, 255],
  [90, 120, 220],
  [75, 80, 180],
  [50, 0, 135],
  [0, 255, 255],
  [55, 200, 255],
  [0, 125, 125],
  [0, 70, 95],
  [178, 178, 178],
  [102, 102, 102],
];

/** 大分類: 0=A 熱帯, 1=B 乾燥, 2=C 温帯, 3=D 冷帯, 4=E 寒帯, -1=海/未分類 */
export function majorClassOf(classId: KoppenClassId): number {
  if (classId >= 1 && classId <= 3) return 0;
  if (classId >= 4 && classId <= 7) return 1;
  if (classId >= 8 && classId <= 16) return 2;
  if (classId >= 17 && classId <= 28) return 3;
  if (classId >= 29 && classId <= 30) return 4;
  return -1;
}

export const MAJOR_CLASS_NAMES = ['A 熱帯', 'B 乾燥', 'C 温帯', 'D 冷帯', 'E 寒帯'] as const;

/**
 * 大分類の名前付き定数(2026-08-16)。
 * `majorClassOf` の返り値は **0 起点**(0=A … 4=E、-1=海/未分類)だが、
 * 同じ日に 2 つの別々のスクリプトが「1 起点」と誤解して書かれた
 * (diag_c_to_b 初版は D↔C を測り、exp_planet_response は A を集計から
 * 除外して全列を 1 つずらしていた)。**裸の数字での比較を書かず、必ずこれを使う。**
 */
export const MAJOR = { A: 0, B: 1, C: 2, D: 3, E: 4 } as const;

export function classIdOf(symbol: string): KoppenClassId {
  const idx = (KOPPEN_CLASSES as readonly string[]).indexOf(symbol);
  return idx >= 0 ? idx : 0;
}
