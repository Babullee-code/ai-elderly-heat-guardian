/**
 * Input source and assembler tests.
 *
 * Phase 2 separated two things that used to be one function: what is
 * physically true in a home, and what its sensors managed to observe of it.
 * These tests pin the consequences of that split, which are the whole reason
 * for making it.
 *
 * The rule underneath all of them: the simulator imitates the SENSORS, never
 * the result. No source here can set a risk level, and no source can put a
 * number on screen that nothing produced.
 */

import { describe, expect, it } from 'vitest';
import {
  SOURCE_PRIORITY,
  assembleReading,
  environmentModelSource,
  simulatedDeviceSource,
  simulatedWeatherSource,
  sourcesForResident,
} from '../shared/domain/inputSources';
import {
  advanceHousehold,
  initialHousehold,
  tickHousehold,
} from '../shared/domain/simulationEngine';
import type {
  Device,
  DeviceStatus,
  DeviceType,
  HouseholdState,
  PersonalBaseline,
  ReadingSnapshot,
  SimulationState,
  SmartHomeState,
} from '../shared/types/domain';
import type { AmbientProfile } from '../shared/domain/simulationEngine';

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
  status: DeviceStatus = 'ONLINE',
  isActuator = false,
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
    isActuator,
    createdAt: NOW.toISOString(),
  };
}

