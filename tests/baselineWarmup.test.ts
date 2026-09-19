/**
 * Baseline warm-up tests.
 *
 * The platform's central clinical claim is that 98 BPM means different things
 * for different people. That claim is only true once it has learned what it
 * means for THIS person - and these tests pin what it says in the meantime,
 * which is the part a prototype normally gets wrong by pretending the question
 * does not arise.
 */

import { describe, expect, it } from 'vitest';
import {
  BASELINE_REQUIREMENTS,
  baselineReadiness,
  countNights,
  evaluateBaseline,
  learnPersonalBaseline,
} from '../shared/domain/baselineEngine';
import {
  SCENARIOS,
  scenarioDurationSec,
  scenarioOfflineDevices,
} from '../shared/domain/simulationEngine';
import type { PersonalBaseline, WearableReading } from '../shared/types/domain';

const NIGHT = (dayOffset: number, index: number): string => {
  const d = new Date('2026-09-17T23:00:00Z');
  d.setUTCDate(d.getUTCDate() - dayOffset);
  d.setUTCMinutes(index * 5);
  return d.toISOString();
};

function samples(count: number, nights: number, hr = 72): WearableReading[] {
  const out: WearableReading[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `w-${i}`,
      userId: 'user-new',
      heartRateBpm: hr + (i % 5) - 2,
      skinTempC: 33.4,
      activityStepsPerHour: 40,
      simulated: true,
      recordedAt: NIGHT(i % Math.max(1, nights), i),
    } as WearableReading);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe('countNights', () => {
  it('counts distinct days, not samples', () => {
    // Twelve samples from one evening are twelve samples from one evening.
    expect(countNights(samples(12, 1))).toBe(1);
    expect(countNights(samples(12, 3))).toBe(3);
  });

  it('is zero with nothing to learn from', () => {
    expect(countNights([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe('baselineReadiness', () => {
  it('a newly enrolled resident is LEARNING, on borrowed ranges', () => {
    const baseline = learnPersonalBaseline('user-new', []);
    const readiness = baselineReadiness(baseline);

    expect(readiness.state).toBe('LEARNING');
    expect(readiness.usingTypicalRanges).toBe(true);
    expect(readiness.sampleCount).toBe(0);
    expect(readiness.progress).toBe(0);
    expect(readiness.summaryZh).toContain('同齡常見範圍');
  });

  it('is PROVISIONAL with enough samples but too few nights', () => {
    /**
     * The distinction this state exists for. A resting heart rate varies night
     * to night; a band drawn from one evening is too narrow, and produces
     * false deviations later on the screen a caregiver is meant to trust.
     */
    const baseline = learnPersonalBaseline('user-new', samples(30, 1));
    const readiness = baselineReadiness(baseline);

    expect(readiness.state).toBe('PROVISIONAL');
    expect(readiness.usingTypicalRanges).toBe(false);
    expect(readiness.nightsCovered).toBe(1);
  });

  it('is READY once it has enough samples across enough nights', () => {
    const baseline = learnPersonalBaseline('user-new', samples(40, 3));
    const readiness = baselineReadiness(baseline);

    expect(readiness.state).toBe('READY');
    expect(readiness.progress).toBe(1);
  });

  it('reports progress across both requirements', () => {
    const half = learnPersonalBaseline(
      'user-new',
      samples(BASELINE_REQUIREMENTS.minSamples, 1),
    );

    // Samples complete, one night of three: (1 + 1/3) / 2
    expect(baselineReadiness(half).progress).toBeCloseTo(0.67, 1);
  });

  it('does not credit coverage that was never recorded', () => {
    // A baseline persisted before nights were tracked reports as less mature
    // than it may be, which is the safe direction to be wrong in.
    const legacy = {
      ...learnPersonalBaseline('user-old', samples(40, 3)),
      nightsCovered: undefined,
    } as PersonalBaseline;

    expect(baselineReadiness(legacy).state).toBe('PROVISIONAL');
  });
});

// ---------------------------------------------------------------------------
// What the resident is told
// ---------------------------------------------------------------------------

describe('evaluateBaseline wording', () => {
  it('does not call a borrowed range personal', () => {
    /**
     * The defect this fixes. A brand-new resident was told "高於個人平常基準
     * 24%" while the range came from cohort defaults - a personal claim the
     * platform had not earned, on the one screen whose entire premise is that
     * personal differs from typical.
     */
    const learning = learnPersonalBaseline('user-new', []);
    const evaluation = evaluateBaseline(140, learning);

    expect(evaluation.personal).toBe(false);
    expect(evaluation.state).toBe('LEARNING');
    expect(evaluation.descriptionZh).toContain('同齡常見');
    expect(evaluation.descriptionZh).not.toContain('個人');
  });

  it('claims a personal baseline once it has one', () => {
    const ready = learnPersonalBaseline('user-new', samples(40, 3));
    const evaluation = evaluateBaseline(140, ready);

    expect(evaluation.personal).toBe(true);
    expect(evaluation.descriptionZh).toContain('個人平常');
  });

  it('still evaluates while learning, rather than refusing to answer', () => {
    // Day one is not a reason to show nothing. It is a reason to say what the
    // comparison is against.
    const learning = learnPersonalBaseline('user-new', []);
    const evaluation = evaluateBaseline(140, learning);

    expect(evaluation.aboveBaseline).toBe(true);
    expect(evaluation.deviationPct).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('degradation scenarios', () => {
  it('registers all three', () => {
    for (const name of ['SENSOR_OFFLINE', 'WEARABLE_OFFLINE', 'NEW_RESIDENT'] as const) {
      expect(SCENARIOS[name]).toBeDefined();
      expect(scenarioDurationSec(name)).toBeGreaterThan(0);
    }
  });

  it('takes the room sensor down only while the heat is on', () => {
    // Normal at the start, failing through the risky phases, restored in
    // recovery - so the reconnect is part of what gets demonstrated.
    expect(scenarioOfflineDevices('SENSOR_OFFLINE', 5)).toEqual([]);
    expect(scenarioOfflineDevices('SENSOR_OFFLINE', 60)).toEqual(['TEMPERATURE_SENSOR']);
    expect(scenarioOfflineDevices('SENSOR_OFFLINE', 100)).toEqual(['TEMPERATURE_SENSOR']);
    expect(scenarioOfflineDevices('SENSOR_OFFLINE', 160)).toEqual([]);
  });

  it('takes the wearable down, which is the worse loss', () => {
    // Heart rate against a personal baseline is the signal nothing else
    // substitutes for.
    expect(scenarioOfflineDevices('WEARABLE_OFFLINE', 60)).toEqual(['SMART_WATCH']);
  });

  it('breaks nothing in the new-resident scenario', () => {
    // The subject there is the baseline, not the hardware.
    expect(scenarioOfflineDevices('NEW_RESIDENT', 60)).toEqual([]);
  });

  it('gives every device back when a scenario finishes', () => {
    const past = scenarioDurationSec('SENSOR_OFFLINE') + 30;
    expect(scenarioOfflineDevices('SENSOR_OFFLINE', past)).toEqual([]);
  });

  it('touches nothing during ambient drift', () => {
    expect(scenarioOfflineDevices('AMBIENT', 60)).toEqual([]);
    expect(scenarioOfflineDevices(null, 60)).toEqual([]);
  });
});
