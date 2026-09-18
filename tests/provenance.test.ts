/**
 * Reading provenance tests.
 *
 * The platform already held the last value when a sensor dropped out rather
 * than inventing a new one. What it could not do was *say so per field*: one
 * `simulated` flag and one timestamp covered all nine measurements, so a
 * four-minute-old heart rate rendered exactly like a three-second-old indoor
 * temperature.
 *
 * These tests pin the part that matters in a safety product: a held value is
 * never reported as current, and the age shown is the age of the measurement
 * rather than the age of the snapshot that carried it.
 */

import { describe, expect, it } from 'vitest';
import {
  FRESHNESS,
  MEASUREMENT_FIELDS,
  buildProvenance,
  defaultProvenance,
  isHeldQuality,
  primaryFieldForDevice,
  estimatedSummaryZh,
  provenanceSummaryZh,
  qualityFromAge,
} from '../shared/domain/provenance';
import { assessRisk } from '../shared/domain/riskEngine';
import { cloneDefaultConfig } from '../shared/domain/config';
import type {
  Device,
  DeviceStatus,
  DeviceType,
  PersonalBaseline,
  ReadingSnapshot,
} from '../shared/types/domain';

const NOW = new Date('2026-09-17T14:00:00Z');

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
    timestamp: NOW.toISOString(),
    ...overrides,
  };
}

function device(
  type: DeviceType,
  status: DeviceStatus = 'ONLINE',
  lastSeenMinutesAgo = 0,
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
    lastSeen: new Date(NOW.getTime() - lastSeenMinutesAgo * 60_000).toISOString(),
    firmware: '1.0.0',
    location: '客廳',
    power: true,
    isActuator: false,
    createdAt: NOW.toISOString(),
  };
}

const ALL_SENSORS = [
  device('TEMPERATURE_SENSOR'),
  device('HUMIDITY_SENSOR'),
  device('AIR_QUALITY_SENSOR'),
  device('SMART_WATCH'),
];

// ---------------------------------------------------------------------------

describe('qualityFromAge', () => {
  it('calls a value within the live window current', () => {
    expect(qualityFromAge(0)).toBe('LIVE');
    expect(qualityFromAge(FRESHNESS.liveSec)).toBe('LIVE');
  });

  it('calls a value past the live window recent but still usable', () => {
    expect(qualityFromAge(FRESHNESS.liveSec + 1)).toBe('RECENT');
    expect(qualityFromAge(FRESHNESS.recentSec)).toBe('RECENT');
  });

  it('calls a value past the recent window stale', () => {
    expect(qualityFromAge(FRESHNESS.recentSec + 1)).toBe('STALE');
    expect(qualityFromAge(86_400)).toBe('STALE');
  });
});

