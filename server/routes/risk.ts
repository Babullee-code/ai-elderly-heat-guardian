/**
 * /api/risk, /api/risk-rules, /api/actions
 *
 * The risk-rules routes are the CMS's control surface over the risk engine.
 * A successful PATCH here calls platformState.reloadConfig(), which
 * re-evaluates every monitored resident against the new configuration and
 * broadcasts the result - so a threshold change is visible on every open
 * screen within the same second, without a refresh.
 */

import { Router } from 'express';
import {
  actionRuleCreateSchema,
  actionRuleUpdateSchema,
  riskRuleConfigUpdateSchema,
} from '../../shared/schemas/index.js';
import type { ActionRule, RiskRuleConfig } from '../../shared/types/domain.js';
import { ACTION_CATALOGUE, buildRuleContext, evaluateRule } from '../../shared/domain/actionEngine.js';
import { actionRuleRepo, configRepo, riskEventRepo, userRepo } from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission, requireUserScope } from '../middleware/auth.js';

export const riskRouter = Router();
export const riskRulesRouter = Router();
export const actionsRouter = Router();

// ---------------------------------------------------------------------------
// Live risk
// ---------------------------------------------------------------------------

/** Current assessment for every monitored resident, plus platform stats. */
riskRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({
      stats: platformState.getStats(),
      simulation: platformState.getSimulation(),
      configVersion: platformState.getConfigVersion(),
      at: new Date().toISOString(),
    });
  }),
);

riskRouter.get(
  '/:userId',
  requireAuth,
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const assessment = platformState.getAssessment(pathParam(req, 'userId'));

    if (!assessment) {
      const user = await userRepo.findById(pathParam(req, 'userId'));
      res.status(user ? 409 : 404).json({
        error: user ? 'NOT_MONITORED' : 'NOT_FOUND',
        message: user
          ? 'This resident is not currently being monitored. Monitoring resumes when their account is active.'
          : 'That resident does not exist.',
        messageZh: user ? '此長者目前未在監測中。' : '找不到此長者。',
      });
      return;
    }

    res.json({
      assessment,
      smartHome: platformState.getSmartHome(pathParam(req, 'userId')),
      history: platformState.getHistory(pathParam(req, 'userId')),
      config: platformState.getConfig(),
    });
  }),
);

/** Risk event history - the risk timeline. */
riskRouter.get(
  '/:userId/events',
  requireAuth,
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    res.json({ events: await riskEventRepo.forUser(pathParam(req, 'userId'), 60) });
  }),
);

// ---------------------------------------------------------------------------
// Risk rule configuration
// ---------------------------------------------------------------------------

riskRulesRouter.get(
  '/',
  requireAuth,
  requirePermission('risk-rule:read'),
  asyncHandler(async (_req, res) => {
    const { config, version } = await configRepo.get();
    res.json({ config, version });
  }),
);

/**
 * PATCH /api/risk-rules
 *
 * Deep-merges the submitted partial into the live config. This is the single
 * write path for every threshold, weight and policy in the platform.
 */
riskRulesRouter.patch(
  '/',
  requireAuth,
  requirePermission('risk-rule:write'),
  validate(riskRuleConfigUpdateSchema),
  asyncHandler(async (req, res) => {
    const { config: before } = await configRepo.get();
    const patch = req.body as Partial<RiskRuleConfig>;

    const next: RiskRuleConfig = {
      ...before,
      ...patch,
      thresholds: { ...before.thresholds, ...(patch.thresholds ?? {}) },
      weights: { ...before.weights, ...(patch.weights ?? {}) },
      scoreEscalation: { ...before.scoreEscalation, ...(patch.scoreEscalation ?? {}) },
      monitoringIntervalSec: {
        ...before.monitoringIntervalSec,
        ...(patch.monitoringIntervalSec ?? {}),
      },
      physiology: { ...before.physiology, ...(patch.physiology ?? {}) },
      environment: { ...before.environment, ...(patch.environment ?? {}) },
      smartHomePolicy: { ...before.smartHomePolicy, ...(patch.smartHomePolicy ?? {}) },
      notificationPolicy: { ...before.notificationPolicy, ...(patch.notificationPolicy ?? {}) },
    };

    // Re-validate the merged result: a partial patch can produce an invalid
    // whole (e.g. raising `medium` above the unchanged `high`), which
    // per-field validation on the patch alone would not catch.
    if (!(next.thresholds.low < next.thresholds.medium && next.thresholds.medium < next.thresholds.high)) {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'Thresholds must increase: LOW < MEDIUM < HIGH.',
        messageZh: '門檻必須遞增：LOW < MEDIUM < HIGH。',
        fieldErrors: { 'thresholds.medium': 'Must sit between the LOW and HIGH thresholds' },
      });
      return;
    }

    if (next.scoreEscalation.mediumScore >= next.scoreEscalation.highScore) {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'The MEDIUM escalation score must be below the HIGH escalation score.',
        messageZh: 'MEDIUM 升級分數必須低於 HIGH 升級分數。',
        fieldErrors: { 'scoreEscalation.mediumScore': 'Must be below the HIGH score' },
      });
      return;
    }

    const { config, version } = await configRepo.save(next, req.account!.id);

    // Audit each changed field separately so /admin/audit-log shows exactly
    // what moved - "Changed MEDIUM threshold 32C to 33C" rather than a blob.
    for (const change of diffConfig(before, config)) {
      await recordAudit(req, {
        action: `Changed ${change.label}`,
        actionZh: `變更${change.labelZh}`,
        entity: 'RiskRuleConfig',
        entityId: change.path,
        oldValue: change.from,
        newValue: change.to,
      });
    }

    await platformState.reloadConfig();

    res.json({
      config,
      version,
      // Report the immediate effect, so the admin sees the consequence of the
      // change rather than trusting that it worked.
      effect: platformState.getStats(),
    });
  }),
);

