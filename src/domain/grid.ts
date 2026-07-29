// 緯度経度規則格子。row 0 = 北端 (+90° 側)、col 0 = 西端 (-180° 側)。
// セル中心の緯度 = 90 − (row + 0.5)·分解能。フラット配列は行優先 (row * width + col)。
// 仕様: docs/spec/00_基盤.md §2

export interface Grid {
  readonly resolutionDeg: number;
  readonly widthCells: number;
  readonly heightCells: number;
  readonly cellCount: number;
}

export function createGrid(resolutionDeg: number): Grid {
  const widthCells = Math.round(360 / resolutionDeg);
  const heightCells = Math.round(180 / resolutionDeg);
  return { resolutionDeg, widthCells, heightCells, cellCount: widthCells * heightCells };
}

export function latDegOfRow(grid: Grid, row: number): number {
  return 90 - (row + 0.5) * grid.resolutionDeg;
}

export function lonDegOfCol(grid: Grid, col: number): number {
  return -180 + (col + 0.5) * grid.resolutionDeg;
}

export function rowOfLatDeg(grid: Grid, latDeg: number): number {
  const row = Math.floor((90 - latDeg) / grid.resolutionDeg);
  return Math.min(grid.heightCells - 1, Math.max(0, row));
}

export function colOfLonDeg(grid: Grid, lonDeg: number): number {
  let n = (lonDeg + 180) / grid.resolutionDeg;
  n = ((n % grid.widthCells) + grid.widthCells) % grid.widthCells;
  return Math.floor(n);
}

export function cellIndex(grid: Grid, row: number, col: number): number {
  return row * grid.widthCells + col;
}

/** 経度方向の循環を考慮した col の正規化 */
export function wrapCol(grid: Grid, col: number): number {
  return ((col % grid.widthCells) + grid.widthCells) % grid.widthCells;
}

/** セル面積の重み(cos φ に比例、正規化なし) */
export function areaWeightOfRow(grid: Grid, row: number): number {
  return Math.cos((latDegOfRow(grid, row) * Math.PI) / 180);
}

/** 面積重み付き平均(field は cellCount 長、mask 指定時は mask≠0 のセルのみ) */
export function areaWeightedMean(
  grid: Grid,
  field: ArrayLike<number>,
  mask?: ArrayLike<number>,
): number {
  let sum = 0;
  let wsum = 0;
  for (let row = 0; row < grid.heightCells; row++) {
    const w = areaWeightOfRow(grid, row);
    const base = row * grid.widthCells;
    for (let col = 0; col < grid.widthCells; col++) {
      const i = base + col;
      if (mask !== undefined && !mask[i]) continue;
      sum += w * (field[i] as number);
      wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : NaN;
}

/** 1 セルの物理幅(東西方向, km)。半径は km。 */
export function cellWidthKm(grid: Grid, row: number, planetRadiusKm: number): number {
  const latRad = (latDegOfRow(grid, row) * Math.PI) / 180;
  return ((2 * Math.PI * planetRadiusKm) / grid.widthCells) * Math.cos(latRad);
}

/** 1 セルの物理高さ(南北方向, km) */
export function cellHeightKm(grid: Grid, planetRadiusKm: number): number {
  return (Math.PI * planetRadiusKm) / grid.heightCells;
}
