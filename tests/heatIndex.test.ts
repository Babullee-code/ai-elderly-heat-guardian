/**
 * Heat index tests.
 *
 * Reference values are taken from the NOAA heat index table, converted to
 * Celsius. A 1°C tolerance is allowed because the published table is rounded
 * to whole Fahrenheit degrees.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateDewPoint,
  calculateHeatIndex,
  calculateWetBulb,
  clamp,
  heatIndexBand,
  normalise,
} from '../shared/domain/heatIndex';

describe('calculateHeatIndex', () => {
  it('matches NOAA reference values in the Rothfusz range', () => {
    // NOAA table: 90F/70%RH = 105F; 90F = 32.2C, 105F = 40.6C
    expect(calculateHeatIndex(32.2, 70)).toBeCloseTo(40.6, 0);

    // NOAA table: 86F/70%RH = 95F; 86F = 30C, 95F = 35C
    expect(calculateHeatIndex(30, 70)).toBeCloseTo(35, 0);

    // NOAA table: 94F/60%RH = 110F; 94F = 34.4C, 110F = 43.3C
    expect(calculateHeatIndex(34.4, 60)).toBeCloseTo(43.3, 0);
  });

  it('uses the simple formula below the Rothfusz threshold', () => {
    // Well below 80F the apparent temperature stays close to the air
    // temperature rather than jumping, which the regression alone would do.
    const result = calculateHeatIndex(22, 50);
    expect(result).toBeGreaterThan(19);
    expect(result).toBeLessThan(24);
  });

  it('rises monotonically with humidity at fixed temperature', () => {
    const readings = [40, 55, 70, 85].map((rh) => calculateHeatIndex(32, rh));
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1]);
    }
  });

  it('rises monotonically with temperature at fixed humidity', () => {
    const readings = [28, 30, 32, 34].map((t) => calculateHeatIndex(t, 70));
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThan(readings[i - 1]);
    }
  });

  it('applies the high-humidity adjustment in its documented window', () => {
    // The adjustment applies for RH > 85 and 80F <= T <= 87F (26.7-30.6C).
    // It should push the value slightly above the unadjusted regression.
    const adjusted = calculateHeatIndex(29, 95);
    const lower = calculateHeatIndex(29, 84);
    expect(adjusted).toBeGreaterThan(lower);
  });

  it('clamps humidity to a valid range rather than producing nonsense', () => {
    expect(Number.isFinite(calculateHeatIndex(30, 150))).toBe(true);
    expect(Number.isFinite(calculateHeatIndex(30, -20))).toBe(true);
  });

  it('places the proposal thresholds in the intended bands', () => {
    // These are the conditions the seed cohort is calibrated against, and the
    // demo narrative depends on them landing in the right band.
    expect(calculateHeatIndex(27.4, 62)).toBeLessThan(32); // LOW
    expect(calculateHeatIndex(30.2, 72)).toBeGreaterThanOrEqual(32); // MEDIUM
    expect(calculateHeatIndex(30.2, 72)).toBeLessThan(39);
    expect(calculateHeatIndex(33.0, 78)).toBeGreaterThanOrEqual(39); // HIGH
  });
});

describe('heatIndexBand', () => {
  it('labels the NOAA caution bands', () => {
    expect(heatIndexBand(25).key).toBe('SAFE');
    expect(heatIndexBand(29).key).toBe('CAUTION');
    expect(heatIndexBand(35).key).toBe('EXTREME_CAUTION');
    expect(heatIndexBand(45).key).toBe('DANGER');
    expect(heatIndexBand(55).key).toBe('EXTREME_DANGER');
  });
});

describe('calculateDewPoint', () => {
  it('equals the air temperature at saturation', () => {
    expect(calculateDewPoint(25, 100)).toBeCloseTo(25, 0);
  });

  it('falls as humidity falls', () => {
    expect(calculateDewPoint(30, 40)).toBeLessThan(calculateDewPoint(30, 80));
  });
});

describe('calculateWetBulb', () => {
  it('never exceeds the dry-bulb temperature', () => {
    for (const [t, rh] of [
      [30, 50],
      [35, 70],
      [40, 90],
    ] as const) {
      expect(calculateWetBulb(t, rh)).toBeLessThanOrEqual(t);
    }
  });

  it('approaches the dry-bulb temperature at saturation', () => {
    expect(calculateWetBulb(30, 100)).toBeCloseTo(30, 0);
  });
});

describe('helpers', () => {
  it('clamps within bounds and handles NaN', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 3, 10)).toBe(3);
  });

  it('normalises a value onto 0..100 and clamps outside the range', () => {
    expect(normalise(27, 27, 39)).toBe(0);
    expect(normalise(39, 27, 39)).toBe(100);
    expect(normalise(33, 27, 39)).toBeCloseTo(50, 0);
    expect(normalise(50, 27, 39)).toBe(100);
    expect(normalise(10, 27, 39)).toBe(0);
  });

  it('handles a zero-width range without dividing by zero', () => {
    expect(normalise(5, 5, 5)).toBe(100);
    expect(normalise(4, 5, 5)).toBe(0);
  });
});
