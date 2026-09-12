/**
 * /api/alerts, /api/notifications
 */

import { Router } from 'express';
import {
  alertUpdateSchema,
  notificationTemplateUpdateSchema,
  testNotificationSchema,
} from '../../shared/schemas/index.js';
import type { AlertStatus, NotificationTemplate } from '../../shared/types/domain.js';
import {
  buildTemplateVars,
  interpolate,
} from '../../shared/domain/notificationEngine.js';
import {
  alertRepo,
  caregiverRepo,
  notificationRepo,
  notificationTemplateRepo,
  userRepo,
} from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

export const alertsRouter = Router();
export const notificationsRouter = Router();

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

alertsRouter.get(
  '/',
  requireAuth,
  requirePermission('alert:read'),
  asyncHandler(async (req, res) => {
    const account = req.account!;
    let alerts = await alertRepo.list(200);

    // A caregiver sees only alerts for their own residents.
    if (account.role === 'CAREGIVER' && account.caregiverId) {
      const caregiver = await caregiverRepo.findById(account.caregiverId);
      const allowed = new Set(caregiver?.assignedUserIds ?? []);
      alerts = alerts.filter((a) => allowed.has(a.userId));
    }

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && status !== 'ALL') {
      alerts = alerts.filter((a) => a.status === status);
    }

    res.json({
      alerts,
      total: alerts.length,
      counts: {
        NEW: alerts.filter((a) => a.status === 'NEW').length,
        ACKNOWLEDGED: alerts.filter((a) => a.status === 'ACKNOWLEDGED').length,
        ESCALATED: alerts.filter((a) => a.status === 'ESCALATED').length,
        RESOLVED: alerts.filter((a) => a.status === 'RESOLVED').length,
      },
    });
  }),
);

/** Full alert detail: why it fired, the sensor data, the AI reasoning, the timeline. */
alertsRouter.get(
  '/:id',
  requireAuth,
  requirePermission('alert:read'),
  asyncHandler(async (req, res) => {
    const alert = await alertRepo.findById(pathParam(req, 'id'));

    if (!alert) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'That alert does not exist.',
        messageZh: '找不到此警示。',
      });
      return;
    }

    const account = req.account!;
    if (account.role === 'CAREGIVER' && account.caregiverId) {
      const caregiver = await caregiverRepo.findById(account.caregiverId);
      if (!caregiver?.assignedUserIds.includes(alert.userId)) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'This alert concerns a resident who is not assigned to you.',
          messageZh: '此警示的長者未指派給您。',
        });
        return;
      }
    }

    const [user, caregivers] = await Promise.all([
      userRepo.findById(alert.userId),
      caregiverRepo.forUser(alert.userId),
    ]);

    res.json({
      alert,
      user,
      caregivers,
      // The live assessment alongside the snapshot at trigger time, so a
      // responder can see whether the situation has since changed.
      currentAssessment: platformState.getAssessment(alert.userId),
    });
  }),
);

alertsRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('alert:write'),
  validate(alertUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await alertRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That alert does not exist.' });
      return;
    }

    const body = req.body as { status: AlertStatus; assignedCaregiverId?: string | null; note?: string };
    const account = req.account!;
    const now = new Date().toISOString();

    const caregiver = body.assignedCaregiverId
      ? await caregiverRepo.findById(body.assignedCaregiverId)
      : null;

    const alert = await alertRepo.update(pathParam(req, 'id'), {
      status: body.status,
      ...(body.assignedCaregiverId !== undefined
        ? {
            assignedCaregiverId: body.assignedCaregiverId,
            assignedCaregiverName: caregiver?.name ?? null,
          }
        : {}),
      ...(body.status === 'ACKNOWLEDGED' && !before.acknowledgedAt ? { acknowledgedAt: now } : {}),
      ...(body.status === 'RESOLVED' ? { resolvedAt: now } : {}),
      appendTimeline: [
        {
          at: now,
          label: `Status changed ${before.status} to ${body.status}${body.note ? ` - ${body.note}` : ''}`,
          labelZh: `狀態由 ${before.status} 變更為 ${body.status}${body.note ? `：${body.note}` : ''}`,
          actor: account.nameZh || account.name,
          kind: 'STATUS',
        },
      ],
    });

    await recordAudit(req, {
      action: `Alert ${body.status.toLowerCase()}`,
      actionZh: `警示狀態變更為 ${body.status}`,
      entity: 'Alert',
      entityId: alert.id,
      oldValue: before.status,
      newValue: body.status,
    });

    await platformState.reloadAlerts();
    res.json({ alert });
  }),
);

// ---------------------------------------------------------------------------
// Notification log
// ---------------------------------------------------------------------------

notificationsRouter.get(
  '/',
  requireAuth,
  requirePermission('notification:read'),
  asyncHandler(async (req, res) => {
    const account = req.account!;
    let notifications = await notificationRepo.list(200);

    if (account.role === 'CAREGIVER' && account.caregiverId) {
      notifications = notifications.filter((n) => n.recipientId === account.caregiverId);
    }

    res.json({
      notifications,
      total: notifications.length,
      unread: notifications.filter((n) => !n.read).length,
    });
  }),
);

