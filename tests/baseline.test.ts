/**
 * Personal baseline tests.
 *
 * The proposal's central clinical claim is that judging an elderly person
 * against a fixed heart-rate threshold is wrong. These tests pin the property
 * that makes that claim true in code: the SAME heart rate produces different
 * risk for different people.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateActivityRisk,
  calculatePhysiologicalDeviation,
  evaluateBaseline,
  learnPersonalBaseline,
} from '../shared/domain/baselineEngine';
import { cloneDefaultConfig } from '../shared/domain/config';
import type { PersonalBaseline, WearableReading } from '../shared/types/domain';

function baseline(min: number, max: number, confidence = 0.95): PersonalBaseline {
  return {
    userId: 'test',
    heartRate: { min, max, mean: Math.round((min + max) / 2) },
    skinTemp: { min: 33, max: 34.5, mean: 33.7 },
    activityStepsPerHour: { min: 60, max: 300, mean: 160 },
    sampleCount: 200,
    confidence,
    learnedAt: new Date().toISOString(),
  };
}

function readings(values: number[]): WearableReading[] {
  return values.map((heartRateBpm, i) => ({
    id: `r${i}`,
    userId: 'test',
    heartRateBpm,
    skinTempC: 33.5,
    activityStepsPerHour: 150,
    simulated: true,
    recordedAt: new Date(Date.now() - i * 60_000).toISOString(),
  }));
}

describe('evaluateBaseline', () => {
  it('reports no deviation inside the personal range', () => {
    const result = evaluateBaseline(75, baseline(65, 82));
    expect(result.aboveBaseline).toBe(false);
    expect(result.deviationPct).toBe(0);
    expect(result.descriptionZh).toContain('個人平常範圍');
  });

  it('measures deviation from the top of the range, not the mean', () => {
    // 98 BPM against a 65-82 band is 16 above the top: 16/82 = 19.5% -> 20%.
    const result = evaluateBaseline(98, baseline(65, 82));
    expect(result.aboveBaseline).toBe(true);
    expect(result.deviationBpm).toBe(16);
    expect(result.deviationPct).toBe(20);
    expect(result.descriptionZh).toBe('高於個人平常基準 20%');
  });

  it('THE CENTRAL PROPERTY: the same BPM is normal for one person and a deviation for another', () => {
    const athlete = evaluateBaseline(98, baseline(50, 65));
    const higherResting = evaluateBaseline(98, baseline(85, 100));

    expect(athlete.aboveBaseline).toBe(true);
    expect(athlete.deviationPct).toBeGreaterThan(45);

    expect(higherResting.aboveBaseline).toBe(false);
    expect(higherResting.deviationPct).toBe(0);
  });

  it('detects readings below the personal range', () => {
    const result = evaluateBaseline(55, baseline(65, 82));
    expect(result.belowBaseline).toBe(true);
    expect(result.aboveBaseline).toBe(false);
    expect(result.deviationPct).toBe(0);
  });

  it('carries the baseline confidence through to the evaluation', () => {
    expect(evaluateBaseline(90, baseline(65, 82, 0.4)).confidence).toBe(0.4);
  });
});

describe('calculatePhysiologicalDeviation', () => {
  const config = cloneDefaultConfig();

  it('scores zero within the range', () => {
    expect(calculatePhysiologicalDeviation(evaluateBaseline(75, baseline(65, 82)), config)).toBe(0);
  });

  it('treats deviation below the configured floor as noise', () => {
    // minDeviationPct default is 5. 85 vs a max of 82 is ~3.7%.
    expect(calculatePhysiologicalDeviation(evaluateBaseline(85, baseline(65, 82)), config)).toBe(0);
  });

  it('increases with deviation and saturates at 100', () => {
    const b = baseline(65, 82);
    const mild = calculatePhysiologicalDeviation(evaluateBaseline(92, b), config);
    const moderate = calculatePhysiologicalDeviation(evaluateBaseline(100, b), config);
    const severe = calculatePhysiologicalDeviation(evaluateBaseline(140, b), config);

    expect(mild).toBeGreaterThan(0);
    expect(moderate).toBeGreaterThan(mild);
    expect(severe).toBeLessThanOrEqual(100);
    expect(severe).toBeGreaterThan(moderate);
  });

  it('damps the score when the baseline was learned from few samples', () => {
    const confident = calculatePhysiologicalDeviation(
      evaluateBaseline(105, baseline(65, 82, 0.95)),
      config,
    );
    const uncertain = calculatePhysiologicalDeviation(
      evaluateBaseline(105, baseline(65, 82, 0.2)),
      config,
    );

    // A low-confidence baseline must not drive a confident risk claim.
    expect(uncertain).toBeLessThan(confident);
  });

  it('respects a CMS-configured physiology window', () => {
    const strict = cloneDefaultConfig();
    strict.physiology = { minDeviationPct: 5, maxDeviationPct: 15 };

    const evaluation = evaluateBaseline(100, baseline(65, 82));
    // A narrower window means the same deviation saturates sooner.
    expect(calculatePhysiologicalDeviation(evaluation, strict)).toBeGreaterThan(
      calculatePhysiologicalDeviation(evaluation, config),
    );
  });
});

describe('calculateActivityRisk', () => {
  it('scores zero at or above the usual minimum', () => {
    expect(calculateActivityRisk(160, baseline(65, 82))).toBe(0);
    expect(calculateActivityRisk(60, baseline(65, 82))).toBe(0);
  });

  it('rises as activity falls below the personal minimum', () => {
    // Lethargy is the warning sign, so LOW activity scores HIGH risk.
    const b = baseline(65, 82);
    expect(calculateActivityRisk(30, b)).toBeGreaterThan(0);
    expect(calculateActivityRisk(0, b)).toBe(100);
    expect(calculateActivityRisk(10, b)).toBeGreaterThan(calculateActivityRisk(40, b));
  });
});

describe('learnPersonalBaseline', () => {
  it('falls back with low confidence when there are too few samples', () => {
    const learned = learnPersonalBaseline('test', readings([70, 72, 74]));
    expect(learned.sampleCount).toBe(3);
    expect(learned.confidence).toBeLessThan(0.6);
  });

  it('learns a range from sufficient samples', () => {
    const values = Array.from({ length: 60 }, (_, i) => 68 + (i % 12));
    const learned = learnPersonalBaseline('test', readings(values));

    expect(learned.sampleCount).toBe(60);
    expect(learned.confidence).toBeGreaterThan(0.6);
    expect(learned.heartRate.min).toBeGreaterThanOrEqual(68);
    expect(learned.heartRate.max).toBeLessThanOrEqual(80);
    expect(learned.heartRate.min).toBeLessThan(learned.heartRate.max);
  });

  it('resists outliers by using a trimmed percentile range', () => {
    // A single exertion spike must not widen the "normal" band, or genuine
    // deviations would stop registering afterwards.
    const normal = Array.from({ length: 40 }, () => 72);
    const withSpike = [...normal, 190, 185];

    const learned = learnPersonalBaseline('test', readings(withSpike));
    expect(learned.heartRate.max).toBeLessThan(100);
  });

  it('grows more confident with more samples', () => {
    const few = learnPersonalBaseline('test', readings(Array.from({ length: 20 }, () => 72)));
    const many = learnPersonalBaseline('test', readings(Array.from({ length: 200 }, () => 72)));
    expect(many.confidence).toBeGreaterThan(few.confidence);
  });
});
