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

  it('ETOPO の水域に気候クラスをほぼ表示しない(南極の棚氷の縁だけ例外)', () => {
    // 観測レイヤーは**モデルとは独立の**ラスタをそのまま描く設計なので、
    // 我々の陸マスクと完全一致する義務は無い。とはいえ大きくずれていれば
    // 位置合わせかマスクの誤りなので、少数であることを確かめる。
    //
    // 残る食い違いの正体(2026-08-02): 南極の棚氷を Natural Earth 1:50m の
    // 棚氷ポリゴンで海へ戻した(ETOPO surface は氷の上面なので浮氷が陸に入る)。
    // Beck の陸マスクは別の出所なので、棚氷の縁で 20〜30 セルだけ判定が食い違う。
    const onWater: number[] = [];
    for (let i = 0; i < displayedObservation.classRaster.length; i++) {
      const id = displayedObservation.classRaster[i] ?? 0;
      if (id !== 0 && earthTerrain.landMask[i] === 0) onWater.push(i);
    }
    expect(onWater.length).toBeLessThan(40);
    // すべて南極(南緯 60 度以南)に限られること — 中低緯度に出たら位置合わせの誤り
    for (const i of onWater) {
      const lat = 90 - (Math.floor(i / 360) + 0.5);
      expect(lat).toBeLessThan(-60);
    }

    // Beck 元ラスターが乾燥気候として持つカスピ海中央部。
    const centralCaspian = 47 * 360 + 230; // 42.5°N, 50.5°E
    expect(earthTerrain.landMask[centralCaspian]).toBe(0);
    expect(displayedObservation.classRaster[centralCaspian]).toBe(0);
  });
});