function household(overrides: Partial<HouseholdState> = {}): HouseholdState {
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

function smartHome(acOn: boolean): SmartHomeState {
  const appliance = (present: boolean, on: boolean) => ({
    present,
    on,
    deviceId: null,
    disabled: false,
  });
  return {
    userId: 'user-001',
    ac: appliance(true, acOn),
    fan: appliance(true, false),
    dehumidifier: appliance(true, false),
    indoorTempC: 27,
    indoorHumidityPct: 62,
    targetTempC: 26,
    automaticallyEngaged: acOn,
    automationNote: '',
    automationNoteZh: '',
    userOverride: false,
  };
}

function simulation(overrides: Partial<SimulationState> = {}): SimulationState {
  return {
    running: true,
    scenario: 'AMBIENT',
    phase: 'NORMAL',
    phaseProgress: 0,
    elapsedSec: 0,
    tickMs: 2000,
    speed: 1,
    focusUserId: 'user-001',
    tickCount: 0,
    manualOffsets: { tempC: 0, humidityPct: 0, heartRateBpm: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe('simulatedDeviceSource', () => {
  it('reports the fields its hardware would measure', () => {
    const source = simulatedDeviceSource(device('SMART_WATCH'))!;
    const report = source.poll(household({ heartRateBpm: 91 }));

    expect(report.fields).toEqual(['heartRateBpm', 'activityStepsPerHour', 'skinTempC']);
    expect(report.measurements.find((m) => m.field === 'heartRateBpm')?.value).toBe(91);
    expect(report.available).toBe(true);
  });

  it('reports NOTHING when the device is down, rather than a stale number', () => {
    const source = simulatedDeviceSource(device('TEMPERATURE_SENSOR', 'OFFLINE'))!;
    const report = source.poll(household({ indoorTempC: 34 }));

    // A sensor that has lost power does not transmit an old value; it does not
    // transmit. What to show instead is the assembler's decision, not the
    // sensor's - which is exactly why this returns an empty list.
    expect(report.measurements).toEqual([]);
    expect(report.available).toBe(false);
    expect(report.unavailableReasonZh).toContain('離線');
  });

  it('distinguishes an administrator disabling a device from it failing', () => {
    const source = simulatedDeviceSource(device('TEMPERATURE_SENSOR', 'DISABLED'))!;
    expect(source.poll(household()).unavailableReasonZh).toContain('停用');
  });

  it('is not a source at all for an actuator', () => {
    expect(simulatedDeviceSource(device('SMART_AC', 'ONLINE', true))).toBeNull();
  });
});

describe('sourcesForResident', () => {
  it('excludes actuators, which measure nothing', () => {
    const sources = sourcesForResident('user-001', [
      device('TEMPERATURE_SENSOR'),
      device('SMART_AC', 'ONLINE', true),
    ]);

    expect(sources.some((s) => s.id.includes('SMART_AC'))).toBe(false);
  });

  it('always supplies weather and a fallback model', () => {
    const sources = sourcesForResident('user-001', []);
    expect(sources.some((s) => s.kind === 'WEATHER')).toBe(true);
    expect(sources.some((s) => s.kind === 'ENVIRONMENT_MODEL')).toBe(true);
  });

  it('ranks a real ingest above the simulator, and the model last', () => {
    // Phase 3 slots a real device in above the simulated one without touching
    // anything else; this ordering is the contract that makes that possible.
    expect(SOURCE_PRIORITY.INGEST).toBeLessThan(SOURCE_PRIORITY.SIMULATED_DEVICE);
    expect(SOURCE_PRIORITY.WEATHER_PROVIDER).toBeLessThan(SOURCE_PRIORITY.SIMULATED_WEATHER);
    expect(SOURCE_PRIORITY.ENVIRONMENT_MODEL).toBeGreaterThan(SOURCE_PRIORITY.SIMULATED_DEVICE);
  });
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe('assembleReading', () => {
  const state = household({ indoorTempC: 31.5, heartRateBpm: 88 });

  it('takes each field from the source responsible for it', () => {
    const sources = sourcesForResident('user-001', [
      device('TEMPERATURE_SENSOR'),
      device('SMART_WATCH'),
    ]);

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(state)),
      previous: reading(),
      now: NOW,
    });

    expect(built.indoorTempC).toBe(31.5);
    expect(built.heartRateBpm).toBe(88);
    expect(provenance.fields.indoorTempC.origin).toBe('SIMULATOR');
    expect(provenance.fields.indoorTempC.deviceId).toBe('HG-TEMPERATURE_SENSOR-0001');
  });

  it('holds the previous value when the responsible source goes quiet', () => {
    const sources = sourcesForResident('user-001', [
      device('TEMPERATURE_SENSOR', 'OFFLINE'),
    ]);

    const previous = reading({ indoorTempC: 28.2 });
    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(state)),
      previous,
      now: NOW,
    });

    expect(built.indoorTempC).toBe(28.2);
    expect(provenance.fields.indoorTempC.origin).toBe('HELD');
    expect(provenance.fields.indoorTempC.quality).toBe('OFFLINE');
  });

  it('does NOT let the environment model stand in for a failed sensor', () => {
    // The single most important rule in this file. A household WITH a
    // thermometer that has died must not have it quietly replaced by a
    // modelled guess: that hides the failure behind a plausible number, and
    // the resident is then told a temperature nobody measured.
    const sources = sourcesForResident('user-001', [
      device('TEMPERATURE_SENSOR', 'OFFLINE'),
    ]);

    const previous = reading({ indoorTempC: 28.2 });
    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(household({ indoorTempC: 36 }))),
      previous,
      now: NOW,
    });

    expect(built.indoorTempC).not.toBe(36);
    expect(built.indoorTempC).toBe(previous.indoorTempC);
    expect(provenance.fields.indoorTempC.origin).not.toBe('DEFAULT');
  });

  it('DOES use the model for a field no device covers', () => {
    // No air-quality sensor is installed, so nothing has failed and there is
    // nothing to hold. An inference is the honest answer, labelled as one.
    const sources = sourcesForResident('user-001', [device('TEMPERATURE_SENSOR')]);

    const { reading: built, provenance } = assembleReading({
      reports: sources.map((s) => s.poll(household({ airQualityIndex: 77 }))),
      previous: reading(),
      now: NOW,
    });

    expect(built.airQualityIndex).toBe(77);
    expect(provenance.fields.airQualityIndex.origin).toBe('DEFAULT');
    expect(provenance.estimatedFields).toContain('airQualityIndex');
    expect(provenance.degradedFields).not.toContain('airQualityIndex');
  });

  it('keeps a held value ageing from when it was actually measured', () => {
    const sources = sourcesForResident('user-001', [device('SMART_WATCH', 'OFFLINE')]);
    const measuredAt = new Date(NOW.getTime() - 6 * 60_000).toISOString();

    const first = assembleReading({
      reports: sourcesForResident('user-001', [device('SMART_WATCH')]).map((s) =>
        s.poll(household({ at: measuredAt })),
      ),
      previous: reading(),
      now: new Date(NOW.getTime() - 6 * 60_000),
    });

    const second = assembleReading({
      reports: sources.map((s) => s.poll(household())),
      previous: first.reading,
      previousProvenance: first.provenance,
      now: NOW,
    });

    // Six minutes since the watch last reported - not zero, and not the age of
    // the snapshot that carried the held value forward.
    expect(second.provenance.fields.heartRateBpm.ageSec).toBe(6 * 60);
  });

  it('reports nothing as current for a resident who is not monitored', () => {
    const sources = sourcesForResident('user-001', [device('TEMPERATURE_SENSOR')]);

    const { provenance } = assembleReading({
      reports: sources.map((s) => s.poll(state)),
      previous: reading(),
      now: NOW,
      monitored: false,
    });

    expect(provenance.worstQuality).toBe('OFFLINE');
    expect(provenance.fields.indoorTempC.noteZh).toContain('未納入監測');
  });
});

