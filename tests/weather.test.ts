/**
 * Weather provider tests.
 *
 * Any adapter works on a good day. What decides whether a monitoring platform
 * can be trusted is the bad one - the provider times out, or answers with
 * yesterday's reading, and the question is whether anyone downstream can tell.
 * Almost everything here is about that.
 */

import { describe, expect, it } from 'vitest';
import {
  HEATWAVE_THRESHOLD_C,
  WEATHER_TUNING,
  type WeatherHealth,
  type WeatherObservation,
  applyObservation,
  backoffSec,
  countHeatwaveDays,
  initialHealth,
  mayAttempt,
  observationIsCurrent,
  recordFailure,
  recordSuccess,
  refreshState,
  scenarioOverridesWeather,
  weatherProviderSource,
} from '../shared/domain/weather';
import { assembleReading, sourcesForResident } from '../shared/domain/inputSources';
import { WEATHER_FRESHNESS, qualityFromAge } from '../shared/domain/provenance';
import { initialHousehold } from '../shared/domain/simulationEngine';
import type { AmbientProfile } from '../shared/domain/simulationEngine';
import type { PersonalBaseline, ReadingSnapshot } from '../shared/types/domain';

const NOW = new Date('2026-09-17T14:00:00Z');

const PROFILE: AmbientProfile = {
  userId: 'user-001',
  baseIndoorTempC: 27,
  baseIndoorHumidityPct: 62,
  baseOutdoorTempC: 29,
  baseOutdoorHumidityPct: 66,
  baseAirQualityIndex: 58,
  baseHeatwaveDays: 0,
  heatSensitivity: 1.1,
};

const BASELINE: PersonalBaseline = {
  userId: 'user-001',
  heartRate: { min: 64, max: 82, mean: 72 },
  skinTemp: { min: 32.8, max: 34.1, mean: 33.4 },
  activityStepsPerHour: { min: 60, max: 340, mean: 200 },
  sampleCount: 60,
  confidence: 0.9,
  learnedAt: NOW.toISOString(),
};

function observation(ageSec = 0, tempC = 25): WeatherObservation {
  const at = new Date(NOW.getTime() - ageSec * 1000).toISOString();
  return {
    locationId: '中正區',
    tempC,
    humidityPct: 84,
    heatwaveDays: 0,
    observedAt: at,
    fetchedAt: at,
    provider: 'Test provider',
  };
}

function reading(overrides: Partial<ReadingSnapshot> = {}): ReadingSnapshot {
  return {
    indoorTempC: 27,
    indoorHumidityPct: 62,
    outdoorTempC: 25,
    outdoorHumidityPct: 84,
    airQualityIndex: 58,
    heartRateBpm: 72,
    activityStepsPerHour: 200,
    skinTempC: 33.4,
    heatwaveDays: 0,
    simulated: true,
    timestamp: NOW.toISOString(),
    ...overrides,
  };
}

const household = () => ({ ...initialHousehold(PROFILE, BASELINE), at: NOW.toISOString() });

const healthy = (): WeatherHealth => recordSuccess(initialHealth(true), 120, NOW);

// ---------------------------------------------------------------------------
// Heatwave counting
// ---------------------------------------------------------------------------

