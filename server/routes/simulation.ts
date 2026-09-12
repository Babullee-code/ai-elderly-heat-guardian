/**
 * /api/simulation - the demo control surface.
 *
 * These endpoints drive the scenario clock that the CMS demo controls and the
 * user-facing SIMULATE HEAT RISK button both call. Because the server owns
 * the clock, a scenario started from the CMS is immediately visible in the
 * elderly app and the caregiver dashboard, on every connected browser.
 */

import { Router } from 'express';
import { simulationCommandSchema } from '../../shared/schemas/index.js';
import type { ScenarioName } from '../../shared/types/domain.js';
import { PHASE_LABELS, SCENARIOS, scenarioDurationSec } from '../../shared/domain/simulationEngine.js';
import { userRepo } from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const simulationRouter = Router();

/** Available scenarios and the current clock state. */
simulationRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({
      simulation: platformState.getSimulation(),
      scenarios: (Object.keys(SCENARIOS) as ScenarioName[]).map((name) => ({
        name,
        label: SCENARIOS[name].label,
        labelZh: SCENARIOS[name].labelZh,
        description: SCENARIOS[name].description,
        durationSec: scenarioDurationSec(name),
        phases: SCENARIOS[name].phases.map((p) => ({
          phase: p.phase,
          label: PHASE_LABELS[p.phase].label,
          labelZh: PHASE_LABELS[p.phase].labelZh,
          durationSec: p.durationSec,
        })),
      })),
      phaseLabels: PHASE_LABELS,
      /**
       * Stated plainly and returned with every call: nothing in this
       * deployment is a real measurement.
       */
      simulated: true,
      notice: 'All sensor values in this prototype are simulated. No real device data is used.',
      noticeZh: '本原型的所有感測數值皆為模擬資料，未使用任何真實裝置數據。',
    });
  }),
);

/**
 * POST /api/simulation
 *
 * One endpoint, several verbs, because they all mutate the same clock and
 * should not race each other across separate routes.
 */
simulationRouter.post(
  '/',
  requireAuth,
  requirePermission('simulation:control'),
  validate(simulationCommandSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof simulationCommandSchema._output;

    switch (body.action) {
      case 'start': {
        // Starting without naming a scenario runs the full competition
        // storyline, which is what the demo button should do.
        const scenario = body.scenario ?? 'FULL_DEMO';
        const focus = body.focusUserId ?? platformState.getSimulation().focusUserId;

        if (body.focusUserId) {
          const user = await userRepo.findById(body.focusUserId);
          if (!user) {
            res.status(404).json({
              error: 'NOT_FOUND',
              message: 'That resident does not exist.',
              messageZh: '找不到此長者。',
            });
            return;
          }
          if (user.status !== 'ACTIVE') {
            res.status(409).json({
              error: 'NOT_MONITORED',
              message: 'A scenario cannot focus on a suspended or inactive resident.',
              messageZh: '無法針對已停用或未啟用的長者執行情境。',
            });
            return;
          }
        }

        const simulation = platformState.startScenario(scenario, focus);

        await recordAudit(req, {
          action: 'Started simulation scenario',
          actionZh: '啟動模擬情境',
          entity: 'Simulation',
          entityId: scenario,
          newValue: `${scenario} focused on ${focus}`,
        });

        res.json({ simulation, started: true });
        return;
      }

      case 'stop': {
        const simulation = platformState.setSimulation({ running: false });
        await recordAudit(req, {
          action: 'Paused simulation',
          actionZh: '暫停模擬',
          entity: 'Simulation',
          entityId: 'clock',
          newValue: 'paused',
        });
        res.json({ simulation, running: false });
        return;
      }

      case 'reset': {
        const simulation = await platformState.resetSimulation();
        await recordAudit(req, {
          action: 'Reset simulation',
          actionZh: '重設模擬',
          entity: 'Simulation',
          entityId: 'clock',
          newValue: 'reset to seeded baseline',
        });
        res.json({ simulation, reset: true });
        return;
      }

      case 'set-scenario': {
        if (!body.scenario) {
          res.status(400).json({
            error: 'VALIDATION_FAILED',
            message: 'A scenario name is required.',
            fieldErrors: { scenario: 'Required for set-scenario' },
          });
          return;
        }
        const simulation = platformState.startScenario(body.scenario, body.focusUserId);
        res.json({ simulation });
        return;
      }

      case 'set-speed': {
        if (body.speed === undefined) {
          res.status(400).json({
            error: 'VALIDATION_FAILED',
            message: 'A speed multiplier is required.',
            fieldErrors: { speed: 'Required for set-speed' },
          });
          return;
        }
        res.json({ simulation: platformState.setSimulation({ speed: body.speed }) });
        return;
      }

      case 'set-focus': {
        if (!body.focusUserId) {
          res.status(400).json({
            error: 'VALIDATION_FAILED',
            message: 'A resident id is required.',
            fieldErrors: { focusUserId: 'Required for set-focus' },
          });
          return;
        }

        const user = await userRepo.findById(body.focusUserId);
        if (!user) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'That resident does not exist.' });
          return;
        }

        res.json({ simulation: platformState.setSimulation({ focusUserId: body.focusUserId }) });
        return;
      }

      case 'set-offsets': {
        const current = platformState.getSimulation().manualOffsets;
        const simulation = platformState.setSimulation({
          manualOffsets: { ...current, ...(body.offsets ?? {}) },
        });
        res.json({ simulation });
        return;
      }

      default:
        res.status(400).json({ error: 'UNKNOWN_ACTION', message: 'Unsupported simulation action.' });
    }
  }),
);