notificationsRouter.post(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    await notificationRepo.markRead(pathParam(req, 'id'));
    await platformState.reloadNotifications();
    res.json({ read: true, id: pathParam(req, 'id') });
  }),
);

notificationsRouter.post(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = req.account!;
    const count = await notificationRepo.markAllRead(account.caregiverId ?? null);
    await platformState.reloadNotifications();
    res.json({ markedRead: count });
  }),
);

// ---------------------------------------------------------------------------
// Notification templates
// ---------------------------------------------------------------------------

notificationsRouter.get(
  '/templates',
  requireAuth,
  requirePermission('notification:read'),
  asyncHandler(async (_req, res) => {
    res.json({
      templates: await notificationTemplateRepo.list(),
      variables: [
        { key: 'user', description: "The resident's name", descriptionZh: '長者姓名' },
        { key: 'level', description: 'Current risk level', descriptionZh: '目前風險等級' },
        { key: 'heatIndex', description: 'Heat index in Celsius', descriptionZh: '熱指數（°C）' },
        { key: 'indoorTemp', description: 'Indoor temperature', descriptionZh: '室內溫度' },
        { key: 'humidity', description: 'Indoor humidity', descriptionZh: '室內濕度' },
        { key: 'hr', description: 'Heart rate in BPM', descriptionZh: '心率（BPM）' },
        { key: 'deviation', description: '% above personal baseline', descriptionZh: '高於個人基準百分比' },
        { key: 'device', description: 'Device name', descriptionZh: '裝置名稱' },
        { key: 'time', description: 'Current time HH:MM', descriptionZh: '目前時間' },
      ],
    });
  }),
);

/**
 * POST /api/notifications/templates/:key/preview
 *
 * Render a template against live data without sending it, so an admin can see
 * the actual message before saving. Accepts an unsaved draft in the body.
 */
notificationsRouter.post(
  '/templates/:key/preview',
  requireAuth,
  requirePermission('notification:read'),
  asyncHandler(async (req, res) => {
    const templates = await notificationTemplateRepo.list();
    const template = templates.find((t) => t.key === pathParam(req, 'key'));

    if (!template) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That template does not exist.' });
      return;
    }

    const draft = req.body as Partial<NotificationTemplate>;
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : 'user-001';

    const user = await userRepo.findById(userId);
    const assessment = platformState.getAssessment(userId);

    const vars = buildTemplateVars({
      userName: user?.name ?? '王奶奶',
      assessment,
      deviceName: platformState.getDevicesCache().find((d) => d.userId === userId)?.nameZh,
    });

    res.json({
      preview: {
        title: interpolate(draft.title ?? template.title, vars),
        titleZh: interpolate(draft.titleZh ?? template.titleZh, vars),
        body: interpolate(draft.body ?? template.body, vars),
        bodyZh: interpolate(draft.bodyZh ?? template.bodyZh, vars),
      },
      variables: vars,
      enabled: draft.enabled ?? template.enabled,
    });
  }),
);

notificationsRouter.patch(
  '/templates/:key',
  requireAuth,
  requirePermission('notification:write'),
  validate(notificationTemplateUpdateSchema),
  asyncHandler(async (req, res) => {
    const templates = await notificationTemplateRepo.list();
    const before = templates.find((t) => t.key === pathParam(req, 'key'));

    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That template does not exist.' });
      return;
    }

    const template = await notificationTemplateRepo.update(
      pathParam(req, 'key'),
      req.body as Partial<NotificationTemplate>,
    );

    await recordAudit(req, {
      action: 'Updated notification template',
      actionZh: '更新通知範本',
      entity: 'NotificationTemplate',
      entityId: template.key,
      oldValue: `${before.enabled ? 'enabled' : 'disabled'}: ${before.titleZh}`,
      newValue: `${template.enabled ? 'enabled' : 'disabled'}: ${template.titleZh}`,
    });

    // Reload so the next notification the platform sends uses the new wording.
    await platformState.reloadTemplates();
    res.json({ template });
  }),
);

/** Send a real notification on demand, from the CMS demo controls. */
notificationsRouter.post(
  '/test',
  requireAuth,
  requirePermission('notification:write'),
  validate(testNotificationSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { templateKey: NotificationTemplate['key']; userId: string };

    const result = await platformState.sendTestNotification({
      templateKey: body.templateKey,
      userId: body.userId,
    });

    await recordAudit(req, {
      action: 'Sent test notification',
      actionZh: '發送測試通知',
      entity: 'Notification',
      entityId: body.templateKey,
      newValue: result.sent ? `sent for ${body.userId}` : `suppressed: ${result.reason}`,
    });

    await platformState.reloadNotifications();

    res.status(result.sent ? 200 : 409).json({
      sent: result.sent,
      // When a send is suppressed the reason is returned rather than a
      // false success, so the admin learns which switch stopped it.
      reason: result.reason,
      message: result.sent
        ? 'Notification sent to the assigned caregivers.'
        : 'The notification was not sent.',
      messageZh: result.sent ? '已發送給指派的照護者。' : '通知未發送。',
    });
  }),
);
