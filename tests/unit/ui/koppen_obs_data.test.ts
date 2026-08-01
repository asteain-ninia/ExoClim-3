import { describe, expect, it } from 'vitest';
import displayedObservation from '../../../src/domain/data/earth_koppen_1deg.json';
import earthTerrain from '../../../src/domain/data/earth_terrain_1deg.json';
import validationObservation from '../../fixtures/earth_koppen_1deg.json';

describe('Beck 観測レイヤー', () => {
  it('高解像度元データから作った検証用 1° ラスターと同じ内容を表示する', () => {
    expect(displayedObservation.widthCells).toBe(360);
    expect(displayedObservation.heightCells).toBe(180);
    expect(displayedObservation.landFractionMin).toBe(0.5);
    expect(displayedObservation.classRaster).toHaveLength(360 * 180);
    expect(displayedObservation.classRaster).toEqual(validationObservation.classRaster);
  });

  it('ETOPO の水域に気候クラスを表示しない', () => {
    const observationsOnWater = displayedObservation.classRaster.filter(
      (classId, i) => classId !== 0 && earthTerrain.landMask[i] === 0,
    );
    expect(observationsOnWater).toHaveLength(0);

    // Beck 元ラスターが乾燥気候として持つカスピ海中央部。
    const centralCaspian = 47 * 360 + 230; // 42.5°N, 50.5°E
    expect(earthTerrain.landMask[centralCaspian]).toBe(0);
    expect(displayedObservation.classRaster[centralCaspian]).toBe(0);
  });
});