describe('countHeatwaveDays', () => {
  it('counts the run of hot days ending at the most recent', () => {
    expect(countHeatwaveDays([30, 31, 36, 37, 35])).toBe(3);
  });

  it('is zero when the most recent day was not hot', () => {
    // A heatwave that ended is not a heatwave. The risk factor is about
    // accumulated load the body has not yet recovered from.
    expect(countHeatwaveDays([37, 38, 39, 28])).toBe(0);
  });

  it('uses the stated threshold', () => {
    expect(countHeatwaveDays([HEATWAVE_THRESHOLD_C])).toBe(1);
    expect(countHeatwaveDays([HEATWAVE_THRESHOLD_C - 0.1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('weather health', () => {
  it('starts NOT_CONFIGURED until someone connects a provider', () => {
    // The honest default. A checkout of this repository makes no outbound
    // requests, and the console says so rather than showing a placeholder.
    expect(initialHealth(false).state).toBe('NOT_CONFIGURED');
    expect(initialHealth(true).state).toBe('OFFLINE');
  });

  it('is DEGRADED while failing but still holding a usable observation', () => {
    const health = recordFailure(healthy(), 'ECONNREFUSED', observation(60), NOW);

    expect(health.state).toBe('DEGRADED');
    expect(health.lastError).toBe('ECONNREFUSED');
  });

  it('becomes OFFLINE after enough consecutive failures', () => {
    let health = healthy();
    for (let i = 0; i < WEATHER_TUNING.failuresBeforeOffline; i++) {
      health = recordFailure(health, 'timeout', observation(60), NOW);
    }

    expect(health.state).toBe('OFFLINE');
    expect(health.consecutiveFailures).toBe(WEATHER_TUNING.failuresBeforeOffline);
  });

  it('is OFFLINE immediately when there is no usable observation to fall back on', () => {
    expect(recordFailure(initialHealth(true), 'timeout', null, NOW).state).toBe('OFFLINE');
  });

  it('clears the failure run on recovery', () => {
    // A provider that recovers is healthy. Carrying old failures forward would
    // keep the indicator lit long after the problem passed, which teaches
    // operators to ignore it.
    const failing = recordFailure(healthy(), 'timeout', observation(60), NOW);
    const recovered = recordSuccess(failing, 90, NOW);

    expect(recovered.state).toBe('ONLINE');
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.lastError).toBeNull();
  });

  it('goes OFFLINE when the last observation quietly expires', () => {
    // A provider can rot without erroring. Nothing has failed here - the data
    // simply stopped being the present.
    const stale = observation(WEATHER_TUNING.observationValiditySec + 60);
    expect(refreshState(healthy(), stale, true, NOW).state).toBe('OFFLINE');
  });

  it('backs off exponentially, with a ceiling', () => {
    expect(backoffSec(1)).toBe(WEATHER_TUNING.backoffBaseSec);
    expect(backoffSec(2)).toBe(WEATHER_TUNING.backoffBaseSec * 2);
    expect(backoffSec(99)).toBe(WEATHER_TUNING.backoffMaxSec);
  });

  it('refuses to retry before the backoff has elapsed', () => {
    const failing = recordFailure(healthy(), 'timeout', observation(60), NOW);

    expect(mayAttempt(failing, true, NOW)).toBe(false);
    expect(mayAttempt(failing, true, new Date(NOW.getTime() + 60_000))).toBe(true);
  });

  it('never attempts anything while disabled', () => {
    expect(mayAttempt(healthy(), false, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Freshness bands
// ---------------------------------------------------------------------------

describe('weather freshness', () => {
  it('judges weather on the provider’s cadence, not a sensor’s', () => {
    /**
     * Providers publish hourly, so an eleven-minute-old observation is the
     * current one and the most recent that exists. Judged against the
     * sixty-second window used for household sensors it read STALE, which lit
     * the indicator for every resident minutes after a perfectly healthy
     * fetch - and an indicator that is always on stops being read.
     */
    const elevenMinutes = 11 * 60;

    expect(qualityFromAge(elevenMinutes, 'outdoorTempC')).toBe('LIVE');
    expect(qualityFromAge(elevenMinutes, 'indoorTempC')).toBe('STALE');
  });

  it('still calls genuinely old weather stale', () => {
    expect(qualityFromAge(WEATHER_FRESHNESS.recentSec + 60, 'outdoorTempC')).toBe('STALE');
  });
});

describe('observationIsCurrent', () => {
  it('accepts a recent observation and rejects an expired one', () => {
    expect(observationIsCurrent(observation(600), NOW)).toBe(true);
    expect(
      observationIsCurrent(observation(WEATHER_TUNING.observationValiditySec + 60), NOW),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The source, and what the rest of the platform sees
// ---------------------------------------------------------------------------

describe('weatherProviderSource', () => {
  it('supplies all three outdoor fields when healthy', () => {
    const report = weatherProviderSource('中正區', observation(600), healthy(), NOW).poll(
      household(),
    );

    expect(report.available).toBe(true);
    expect(report.origin).toBe('WEATHER_API');
    expect(report.simulated).toBe(false);
    expect(report.measurements.map((m) => m.field).sort()).toEqual([
      'heatwaveDays',
      'outdoorHumidityPct',
      'outdoorTempC',
    ]);
  });

  it('keeps serving its last observation while DEGRADED, but caps the label', () => {
    // The measurement is real, so holding it beats inventing a replacement.
    // What must change is the claim: nothing is keeping it current.
    const degraded = recordFailure(healthy(), 'timeout', observation(60), NOW);
    const report = weatherProviderSource('中正區', observation(60), degraded, NOW).poll(
      household(),
    );

    expect(report.available).toBe(true);
    expect(report.qualityCap).toBe('RECENT');
    expect(report.unavailableReasonZh).toContain('連線異常');
  });

  it('reports nothing once OFFLINE', () => {
    let offline = healthy();
    for (let i = 0; i < WEATHER_TUNING.failuresBeforeOffline; i++) {
      offline = recordFailure(offline, 'timeout', observation(60), NOW);
    }

    expect(
      weatherProviderSource('中正區', observation(60), offline, NOW).poll(household()).available,
    ).toBe(false);
  });

  it('says so plainly when no provider is connected', () => {
    const report = weatherProviderSource('中正區', null, initialHealth(false), NOW).poll(
      household(),
    );

    expect(report.available).toBe(false);
    expect(report.unavailableReasonZh).toContain('尚未連接');
  });
});

describe('degradation as the rest of the platform sees it', () => {
  const external = (health: WeatherHealth, obs: WeatherObservation | null) => ({
    byDeviceId: new Map(),
    realDeviceIds: new Set<string>(),
    extra: [weatherProviderSource('中正區', obs, health, NOW)],
    suppressSimulatedWeather: obs !== null,
  });

  it('a healthy provider reaches the reading as a real measurement', () => {
    const sources = sourcesForResident('user-001', [], external(healthy(), observation(600, 25)));

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(household())),
      previous: reading(),
      now: NOW,
    });

    expect(built.outdoorTempC).toBe(25);
    expect(provenance.fields.outdoorTempC.origin).toBe('WEATHER_API');
    expect(provenance.fields.outdoorTempC.quality).toBe('LIVE');
  });

  it('a DEGRADED provider keeps its value but loses its LIVE label', () => {
    const degraded = recordFailure(healthy(), 'timeout', observation(600), NOW);
    const sources = sourcesForResident('user-001', [], external(degraded, observation(600, 25)));

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(household())),
      previous: reading(),
      now: NOW,
    });

    expect(built.outdoorTempC).toBe(25);
    expect(provenance.fields.outdoorTempC.quality).toBe('RECENT');
  });

  it('an OFFLINE provider holds its value - the simulator does NOT take over', () => {
    /**
     * The rule this phase turns on, and the one the live gate caught me
     * getting wrong. When the provider died, the simulated weather source was
     * still in the set and won by default, replacing a real 25C with an
     * invented 34.5C labelled LIVE. Once a provider has delivered, its silence
     * is information - exactly as a household sensor's is.
     */
    let offline = healthy();
    for (let i = 0; i < WEATHER_TUNING.failuresBeforeOffline; i++) {
      offline = recordFailure(offline, 'timeout', observation(600), NOW);
    }

    const sources = sourcesForResident('user-001', [], external(offline, observation(600, 25)));

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll({ ...household(), outdoorTempC: 34.5 })),
      previous: reading({ outdoorTempC: 25 }),
      now: NOW,
    });

    expect(built.outdoorTempC).toBe(25);
    expect(built.outdoorTempC).not.toBe(34.5);
    expect(provenance.fields.outdoorTempC.origin).toBe('HELD');
    expect(provenance.fields.outdoorTempC.quality).toBe('OFFLINE');
  });

  it('falls back to the simulator when no provider has ever delivered', () => {
    // Enabling a provider that has not answered yet must not strand anyone.
    const sources = sourcesForResident('user-001', [], external(initialHealth(true), null));

    const { provenance } = assembleReading({
      reports: sources.map((s) => s.poll(household())),
      previous: reading(),
      now: NOW,
    });

    expect(provenance.fields.outdoorTempC.origin).toBe('SIMULATOR');
  });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('scenarioOverridesWeather', () => {
  it('bypasses a live feed for the focus resident during a scripted scenario', () => {
    /**
     * A demonstration works by driving outdoor temperature upward, which real
     * weather would overrule - so the demo would silently stop working. The
     * alternative, adding an offset to a real value and still calling it
     * WEATHER_API, would be a lie about where the number came from.
     */
    expect(scenarioOverridesWeather({ isFocus: true, scenario: 'FULL_DEMO' })).toBe(true);
  });

  it('leaves every other resident on the real feed', () => {
    expect(scenarioOverridesWeather({ isFocus: false, scenario: 'FULL_DEMO' })).toBe(false);
  });

  it('does not treat ambient drift as a scenario', () => {
    expect(scenarioOverridesWeather({ isFocus: true, scenario: 'AMBIENT' })).toBe(false);
    expect(scenarioOverridesWeather({ isFocus: true, scenario: null })).toBe(false);
  });
});

describe('applyObservation', () => {
  it('seeds a household from a real observation', () => {
    const seeded = applyObservation(household(), observation(0, 31.2));

    expect(seeded.outdoorTempC).toBe(31.2);
    expect(seeded.outdoorHumidityPct).toBe(84);
  });

  it('leaves the household alone when there is no observation', () => {
    const before = household();
    expect(applyObservation(before, null)).toBe(before);
  });
});