// ---------------------------------------------------------------------------
// Physics is independent of measurement
// ---------------------------------------------------------------------------

describe('advanceHousehold', () => {
  it('keeps heating a room whose thermometer is offline', () => {
    /**
     * The reason the split exists. Previously the physics resumed from the
     * last REPORTED value, so a dead sensor froze the simulated room - and
     * when the sensor came back it resumed from a temperature that was no
     * longer true. A room does not stop warming because nobody is watching.
     */
    let state = household({ indoorTempC: 27, outdoorTempC: 38 });
    let snapshot = reading({ indoorTempC: 27 });
    const devices = [device('TEMPERATURE_SENSOR', 'OFFLINE')];

    for (let i = 0; i < 40; i++) {
      const ticked = tickHousehold({
        userId: 'user-001',
        profile: { ...PROFILE, baseOutdoorTempC: 38 },
        baseline: BASELINE,
        previous: snapshot,
        household: state,
        smartHome: smartHome(false),
        devices,
        simulation: simulation(),
        isFocus: true,
      });
      state = ticked.household;
      snapshot = ticked.reading;
    }

    // The room really did get hotter...
    expect(state.indoorTempC).toBeGreaterThan(30);
    // ...and the platform still reports the last value it actually measured.
    expect(snapshot.indoorTempC).toBe(27);
  });

  it('shows the room as it is now when the sensor comes back', () => {
    let state = household({ indoorTempC: 27, outdoorTempC: 38 });
    let snapshot = reading({ indoorTempC: 27 });

    const run = (devices: Device[], ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        const ticked = tickHousehold({
          userId: 'user-001',
          profile: { ...PROFILE, baseOutdoorTempC: 38 },
          baseline: BASELINE,
          previous: snapshot,
          household: state,
          smartHome: smartHome(false),
          devices,
          simulation: simulation(),
          isFocus: true,
        });
        state = ticked.household;
        snapshot = ticked.reading;
      }
    };

    run([device('TEMPERATURE_SENSOR', 'OFFLINE')], 40);
    run([device('TEMPERATURE_SENSOR', 'ONLINE')], 1);

    // One tick after reconnecting, the reading jumps to the truth rather than
    // creeping up from the value it was frozen at.
    expect(snapshot.indoorTempC).toBe(state.indoorTempC);
    expect(snapshot.indoorTempC).toBeGreaterThan(30);
  });

  it('does not care whether any sensors exist', () => {
    const before = household({ indoorTempC: 27, outdoorTempC: 39 });
    const after = advanceHousehold({
      profile: { ...PROFILE, baseOutdoorTempC: 39 },
      baseline: BASELINE,
      previous: before,
      smartHome: smartHome(false),
      simulation: simulation(),
      isFocus: true,
    });

    expect(after.indoorTempC).toBeGreaterThan(before.indoorTempC);
  });
});

describe('simulatedWeatherSource and environmentModelSource', () => {
  it('does not claim a weather provider that is not connected', () => {
    const report = simulatedWeatherSource('user-001').poll(household());
    expect(report.origin).toBe('SIMULATOR');
    expect(report.origin).not.toBe('WEATHER_API');
  });

  it('marks the environment model as a gap-filler, not a measurement', () => {
    const report = environmentModelSource('user-001').poll(household());
    expect(report.fallback).toBe(true);
    expect(report.origin).toBe('DEFAULT');
  });
});
