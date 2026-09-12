/**
 * Policy / action engine.
 *
 * Separated from the risk engine because an action depends on things risk
 * scoring should not know about: which appliances exist, whether the admin
 * policy permits automation, and whether the user consented to it.
 *
 * Two mechanisms produce actions:
 *  1. The cumulative level model from the proposal (LOW actions also apply at
 *     MEDIUM and HIGH).
 *  2. CMS-authored ActionRules from the rule builder, which can add actions
 *     on arbitrary conditions.
 *
 * An automatic action that is not permitted is NOT silently dropped - it is
 * returned with a blockedReason, so the UI can show the user exactly why the
 * air conditioner did not switch itself on.
 */

import type {
  ActionRule,
  ActionType,
  Device,
  ElderlyUser,
  RecommendedAction,
  RiskAssessment,
  RiskLevel,
  RiskRuleConfig,
  RuleCondition,
} from '../types/domain.js';
import { RISK_ORDER } from '../types/domain.js';

// ---------------------------------------------------------------------------
// Action catalogue
// ---------------------------------------------------------------------------

interface ActionDefinition {
  titleZh: string;
  title: string;
  bodyZh: string;
  body: string;
  fromLevel: RiskLevel;
  priority: number;
  automatic: boolean;
  icon: string;
}

/**
 * Canonical copy for every action. Safety-oriented wording throughout: the
 * platform advises and reports, it never diagnoses.
 */
export const ACTION_CATALOGUE: Record<ActionType, ActionDefinition> = {
  HYDRATE: {
    titleZh: '請先喝水',
    title: 'Drink water',
    bodyZh: '建議立即補充 200-300 毫升的水，並在接下來每小時持續補水。',
    body: 'Drink 200-300 ml of water now, and keep drinking every hour.',
    fromLevel: 'LOW',
    priority: 20,
    automatic: false,
    icon: 'droplet',
  },
  REST: {
    titleZh: '暫停活動並休息',
    title: 'Rest and pause activity',
    bodyZh: '請找陰涼處坐下休息，避免持續走動或做家事。',
    body: 'Sit down somewhere cool and pause any housework or walking.',
    fromLevel: 'LOW',
    priority: 30,
    automatic: false,
    icon: 'armchair',
  },
  AVOID_OUTDOOR: {
    titleZh: '避免外出活動',
    title: 'Avoid going outdoors',
    bodyZh: '目前室外熱風險偏高，建議延後外出，特別是中午到下午三點。',
    body: 'Outdoor heat risk is elevated. Postpone trips, especially between noon and 3pm.',
    fromLevel: 'LOW',
    priority: 40,
    automatic: false,
    icon: 'sun',
  },
  NOTIFY_CAREGIVER: {
    titleZh: '通知家人或照護者',
    title: 'Notify caregiver',
    bodyZh: '系統已將目前狀況通知您的家人。',
    body: 'Your caregiver has been informed of the current conditions.',
    fromLevel: 'LOW',
    priority: 50,
    automatic: true,
    icon: 'bell',
  },
  ACTIVATE_COOLING: {
    titleZh: '啟動降溫設備',
    title: 'Activate cooling',
    bodyZh: '系統已依您的授權開啟冷氣或除濕機，協助降低室內熱指數。',
    body: 'Cooling appliances have been switched on under your authorisation to bring the indoor heat index down.',
    fromLevel: 'MEDIUM',
    priority: 10,
    automatic: true,
    icon: 'air-vent',
  },
  MONITOR_INDOOR: {
    titleZh: '持續監測室內溫度',
    title: 'Monitor indoor temperature',
    bodyZh: '系統正持續追蹤室內溫濕度，並確認降溫是否生效。',
    body: 'Indoor temperature and humidity are being tracked to confirm cooling is working.',
    fromLevel: 'MEDIUM',
    priority: 60,
    automatic: true,
    icon: 'thermometer',
  },
  INCREASE_MONITORING: {
    titleZh: '提高監測頻率',
    title: 'Increase monitoring frequency',
    bodyZh: '系統已縮短感測器讀取間隔，以更快察覺變化。',
    body: 'Sensor sampling has been shortened so changes are detected sooner.',
    fromLevel: 'HIGH',
    priority: 55,
    automatic: true,
    icon: 'activity',
  },
  RECOMMEND_COOLING_SPACE: {
    titleZh: '前往附近的涼適空間',
    title: 'Move to a cooling location',
    bodyZh: '若室內無法有效降溫，建議前往附近有冷氣的公共空間暫留。',
    body: 'If the home cannot cool down, move to a nearby air-conditioned public space.',
    fromLevel: 'HIGH',
    priority: 25,
    automatic: false,
    icon: 'map-pin',
  },
  EMERGENCY_ASSISTANCE: {
    titleZh: '需要協助時可立即求助',
    title: 'Emergency assistance available',
    bodyZh: '若感到頭暈、噁心或無力，請立即使用求助功能聯絡家人或緊急服務。',
    body: 'If you feel dizzy, nauseated or weak, use the help button to reach your family or emergency services.',
    fromLevel: 'HIGH',
    priority: 5,
    automatic: false,
    icon: 'phone-call',
  },
};

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/** Values a rule condition may be tested against. */
export interface RuleEvaluationContext {
  riskLevel: RiskLevel;
  riskScore: number;
  heatIndex: number;
  indoorTemp: number;
  humidity: number;
  heartRateDeviation: number;
  activityLevel: number;
}

