/**
 * Risk engine tests.
 *
 * These cover the properties the whole product rests on:
 *  - the CMS-configured thresholds actually drive the level,
 *  - the composite score can escalate but never de-escalate a level,
 *  - the required LOW -> MEDIUM -> HIGH -> RECOVERY transition sequence works,
 *  - the explanation never asserts a diagnosis.
 */

import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  buildRiskFactors,
  calculateEnvironmentalRisk,
  calculateHeatwaveRisk,
  calculateTotalRisk,
  calculateVentilationRisk,
  generateAIExplanation,
  getRiskLevel,
} from '../shared/domain/riskEngine';
import { cloneDefaultConfig } from '../shared/domain/config';
import type {
  PersonalBaseline,
  ReadingSnapshot,
  RiskHistoryPoint,
  RiskLevel,
} from '../shared/types/domain';

const BASELINE: PersonalBaseline = {
  userId: 'user-001',
  heartRate: { min: 65, max: 82, mean: 73 },
  skinTemp: { min: 33, max: 34.4, mean: 33.6 },
  activityStepsPerHour: { min: 63, max: 324, mean: 180 },
  sampleCount: 168,
  confidence: 0.93,
  learnedAt: new Date().toISOString(),
};

function reading(overrides: Partial<ReadingSnapshot> = {}): ReadingSnapshot {
  return {
    indoorTempC: 27,
    indoorHumidityPct: 60,
    outdoorTempC: 29,
    outdoorHumidityPct: 64,
    airQualityIndex: 60,
    heartRateBpm: 73,
    activityStepsPerHour: 180,
    skinTempC: 33.6,
    heatwaveDays: 0,
    simulated: true,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function assess(r: ReadingSnapshot, previousLevel: RiskLevel | null = null, history: RiskHistoryPoint[] = []) {
  return assessRisk({
    userId: 'user-001',
    reading: r,
    baseline: BASELINE,
    config: cloneDefaultConfig(),
    history,
    previousLevel,
  });
}

describe('individual factors', () => {
  const config = cloneDefaultConfig();

  it('scales environmental risk across the configured threshold band', () => {
    expect(calculateEnvironmentalRisk(27, config)).toBe(0);
    expect(calculateEnvironmentalRisk(39, config)).toBe(100);
    expect(calculateEnvironmentalRisk(33, config)).toBeCloseTo(50, 0);
    expect(calculateEnvironmentalRisk(50, config)).toBe(100);
  });

  it('moves environmental risk when the CMS changes the thresholds', () => {
    const widened = cloneDefaultConfig();
    widened.thresholds = { low: 27, medium: 32, high: 50 };
    // The same heat index is less severe once HIGH is further away.
    expect(calculateEnvironmentalRisk(39, widened)).toBeLessThan(
      calculateEnvironmentalRisk(39, config),
    );
  });

  it('scores ventilation risk from humidity, stagnation and air quality', () => {
    const wellVentilated = calculateVentilationRisk(
      reading({ indoorHumidityPct: 50, indoorTempC: 26, outdoorTempC: 30, airQualityIndex: 40 }),
      config,
    );
    const humidAndStagnant = calculateVentilationRisk(
      reading({ indoorHumidityPct: 92, indoorTempC: 31, outdoorTempC: 31, airQualityIndex: 160 }),
      config,
    );

    expect(wellVentilated).toBeLessThan(20);
    expect(humidAndStagnant).toBeGreaterThan(55);
    // The point of the factor: stagnant humid air scores far worse than a
    // ventilated room, not merely a little worse.
    expect(humidAndStagnant - wellVentilated).toBeGreaterThan(40);
  });

  it('treats a home no cooler than outdoors as offering no refuge', () => {
    const refuge = calculateVentilationRisk(
      reading({ indoorTempC: 25, outdoorTempC: 34, indoorHumidityPct: 60 }),
      config,
    );
    const noRefuge = calculateVentilationRisk(
      reading({ indoorTempC: 34, outdoorTempC: 34, indoorHumidityPct: 60 }),
      config,
    );
    expect(noRefuge).toBeGreaterThan(refuge);
  });

  it('accumulates heatwave risk over consecutive hot days', () => {
    const day0 = calculateHeatwaveRisk(reading({ heatwaveDays: 0 }), config);
    const day3 = calculateHeatwaveRisk(reading({ heatwaveDays: 3 }), config);
    const day7 = calculateHeatwaveRisk(reading({ heatwaveDays: 7 }), config);

    expect(day3).toBeGreaterThan(day0);
    expect(day7).toBeGreaterThanOrEqual(day3);
  });
});

describe('composite scoring', () => {
  it('normalises weights defensively so the score cannot exceed 100', () => {
    const config = cloneDefaultConfig();
    // A mis-entered set of weights summing well above 1 must not break the scale.
    config.weights = {
      environmental: 5,
      physiological: 5,
      heatwave: 5,
      ventilation: 5,
      activity: 5,
    };

    const { factors } = buildRiskFactors({
      reading: reading({ indoorTempC: 40, indoorHumidityPct: 95, heartRateBpm: 150 }),
      baseline: BASELINE,
      config,
    });

    const score = calculateTotalRisk(factors);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(0);
  });

  it('produces exactly the five documented factors', () => {
    const { factors } = buildRiskFactors({
      reading: reading(),
      baseline: BASELINE,
      config: cloneDefaultConfig(),
    });

    expect(factors.map((f) => f.key).sort()).toEqual([
      'activity',
      'environmental',
      'heatwave',
      'physiological',
      'ventilation',
    ]);
  });

  it('reports each factor contribution as score times weight', () => {
    const { factors } = buildRiskFactors({
      reading: reading({ indoorTempC: 33, indoorHumidityPct: 78 }),
      baseline: BASELINE,
      config: cloneDefaultConfig(),
    });

    for (const factor of factors) {
      // Contribution is rounded to one decimal place for display, so allow
      // half a unit of tolerance rather than demanding exact equality.
      expect(factor.contribution).toBeCloseTo(factor.score * factor.weight, 0);
    }
  });
});

describe('getRiskLevel', () => {
  const config = cloneDefaultConfig();

  it('bands by heat index using the configured thresholds', () => {
    expect(getRiskLevel(28, 0, config)).toBe('LOW');
    expect(getRiskLevel(35, 0, config)).toBe('MEDIUM');
    expect(getRiskLevel(42, 0, config)).toBe('HIGH');
  });

  it('escalates on composite score even when the heat index is low', () => {
    // A dangerous physiological deviation must not be hidden by a warm room.
    expect(getRiskLevel(28, 50, config)).toBe('MEDIUM');
    expect(getRiskLevel(28, 80, config)).toBe('HIGH');
  });

  it('never de-escalates a level because the score is low', () => {
    // Heat index alone says HIGH; a low score must not soften that.
    expect(getRiskLevel(42, 5, config)).toBe('HIGH');
    expect(getRiskLevel(35, 5, config)).toBe('MEDIUM');
  });

  it('honours the escalation switch being turned off in the CMS', () => {
    const noEscalation = cloneDefaultConfig();
    noEscalation.scoreEscalation.enabled = false;
    expect(getRiskLevel(28, 95, noEscalation)).toBe('LOW');
  });

  it('CMS THRESHOLD CONTROL: raising MEDIUM moves a resident from MEDIUM to LOW', () => {
    const before = cloneDefaultConfig();
    const after = cloneDefaultConfig();
    after.thresholds.medium = 36;

    // Score kept below the escalation floor so the threshold is the only cause.
    expect(getRiskLevel(34, 10, before)).toBe('MEDIUM');
    expect(getRiskLevel(34, 10, after)).toBe('LOW');
  });
});

describe('assessRisk', () => {
  it('produces a complete assessment for comfortable conditions', () => {
    const result = assess(reading());

    expect(result.level).toBe('LOW');
    expect(result.heatIndex).toBeLessThan(32);
    expect(result.factors).toHaveLength(5);
    expect(result.explanation.lines.length).toBeGreaterThan(0);
    expect(result.baseline.aboveBaseline).toBe(false);
    expect(result.monitoringIntervalSec).toBe(300);
  });

  it('detects escalation and recovery against the previous level', () => {
    const escalating = assess(reading({ indoorTempC: 33, indoorHumidityPct: 78 }), 'LOW');
    expect(escalating.escalated).toBe(true);
    expect(escalating.recovered).toBe(false);

    const recovering = assess(reading(), 'HIGH');
    expect(recovering.recovered).toBe(true);
    expect(recovering.escalated).toBe(false);
  });

  it('tightens the monitoring interval as risk rises', () => {
    const low = assess(reading());
    const high = assess(reading({ indoorTempC: 34, indoorHumidityPct: 82 }));

    expect(high.monitoringIntervalSec).toBeLessThan(low.monitoringIntervalSec);
  });

  it('REQUIRED SEQUENCE: LOW -> MEDIUM -> HIGH -> RECOVERY', () => {
    const low = assess(reading({ indoorTempC: 27.4, indoorHumidityPct: 62 }));
    expect(low.level).toBe('LOW');

    const medium = assess(
      reading({ indoorTempC: 30.2, indoorHumidityPct: 72, heartRateBpm: 88, heatwaveDays: 2 }),
      low.level,
    );
    expect(medium.level).toBe('MEDIUM');
    expect(medium.escalated).toBe(true);

    const high = assess(
      reading({
        indoorTempC: 33.5,
        indoorHumidityPct: 80,
        heartRateBpm: 105,
        activityStepsPerHour: 20,
        heatwaveDays: 5,
      }),
      medium.level,
    );
    expect(high.level).toBe('HIGH');
    expect(high.escalated).toBe(true);

    // Cooling brings the room back down.
    const recovered = assess(reading({ indoorTempC: 26, indoorHumidityPct: 52 }), high.level);
    expect(recovered.level).toBe('LOW');
    expect(recovered.recovered).toBe(true);
  });

  it('scores higher as conditions worsen', () => {
    const scores = [
      assess(reading({ indoorTempC: 26, indoorHumidityPct: 50 })).score,
      assess(reading({ indoorTempC: 30, indoorHumidityPct: 70, heartRateBpm: 90 })).score,
      assess(reading({ indoorTempC: 34, indoorHumidityPct: 85, heartRateBpm: 110, heatwaveDays: 5 })).score,
    ];

    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[2]).toBeGreaterThan(scores[1]);
  });
});

describe('generateAIExplanation', () => {
  const config = cloneDefaultConfig();

  function explain(r: ReadingSnapshot, history: RiskHistoryPoint[] = []) {
    const { factors, baselineEval, heatIndex } = buildRiskFactors({
      reading: r,
      baseline: BASELINE,
      config,
    });
    const score = calculateTotalRisk(factors);
    return generateAIExplanation({
      factors,
      baselineEval,
      heatIndex,
      score,
      level: getRiskLevel(heatIndex, score, config),
      reading: r,
      history,
      config,
    });
  }

  it('SAFETY: never asserts a diagnosis', () => {
    const forbidden = ['中暑', '你已經', '您已經', '確診', '診斷'];

    for (const r of [
      reading(),
      reading({ indoorTempC: 33, indoorHumidityPct: 80, heartRateBpm: 110 }),
      reading({ indoorTempC: 40, indoorHumidityPct: 95, heartRateBpm: 150, activityStepsPerHour: 0 }),
    ]) {
      const explanation = explain(r);
      const text = [
        explanation.headline,
        explanation.forecast,
        ...explanation.lines.map((l) => l.zh),
      ].join(' ');

      for (const phrase of forbidden) {
        expect(text).not.toContain(phrase);
      }
    }
  });

  it('uses risk-direction language rather than clinical claims', () => {
    const explanation = explain(
      reading({ indoorTempC: 33, indoorHumidityPct: 80, heartRateBpm: 105 }),
    );
    expect(explanation.headline).toMatch(/熱風險/);
  });

  it('cites the personal baseline rather than an absolute threshold', () => {
    const explanation = explain(reading({ heartRateBpm: 100 }));
    const text = explanation.lines.map((l) => l.zh).join(' ');
    expect(text).toContain('個人平常基準');
  });

  it('describes the trend when history is available', () => {
    const history: RiskHistoryPoint[] = Array.from({ length: 40 }, (_, i) => ({
      at: new Date(Date.now() - (40 - i) * 60_000).toISOString(),
      label: `${i}`,
      score: 10,
      level: 'LOW' as const,
      heatIndex: 28,
      indoorTempC: 27,
      outdoorTempC: 29,
      humidityPct: 60,
      heartRateBpm: 73,
      baselineMin: 65,
      baselineMax: 82,
      activityStepsPerHour: 180,
      targetTempC: 26,
      coolingOn: false,
    }));

    const explanation = explain(reading({ indoorTempC: 34, indoorHumidityPct: 82 }), history);
    const trend = explanation.lines.find((l) => l.factor === 'trend');

    expect(trend).toBeDefined();
    expect(trend?.direction).toBe('up');
    expect(trend?.zh).toContain('30 分鐘');
  });

  it('reports a confidence value between 0 and 1', () => {
    const explanation = explain(reading());
    expect(explanation.confidence).toBeGreaterThan(0);
    expect(explanation.confidence).toBeLessThanOrEqual(1);
  });
});
