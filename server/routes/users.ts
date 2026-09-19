/**
 * /api/users - elderly resident records.
 *
 * Read routes serve both the CMS user table and the caregiver dashboard, so
 * each row is returned already joined to its live risk assessment, device
 * health and caregivers. That keeps the client free of aggregation logic.
 */

import { Router } from 'express';
import {
  elderlyUserCreateSchema,
  elderlyUserUpdateSchema,
  userPermissionsUpdateSchema,
} from '../../shared/schemas/index.js';
import { baselineReadiness, learnPersonalBaseline } from '../../shared/domain/baselineEngine.js';
import { RISK_ORDER } from '../../shared/types/domain.js';
import type { ElderlyUser } from '../../shared/types/domain.js';
import {
  alertRepo,
  caregiverRepo,
  deviceRepo,
  readingRepo,
  riskEventRepo,
  userRepo,
} from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission, requireUserScope } from '../middleware/auth.js';

export const usersRouter = Router();

/**
 * GET /api/users
 *
 * Returns every resident joined to live risk data, sorted with the highest
 * risk first - the ordering both the CMS table and the caregiver dashboard
 * need, so neither has to re-sort.
 *
 * A CAREGIVER account receives only their assigned residents.
 */
usersRouter.get(
  '/',
  requireAuth,
  requirePermission('user:read'),
  asyncHandler(async (req, res) => {
    const account = req.account!;
    let users = await userRepo.list();

    if (account.role === 'CAREGIVER' && account.caregiverId) {
      const caregiver = await caregiverRepo.findById(account.caregiverId);
      const allowed = new Set(caregiver?.assignedUserIds ?? []);
      users = users.filter((u) => allowed.has(u.id));
    } else if (account.role === 'ELDER' && account.elderlyUserId) {
      users = users.filter((u) => u.id === account.elderlyUserId);
    }

    const devices = platformState.getDevicesCache();
    const caregivers = await caregiverRepo.list();

    const rows = users.map((user) => {
      const assessment = platformState.getAssessment(user.id);
      const userDevices = devices.filter((d) => d.userId === user.id);
      const online = userDevices.filter(
        (d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY',
      ).length;

      return {
        ...user,
        assessment,
        deviceCount: userDevices.length,
        devicesOnline: online,
        deviceStatus:
          userDevices.length === 0
            ? ('NONE' as const)
            : online === userDevices.length
              ? ('ALL_ONLINE' as const)
              : online === 0
                ? ('ALL_OFFLINE' as const)
                : ('PARTIAL' as const),
        caregivers: caregivers
          .filter((c) => c.assignedUserIds.includes(user.id))
          .map((c) => ({ id: c.id, name: c.name, relationship: c.relationship, status: c.status })),
        lastUpdate: assessment?.timestamp ?? null,
      };
    });

    // Highest risk first, then by score, so the most urgent resident is always
    // the first row a caregiver sees.
    rows.sort((a, b) => {
      const levelDiff =
        RISK_ORDER[b.assessment?.level ?? 'LOW'] - RISK_ORDER[a.assessment?.level ?? 'LOW'];
      if (levelDiff !== 0) return levelDiff;
      return (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0);
    });

    res.json({ users: rows, total: rows.length });
  }),
);

/**
 * GET /api/users/:id
 *
 * The full resident record for the CMS user-detail page: profile, baseline,
 * risk history, environment and wearable history, caregivers, devices,
 * permissions and recent alerts.
 */
usersRouter.get(
  '/:id',
  requireAuth,
  requirePermission('user:read'),
  requireUserScope((req) => pathParam(req, 'id')),
  asyncHandler(async (req, res) => {
    const user = await userRepo.findById(pathParam(req, 'id'));

    if (!user) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'That resident record does not exist.',
        messageZh: '找不到此長者資料。',
      });
      return;
    }

    const [baseline, devices, caregivers, riskEvents, envHistory, wearHistory, alerts] =
      await Promise.all([
        userRepo.getBaseline(user.id),
        deviceRepo.forUser(user.id),
        caregiverRepo.forUser(user.id),
        riskEventRepo.forUser(user.id, 40),
        readingRepo.environmentHistory(user.id, 96),
        readingRepo.wearableHistory(user.id, 96),
        alertRepo.forUser(user.id, 20),
      ]);

    res.json({
      user,
      baseline,
      assessment: platformState.getAssessment(user.id),
      smartHome: platformState.getSmartHome(user.id),
      history: platformState.getHistory(user.id),
      devices,
      caregivers,
      riskEvents,
      environmentHistory: envHistory,
      wearableHistory: wearHistory,
      alerts,
      monitoringIntervalSec:
        platformState.getConfig().monitoringIntervalSec[
          platformState.getAssessment(user.id)?.level ?? 'LOW'
        ],
    });
  }),
);

usersRouter.post(
  '/',
  requireAuth,
  requirePermission('user:write'),
  validate(elderlyUserCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof elderlyUserCreateSchema._output;

    const existing = await userRepo.list();
    const nextNumber = existing.length + 1;
    const id = `user-${String(nextNumber).padStart(3, '0')}`;

    // A new resident has no history, so the baseline starts at low confidence
    // and the engine damps physiological risk accordingly until it learns.
    const baseline = learnPersonalBaseline(id, [], {
      heartRate: { min: 62, max: 84, mean: 73 },
      skinTemp: { min: 33, max: 34.6, mean: 33.8 },
      activityStepsPerHour: { min: 50, max: 320, mean: 160 },
    });

    const user = await userRepo.create({
      id,
      name: body.name,
      nameEn: body.nameEn,
      age: body.age,
      gender: body.gender,
      city: body.city,
      district: body.district,
      lat: body.lat,
      lng: body.lng,
      phone: body.phone,
      address: body.address,
      conditions: body.conditions,
      medications: body.medications,
      status: body.status,
      permissions: body.permissions,
      elderlyModeDefault: body.elderlyModeDefault,
      emergencyContact: body.emergencyContact,
      baseline,
      ambientProfile: {
        userId: id,
        baseIndoorTempC: 26,
        baseIndoorHumidityPct: 58,
        baseOutdoorTempC: 29,
        baseOutdoorHumidityPct: 66,
        baseAirQualityIndex: 60,
        baseHeatwaveDays: 0,
        heatSensitivity: 1,
      },
    });

    await recordAudit(req, {
      action: 'Created resident',
      actionZh: '新增長者',
      entity: 'ElderlyUser',
      entityId: user.id,
      newValue: `${user.name} (${user.age}), ${user.district}`,
    });

    await platformState.reloadUsers();
    res.status(201).json({ user });
  }),
);

usersRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('user:write'),
  validate(elderlyUserUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await userRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident does not exist.' });
      return;
    }

    const user = await userRepo.update(pathParam(req, 'id'), req.body as Partial<ElderlyUser>);

    await recordAudit(req, {
      action: 'Updated resident',
      actionZh: '更新長者資料',
      entity: 'ElderlyUser',
      entityId: user.id,
      oldValue: summariseUser(before),
      newValue: summariseUser(user),
    });

    await platformState.reloadUsers();
    res.json({ user });
  }),
);

/**
 * PATCH /api/users/:id/permissions
 *
 * The privacy centre and the CMS both write here. Changing
 * `automaticCooling` to false takes effect on the next tick: the policy
 * engine will report ACTIVATE_COOLING as blocked rather than running it.
 */
usersRouter.patch(
  '/:id/permissions',
  requireAuth,
  validate(userPermissionsUpdateSchema),
  requireUserScope((req) => pathParam(req, 'id')),
  asyncHandler(async (req, res) => {
    const before = await userRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident does not exist.' });
      return;
    }

    const permissions = { ...before.permissions, ...req.body };
    const user = await userRepo.update(pathParam(req, 'id'), { permissions });

    await recordAudit(req, {
      action: 'Updated resident permissions',
      actionZh: '更新長者授權設定',
      entity: 'ElderlyUser',
      entityId: user.id,
      oldValue: before.permissions,
      newValue: permissions,
    });

    await platformState.reloadUsers();
    await platformState.reloadConfig();

    res.json({ user });
  }),
);

/** Suspend or reactivate. A suspended resident is no longer monitored. */
usersRouter.post(
  '/:id/suspend',
  requireAuth,
  requirePermission('user:suspend'),
  asyncHandler(async (req, res) => {
    const before = await userRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident does not exist.' });
      return;
    }

    const nextStatus = before.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    const user = await userRepo.update(pathParam(req, 'id'), { status: nextStatus });

    await recordAudit(req, {
      action: nextStatus === 'SUSPENDED' ? 'Suspended resident' : 'Reactivated resident',
      actionZh: nextStatus === 'SUSPENDED' ? '暫停長者帳號' : '恢復長者帳號',
      entity: 'ElderlyUser',
      entityId: user.id,
      oldValue: before.status,
      newValue: nextStatus,
    });

    await platformState.reloadUsers();
    res.json({ user });
  }),
);

/** Re-learn the personal baseline from stored wearable history. */
usersRouter.post(
  '/:id/relearn-baseline',
  requireAuth,
  requirePermission('user:write'),
  asyncHandler(async (req, res) => {
    const user = await userRepo.findById(pathParam(req, 'id'));
    if (!user) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident does not exist.' });
      return;
    }

    if (!user.permissions.physiologicalDataStorage) {
      res.status(409).json({
        error: 'CONSENT_REQUIRED',
        message:
          'This resident has not consented to physiological data storage, so no baseline can be learned.',
        messageZh: '此長者尚未同意儲存生理資料，因此無法學習個人基準。',
      });
      return;
    }

    const readings = await readingRepo.wearableHistory(user.id, 400);
    const previous = await userRepo.getBaseline(user.id);

    /**
     * Learn from resting samples only.
     *
     * A daytime average is contaminated by activity and would widen the band
     * until real deviations stop registering. This used to fall back to ALL
     * readings when resting samples were thin - doing the very thing the rule
     * exists to prevent, and now also reporting a high sample count that would
     * promote the baseline to "ready" on daytime data.
     *
     * There is no need for that compromise. Too few resting samples is not a
     * problem to be papered over, it is a state the platform can be in and
     * say so: the baseline comes back LEARNING, the screens explain that it is
     * comparing against typical ranges meanwhile, and it settles as the nights
     * accumulate.
     */
    const resting = readings.filter((r) => {
      const hour = new Date(r.recordedAt).getHours();
      return hour >= 22 || hour <= 6;
    });

    const baseline = learnPersonalBaseline(user.id, resting, previous ?? undefined);

    await userRepo.setBaseline(user.id, baseline);

    await recordAudit(req, {
      action: 'Re-learned personal baseline',
      actionZh: '重新學習個人生理基準',
      entity: 'ElderlyUser',
      entityId: user.id,
      oldValue: previous ? `${previous.heartRate.min}-${previous.heartRate.max} BPM` : '-',
      newValue: `${baseline.heartRate.min}-${baseline.heartRate.max} BPM (${baseline.sampleCount} samples)`,
    });

    await platformState.reloadUsers();

    res.json({
      baseline,
      sampleCount: baseline.sampleCount,
      // What the operator actually needs to know: whether this is usable yet.
      readiness: baselineReadiness(baseline),
    });
  }),
);

function summariseUser(user: ElderlyUser): string {
  return `${user.name}, age ${user.age}, ${user.district}, ${user.status}`;
}