export function buildRuleContext(
  assessment: Omit<RiskAssessment, 'actions'>,
): RuleEvaluationContext {
  return {
    riskLevel: assessment.level,
    riskScore: assessment.score,
    heatIndex: assessment.heatIndex,
    indoorTemp: assessment.readings.indoorTempC,
    humidity: assessment.readings.indoorHumidityPct,
    heartRateDeviation: assessment.baseline.deviationPct,
    activityLevel: assessment.readings.activityStepsPerHour,
  };
}

/** Evaluate one condition against the context. */
export function evaluateCondition(
  condition: RuleCondition,
  ctx: RuleEvaluationContext,
): boolean {
  const actual = ctx[condition.field];

  if (condition.field === 'riskLevel') {
    const expected = String(condition.value) as RiskLevel;
    const actualLevel = actual as RiskLevel;
    switch (condition.operator) {
      case 'is':
        return actualLevel === expected;
      case 'isNot':
        return actualLevel !== expected;
      case 'gte':
        return RISK_ORDER[actualLevel] >= RISK_ORDER[expected];
      case 'lte':
        return RISK_ORDER[actualLevel] <= RISK_ORDER[expected];
      case 'gt':
        return RISK_ORDER[actualLevel] > RISK_ORDER[expected];
      case 'lt':
        return RISK_ORDER[actualLevel] < RISK_ORDER[expected];
      default:
        return false;
    }
  }

  const actualNum = Number(actual);
  const expectedNum = Number(condition.value);
  if (!Number.isFinite(actualNum) || !Number.isFinite(expectedNum)) return false;

  switch (condition.operator) {
    case 'is':
      return actualNum === expectedNum;
    case 'isNot':
      return actualNum !== expectedNum;
    case 'gte':
      return actualNum >= expectedNum;
    case 'lte':
      return actualNum <= expectedNum;
    case 'gt':
      return actualNum > expectedNum;
    case 'lt':
      return actualNum < expectedNum;
    default:
      return false;
  }
}

/** A rule fires when it is enabled and every condition holds. */
export function evaluateRule(rule: ActionRule, ctx: RuleEvaluationContext): boolean {
  if (!rule.enabled) return false;
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => evaluateCondition(c, ctx));
}