describe('buildProvenance', () => {
  it('covers every measured field', () => {
    const p = buildProvenance({ reading: reading(), devices: ALL_SENSORS, simulated: true, now: NOW });
    for (const field of MEASUREMENT_FIELDS) {
      expect(p.fields[field]).toBeDefined();
      expect(p.fields[field].field).toBe(field);
    }
  });

  it('reports a fresh reading from online devices as live', () => {
    const p = buildProvenance({ reading: reading(), devices: ALL_SENSORS, simulated: true, now: NOW });

    expect(p.worstQuality).toBe('LIVE');
    expect(p.degradedFields).toEqual([]);
    expect(p.fields.indoorTempC.quality).toBe('LIVE');
    expect(p.fields.indoorTempC.deviceId).toBe('HG-TEMPERATURE_SENSOR-0001');
  });

  it('marks only the offline device’s fields as held, not the whole reading', () => {
    const devices = [
      device('TEMPERATURE_SENSOR'),
      device('HUMIDITY_SENSOR'),
      device('AIR_QUALITY_SENSOR'),
      device('SMART_WATCH', 'OFFLINE', 4),
    ];

    const p = buildProvenance({ reading: reading(), devices, simulated: true, now: NOW });

    // The wearable's three fields are held...
    for (const field of ['heartRateBpm', 'activityStepsPerHour', 'skinTempC'] as const) {
      expect(p.fields[field].quality).toBe('OFFLINE');
      expect(p.fields[field].origin).toBe('HELD');
    }

    // ...while the household sensors are unaffected. This is the distinction
    // the single `simulated` flag could not express.
    expect(p.fields.indoorTempC.quality).toBe('LIVE');
    expect(p.fields.indoorHumidityPct.quality).toBe('LIVE');
    expect(p.worstQuality).toBe('OFFLINE');
  });

  it('ages a held value from the device’s last contact, not the snapshot', () => {
    const devices = [device('SMART_WATCH', 'OFFLINE', 7)];
    const p = buildProvenance({ reading: reading(), devices, simulated: true, now: NOW });

    // The snapshot is current; the measurement inside it is seven minutes old,
    // and it is the measurement's age a caregiver needs.
    expect(p.fields.heartRateBpm.ageSec).toBe(7 * 60);
    expect(p.fields.heartRateBpm.observedAt).toBe(devices[0].lastSeen);
  });

  it('treats an administrator-disabled device as offline, with its own reason', () => {
    const devices = [device('TEMPERATURE_SENSOR', 'DISABLED', 2)];
    const p = buildProvenance({ reading: reading(), devices, simulated: true, now: NOW });

    expect(p.fields.indoorTempC.quality).toBe('OFFLINE');
    expect(p.fields.indoorTempC.noteZh).toContain('停用');
  });

  it('reports a field with no installed sensor as a current estimate, not a fault', () => {
    const p = buildProvenance({ reading: reading(), devices: [], simulated: true, now: NOW });

    // 42 of the 50 seeded households have no air-quality sensor. Calling that
    // OFFLINE would put almost every resident in a permanent warning state and
    // teach readers to ignore the badge - so nothing has failed here, and the
    // value is fresh; what is true is that it was modelled, not measured.
    expect(p.fields.indoorTempC.origin).toBe('DEFAULT');
    expect(p.fields.indoorTempC.quality).toBe('LIVE');
    expect(p.estimatedFields).toContain('indoorTempC');
    expect(p.degradedFields).not.toContain('indoorTempC');
  });

  it('separates a value that stopped updating from one that was never measured', () => {
    const devices = [
      device('TEMPERATURE_SENSOR'),
      // No humidity sensor installed at all.
      device('SMART_WATCH', 'OFFLINE', 5),
    ];
    const p = buildProvenance({ reading: reading(), devices, simulated: true, now: NOW });

    expect(p.degradedFields).toContain('heartRateBpm');
    expect(p.degradedFields).not.toContain('indoorHumidityPct');
    expect(p.estimatedFields).toContain('indoorHumidityPct');
    expect(p.estimatedFields).not.toContain('heartRateBpm');
  });

  it('does not claim a weather service that is not connected', () => {
    const p = buildProvenance({ reading: reading(), devices: ALL_SENSORS, simulated: true, now: NOW });

    // Until a provider is wired up, outdoor values are simulated and say so.
    expect(p.fields.outdoorTempC.origin).toBe('SIMULATOR');
    expect(p.fields.outdoorTempC.origin).not.toBe('WEATHER_API');
    expect(p.anySimulated).toBe(true);
  });

  it('reports an unmonitored resident as offline rather than as slightly old', () => {
    const p = buildProvenance({
      reading: reading(),
      devices: ALL_SENSORS,
      simulated: true,
      monitored: false,
      now: NOW,
    });

    // A suspended resident's reading is frozen: nothing refreshes it. Calling
    // it RECENT would imply someone is still watching, which is the opposite
    // of what "not monitored" means.
    expect(p.worstQuality).toBe('OFFLINE');
    expect(p.fields.indoorTempC.quality).toBe('OFFLINE');
    expect(p.fields.indoorTempC.noteZh).toContain('未納入監測');
  });

  it('degrades a field whose snapshot has gone stale even while the device is up', () => {
    const old = reading({
      timestamp: new Date(NOW.getTime() - (FRESHNESS.recentSec + 60) * 1000).toISOString(),
    });
    const p = buildProvenance({ reading: old, devices: ALL_SENSORS, simulated: true, now: NOW });

    expect(p.fields.indoorTempC.quality).toBe('STALE');
    expect(p.worstQuality).toBe('STALE');
  });
});

