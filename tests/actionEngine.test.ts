/**
 * Policy engine tests.
 *
 * The property under test is that an automatic action is only taken when the
 * admin policy AND the user's consent AND the hardware all permit it - and
 * that when it is refused, the refusal is reported with a reason rather than
 * silently dropped.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_CATALOGUE,
  buildRuleContext,
  decideCooling,
  evaluateActionRules,
  evaluateCondition,
  evaluateRule,
  executedActionTypes,
  getRecommendedActions,
} from '../shared/domain/actionEngine';
import { assessRisk } from '../shared/domain/riskEngine';
import { cloneDefaultActionRules, cloneDefaultConfig } from '../shared/domain/config';
import type {
  ActionRule,
  Device,
  ElderlyUser,
  PersonalBaseline,
  ReadingSnapshot,
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

function device(type: Device['type'], status: Device['status'] = 'ONLINE'): Device {
  const actuator = type === 'SMART_AC' || type === 'FAN' || type === 'DEHUMIDIFIER';
  return {
    id: `dev-${type}`,
    deviceId: `HG-${type}`,
    name: type,
    nameZh: type,
    type,
    userId: 'user-001',
    status,
    batteryPct: actuator ? null : 80,
    signalPct: status === 'OFFLINE' ? 0 : 90,
    lastSeen: new Date().toISOString(),
    firmware: 'v2.1.0',
    location: '客廳',
    power: false,
    isActuator: actuator,
    createdAt: new Date().toISOString(),
  };
}

const permissions = (overrides: Partial<ElderlyUser['permissions']> = {}) => ({
  permissions: {
    automaticCooling: true,
    caregiverNotifications: true,
    locationSharing: true,
    physiologicalDataStorage: true,
    cityDataContribution: true,
    ...overrides,
  },
});

const FULL_DEVICES = [
  device('SMART_AC'),
  device('FAN'),
  device('TEMPERATURE_SENSOR'),
  device('HUMIDITY_SENSOR'),
  device('SMART_WATCH'),
];

function assessment(r: ReadingSnapshot, previousLevel: RiskLevel | null = null) {
  return assessRisk({
    userId: 'user-001',
    reading: r,
    baseline: BASELINE,
    config: cloneDefaultConfig(),
    history: [],
    previousLevel,
  });
}

// ---------------------------------------------------------------------------

describe('decideCooling', () => {
  const config = cloneDefaultConfig();

  it('permits cooling when policy, consent, level and hardware all allow it', () => {
    const decision = decideCooling({
      level: 'MEDIUM',
      config,
      user: permissions(),
      devices: FULL_DEVICES,
      userOverride: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it('ADMIN POLICY: refuses when automatic cooling is disabled platform-wide', () => {
    const disabled = cloneDefaultConfig();
    disabled.smartHomePolicy.allowAutomaticCooling = false;

    const decision = decideCooling({
      level: 'HIGH',
      config: disabled,
      user: permissions(),
      devices: FULL_DEVICES,
      userOverride: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonZh).toContain('平台政策');
  });

  it('USER CONSENT: refuses when the resident has not authorised it', () => {
    const decision = decideCooling({
      level: 'HIGH',
      config,
      user: permissions({ automaticCooling: false }),
      devices: FULL_DEVICES,
      userOverride: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonZh).toContain('尚未授權');
  });

  it('refuses below the configured minimum level', () => {
    const decision = decideCooling({
      level: 'LOW',
      config,
      user: permissions(),
      devices: FULL_DEVICES,
      userOverride: false,
    });
    expect(decision.allowed).toBe(false);
  });

  it('respects a lowered minimum level set in the CMS', () => {
    const eager = cloneDefaultConfig();
    eager.smartHomePolicy.minLevelForCooling = 'LOW';

    expect(
      decideCooling({
        level: 'LOW',
        config: eager,
        user: permissions(),
        devices: FULL_DEVICES,
        userOverride: false,
      }).allowed,
    ).toBe(true);
  });

  it('HARDWARE: refuses when every cooling appliance is offline', () => {
    const decision = decideCooling({
      level: 'HIGH',
      config,
      user: permissions(),
      devices: [device('SMART_AC', 'OFFLINE'), device('FAN', 'DISABLED')],
      userOverride: false,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonZh).toContain('沒有可用');
  });

  it('respects a user cancelling automation for the episode', () => {
    const decision = decideCooling({
      level: 'HIGH',
      config,
      user: permissions(),
      devices: FULL_DEVICES,
      userOverride: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonZh).toContain('取消');
  });
});

// ---------------------------------------------------------------------------

describe('getRecommendedActions', () => {
  const base = {
    config: cloneDefaultConfig(),
    rules: cloneDefaultActionRules(),
    user: permissions(),
    devices: FULL_DEVICES,
    userOverride: false,
    coolingSpaceCount: 40,
    hasCaregiver: true,
  };

  it('CUMULATIVE MODEL: HIGH includes the LOW and MEDIUM actions', () => {
    const high = getRecommendedActions({
      ...base,
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    const types = high.map((a) => a.type);
    expect(types).toContain('HYDRATE');
    expect(types).toContain('REST');
    expect(types).toContain('ACTIVATE_COOLING');
    expect(types).toContain('INCREASE_MONITORING');
    expect(types).toContain('RECOMMEND_COOLING_SPACE');
    expect(types).toContain('EMERGENCY_ASSISTANCE');
  });

  it('LOW does not include the HIGH-only actions', () => {
    const low = getRecommendedActions({ ...base, assessment: assessment(reading()) });
    const types = low.map((a) => a.type);

    expect(types).toContain('HYDRATE');
    expect(types).not.toContain('EMERGENCY_ASSISTANCE');
    expect(types).not.toContain('RECOMMEND_COOLING_SPACE');
  });

  it('REPORTS RATHER THAN HIDES a blocked cooling action', () => {
    const actions = getRecommendedActions({
      ...base,
      user: permissions({ automaticCooling: false }),
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    const cooling = actions.find((a) => a.type === 'ACTIVATE_COOLING');
    expect(cooling).toBeDefined();
    expect(cooling?.blockedReason).toBeTruthy();
    expect(cooling?.blockedReasonZh).toContain('尚未授權');
  });

  it('blocks caregiver notification when there is no active caregiver', () => {
    const actions = getRecommendedActions({
      ...base,
      hasCaregiver: false,
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    const notify = actions.find((a) => a.type === 'NOTIFY_CAREGIVER');
    expect(notify?.blockedReasonZh).toContain('沒有指派');
  });

  it('blocks the cooling-space recommendation when none are active', () => {
    const actions = getRecommendedActions({
      ...base,
      coolingSpaceCount: 0,
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    const recommend = actions.find((a) => a.type === 'RECOMMEND_COOLING_SPACE');
    expect(recommend?.blockedReasonZh).toContain('沒有啟用');
  });

  it('blocks indoor monitoring when no environment sensor is online', () => {
    const actions = getRecommendedActions({
      ...base,
      devices: [device('SMART_AC'), device('TEMPERATURE_SENSOR', 'OFFLINE'), device('HUMIDITY_SENSOR', 'OFFLINE')],
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    const monitor = actions.find((a) => a.type === 'MONITOR_INDOOR');
    expect(monitor?.blockedReasonZh).toContain('感測器');
  });

  it('returns actions sorted by priority', () => {
    const actions = getRecommendedActions({
      ...base,
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    for (let i = 1; i < actions.length; i++) {
      expect(actions[i].priority).toBeGreaterThanOrEqual(actions[i - 1].priority);
    }
  });

  it('counts only unblocked automatic actions as executed', () => {
    const actions = getRecommendedActions({
      ...base,
      user: permissions({ automaticCooling: false }),
      assessment: assessment(reading({ indoorTempC: 34, indoorHumidityPct: 82 })),
    });

    expect(executedActionTypes(actions)).not.toContain('ACTIVATE_COOLING');
    // A manual advisory is never reported as something the platform did.
    expect(executedActionTypes(actions)).not.toContain('HYDRATE');
  });

  it('reports the live monitoring interval in the action copy', () => {
    const config = cloneDefaultConfig();
    config.monitoringIntervalSec.HIGH = 15;

    const actions = getRecommendedActions({
      ...base,
      config,
      assessment: assessRisk({
        userId: 'user-001',
        reading: reading({ indoorTempC: 34, indoorHumidityPct: 82 }),
        baseline: BASELINE,
        config,
        history: [],
        previousLevel: null,
      }),
    });

    expect(actions.find((a) => a.type === 'INCREASE_MONITORING')?.bodyZh).toContain('15');
  });
});

// ---------------------------------------------------------------------------

describe('rule evaluation', () => {
  const ctx = buildRuleContext(
    assessment(reading({ indoorTempC: 33, indoorHumidityPct: 82, heartRateBpm: 105 })),
  );

  it('compares risk levels ordinally', () => {
    expect(evaluateCondition({ field: 'riskLevel', operator: 'gte', value: 'MEDIUM' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'riskLevel', operator: 'lt', value: 'MEDIUM' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'riskLevel', operator: 'isNot', value: 'LOW' }, ctx)).toBe(true);
  });

  it('compares numeric fields', () => {
    expect(evaluateCondition({ field: 'humidity', operator: 'gte', value: 80 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'humidity', operator: 'lt', value: 50 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'heartRateDeviation', operator: 'gt', value: 10 }, ctx)).toBe(true);
  });

  it('rejects a non-numeric comparison rather than coercing it', () => {
    expect(evaluateCondition({ field: 'humidity', operator: 'gte', value: 'hot' }, ctx)).toBe(false);
  });

  it('requires every condition to hold', () => {
    const rule: ActionRule = {
      id: 'r1',
      name: 'test',
      nameZh: 'test',
      description: '',
      enabled: true,
      builtIn: false,
      priority: 10,
      conditions: [
        { field: 'humidity', operator: 'gte', value: 80 },
        { field: 'heatIndex', operator: 'gte', value: 30 },
      ],
      actions: ['ACTIVATE_COOLING'],
      updatedAt: new Date().toISOString(),
    };

    expect(evaluateRule(rule, ctx)).toBe(true);

    // One failing condition is enough to stop the rule firing.
    rule.conditions[1] = { field: 'heatIndex', operator: 'gte', value: 99 };
    expect(evaluateRule(rule, ctx)).toBe(false);
  });

  it('never fires a disabled rule', () => {
    const rule: ActionRule = {
      id: 'r2',
      name: 'off',
      nameZh: 'off',
      description: '',
      enabled: false,
      builtIn: false,
      priority: 10,
      conditions: [{ field: 'humidity', operator: 'gte', value: 0 }],
      actions: ['HYDRATE'],
      updatedAt: new Date().toISOString(),
    };
    expect(evaluateRule(rule, ctx)).toBe(false);
  });

  it('never fires a rule with no conditions', () => {
    const rule: ActionRule = {
      id: 'r3',
      name: 'empty',
      nameZh: 'empty',
      description: '',
      enabled: true,
      builtIn: false,
      priority: 10,
      conditions: [],
      actions: ['HYDRATE'],
      updatedAt: new Date().toISOString(),
    };
    expect(evaluateRule(rule, ctx)).toBe(false);
  });

  it('unions the actions of every rule that fires', () => {
    const { actions, firedRuleIds } = evaluateActionRules(cloneDefaultActionRules(), ctx);
    expect(firedRuleIds.length).toBeGreaterThan(0);
    expect(actions.size).toBeGreaterThan(0);
  });

  it('CMS RULE CONTROL: disabling a rule withdraws its actions', () => {
    const rules = cloneDefaultActionRules();
    const before = evaluateActionRules(rules, ctx);

    const humidityRule = rules.find((r) => r.id === 'rule-humidity')!;
    humidityRule.enabled = false;
    const after = evaluateActionRules(rules, ctx);

    expect(before.firedRuleIds).toContain('rule-humidity');
    expect(after.firedRuleIds).not.toContain('rule-humidity');
  });
});

describe('ACTION_CATALOGUE', () => {
  it('gives every action bilingual copy, an icon and a source level', () => {
    for (const [type, def] of Object.entries(ACTION_CATALOGUE)) {
      expect(def.titleZh, `${type} titleZh`).toBeTruthy();
      expect(def.title, `${type} title`).toBeTruthy();
      expect(def.bodyZh, `${type} bodyZh`).toBeTruthy();
      expect(def.icon, `${type} icon`).toBeTruthy();
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(def.fromLevel);
    }
  });

  it('SAFETY: no action copy asserts a diagnosis', () => {
    for (const def of Object.values(ACTION_CATALOGUE)) {
      expect(def.bodyZh).not.toContain('中暑');
      expect(def.titleZh).not.toContain('中暑');
    }
  });
});
