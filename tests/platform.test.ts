/**
 * Permissions, cooling-space recommendation, notification rendering and
 * simulation tests.
 */

import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSIONS,
  canAccessAdmin,
  canAccessCaregiver,
  hasPermission,
} from '../shared/domain/permissions';
import {
  haversineKm,
  isOpenNow,
  recommendCoolingSpaces,
  walkingMinutes,
} from '../shared/domain/coolingSpaces';
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  buildTemplateVars,
  interpolate,
  renderNotification,
  templateKeyForLevel,
} from '../shared/domain/notificationEngine';
import {
  SCENARIOS,
  initialReading,
  resolvePhase,
  scenarioDurationSec,
  tickReadings,
  type AmbientProfile,
} from '../shared/domain/simulationEngine';
import { calculateHeatIndex } from '../shared/domain/heatIndex';
import type {
  CoolingSpace,
  Device,
  PersonalBaseline,
  RiskLevel,
  SimulationState,
  SmartHomeState,
} from '../shared/types/domain';

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('role-based permissions', () => {
  it('gives SUPER_ADMIN everything', () => {
    expect(hasPermission('SUPER_ADMIN', 'risk-rule:write')).toBe(true);
    expect(hasPermission('SUPER_ADMIN', 'account:write')).toBe(true);
    expect(hasPermission('SUPER_ADMIN', 'simulation:control')).toBe(true);
  });

  it('withholds account management from ADMIN', () => {
    expect(hasPermission('ADMIN', 'risk-rule:write')).toBe(true);
    expect(hasPermission('ADMIN', 'account:write')).toBe(false);
  });

  it('makes VIEWER strictly read-only', () => {
    const writes = ROLE_PERMISSIONS.VIEWER.filter((p) => !p.endsWith(':read'));
    expect(writes).toHaveLength(0);
    expect(hasPermission('VIEWER', 'risk-rule:read')).toBe(true);
    expect(hasPermission('VIEWER', 'risk-rule:write')).toBe(false);
  });

  it('limits CAREGIVER to care-related capabilities', () => {
    expect(hasPermission('CAREGIVER', 'user:read')).toBe(true);
    expect(hasPermission('CAREGIVER', 'alert:write')).toBe(true);
    expect(hasPermission('CAREGIVER', 'user:write')).toBe(false);
    expect(hasPermission('CAREGIVER', 'risk-rule:write')).toBe(false);
    expect(hasPermission('CAREGIVER', 'audit:read')).toBe(false);
  });

  it('EXPOSES NO ADMIN SURFACE to an elderly user', () => {
    expect(canAccessAdmin('ELDER')).toBe(false);
    expect(hasPermission('ELDER', 'user:write')).toBe(false);
    expect(hasPermission('ELDER', 'risk-rule:read')).toBe(false);
    expect(hasPermission('ELDER', 'audit:read')).toBe(false);
    expect(hasPermission('ELDER', 'device:write')).toBe(false);
  });

  it('gates the admin and caregiver surfaces by role', () => {
    expect(canAccessAdmin('SUPER_ADMIN')).toBe(true);
    expect(canAccessAdmin('ADMIN')).toBe(true);
    expect(canAccessAdmin('VIEWER')).toBe(true);
    expect(canAccessAdmin('CAREGIVER')).toBe(false);

    expect(canAccessCaregiver('CAREGIVER')).toBe(true);
    expect(canAccessCaregiver('ELDER')).toBe(false);
  });

  it('never grants simulation control to a non-staff role', () => {
    expect(hasPermission('ELDER', 'simulation:control')).toBe(false);
    expect(hasPermission('CAREGIVER', 'simulation:control')).toBe(false);
    expect(hasPermission('VIEWER', 'simulation:control')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cooling spaces
// ---------------------------------------------------------------------------

function space(overrides: Partial<CoolingSpace> = {}): CoolingSpace {
  return {
    id: 'cool-1',
    name: '測試圖書館',
    nameEn: 'Test Library',
    type: 'LIBRARY',
    address: '台北市大安區',
    district: '大安區',
    lat: 25.0263,
    lng: 121.5436,
    riskLevel: 'LOW',
    airConditioned: true,
    accessible: true,
    accessibilityNotes: '',
    openingHours: '08:00 - 21:00',
    opensAt: '08:00',
    closesAt: '21:00',
    contact: '02-1234567',
    capacity: 200,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A resident at the reference coordinate, with all consents granted. */
function resident(locationSharing = true) {
  return {
    lat: 25.0263,
    lng: 121.5436,
    permissions: {
      automaticCooling: true,
      caregiverNotifications: true,
      locationSharing,
      physiologicalDataStorage: true,
      cityDataContribution: true,
    },
  };
}

const USER = resident();

describe('haversineKm', () => {
  it('returns zero for identical points', () => {
    expect(haversineKm({ lat: 25, lng: 121 }, { lat: 25, lng: 121 })).toBeCloseTo(0, 3);
  });

  it('measures a known short distance', () => {
    // ~0.01 degrees of latitude is roughly 1.11 km.
    expect(haversineKm({ lat: 25, lng: 121 }, { lat: 25.01, lng: 121 })).toBeCloseTo(1.11, 1);
  });
});

describe('walkingMinutes', () => {
  it('uses an elderly walking pace, not a healthy-adult one', () => {
    // 1 km at 3.2 km/h is ~19 minutes, not the ~12 a 5 km/h pace would give.
    expect(walkingMinutes(1)).toBeGreaterThan(15);
    expect(walkingMinutes(1)).toBeLessThan(22);
  });

  it('never reports less than a minute', () => {
    expect(walkingMinutes(0.001)).toBeGreaterThanOrEqual(1);
  });
});

describe('isOpenNow', () => {
  it('handles a normal daytime window', () => {
    const s = space({ opensAt: '08:00', closesAt: '21:00' });
    expect(isOpenNow(s, new Date('2026-09-10T12:00:00'))).toBe(true);
    expect(isOpenNow(s, new Date('2026-09-10T06:00:00'))).toBe(false);
    expect(isOpenNow(s, new Date('2026-09-10T22:00:00'))).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    const s = space({ opensAt: '22:00', closesAt: '06:00' });
    expect(isOpenNow(s, new Date('2026-09-10T23:00:00'))).toBe(true);
    expect(isOpenNow(s, new Date('2026-09-10T03:00:00'))).toBe(true);
    expect(isOpenNow(s, new Date('2026-09-10T12:00:00'))).toBe(false);
  });
});

describe('recommendCoolingSpaces', () => {
  it('PRIVACY: returns nothing when the resident has not shared location', () => {
    const result = recommendCoolingSpaces({
      user: resident(false),
      spaces: [space()],
      level: 'HIGH',
    });
    expect(result).toHaveLength(0);
  });

  it('CMS CONTROL: excludes spaces the admin has disabled', () => {
    const result = recommendCoolingSpaces({
      user: USER,
      spaces: [space({ id: 'a' }), space({ id: 'b', status: 'DISABLED' })],
      level: 'MEDIUM',
    });

    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('prefers an air-conditioned space over a nearer park at elevated risk', () => {
    const park = space({
      id: 'park',
      name: '公園',
      type: 'PARK',
      airConditioned: false,
      riskLevel: 'MEDIUM',
      lat: 25.0264,
      lng: 121.5437, // very close
    });
    const library = space({
      id: 'library',
      airConditioned: true,
      lat: 25.032,
      lng: 121.549, // further away
      opensAt: '00:00',
      closesAt: '24:00',
    });

    const result = recommendCoolingSpaces({
      user: USER,
      spaces: [park, library],
      level: 'HIGH',
      now: new Date('2026-09-10T14:00:00'),
    });

    expect(result[0].id).toBe('library');
  });

  it('excludes spaces beyond the distance limit', () => {
    const far = space({ id: 'far', lat: 25.2, lng: 121.8 });
    const result = recommendCoolingSpaces({
      user: USER,
      spaces: [far],
      level: 'HIGH',
      maxDistanceKm: 5,
    });
    expect(result).toHaveLength(0);
  });

  it('ranks an open space above an identical closed one', () => {
    const open = space({ id: 'open', opensAt: '00:00', closesAt: '24:00' });
    const closed = space({ id: 'closed', opensAt: '01:00', closesAt: '02:00' });

    const result = recommendCoolingSpaces({
      user: USER,
      spaces: [closed, open],
      level: 'MEDIUM',
      now: new Date('2026-09-10T14:00:00'),
    });

    expect(result[0].id).toBe('open');
    expect(result[0].openNow).toBe(true);
  });

  it('explains why each space was recommended', () => {
    const result = recommendCoolingSpaces({ user: USER, spaces: [space()], level: 'MEDIUM' });
    expect(result[0].reasonZh).toBeTruthy();
    expect(result[0].walkingMinutes).toBeGreaterThan(0);
  });

  it('honours the result limit', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      space({ id: `s${i}`, lat: 25.0263 + i * 0.0005 }),
    );
    expect(recommendCoolingSpaces({ user: USER, spaces: many, level: 'LOW', limit: 5 })).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('notification rendering', () => {
  const vars = buildTemplateVars({
    userName: '王奶奶',
    assessment: {
      level: 'HIGH',
      heatIndex: 40.2,
      readings: { indoorTempC: 34.1, indoorHumidityPct: 81 } as never,
      baseline: { heartRateBpm: 99, deviationPct: 21 } as never,
    },
  });

  it('interpolates known variables', () => {
    expect(interpolate('{{user}} 熱指數 {{heatIndex}}°C', vars)).toBe('王奶奶 熱指數 40.2°C');
  });

  it('leaves an unknown placeholder visible so a CMS typo is obvious', () => {
    expect(interpolate('{{user}} {{nonsense}}', vars)).toBe('王奶奶 {{nonsense}}');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(interpolate('{{ user }}', vars)).toBe('王奶奶');
  });

  it('CMS CONTROL: a disabled template renders nothing at all', () => {
    const template = { ...DEFAULT_NOTIFICATION_TEMPLATES[2], enabled: false };
    expect(renderNotification(template, vars)).toBeNull();
  });

  it('CMS CONTROL: editing the template changes the rendered message', () => {
    const original = DEFAULT_NOTIFICATION_TEMPLATES[2];
    const edited = { ...original, titleZh: '緊急：{{user}} 需要協助' };

    expect(renderNotification(original, vars)?.titleZh).not.toBe(
      renderNotification(edited, vars)?.titleZh,
    );
    expect(renderNotification(edited, vars)?.titleZh).toBe('緊急：王奶奶 需要協助');
  });

  it('maps each risk level to its template', () => {
    expect(templateKeyForLevel('LOW')).toBe('LOW_RISK');
    expect(templateKeyForLevel('MEDIUM')).toBe('MEDIUM_RISK');
    expect(templateKeyForLevel('HIGH')).toBe('HIGH_RISK');
  });

  it('SAFETY: no default template asserts a diagnosis', () => {
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      expect(template.bodyZh).not.toContain('中暑');
      expect(template.titleZh).not.toContain('中暑');
    }
  });

  it('renders every default template without leaving placeholders behind', () => {
    for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
      const rendered = renderNotification(template, vars);
      expect(rendered).not.toBeNull();
      expect(rendered!.bodyZh).not.toMatch(/\{\{\s*\w+\s*\}\}/);
      expect(rendered!.titleZh).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const PROFILE: AmbientProfile = {
  userId: 'user-001',
  baseIndoorTempC: 27.4,
  baseIndoorHumidityPct: 62,
  baseOutdoorTempC: 29.2,
  baseOutdoorHumidityPct: 66,
  baseAirQualityIndex: 84,
  baseHeatwaveDays: 1,
  heatSensitivity: 1.25,
};

const SIM_BASELINE: PersonalBaseline = {
  userId: 'user-001',
  heartRate: { min: 65, max: 82, mean: 73 },
  skinTemp: { min: 33, max: 34.4, mean: 33.6 },
  activityStepsPerHour: { min: 63, max: 324, mean: 180 },
  sampleCount: 168,
  confidence: 0.93,
  learnedAt: new Date().toISOString(),
};

function smartHome(acOn: boolean, targetTempC = 26): SmartHomeState {
  const appliance = (on: boolean, present = true) => ({
    present,
    on,
    deviceId: 'dev-1',
    disabled: false,
  });
  return {
    userId: 'user-001',
    ac: appliance(acOn),
    fan: appliance(false),
    dehumidifier: appliance(false),
    indoorTempC: 27.4,
    indoorHumidityPct: 62,
    targetTempC,
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

function device(type: Device['type'], status: Device['status'] = 'ONLINE'): Device {
  return {
    id: `dev-${type}`,
    deviceId: `HG-${type}`,
    name: type,
    nameZh: type,
    type,
    userId: 'user-001',
    status,
    batteryPct: 80,
    signalPct: 90,
    lastSeen: new Date().toISOString(),
    firmware: 'v2.1.0',
    location: '客廳',
    power: false,
    isActuator: false,
    createdAt: new Date().toISOString(),
  };
}

describe('scenario definitions', () => {
  it('defines the full competition storyline in order', () => {
    const phases = SCENARIOS.FULL_DEMO.phases.map((p) => p.phase);
    expect(phases).toEqual(['NORMAL', 'HEAT_INCREASING', 'MEDIUM_RISK', 'HIGH_RISK', 'RECOVERY']);
  });

  it('gives every scenario a positive duration except ambient drift', () => {
    for (const name of Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]) {
      const duration = scenarioDurationSec(name);
      if (name === 'AMBIENT') expect(duration).toBe(0);
      else expect(duration).toBeGreaterThan(0);
    }
  });

  it('resolves the phase from elapsed time', () => {
    // Boundaries are derived from the scenario definition rather than pinned
    // to literal seconds, so retuning a phase duration does not break this
    // test - what is being asserted is the ORDER, not the tuning.
    const phases = SCENARIOS.FULL_DEMO.phases;
    let elapsed = 0;

    for (const phase of phases) {
      // Sample in the middle of each phase.
      const midpoint = elapsed + phase.durationSec / 2;
      expect(resolvePhase('FULL_DEMO', midpoint).spec.phase).toBe(phase.phase);
      elapsed += phase.durationSec;
    }

    expect(resolvePhase('FULL_DEMO', 0).spec.phase).toBe('NORMAL');
    expect(resolvePhase('FULL_DEMO', elapsed - 1).spec.phase).toBe('RECOVERY');
  });

  it('marks the scenario finished past its total duration', () => {
    const total = scenarioDurationSec('FULL_DEMO');
    expect(resolvePhase('FULL_DEMO', total + 10).finished).toBe(true);
  });
});

describe('tickReadings', () => {
  it('holds ambient conditions roughly steady with no scenario running', () => {
    let current = initialReading(PROFILE, SIM_BASELINE);

    for (let i = 0; i < 60; i++) {
      current = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: current,
        smartHome: smartHome(false),
        devices: [device('TEMPERATURE_SENSOR'), device('SMART_WATCH')],
        simulation: simulation(),
        isFocus: true,
      });
    }

    // Should settle near outdoor minus the insulation offset, not drift away.
    const expected = PROFILE.baseOutdoorTempC - 2.2 / PROFILE.heatSensitivity;
    expect(current.indoorTempC).toBeGreaterThan(expected - 1.5);
    expect(current.indoorTempC).toBeLessThan(expected + 1.5);
  });

  it('THE AC ACTUALLY WORKS: cooling pulls indoor temperature toward the target', () => {
    let hot = { ...initialReading(PROFILE, SIM_BASELINE), indoorTempC: 34, indoorHumidityPct: 80 };
    const startTemp = hot.indoorTempC;

    for (let i = 0; i < 80; i++) {
      hot = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: hot,
        smartHome: smartHome(true, 26),
        devices: [device('TEMPERATURE_SENSOR'), device('SMART_WATCH')],
        simulation: simulation(),
        isFocus: true,
      });
    }

    expect(hot.indoorTempC).toBeLessThan(startTemp - 4);
    expect(hot.indoorTempC).toBeLessThan(28);
    // Air conditioning also removes moisture.
    expect(hot.indoorHumidityPct).toBeLessThan(80);
  });

  it('COOLING REDUCES RISK: the heat index falls once the AC runs', () => {
    let state = { ...initialReading(PROFILE, SIM_BASELINE), indoorTempC: 34, indoorHumidityPct: 82 };
    const before = calculateHeatIndex(state.indoorTempC, state.indoorHumidityPct);

    for (let i = 0; i < 80; i++) {
      state = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: state,
        smartHome: smartHome(true, 26),
        devices: [device('TEMPERATURE_SENSOR')],
        simulation: simulation(),
        isFocus: true,
      });
    }

    const after = calculateHeatIndex(state.indoorTempC, state.indoorHumidityPct);
    expect(after).toBeLessThan(before - 8);
  });

  it('HONEST SENSORS: an offline sensor holds its last value instead of inventing one', () => {
    const previous = { ...initialReading(PROFILE, SIM_BASELINE), indoorTempC: 29.5 };

    const next = tickReadings({
      profile: PROFILE,
      baseline: SIM_BASELINE,
      previous,
      smartHome: smartHome(false),
      devices: [device('TEMPERATURE_SENSOR', 'OFFLINE')],
      simulation: simulation(),
      isFocus: true,
    });

    expect(next.indoorTempC).toBe(previous.indoorTempC);
  });

  it('holds every wearable metric when the watch is disabled', () => {
    const previous = initialReading(PROFILE, SIM_BASELINE);

    const next = tickReadings({
      profile: PROFILE,
      baseline: SIM_BASELINE,
      previous,
      smartHome: smartHome(false),
      devices: [device('SMART_WATCH', 'DISABLED')],
      simulation: simulation(),
      isFocus: true,
    });

    expect(next.heartRateBpm).toBe(previous.heartRateBpm);
    expect(next.activityStepsPerHour).toBe(previous.activityStepsPerHour);
    expect(next.skinTempC).toBe(previous.skinTempC);
  });

  it('drives the focus resident into high heat during the scenario', () => {
    let state = initialReading(PROFILE, SIM_BASELINE);

    // Run into the HIGH_RISK phase of the full demo.
    for (let elapsed = 0; elapsed <= 100; elapsed += 2) {
      state = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: state,
        smartHome: smartHome(false),
        devices: [device('TEMPERATURE_SENSOR'), device('SMART_WATCH')],
        simulation: simulation({ scenario: 'FULL_DEMO', elapsedSec: elapsed }),
        isFocus: true,
      });
    }

    expect(state.indoorTempC).toBeGreaterThan(PROFILE.baseIndoorTempC + 4);
    expect(state.heartRateBpm).toBeGreaterThan(SIM_BASELINE.heartRate.max);
  });

  it('leaves non-focus residents unaffected by the scenario', () => {
    let state = initialReading(PROFILE, SIM_BASELINE);

    for (let elapsed = 0; elapsed <= 100; elapsed += 2) {
      state = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: state,
        smartHome: smartHome(false),
        devices: [device('TEMPERATURE_SENSOR')],
        simulation: simulation({ scenario: 'FULL_DEMO', elapsedSec: elapsed }),
        isFocus: false,
      });
    }

    const expected = PROFILE.baseOutdoorTempC - 2.2 / PROFILE.heatSensitivity;
    expect(state.indoorTempC).toBeLessThan(expected + 2);
  });

  it('applies an admin manual temperature offset to the focus resident', () => {
    let state = initialReading(PROFILE, SIM_BASELINE);

    for (let i = 0; i < 40; i++) {
      state = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: state,
        smartHome: smartHome(false),
        devices: [device('TEMPERATURE_SENSOR')],
        simulation: simulation({ manualOffsets: { tempC: 8, humidityPct: 0, heartRateBpm: 0 } }),
        isFocus: true,
      });
    }

    expect(state.outdoorTempC).toBeGreaterThan(PROFILE.baseOutdoorTempC + 6);
  });

  /**
   * The competition storyline, end to end.
   *
   * Runs the FULL_DEMO scenario through the real simulation and risk engine,
   * with the policy engine switching cooling on exactly as the server does,
   * and asserts the level actually walks LOW -> MEDIUM -> HIGH -> back to LOW.
   *
   * This is the single most important behavioural test in the suite: it is
   * the demo the whole product is judged on.
   */
  it('THE DEMO ARC: FULL_DEMO drives LOW -> MEDIUM -> HIGH -> RECOVERY', async () => {
    const { assessRisk } = await import('../shared/domain/riskEngine');
    const { decideCooling } = await import('../shared/domain/actionEngine');
    const { cloneDefaultConfig } = await import('../shared/domain/config');

    const config = cloneDefaultConfig();
    const devices = [device('SMART_AC'), device('TEMPERATURE_SENSOR'), device('SMART_WATCH')];
    const user = {
      permissions: {
        automaticCooling: true,
        caregiverNotifications: true,
        locationSharing: true,
        physiologicalDataStorage: true,
        cityDataContribution: true,
      },
    };

    let reading = initialReading(PROFILE, SIM_BASELINE);
    let acOn = false;
    let level: RiskLevel = 'LOW';
    const seen: RiskLevel[] = [];

    const total = scenarioDurationSec('FULL_DEMO');
    const tickSec = 2;

    // Run a little past the scenario end, mirroring the server, which falls
    // back to ambient drift rather than freezing on the last frame.
    for (let elapsed = 0; elapsed <= total + 40; elapsed += tickSec) {
      const home = smartHome(acOn);

      reading = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: reading,
        smartHome: home,
        devices,
        simulation: simulation({ scenario: 'FULL_DEMO', elapsedSec: elapsed }),
        isFocus: true,
      });

      const assessment = assessRisk({
        userId: 'user-001',
        reading,
        baseline: SIM_BASELINE,
        config,
        history: [],
        previousLevel: level,
      });

      level = assessment.level;
      if (seen[seen.length - 1] !== level) seen.push(level);

      // Mirror the server: the policy engine decides whether cooling runs.
      acOn = decideCooling({ level, config, user, devices, userOverride: false }).allowed;
    }

    // The arc must reach HIGH and return to LOW.
    expect(seen).toContain('MEDIUM');
    expect(seen).toContain('HIGH');
    expect(seen[0]).toBe('LOW');
    expect(seen[seen.length - 1]).toBe('LOW');

    // And it must get there in order, without skipping MEDIUM on the way up.
    const firstMedium = seen.indexOf('MEDIUM');
    const firstHigh = seen.indexOf('HIGH');
    expect(firstMedium).toBeLessThan(firstHigh);
  });

  it('keeps every value physically plausible over a long run', () => {
    let state = initialReading(PROFILE, SIM_BASELINE);

    for (let elapsed = 0; elapsed < 400; elapsed += 2) {
      state = tickReadings({
        profile: PROFILE,
        baseline: SIM_BASELINE,
        previous: state,
        smartHome: smartHome(elapsed > 100),
        devices: [device('TEMPERATURE_SENSOR'), device('SMART_WATCH')],
        simulation: simulation({ scenario: 'FULL_DEMO', elapsedSec: elapsed }),
        isFocus: true,
      });

      expect(state.indoorTempC).toBeGreaterThan(10);
      expect(state.indoorTempC).toBeLessThan(50);
      expect(state.indoorHumidityPct).toBeGreaterThanOrEqual(20);
      expect(state.indoorHumidityPct).toBeLessThanOrEqual(100);
      expect(state.heartRateBpm).toBeGreaterThan(40);
      expect(state.heartRateBpm).toBeLessThan(190);
      expect(state.activityStepsPerHour).toBeGreaterThanOrEqual(0);
      expect(state.simulated).toBe(true);
    }
  });
});
