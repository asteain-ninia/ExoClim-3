// P1-3(FB 2026-07-31): モデル適用範囲と異常診断。
// 受入条件: 高加熱端が明示的な適用範囲外になる/数十億 mm/月を正常結果として
// 返さない/地球条件と妥当範囲内のケースは従来どおり計算可能。

import { describe, expect, it } from 'vitest';
import {
  FIELD_DOMAIN,
  buildDiagnostics,
  diagnoseFields,
  diagnoseInputs,
} from '../../../src/sim/diagnostics';
import { EARTH_PARAMS, type PlanetParams } from '../../../src/domain/planetParams';
import { runPipeline } from '../../../src/sim/pipeline';
import type { PrecipitationResult, TemperatureResult } from '../../../src/sim/types';

function tempOf(values: number[]): TemperatureResult {
  return { monthlyTemperatureC: [Float32Array.from(values)] } as unknown as TemperatureResult;
}
function precipOf(values: number[]): PrecipitationResult {
  return { monthlyPrecipMm: [Float32Array.from(values)] } as unknown as PrecipitationResult;
}

describe('適用範囲診断(P1-3)', () => {
  it('地球入力は事前診断ゼロ件', () => {
    expect(diagnoseInputs(EARTH_PARAMS)).toEqual([]);
  });

  it('範囲外・非有限の入力は理由つきエラー', () => {
    const hot: PlanetParams = {
      ...EARTH_PARAMS,
      orbital: { ...EARTH_PARAMS.orbital, starLuminositySolar: 1000 },
    };
    const issues = diagnoseInputs(hot);
    expect(issues.some((x) => x.code === 'input:starLuminositySolar:range')).toBe(true);
    const nan: PlanetParams = {
      ...EARTH_PARAMS,
      body: { ...EARTH_PARAMS.body, axialTiltDeg: Number.NaN },
    };
    expect(diagnoseInputs(nan).some((x) => x.code === 'input:axialTiltDeg:nonfinite')).toBe(true);
  });

  it('高加熱端の気温(数千 °C)は判定不能', () => {
    const issues = diagnoseFields(tempOf([2000, 20]), precipOf([50, 60]));
    expect(issues.some((x) => x.code === 'field:temp:domain')).toBe(true);
  });

  it('数十億 mm/月の降水を正常結果として返さない', () => {
    const issues = diagnoseFields(tempOf([20, 25]), precipOf([3.4e9, 50]));
    expect(issues.some((x) => x.code === 'field:precip:domain')).toBe(true);
  });

  it('非有限・負の降水も判定不能', () => {
    expect(
      diagnoseFields(tempOf([Number.NaN, 20]), precipOf([50, 60])).some(
        (x) => x.code === 'field:temp:nonfinite',
      ),
    ).toBe(true);
    expect(
      diagnoseFields(tempOf([20, 20]), precipOf([-5, 60])).some(
        (x) => x.code === 'field:precip:negative',
      ),
    ).toBe(true);
  });

  it('地球圏内の場は診断ゼロ件(適用域は地球極値を余裕込みで含む)', () => {
    expect(FIELD_DOMAIN.monthlyTempMinC).toBeLessThan(-89);
    expect(FIELD_DOMAIN.monthlyTempMaxC).toBeGreaterThan(57);
    expect(diagnoseFields(tempOf([-89, 57]), precipOf([0, 9300]))).toEqual([]);
  });

  it('統合(2° 地球): 従来どおり計算可能で status = ok', () => {
    const result = runPipeline({ ...EARTH_PARAMS, gridResolutionDeg: 2 });
    expect(result.diagnostics.status).toBe('ok');
    expect(result.diagnostics.issues.filter((x) => x.severity === 'error')).toEqual([]);
  }, 300_000);

  it('統合(2° 高加熱端): 判定不能が宣言される', () => {
    const hot: PlanetParams = {
      ...EARTH_PARAMS,
      gridResolutionDeg: 2,
      terrain: { kind: 'preset', preset: 'aquaplanet' },
      orbital: { ...EARTH_PARAMS.orbital, starLuminositySolar: 25, semiMajorAxisAu: 0.5 },
    };
    const result = runPipeline(hot);
    const d = buildDiagnostics(hot, result.temperature, result.precipitation);
    expect(result.diagnostics.status).toBe('out_of_domain');
    expect(d.status).toBe('out_of_domain');
    expect(
      result.diagnostics.issues.some(
        (x) => x.code === 'field:temp:domain' || x.code === 'field:precip:domain',
      ),
    ).toBe(true);
  }, 300_000);
});
