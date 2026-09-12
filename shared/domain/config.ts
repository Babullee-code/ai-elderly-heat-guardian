/**
 * Default platform configuration.
 *
 * This file holds the ONLY hard-coded thresholds and weights in the codebase.
 * At runtime the live config lives in the database and is edited through
 * /admin/risk-rules; the risk engine always reads the live value. UI
 * components must never inline a threshold - they receive config as data.
 *
 * Threshold defaults come from the proposal:
 *   LOW    heat index 27-32C
 *   MEDIUM heat index 32-39C
 *   HIGH   heat index 39C+
 */

import type { ActionRule, RiskRuleConfig } from '../types/domain.js';

export const DEFAULT_RISK_CONFIG: RiskRuleConfig = {
  id: 'default',
  thresholds: {
    low: 27,
    medium: 32,
    high: 39,
  },
  weights: {
    environmental: 0.35,
    physiological: 0.25,
    heatwave: 0.15,
    ventilation: 0.15,
    activity: 0.1,
  },
  scoreEscalation: {
    mediumScore: 45,
    highScore: 75,
    enabled: true,
  },
  monitoringIntervalSec: {
    LOW: 300,
    MEDIUM: 120,
    HIGH: 30,
  },
  physiology: {
    minDeviationPct: 5,
    maxDeviationPct: 35,
  },
  environment: {
    humidityConcernPct: 65,
    ventilationDeltaC: 2,
    heatwaveDayThreshold: 3,
  },
  smartHomePolicy: {
    allowAutomaticCooling: true,
    minLevelForCooling: 'MEDIUM',
    targetIndoorTempC: 26,
  },
  notificationPolicy: {
    minLevelForCaregiver: 'LOW',
    cooldownMinutes: 3,
    escalateAfterMinutes: 10,
  },
  updatedAt: new Date().toISOString(),
  updatedBy: 'system',
};

/**
 * Built-in policy rules mirroring the proposal's cumulative action model.
 * Admins can disable or reorder them and add their own in the rule builder,
 * but the built-ins cannot be deleted so the demo always has a baseline.
 */
export const DEFAULT_ACTION_RULES: ActionRule[] = [
  {
    id: 'rule-low',
    name: 'Low risk advisory',
    nameZh: '低風險提醒',
    description: 'Baseline hydration and rest guidance whenever heat risk is present.',
    enabled: true,
    builtIn: true,
    priority: 30,
    conditions: [{ field: 'riskLevel', operator: 'is', value: 'LOW' }],
    actions: ['HYDRATE', 'REST', 'AVOID_OUTDOOR', 'NOTIFY_CAREGIVER'],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'rule-medium',
    name: 'Medium risk intervention',
    nameZh: '中度風險介入',
    description:
      'Engage authorised cooling, watch indoor conditions and notify the caregiver.',
    enabled: true,
    builtIn: true,
    priority: 20,
    conditions: [{ field: 'riskLevel', operator: 'is', value: 'MEDIUM' }],
    actions: ['ACTIVATE_COOLING', 'MONITOR_INDOOR', 'NOTIFY_CAREGIVER'],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'rule-high',
    name: 'High risk escalation',
    nameZh: '高風險升級',
    description:
      'Increase monitoring, recommend a cooling location and surface emergency assistance.',
    enabled: true,
    builtIn: true,
    priority: 10,
    conditions: [{ field: 'riskLevel', operator: 'is', value: 'HIGH' }],
    actions: [
      'INCREASE_MONITORING',
      'NOTIFY_CAREGIVER',
      'RECOMMEND_COOLING_SPACE',
      'EMERGENCY_ASSISTANCE',
    ],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'rule-humidity',
    name: 'High humidity cooling assist',
    nameZh: '高濕度除濕輔助',
    description:
      'Very humid air blocks evaporative cooling, so dehumidify even before the heat index crosses MEDIUM.',
    enabled: true,
    builtIn: false,
    priority: 25,
    conditions: [
      { field: 'humidity', operator: 'gte', value: 80 },
      { field: 'heatIndex', operator: 'gte', value: 30 },
    ],
    actions: ['ACTIVATE_COOLING', 'MONITOR_INDOOR'],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'rule-physio',
    name: 'Physiological deviation watch',
    nameZh: '生理偏離監控',
    description:
      'A large deviation from the personal baseline warrants caregiver awareness regardless of the ambient heat index.',
    enabled: true,
    builtIn: false,
    priority: 15,
    conditions: [{ field: 'heartRateDeviation', operator: 'gte', value: 25 }],
    actions: ['NOTIFY_CAREGIVER', 'INCREASE_MONITORING', 'REST'],
    updatedAt: new Date().toISOString(),
  },
];

/** Deep clone helper so callers never mutate the shared default object. */
export function cloneDefaultConfig(): RiskRuleConfig {
  return JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG)) as RiskRuleConfig;
}

export function cloneDefaultActionRules(): ActionRule[] {
  return JSON.parse(JSON.stringify(DEFAULT_ACTION_RULES)) as ActionRule[];
}
