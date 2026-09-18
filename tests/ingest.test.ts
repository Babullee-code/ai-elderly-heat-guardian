/**
 * Ingest tests.
 *
 * Phase 3 opened a door into the platform from outside. These tests are mostly
 * about what does NOT get through it: a monitoring system that scores whatever
 * arrives is not measuring anything, and one that lets the simulator quietly
 * cover for a failed real sensor is worse than one with no sensors at all.
 */

import { describe, expect, it } from 'vitest';
import {
  INGEST_VALIDITY_SEC,
  MAX_BACKDATE_SEC,
  assimilate,
  deviceIsReal,
  ingestSource,
  validateIngest,
} from '../shared/domain/ingest';
import { assembleReading, sourcesForResident } from '../shared/domain/inputSources';
import { initialHousehold } from '../shared/domain/simulationEngine';
import type { AmbientProfile } from '../shared/domain/simulationEngine';
import type {
  Device,
  DeviceStatus,
  DeviceType,
  PersonalBaseline,
  ReadingSnapshot,
} from '../shared/types/domain';

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

function device(
  type: DeviceType,
  overrides: Partial<Device> = {},
  status: DeviceStatus = 'ONLINE',
): Device {
  return {
    id: `dev-${type}`,
    deviceId: `HG-${type}-0001`,
    name: type,
    nameZh: '測試裝置',
    type,
    userId: 'user-001',
    status,
    batteryPct: 80,
    signalPct: 90,
    lastSeen: NOW.toISOString(),
    firmware: '1.0.0',
    location: '客廳',
    power: true,
    isActuator: false,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function household(overrides = {}) {
  return { ...initialHousehold(PROFILE, BASELINE), at: NOW.toISOString(), ...overrides };
}

function reading(overrides: Partial<ReadingSnapshot> = {}): ReadingSnapshot {
  return {
    indoorTempC: 27,
    indoorHumidityPct: 62,
    outdoorTempC: 29,
    outdoorHumidityPct: 66,
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateIngest', () => {
  const temp = device('TEMPERATURE_SENSOR');
  const watch = device('SMART_WATCH');

  it('accepts a plausible value for a field the device measures', () => {
    const result = validateIngest({ device: temp, values: { indoorTempC: 34.2 }, now: NOW });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      { field: 'indoorTempC', value: 34.2, observedAt: NOW.toISOString() },
    ]);
  });

  it('refuses a field the device has no hardware for', () => {
    // A thermometer claiming to know a heart rate is either broken or lying.
    // Either way the value must not reach the risk engine.
    const result = validateIngest({ device: temp, values: { heartRateBpm: 150 }, now: NOW });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].code).toBe('FIELD_NOT_PERMITTED');
  });

  it('refuses a physically impossible value', () => {
    // 200C is evidence of a broken sensor, not of a dangerous room. Scoring it
    // would raise an emergency that buries the real ones.
    const result = validateIngest({ device: temp, values: { indoorTempC: 200 }, now: NOW });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].code).toBe('OUT_OF_RANGE');
  });

  it('refuses a value that is not a number', () => {
    const result = validateIngest({ device: temp, values: { indoorTempC: '34' }, now: NOW });
    expect(result.rejected[0].code).toBe('NOT_A_NUMBER');
  });

  it('refuses a field the platform does not record at all', () => {
    const result = validateIngest({ device: temp, values: { windSpeed: 12 }, now: NOW });
    expect(result.rejected[0].code).toBe('UNKNOWN_FIELD');
  });

  it('accepts a short backlog but refuses yesterday', () => {
    const recent = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const ancient = new Date(NOW.getTime() - (MAX_BACKDATE_SEC + 60) * 1000).toISOString();

    expect(
      validateIngest({ device: temp, values: { indoorTempC: 30 }, observedAt: recent, now: NOW })
        .accepted,
    ).toHaveLength(1);

    expect(
      validateIngest({ device: temp, values: { indoorTempC: 30 }, observedAt: ancient, now: NOW })
        .rejected[0].code,
    ).toBe('TOO_OLD');
  });

  it('refuses a measurement dated in the future', () => {
    const ahead = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const result = validateIngest({
      device: temp,
      values: { indoorTempC: 30 },
      observedAt: ahead,
      now: NOW,
    });

    expect(result.rejected[0].code).toBe('IN_FUTURE');
  });

  it('accepts the good values and refuses the bad ones in the same payload', () => {
    // Rejecting the whole batch would discard a genuine heart rate because of
    // an unrelated fault in the same device.
    const result = validateIngest({
      device: watch,
      values: { heartRateBpm: 96, skinTempC: 900 },
      now: NOW,
    });

    expect(result.accepted.map((m) => m.field)).toEqual(['heartRateBpm']);
    expect(result.rejected.map((r) => r.field)).toEqual(['skinTempC']);
  });
});

// ---------------------------------------------------------------------------
// The ingest source
// ---------------------------------------------------------------------------