riskRulesRouter.post(
  '/reset',
  requireAuth,
  requirePermission('risk-rule:write'),
  asyncHandler(async (req, res) => {
    const { config: before } = await configRepo.get();
    const { config, version } = await configRepo.reset(req.account!.id);

    await recordAudit(req, {
      action: 'Reset risk rules to defaults',
      actionZh: '重設風險規則為預設值',
      entity: 'RiskRuleConfig',
      entityId: 'default',
      oldValue: `LOW ${before.thresholds.low} / MEDIUM ${before.thresholds.medium} / HIGH ${before.thresholds.high}`,
      newValue: `LOW ${config.thresholds.low} / MEDIUM ${config.thresholds.medium} / HIGH ${config.thresholds.high}`,
    });

    await platformState.reloadConfig();
    res.json({ config, version, effect: platformState.getStats() });
  }),
);

/**
 * POST /api/risk-rules/preview
 *
 * Evaluate a proposed configuration WITHOUT saving it, and report how many
 * residents would move to each level. Lets an admin see the consequence of a
 * threshold change before committing to it.
 */
riskRulesRouter.post(
  '/preview',
  requireAuth,
  requirePermission('risk-rule:read'),
  validate(riskRuleConfigUpdateSchema),
  asyncHandler(async (req, res) => {
    const { config: current } = await configRepo.get();
    const patch = req.body as Partial<RiskRuleConfig>;

    const candidate: RiskRuleConfig = {
      ...current,
      ...patch,
      thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) },
      weights: { ...current.weights, ...(patch.weights ?? {}) },
      scoreEscalation: { ...current.scoreEscalation, ...(patch.scoreEscalation ?? {}) },
      monitoringIntervalSec: {
        ...current.monitoringIntervalSec,
        ...(patch.monitoringIntervalSec ?? {}),
      },
      physiology: { ...current.physiology, ...(patch.physiology ?? {}) },
      environment: { ...current.environment, ...(patch.environment ?? {}) },
      smartHomePolicy: { ...current.smartHomePolicy, ...(patch.smartHomePolicy ?? {}) },
      notificationPolicy: { ...current.notificationPolicy, ...(patch.notificationPolicy ?? {}) },
    };

    const users = await userRepo.list();
    const baselines = await userRepo.getAllBaselines();

    const { assessRisk } = await import('../../shared/domain/riskEngine.js');

    const counts = { LOW: 0, MEDIUM: 0, HIGH: 0 };
    const moved: { userId: string; name: string; from: string; to: string }[] = [];

    for (const user of users) {
      if (user.status !== 'ACTIVE') continue;

      const reading = platformState.getReading(user.id);
      const baseline = baselines[user.id];
      const currentLevel = platformState.getAssessment(user.id)?.level;
      if (!reading || !baseline) continue;

      const candidateAssessment = assessRisk({
        userId: user.id,
        reading,
        baseline,
        config: candidate,
        history: platformState.getHistory(user.id),
        previousLevel: null,
      });

      counts[candidateAssessment.level]++;

      if (currentLevel && currentLevel !== candidateAssessment.level) {
        moved.push({
          userId: user.id,
          name: user.name,
          from: currentLevel,
          to: candidateAssessment.level,
        });
      }
    }

    res.json({
      current: platformState.getStats(),
      projected: counts,
      moved,
      saved: false,
    });
  }),
);