describe('provenanceSummaryZh', () => {
  it('says nothing when every value is current', () => {
    const p = buildProvenance({ reading: reading(), devices: ALL_SENSORS, simulated: true, now: NOW });
    expect(provenanceSummaryZh(p)).toBeNull();
  });

  it('does not raise a freshness warning about a household with no sensor', () => {
    const p = buildProvenance({ reading: reading(), devices: [], simulated: true, now: NOW });

    expect(provenanceSummaryZh(p)).toBeNull();
    expect(estimatedSummaryZh(p)).toContain('推估');
  });

  it('names the fields that cannot be updated', () => {
    const devices = [
      device('TEMPERATURE_SENSOR'),
      device('HUMIDITY_SENSOR'),
      device('AIR_QUALITY_SENSOR'),
      device('SMART_WATCH', 'OFFLINE', 5),
    ];
    const summary = provenanceSummaryZh(
      buildProvenance({ reading: reading(), devices, simulated: true, now: NOW }),
    );

    expect(summary).toContain('心率');
    expect(summary).toContain('最後一次讀值');
  });
});

describe('primaryFieldForDevice', () => {
  it('maps each sensor type to the field an operator watches', () => {
    expect(primaryFieldForDevice('TEMPERATURE_SENSOR')).toBe('indoorTempC');
    expect(primaryFieldForDevice('HUMIDITY_SENSOR')).toBe('indoorHumidityPct');
    expect(primaryFieldForDevice('AIR_QUALITY_SENSOR')).toBe('airQualityIndex');
    expect(primaryFieldForDevice('SMART_WATCH')).toBe('heartRateBpm');
  });

  it('returns nothing for an actuator, which measures nothing', () => {
    expect(primaryFieldForDevice('SMART_AC')).toBeNull();
  });
});

describe('isHeldQuality', () => {
  it('treats stale and offline as held, live and recent as current', () => {
    expect(isHeldQuality('OFFLINE')).toBe(true);
    expect(isHeldQuality('STALE')).toBe(true);
    expect(isHeldQuality('RECENT')).toBe(false);
    expect(isHeldQuality('LIVE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration with the risk engine
// ---------------------------------------------------------------------------

describe('assessRisk provenance', () => {
  const baseline: PersonalBaseline = {
    userId: 'user-001',
    heartRate: { min: 64, max: 82, mean: 72 },
    skinTemp: { min: 32.8, max: 34.1, mean: 33.4 },
    activityStepsPerHour: { min: 60, max: 340, mean: 200 },
    sampleCount: 60,
    confidence: 0.9,
    learnedAt: NOW.toISOString(),
  };

  it('carries the provenance it was given', () => {
    const devices = [device('SMART_WATCH', 'OFFLINE', 6)];
    const provenance = buildProvenance({
      reading: reading(),
      devices,
      simulated: true,
      now: NOW,
    });

    const result = assessRisk({
      userId: 'user-001',
      reading: reading(),
      baseline,
      config: cloneDefaultConfig(),
      history: [],
      previousLevel: null,
      provenance,
    });

    expect(result.provenance.fields.heartRateBpm.quality).toBe('OFFLINE');
  });

  it('still produces provenance when a caller supplies none', () => {
    const result = assessRisk({
      userId: 'user-001',
      reading: reading(),
      baseline,
      config: cloneDefaultConfig(),
      history: [],
      previousLevel: null,
    });

    // Optional input, always-present output: no screen has to cope with a
    // missing answer, and the 133 pre-existing tests keep their signature.
    expect(result.provenance).toBeDefined();
    expect(result.provenance.anySimulated).toBe(true);
  });

  it('does not let data quality change the score', () => {
    const shared = reading();
    const config = cloneDefaultConfig();

    const live = assessRisk({
      userId: 'user-001',
      reading: shared,
      baseline,
      config,
      history: [],
      previousLevel: null,
      provenance: buildProvenance({
        reading: shared,
        devices: ALL_SENSORS,
        simulated: true,
        now: NOW,
      }),
    });

    const degraded = assessRisk({
      userId: 'user-001',
      reading: shared,
      baseline,
      config,
      history: [],
      previousLevel: null,
      provenance: buildProvenance({
        reading: shared,
        devices: [device('SMART_WATCH', 'OFFLINE', 9)],
        simulated: true,
        now: NOW,
      }),
    });

    // Phase 1 is additive by design. Provenance describes the inputs; it must
    // not silently become a sixth risk factor, or the current score would stop
    // being reproducible.
    expect(degraded.score).toBe(live.score);
    expect(degraded.level).toBe(live.level);
  });
});

describe('defaultProvenance', () => {
  it('reports a device-less reading honestly rather than as live hardware', () => {
    const p = defaultProvenance(reading(), NOW);

    expect(p.fields.heartRateBpm.origin).toBe('DEFAULT');
    expect(p.anySimulated).toBe(true);
  });
});