/** All action types produced by the CMS rule set for this assessment. */
export function evaluateActionRules(
  rules: ActionRule[],
  ctx: RuleEvaluationContext,
): { actions: Set<ActionType>; firedRuleIds: string[] } {
  const actions = new Set<ActionType>();
  const firedRuleIds: string[] = [];

  for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
    if (evaluateRule(rule, ctx)) {
      firedRuleIds.push(rule.id);
      rule.actions.forEach((a) => actions.add(a));
    }
  }

  return { actions, firedRuleIds };
}

// ---------------------------------------------------------------------------
// Cooling authorisation
// ---------------------------------------------------------------------------

export interface CoolingDecision {
  /** True when the platform may switch cooling on right now. */
  allowed: boolean;
  /** Explanation shown in the smart-home card. */
  reason: string;
  reasonZh: string;
}

/**
 * Decide whether automatic cooling may engage.
 *
 * Requires ALL of:
 *  - the admin policy permits automatic cooling at all,
 *  - the risk level has reached the policy's minimum level,
 *  - the user has authorised automatic cooling,
 *  - the user has not cancelled automation for this episode,
 *  - a usable, non-disabled cooling appliance exists.
 *
 * Any single failure blocks automation and is reported verbatim to the user,
 * which is both an honesty requirement and how the CMS demonstrates control.
 */
export function decideCooling(args: {
  level: RiskLevel;
  config: RiskRuleConfig;
  user: Pick<ElderlyUser, 'permissions'>;
  devices: Device[];
  userOverride: boolean;
}): CoolingDecision {
  const { level, config, user, devices, userOverride } = args;
  const policy = config.smartHomePolicy;

  if (!policy.allowAutomaticCooling) {
    return {
      allowed: false,
      reason: 'Automatic cooling is disabled by platform policy.',
      reasonZh: '平台政策目前停用自動降溫功能。',
    };
  }

  if (!user.permissions.automaticCooling) {
    return {
      allowed: false,
      reason: 'The user has not authorised automatic cooling.',
      reasonZh: '使用者尚未授權自動降溫。',
    };
  }

  if (userOverride) {
    return {
      allowed: false,
      reason: 'The user cancelled automatic cooling for this episode.',
      reasonZh: '使用者已取消本次自動降溫。',
    };
  }

  if (RISK_ORDER[level] < RISK_ORDER[policy.minLevelForCooling]) {
    return {
      allowed: false,
      reason: `Risk has not reached the ${policy.minLevelForCooling} level required for automatic cooling.`,
      reasonZh: `風險尚未達到自動降溫所需的 ${policy.minLevelForCooling} 等級。`,
    };
  }

  const usable = devices.filter(
    (d) =>
      d.isActuator &&
      d.status !== 'DISABLED' &&
      d.status !== 'OFFLINE' &&
      (d.type === 'SMART_AC' || d.type === 'DEHUMIDIFIER' || d.type === 'FAN'),
  );

  if (usable.length === 0) {
    return {
      allowed: false,
      reason: 'No cooling appliance is available or online.',
      reasonZh: '目前沒有可用或已連線的降溫設備。',
    };
  }

  return {
    allowed: true,
    reason: `Cooling authorised - target ${policy.targetIndoorTempC}C.`,
    reasonZh: `已授權自動降溫，目標室溫 ${policy.targetIndoorTempC}°C。`,
  };
}

// ---------------------------------------------------------------------------
// Recommended actions
// ---------------------------------------------------------------------------

export interface ActionGenerationArgs {
  assessment: Omit<RiskAssessment, 'actions'>;
  config: RiskRuleConfig;
  rules: ActionRule[];
  user: Pick<ElderlyUser, 'permissions'>;
  devices: Device[];
  userOverride: boolean;
  /** Number of active, non-disabled cooling spaces available for referral. */
  coolingSpaceCount: number;
  /** Whether the user has at least one active caregiver assigned. */
  hasCaregiver: boolean;
}

