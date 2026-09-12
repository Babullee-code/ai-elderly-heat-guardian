/**
 * /api/caregivers - caregiver records and assignments.
 */

import { Router } from 'express';
import {
  assignmentSchema,
  caregiverCreateSchema,
  caregiverUpdateSchema,
} from '../../shared/schemas/index.js';
import type { Caregiver } from '../../shared/types/domain.js';
import { RISK_ORDER } from '../../shared/types/domain.js';
import { alertRepo, caregiverRepo, userRepo } from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const caregiversRouter = Router();

caregiversRouter.get(
  '/',
  requireAuth,
  requirePermission('caregiver:read'),
  asyncHandler(async (req, res) => {
    const account = req.account!;
    let caregivers = await caregiverRepo.list();

    // A caregiver sees their own record, not the whole roster.
    if (account.role === 'CAREGIVER' && account.caregiverId) {
      caregivers = caregivers.filter((c) => c.id === account.caregiverId);
    }

    const users = await userRepo.list();

    const rows = caregivers.map((caregiver) => {
      const assigned = users.filter((u) => caregiver.assignedUserIds.includes(u.id));

      // How many of this caregiver's residents are currently at each level -
      // the figure that makes the caregiver table actionable.
      const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const user of assigned) {
        const level = platformState.getAssessment(user.id)?.level ?? 'LOW';
        counts[level]++;
      }

      return {
        ...caregiver,
        assignedUsers: assigned.map((u) => ({
          id: u.id,
          name: u.name,
          age: u.age,
          district: u.district,
          level: platformState.getAssessment(u.id)?.level ?? 'LOW',
        })),
        riskCounts: counts,
      };
    });

    res.json({ caregivers: rows, total: rows.length });
  }),
);

/**
 * GET /api/caregivers/:id/dashboard
 *
 * Everything the caregiver dashboard needs in one call: assigned residents
 * with live risk, sorted highest-risk first, plus their open alerts.
 */
caregiversRouter.get(
  '/:id/dashboard',
  requireAuth,
  requirePermission('caregiver:read'),
  asyncHandler(async (req, res) => {
    const account = req.account!;

    if (account.role === 'CAREGIVER' && account.caregiverId !== pathParam(req, 'id')) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You can only view your own dashboard.',
        messageZh: '您只能檢視自己的照護儀表板。',
      });
      return;
    }

    const caregiver = await caregiverRepo.findById(pathParam(req, 'id'));
    if (!caregiver) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That caregiver does not exist.' });
      return;
    }

    const allUsers = await userRepo.list();
    const assigned = allUsers.filter((u) => caregiver.assignedUserIds.includes(u.id));
    const devices = platformState.getDevicesCache();

    const residents = assigned
      .map((user) => {
        const assessment = platformState.getAssessment(user.id);
        const userDevices = devices.filter((d) => d.userId === user.id);
        const online = userDevices.filter(
          (d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY',
        ).length;

        return {
          user,
          assessment,
          smartHome: platformState.getSmartHome(user.id),
          history: platformState.getHistory(user.id).slice(-40),
          deviceCount: userDevices.length,
          devicesOnline: online,
          lastUpdate: assessment?.timestamp ?? null,
        };
      })
      .sort((a, b) => {
        const diff =
          RISK_ORDER[b.assessment?.level ?? 'LOW'] - RISK_ORDER[a.assessment?.level ?? 'LOW'];
        return diff !== 0 ? diff : (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0);
      });

    const alerts = (await alertRepo.list(150)).filter(
      (a) => caregiver.assignedUserIds.includes(a.userId) && a.status !== 'RESOLVED',
    );

    res.json({ caregiver, residents, alerts });
  }),
);

caregiversRouter.post(
  '/',
  requireAuth,
  requirePermission('caregiver:write'),
  validate(caregiverCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof caregiverCreateSchema._output;

    const existing = await caregiverRepo.list();
    const id = `cg-${String(existing.length + 1).padStart(3, '0')}`;

    const caregiver = await caregiverRepo.create({
      id,
      name: body.name,
      nameEn: body.nameEn,
      relationship: body.relationship,
      phone: body.phone,
      email: body.email,
      assignedUserIds: body.assignedUserIds,
      notificationPreferences: body.notificationPreferences,
      emergencyPermission: body.emergencyPermission,
      status: body.status,
    });

    await recordAudit(req, {
      action: 'Created caregiver',
      actionZh: '新增照護者',
      entity: 'Caregiver',
      entityId: caregiver.id,
      newValue: `${caregiver.name} (${caregiver.relationship}), ${caregiver.assignedUserIds.length} residents`,
    });

    await platformState.reloadCaregivers();
    res.status(201).json({ caregiver });
  }),
);

caregiversRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('caregiver:write'),
  validate(caregiverUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await caregiverRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That caregiver does not exist.' });
      return;
    }

    const caregiver = await caregiverRepo.update(pathParam(req, 'id'), req.body as Partial<Caregiver>);

    await recordAudit(req, {
      action: 'Updated caregiver',
      actionZh: '更新照護者資料',
      entity: 'Caregiver',
      entityId: caregiver.id,
      oldValue: summarise(before),
      newValue: summarise(caregiver),
    });

    await platformState.reloadCaregivers();
    res.json({ caregiver });
  }),
);

/** Deactivate or reactivate. An inactive caregiver receives no notifications. */
caregiversRouter.post(
  '/:id/toggle-status',
  requireAuth,
  requirePermission('caregiver:write'),
  asyncHandler(async (req, res) => {
    const before = await caregiverRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That caregiver does not exist.' });
      return;
    }

    const status = before.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const caregiver = await caregiverRepo.update(pathParam(req, 'id'), { status });

    await recordAudit(req, {
      action: status === 'ACTIVE' ? 'Reactivated caregiver' : 'Deactivated caregiver',
      actionZh: status === 'ACTIVE' ? '恢復照護者' : '停用照護者',
      entity: 'Caregiver',
      entityId: caregiver.id,
      oldValue: before.status,
      newValue: status,
    });

    await platformState.reloadCaregivers();
    // Re-evaluate: a resident whose only caregiver just went inactive should
    // now show NOTIFY_CAREGIVER as blocked rather than silently doing nothing.
    await platformState.reloadConfig();

    res.json({ caregiver });
  }),
);

caregiversRouter.post(
  '/assign',
  requireAuth,
  requirePermission('caregiver:write'),
  validate(assignmentSchema),
  asyncHandler(async (req, res) => {
    const { caregiverId, userId } = req.body as { caregiverId: string; userId: string };

    const [caregiver, user] = await Promise.all([
      caregiverRepo.findById(caregiverId),
      userRepo.findById(userId),
    ]);

    if (!caregiver || !user) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Caregiver or resident not found.',
        messageZh: '找不到照護者或長者。',
      });
      return;
    }

    await caregiverRepo.assign(caregiverId, userId);

    await recordAudit(req, {
      action: 'Assigned resident to caregiver',
      actionZh: '指派長者給照護者',
      entity: 'CaregiverAssignment',
      entityId: `${caregiverId}:${userId}`,
      newValue: `${caregiver.name} to ${user.name}`,
    });

    await platformState.reloadCaregivers();
    await platformState.reloadConfig();

    res.json({ caregiver: await caregiverRepo.findById(caregiverId) });
  }),
);

caregiversRouter.post(
  '/unassign',
  requireAuth,
  requirePermission('caregiver:write'),
  validate(assignmentSchema),
  asyncHandler(async (req, res) => {
    const { caregiverId, userId } = req.body as { caregiverId: string; userId: string };

    await caregiverRepo.unassign(caregiverId, userId);

    await recordAudit(req, {
      action: 'Removed caregiver assignment',
      actionZh: '移除照護指派',
      entity: 'CaregiverAssignment',
      entityId: `${caregiverId}:${userId}`,
      oldValue: `${caregiverId} to ${userId}`,
      newValue: 'removed',
    });

    await platformState.reloadCaregivers();
    await platformState.reloadConfig();

    res.json({ caregiver: await caregiverRepo.findById(caregiverId) });
  }),
);

function summarise(caregiver: Caregiver): string {
  return `${caregiver.name} (${caregiver.relationship}), min level ${caregiver.notificationPreferences.minLevel}, ${caregiver.assignedUserIds.length} residents, ${caregiver.status}`;
}