// ---------------------------------------------------------------------------
// Action rules (the policy engine / rule builder)
// ---------------------------------------------------------------------------

actionsRouter.get(
  '/catalogue',
  requireAuth,
  requirePermission('action-rule:read'),
  asyncHandler(async (_req, res) => {
    res.json({
      actions: Object.entries(ACTION_CATALOGUE).map(([type, def]) => ({ type, ...def })),
    });
  }),
);

actionsRouter.get(
  '/rules',
  requireAuth,
  requirePermission('action-rule:read'),
  asyncHandler(async (_req, res) => {
    const rules = await actionRuleRepo.list();

    // Show which rules are currently firing, and for whom - the rule list is
    // far more useful when it reports live effect rather than just definitions.
    const firing: Record<string, string[]> = {};
    const users = await userRepo.list();

    for (const user of users) {
      if (user.status !== 'ACTIVE') continue;
      const assessment = platformState.getAssessment(user.id);
      if (!assessment) continue;

      const ctx = buildRuleContext(assessment);
      for (const rule of rules) {
        if (evaluateRule(rule, ctx)) {
          firing[rule.id] = [...(firing[rule.id] ?? []), user.name];
        }
      }
    }

    res.json({
      rules,
      firing,
      firingCounts: Object.fromEntries(
        rules.map((r) => [r.id, (firing[r.id] ?? []).length]),
      ),
    });
  }),
);

actionsRouter.post(
  '/rules',
  requireAuth,
  requirePermission('action-rule:write'),
  validate(actionRuleCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof actionRuleCreateSchema._output;

    const rule = await actionRuleRepo.create({
      id: `rule-${Date.now().toString(36)}`,
      name: body.name,
      nameZh: body.nameZh,
      description: body.description,
      enabled: body.enabled,
      conditions: body.conditions as ActionRule['conditions'],
      actions: body.actions,
      priority: body.priority,
      builtIn: false,
      updatedAt: new Date().toISOString(),
    });

    await recordAudit(req, {
      action: 'Created action rule',
      actionZh: '新增行動規則',
      entity: 'ActionRule',
      entityId: rule.id,
      newValue: describeRule(rule),
    });

    await platformState.reloadConfig();
    res.status(201).json({ rule });
  }),
);

actionsRouter.patch(
  '/rules/:id',
  requireAuth,
  requirePermission('action-rule:write'),
  validate(actionRuleUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await actionRuleRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That rule does not exist.' });
      return;
    }

    const rule = await actionRuleRepo.update(pathParam(req, 'id'), req.body as Partial<ActionRule>);

    await recordAudit(req, {
      action: 'Updated action rule',
      actionZh: '更新行動規則',
      entity: 'ActionRule',
      entityId: rule.id,
      oldValue: describeRule(before),
      newValue: describeRule(rule),
    });

    await platformState.reloadConfig();
    res.json({ rule });
  }),
);

actionsRouter.delete(
  '/rules/:id',
  requireAuth,
  requirePermission('action-rule:write'),
  asyncHandler(async (req, res) => {
    const rule = await actionRuleRepo.findById(pathParam(req, 'id'));

    if (!rule) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That rule does not exist.' });
      return;
    }

    // Built-in rules encode the proposal's cumulative action model. They can
    // be disabled but not deleted, so the platform always retains a baseline
    // policy and the demo cannot be left in a state with no actions at all.
    if (rule.builtIn) {
      res.status(409).json({
        error: 'BUILT_IN_RULE',
        message:
          'Built-in rules cannot be deleted because they define the platform baseline. Disable it instead.',
        messageZh: '內建規則為平台基礎政策，無法刪除，請改為停用。',
      });
      return;
    }

    await actionRuleRepo.delete(pathParam(req, 'id'));

    await recordAudit(req, {
      action: 'Deleted action rule',
      actionZh: '刪除行動規則',
      entity: 'ActionRule',
      entityId: pathParam(req, 'id'),
      oldValue: describeRule(rule),
      newValue: 'deleted',
    });

    await platformState.reloadConfig();
    res.json({ deleted: true, id: pathParam(req, 'id') });
  }),
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeRule(rule: ActionRule): string {
  const conditions = rule.conditions
    .map((c) => `${c.field} ${c.operator} ${c.value}`)
    .join(' AND ');
  return `${rule.name} [${rule.enabled ? 'enabled' : 'disabled'}] IF ${conditions} THEN ${rule.actions.join(', ')}`;
}