/**
 * Build the ordered, de-duplicated action list for one assessment.
 *
 * Actions are cumulative by level as the proposal requires, then unioned with
 * anything the CMS rule set fired, then gated for feasibility.
 */
export function getRecommendedActions(args: ActionGenerationArgs): RecommendedAction[] {
  const {
    assessment,
    config,
    rules,
    user,
    devices,
    userOverride,
    coolingSpaceCount,
    hasCaregiver,
  } = args;

  const level = assessment.level;
  const selected = new Set<ActionType>();

  // 1. Cumulative level model - every action whose fromLevel is at or below
  //    the current level applies.
  (Object.keys(ACTION_CATALOGUE) as ActionType[]).forEach((type) => {
    if (RISK_ORDER[ACTION_CATALOGUE[type].fromLevel] <= RISK_ORDER[level]) {
      selected.add(type);
    }
  });

  // 2. Union with CMS rule output.
  const ctx = buildRuleContext(assessment);
  const { actions: ruleActions } = evaluateActionRules(rules, ctx);
  ruleActions.forEach((a) => selected.add(a));

  // 3. Gate for policy, consent and feasibility.
  const cooling = decideCooling({ level, config, user, devices, userOverride });

  const result: RecommendedAction[] = [];

  for (const type of selected) {
    const def = ACTION_CATALOGUE[type];
    const action: RecommendedAction = { type, ...def };

    if (type === 'ACTIVATE_COOLING' && !cooling.allowed) {
      action.blockedReason = cooling.reason;
      action.blockedReasonZh = cooling.reasonZh;
    }

    if (type === 'NOTIFY_CAREGIVER') {
      if (!user.permissions.caregiverNotifications) {
        action.blockedReason = 'The user has not authorised caregiver notifications.';
        action.blockedReasonZh = '使用者尚未授權通知照護者。';
      } else if (!hasCaregiver) {
        action.blockedReason = 'No active caregiver is assigned to this user.';
        action.blockedReasonZh = '此使用者目前沒有指派的照護者。';
      } else if (RISK_ORDER[level] < RISK_ORDER[config.notificationPolicy.minLevelForCaregiver]) {
        action.blockedReason = `Risk is below the ${config.notificationPolicy.minLevelForCaregiver} notification threshold.`;
        action.blockedReasonZh = `風險低於通知門檻（${config.notificationPolicy.minLevelForCaregiver}）。`;
      }
    }

    if (type === 'RECOMMEND_COOLING_SPACE' && coolingSpaceCount === 0) {
      action.blockedReason = 'No active cooling location is available nearby.';
      action.blockedReasonZh = '附近目前沒有啟用的涼適空間。';
    }

    if (type === 'MONITOR_INDOOR') {
      const hasEnvSensor = devices.some(
        (d) =>
          (d.type === 'TEMPERATURE_SENSOR' || d.type === 'HUMIDITY_SENSOR') &&
          d.status !== 'DISABLED' &&
          d.status !== 'OFFLINE',
      );
      if (!hasEnvSensor) {
        action.blockedReason = 'No indoor environment sensor is online.';
        action.blockedReasonZh = '目前沒有已連線的室內環境感測器。';
      }
    }

    if (type === 'INCREASE_MONITORING') {
      action.bodyZh = `系統已將感測間隔縮短為每 ${config.monitoringIntervalSec[level]} 秒一次，以更快察覺變化。`;
      action.body = `Sensor sampling shortened to every ${config.monitoringIntervalSec[level]}s so changes are detected sooner.`;
    }

    result.push(action);
  }

  return result.sort((a, b) => a.priority - b.priority);
}

/** The action types that were actually carried out (not blocked). */
export function executedActionTypes(actions: RecommendedAction[]): ActionType[] {
  return actions.filter((a) => a.automatic && !a.blockedReason).map((a) => a.type);
}