describe('ingestSource', () => {
  const temp = device('TEMPERATURE_SENSOR');

  const posted = (ageSec: number, value = 34.2) => ({
    deviceId: temp.deviceId,
    measurements: [
      {
        field: 'indoorTempC' as const,
        value,
        observedAt: new Date(NOW.getTime() - ageSec * 1000).toISOString(),
      },
    ],
    receivedAt: new Date(NOW.getTime() - ageSec * 1000).toISOString(),
  });

  it('reports a recent measurement, and says it is not simulated', () => {
    const report = ingestSource(temp, posted(30), NOW).poll(household());

    expect(report.available).toBe(true);
    expect(report.origin).toBe('DEVICE');
    expect(report.simulated).toBe(false);
    expect(report.measurements[0].value).toBe(34.2);
  });

  it('stops reporting once its measurement is past the validity window', () => {
    const report = ingestSource(temp, posted(INGEST_VALIDITY_SEC + 60), NOW).poll(household());

    expect(report.available).toBe(false);
    expect(report.unavailableReasonZh).toContain('尚未回報');
  });

  it('is unavailable for a device that has never posted', () => {
    expect(ingestSource(temp, undefined, NOW).poll(household()).available).toBe(false);
  });
});

describe('deviceIsReal', () => {
  it('is false until the device has actually posted something', () => {
    // Issuing a key is an intention; posting a reading is evidence.
    expect(deviceIsReal(device('TEMPERATURE_SENSOR', { ingestKeyPrefix: 'hgk_abc' }))).toBe(false);
    expect(deviceIsReal(device('TEMPERATURE_SENSOR', { lastIngestAt: NOW.toISOString() }))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Precedence: what the assembler does with a real device
// ---------------------------------------------------------------------------

describe('ingest precedence', () => {
  const state = household({ indoorTempC: 27 });

  const external = (dev: Device, ingested?: Parameters<typeof ingestSource>[1]) => ({
    byDeviceId: new Map([[dev.id, ingestSource(dev, ingested, NOW)]]),
    realDeviceIds: new Set(deviceIsReal(dev) ? [dev.id] : []),
  });

  const fresh = (value: number) => ({
    deviceId: 'HG-TEMPERATURE_SENSOR-0001',
    measurements: [
      { field: 'indoorTempC' as const, value, observedAt: NOW.toISOString() },
    ],
    receivedAt: NOW.toISOString(),
  });

  it('a real measurement beats the simulator', () => {
    const dev = device('TEMPERATURE_SENSOR', { lastIngestAt: NOW.toISOString() });
    const sources = sourcesForResident('user-001', [dev], external(dev, fresh(41.5)));

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(state)),
      previous: reading(),
      now: NOW,
    });

    expect(built.indoorTempC).toBe(41.5);
    expect(provenance.fields.indoorTempC.origin).toBe('DEVICE');
    expect(provenance.fields.indoorTempC.simulated).toBe(false);
  });

  it('the simulator still stands in for a device that has never reported', () => {
    // Issuing a key must not strand a household. Until real data arrives the
    // simulated value is used, and labelled as simulated.
    const dev = device('TEMPERATURE_SENSOR', { ingestKeyPrefix: 'hgk_abc' });
    const sources = sourcesForResident('user-001', [dev], external(dev));

    const { provenance } = assembleReading({
      reports: sources.map((s) => s.poll(state)),
      previous: reading(),
      now: NOW,
    });

    expect(provenance.fields.indoorTempC.origin).toBe('SIMULATOR');
  });

  it('the simulator does NOT take back over when a real device goes quiet', () => {
    /**
     * The rule this phase turns on. Once a device has proved it reports for
     * itself, its silence is information. Filling the gap with a simulated
     * number that looks exactly like a measurement would hide a failed sensor
     * in someone's home behind a plausible reading.
     */
    const dev = device('TEMPERATURE_SENSOR', { lastIngestAt: NOW.toISOString() });
    const stale = {
      deviceId: dev.deviceId,
      measurements: [
        {
          field: 'indoorTempC' as const,
          value: 41.5,
          observedAt: new Date(NOW.getTime() - (INGEST_VALIDITY_SEC + 60) * 1000).toISOString(),
        },
      ],
      receivedAt: NOW.toISOString(),
    };

    const sources = sourcesForResident('user-001', [dev], external(dev, stale));

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(state)),
      previous: reading({ indoorTempC: 41.5 }),
      now: NOW,
    });

    expect(provenance.fields.indoorTempC.origin).toBe('HELD');
    expect(provenance.fields.indoorTempC.quality).toBe('OFFLINE');
    expect(built.indoorTempC).toBe(41.5);
    // Emphatically not the simulated room temperature.
    expect(built.indoorTempC).not.toBe(state.indoorTempC);
  });
});

// ---------------------------------------------------------------------------
// Assimilation
// ---------------------------------------------------------------------------

describe('assimilate', () => {
  it('corrects the model with what was really measured', () => {
    const dev = device('TEMPERATURE_SENSOR', { lastIngestAt: NOW.toISOString() });
    const report = ingestSource(dev, {
      deviceId: dev.deviceId,
      measurements: [
        { field: 'indoorTempC', value: 41.5, observedAt: NOW.toISOString() },
      ],
      receivedAt: NOW.toISOString(),
    }, NOW).poll(household());

    const corrected = assimilate(household({ indoorTempC: 27 }), [report]);

    // Without this the screen would show 41.5C while the model went on
    // believing the room was 27C - and heart rate, which the model drives from
    // indoor temperature, would be computed from the wrong number.
    expect(corrected.indoorTempC).toBe(41.5);
  });

  it('leaves fields nothing reported alone', () => {
    const before = household({ indoorTempC: 27, heartRateBpm: 70 });
    const after = assimilate(before, []);

    expect(after).toBe(before);
  });
});