interface ConfigChange {
  path: string;
  label: string;
  labelZh: string;
  from: string;
  to: string;
}

/** Field-level diff of two configs, for readable audit entries. */
function diffConfig(before: RiskRuleConfig, after: RiskRuleConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];

  const compare = (
    path: string,
    label: string,
    labelZh: string,
    from: unknown,
    to: unknown,
    suffix = '',
  ) => {
    if (String(from) === String(to)) return;
    changes.push({
      path,
      label,
      labelZh,
      from: `${from}${suffix}`,
      to: `${to}${suffix}`,
    });
  };

  compare('thresholds.low', 'LOW threshold', 'LOW 門檻', before.thresholds.low, after.thresholds.low, 'C');
  compare('thresholds.medium', 'MEDIUM threshold', 'MEDIUM 門檻', before.thresholds.medium, after.thresholds.medium, 'C');
  compare('thresholds.high', 'HIGH threshold', 'HIGH 門檻', before.thresholds.high, after.thresholds.high, 'C');

  const weightLabels: Record<string, string> = {
    environmental: '環境風險權重',
    physiological: '生理偏離權重',
    heatwave: '熱浪權重',
    ventilation: '通風權重',
    activity: '活動量權重',
  };

  for (const key of Object.keys(after.weights) as (keyof typeof after.weights)[]) {
    compare(
      `weights.${key}`,
      `${key} weight`,
      weightLabels[key] ?? `${key} 權重`,
      before.weights[key],
      after.weights[key],
    );
  }

  compare('scoreEscalation.mediumScore', 'MEDIUM escalation score', 'MEDIUM 升級分數', before.scoreEscalation.mediumScore, after.scoreEscalation.mediumScore);
  compare('scoreEscalation.highScore', 'HIGH escalation score', 'HIGH 升級分數', before.scoreEscalation.highScore, after.scoreEscalation.highScore);
  compare('scoreEscalation.enabled', 'score escalation', '分數升級機制', before.scoreEscalation.enabled, after.scoreEscalation.enabled);

  for (const level of ['LOW', 'MEDIUM', 'HIGH'] as const) {
    compare(
      `monitoringIntervalSec.${level}`,
      `${level} monitoring interval`,
      `${level} 監測間隔`,
      before.monitoringIntervalSec[level],
      after.monitoringIntervalSec[level],
      's',
    );
  }

  compare('physiology.minDeviationPct', 'minimum physiological deviation', '生理偏離下限', before.physiology.minDeviationPct, after.physiology.minDeviationPct, '%');
  compare('physiology.maxDeviationPct', 'maximum physiological deviation', '生理偏離上限', before.physiology.maxDeviationPct, after.physiology.maxDeviationPct, '%');

  compare('environment.humidityConcernPct', 'humidity concern level', '濕度關注門檻', before.environment.humidityConcernPct, after.environment.humidityConcernPct, '%');
  compare('environment.ventilationDeltaC', 'ventilation delta', '通風溫差門檻', before.environment.ventilationDeltaC, after.environment.ventilationDeltaC, 'C');
  compare('environment.heatwaveDayThreshold', 'heatwave day threshold', '熱浪天數門檻', before.environment.heatwaveDayThreshold, after.environment.heatwaveDayThreshold, ' days');

  compare('smartHomePolicy.allowAutomaticCooling', 'automatic cooling policy', '自動降溫政策', before.smartHomePolicy.allowAutomaticCooling, after.smartHomePolicy.allowAutomaticCooling);
  compare('smartHomePolicy.minLevelForCooling', 'minimum level for cooling', '自動降溫最低等級', before.smartHomePolicy.minLevelForCooling, after.smartHomePolicy.minLevelForCooling);
  compare('smartHomePolicy.targetIndoorTempC', 'target indoor temperature', '目標室內溫度', before.smartHomePolicy.targetIndoorTempC, after.smartHomePolicy.targetIndoorTempC, 'C');

  compare('notificationPolicy.minLevelForCaregiver', 'minimum caregiver notification level', '照護者通知最低等級', before.notificationPolicy.minLevelForCaregiver, after.notificationPolicy.minLevelForCaregiver);
  compare('notificationPolicy.cooldownMinutes', 'notification cooldown', '通知冷卻時間', before.notificationPolicy.cooldownMinutes, after.notificationPolicy.cooldownMinutes, ' min');
  compare('notificationPolicy.escalateAfterMinutes', 'escalation delay', '升級等待時間', before.notificationPolicy.escalateAfterMinutes, after.notificationPolicy.escalateAfterMinutes, ' min');

  return changes;
}
