/**
 * In-browser API router for the static build.
 *
 * Mirrors `server/routes/*` so that `src/lib/api.ts` and every page work
 * byte-identically against either backend. Interception happens at the fetch
 * layer precisely so nothing above it has to know which mode it is in.
 *
 * Authorisation is enforced here too. It is *not* a security boundary in a
 * static build — anyone can edit the JavaScript — but leaving it in means a
 * VIEWER still sees 403 and the permission model is demonstrable rather than
 * merely described.
 */

import { isHeldQuality, primaryFieldForDevice } from '@shared/domain/provenance';
import type {
  ActionRule,
  Alert,
  ContentArticle,
  CoolingSpace,
  DataSource,
  Device,
  ElderlyUser,
  NotificationTemplate,
  Permission,
  RiskLevel,
  RiskRuleConfig,
  Role,
  ServiceStatus,
  SystemService,
} from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';
import { ROLE_PERMISSIONS, hasPermission } from '@shared/domain/permissions';
import { buildRuleContext, evaluateRule, ACTION_CATALOGUE } from '@shared/domain/actionEngine';
import {
  COOLING_SPACE_LABELS,
  isOpenNow,
  recommendCoolingSpaces,
} from '@shared/domain/coolingSpaces';
import { buildTemplateVars, interpolate } from '@shared/domain/notificationEngine';
import { PHASE_LABELS, SCENARIOS, scenarioDurationSec } from '@shared/domain/simulationEngine';
import { learnPersonalBaseline } from '@shared/domain/baselineEngine';
import { cloneDefaultConfig } from '@shared/domain/config';
import type { DataQuality, ScenarioName } from '@shared/types/domain';

import { demoBackend as db } from './backend';

// ---------------------------------------------------------------------------

interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  accountId: string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly messageZh?: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

const notFound = (zh = '找不到資料。') => new HttpError(404, 'NOT_FOUND', 'Not found.', zh);

function account(ctx: Ctx) {
  const found = ctx.accountId ? db.accounts.find((a) => a.id === ctx.accountId) : null;
  if (!found) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Sign in to continue.', '請先以示範帳號登入。');
  }
  return found;
}

function require_(ctx: Ctx, permission: Permission) {
  const acc = account(ctx);
  if (!hasPermission(acc.role, permission)) {
    throw new HttpError(
      403,
      'FORBIDDEN',
      `The ${acc.role} role does not have the "${permission}" permission.`,
      `目前角色（${acc.role}）沒有「${permission}」權限。`,
    );
  }
  return acc;
}

/** Caregivers may only reach residents assigned to them; elders only themselves. */
function requireScope(ctx: Ctx, userId: string) {
  const acc = account(ctx);

  if (acc.role === 'ELDER') {
    if (acc.elderlyUserId !== userId) {
      throw new HttpError(403, 'FORBIDDEN', 'You can only view your own information.', '您只能檢視自己的資料。');
    }
    return acc;
  }

  if (acc.role === 'CAREGIVER') {
    const cg = acc.caregiverId ? db.caregivers.find((c) => c.id === acc.caregiverId) : null;
    if (!cg || !cg.assignedUserIds.includes(userId)) {
      throw new HttpError(403, 'FORBIDDEN', 'This resident is not assigned to you.', '此長者未指派給您。');
    }
  }

  return acc;
}

const isStaff = (role: Role) => role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'VIEWER';

/** Match a path against a pattern like `/users/:id/devices`. */
function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

type Handler = (ctx: Ctx, params: Record<string, string>) => unknown;

const routes: { method: string; pattern: string; handler: Handler }[] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push({ method, pattern, handler });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function userRow(user: ElderlyUser) {
  const assessment = db.runtimes.get(user.id)?.assessment ?? null;
  const devices = db.devices.filter((d) => d.userId === user.id);
  const online = devices.filter((d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY').length;

  return {
    ...user,
    assessment,
    deviceCount: devices.length,
    devicesOnline: online,
    deviceStatus:
      devices.length === 0
        ? 'NONE'
        : online === devices.length
          ? 'ALL_ONLINE'
          : online === 0
            ? 'ALL_OFFLINE'
            : 'PARTIAL',
    caregivers: db.caregivers
      .filter((c) => c.assignedUserIds.includes(user.id))
      .map((c) => ({ id: c.id, name: c.name, relationship: c.relationship, status: c.status })),
    lastUpdate: assessment?.timestamp ?? null,
  };
}

function mergeConfig(patch: Partial<RiskRuleConfig>): RiskRuleConfig {
  const current = db.config;
  return {
    ...current,
    ...patch,
    thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) },
    weights: { ...current.weights, ...(patch.weights ?? {}) },
    scoreEscalation: { ...current.scoreEscalation, ...(patch.scoreEscalation ?? {}) },
    monitoringIntervalSec: { ...current.monitoringIntervalSec, ...(patch.monitoringIntervalSec ?? {}) },
    physiology: { ...current.physiology, ...(patch.physiology ?? {}) },
    environment: { ...current.environment, ...(patch.environment ?? {}) },
    smartHomePolicy: { ...current.smartHomePolicy, ...(patch.smartHomePolicy ?? {}) },
    notificationPolicy: { ...current.notificationPolicy, ...(patch.notificationPolicy ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

route('GET', '/auth/accounts', () => ({
  accounts: db.accounts,
  demo: true,
  notice: 'These are demo accounts with no passwords.',
  noticeZh: '這些是無密碼的示範帳號，請勿用於正式環境。',
}));

route('POST', '/auth/login', (ctx) => {
  const email = String(ctx.body.email ?? '').toLowerCase().trim();
  const found = db.accounts.find((a) => a.email === email);
  if (!found) {
    throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'No demo account uses that email address.', '找不到使用此電子郵件的示範帳號。');
  }
  return { account: found, permissions: ROLE_PERMISSIONS[found.role], token: found.id };
});

route('GET', '/auth/me', (ctx) => {
  const acc = account(ctx);
  return {
    account: acc,
    permissions: ROLE_PERMISSIONS[acc.role],
    elderlyUser: acc.elderlyUserId ? (db.users.find((u) => u.id === acc.elderlyUserId) ?? null) : null,
    caregiver: acc.caregiverId ? (db.caregivers.find((c) => c.id === acc.caregiverId) ?? null) : null,
  };
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

route('GET', '/users', (ctx) => {
  const acc = require_(ctx, 'user:read');
  let users = db.users;

  if (acc.role === 'CAREGIVER' && acc.caregiverId) {
    const cg = db.caregivers.find((c) => c.id === acc.caregiverId);
    const allowed = new Set(cg?.assignedUserIds ?? []);
    users = users.filter((u) => allowed.has(u.id));
  } else if (acc.role === 'ELDER' && acc.elderlyUserId) {
    users = users.filter((u) => u.id === acc.elderlyUserId);
  }

  const rows = users.map(userRow).sort((a, b) => {
    const diff = RISK_ORDER[b.assessment?.level ?? 'LOW'] - RISK_ORDER[a.assessment?.level ?? 'LOW'];
    return diff !== 0 ? diff : (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0);
  });

  return { users: rows, total: rows.length };
});

route('GET', '/users/:id', (ctx, { id }) => {
  require_(ctx, 'user:read');
  requireScope(ctx, id);

  const user = db.users.find((u) => u.id === id);
  if (!user) throw notFound('找不到此長者資料。');
  const runtime = db.runtimes.get(id);

  return {
    user,
    baseline: runtime?.baseline ?? null,
    assessment: runtime?.assessment ?? null,
    smartHome: runtime?.smartHome ?? null,
    history: runtime?.history ?? [],
    devices: db.devices.filter((d) => d.userId === id),
    caregivers: db.caregivers.filter((c) => c.assignedUserIds.includes(id)),
    riskEvents: db.riskEvents.filter((e) => e.userId === id).slice(0, 40),
    environmentHistory: db.getEnvironmentHistory(id, 96),
    wearableHistory: db.getWearableHistory(id, 96),
    alerts: db.alerts.filter((a) => a.userId === id).slice(0, 20),
    monitoringIntervalSec: db.config.monitoringIntervalSec[runtime?.assessment.level ?? 'LOW'],
  };
});

route('PATCH', '/users/:id/permissions', (ctx, { id }) => {
  requireScope(ctx, id);
  const user = db.users.find((u) => u.id === id);
  if (!user) throw notFound('找不到此長者。');

  const before = { ...user.permissions };
  user.permissions = { ...user.permissions, ...(ctx.body as Partial<ElderlyUser['permissions']>) };
  user.updatedAt = new Date().toISOString();

  db.audit({
    actorId: account(ctx).id,
    actorName: account(ctx).nameZh,
    actorRole: account(ctx).role,
    action: 'Updated resident permissions',
    actionZh: '更新長者授權設定',
    entity: 'ElderlyUser',
    entityId: id,
    oldValue: JSON.stringify(before),
    newValue: JSON.stringify(user.permissions),
  });

  db.refreshRuntimeUsers();
  return { user };
});

route('PATCH', '/users/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'user:write');
  const user = db.users.find((u) => u.id === id);
  if (!user) throw notFound('找不到此長者。');

  Object.assign(user, ctx.body, { updatedAt: new Date().toISOString() });
  user.location = `${user.city} ${user.district}`;

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Updated resident',
    actionZh: '更新長者資料',
    entity: 'ElderlyUser',
    entityId: id,
    oldValue: null,
    newValue: `${user.name}, age ${user.age}, ${user.district}`,
  });

  db.refreshRuntimeUsers();
  return { user };
});

route('POST', '/users/:id/suspend', (ctx, { id }) => {
  const acc = require_(ctx, 'user:suspend');
  const user = db.users.find((u) => u.id === id);
  if (!user) throw notFound('找不到此長者。');

  const before = user.status;
  user.status = user.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: user.status === 'SUSPENDED' ? 'Suspended resident' : 'Reactivated resident',
    actionZh: user.status === 'SUSPENDED' ? '暫停長者帳號' : '恢復長者帳號',
    entity: 'ElderlyUser',
    entityId: id,
    oldValue: before,
    newValue: user.status,
  });

  db.refreshRuntimeUsers();
  return { user };
});

route('POST', '/users/:id/relearn-baseline', (ctx, { id }) => {
  const acc = require_(ctx, 'user:write');
  const user = db.users.find((u) => u.id === id);
  const runtime = db.runtimes.get(id);
  if (!user || !runtime) throw notFound('找不到此長者。');

  if (!user.permissions.physiologicalDataStorage) {
    throw new HttpError(
      409,
      'CONSENT_REQUIRED',
      'This resident has not consented to physiological data storage.',
      '此長者尚未同意儲存生理資料，因此無法學習個人基準。',
    );
  }

  const readings = db.getWearableHistory(id, 400);
  const resting = readings.filter((r) => {
    const hour = new Date(r.recordedAt).getHours();
    return hour >= 22 || hour <= 6;
  });

  const previous = runtime.baseline;
  runtime.baseline = learnPersonalBaseline(id, resting.length >= 12 ? resting : readings, previous);

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Re-learned personal baseline',
    actionZh: '重新學習個人生理基準',
    entity: 'ElderlyUser',
    entityId: id,
    oldValue: `${previous.heartRate.min}-${previous.heartRate.max} BPM`,
    newValue: `${runtime.baseline.heartRate.min}-${runtime.baseline.heartRate.max} BPM (${runtime.baseline.sampleCount} samples)`,
  });

  db.reloadConfig();
  return { baseline: runtime.baseline, sampleCount: runtime.baseline.sampleCount };
});

// ---------------------------------------------------------------------------
// Caregivers
// ---------------------------------------------------------------------------

route('GET', '/caregivers', (ctx) => {
  const acc = require_(ctx, 'caregiver:read');
  let caregivers = db.caregivers;
  if (acc.role === 'CAREGIVER' && acc.caregiverId) {
    caregivers = caregivers.filter((c) => c.id === acc.caregiverId);
  }

  const rows = caregivers.map((caregiver) => {
    const assigned = db.users.filter((u) => caregiver.assignedUserIds.includes(u.id));
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const u of assigned) counts[db.runtimes.get(u.id)?.assessment.level ?? 'LOW']++;

    return {
      ...caregiver,
      assignedUsers: assigned.map((u) => ({
        id: u.id,
        name: u.name,
        age: u.age,
        district: u.district,
        level: db.runtimes.get(u.id)?.assessment.level ?? 'LOW',
      })),
      riskCounts: counts,
    };
  });

  return { caregivers: rows, total: rows.length };
});

route('GET', '/caregivers/:id/dashboard', (ctx, { id }) => {
  const acc = require_(ctx, 'caregiver:read');
  if (acc.role === 'CAREGIVER' && acc.caregiverId !== id) {
    throw new HttpError(403, 'FORBIDDEN', 'You can only view your own dashboard.', '您只能檢視自己的照護儀表板。');
  }

  const caregiver = db.caregivers.find((c) => c.id === id);
  if (!caregiver) throw notFound('找不到此照護者。');

  const residents = db.users
    .filter((u) => caregiver.assignedUserIds.includes(u.id))
    .map((user) => {
      const runtime = db.runtimes.get(user.id);
      const devices = db.devices.filter((d) => d.userId === user.id);
      return {
        user,
        assessment: runtime?.assessment ?? null,
        smartHome: runtime?.smartHome ?? null,
        history: (runtime?.history ?? []).slice(-40),
        deviceCount: devices.length,
        devicesOnline: devices.filter((d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY').length,
        lastUpdate: runtime?.assessment.timestamp ?? null,
      };
    })
    .sort((a, b) => {
      const diff = RISK_ORDER[b.assessment?.level ?? 'LOW'] - RISK_ORDER[a.assessment?.level ?? 'LOW'];
      return diff !== 0 ? diff : (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0);
    });

  return {
    caregiver,
    residents,
    alerts: db.alerts.filter(
      (a) => caregiver.assignedUserIds.includes(a.userId) && a.status !== 'RESOLVED',
    ),
  };
});

route('PATCH', '/caregivers/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'caregiver:write');
  const caregiver = db.caregivers.find((c) => c.id === id);
  if (!caregiver) throw notFound('找不到此照護者。');

  Object.assign(caregiver, ctx.body);

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Updated caregiver',
    actionZh: '更新照護者資料',
    entity: 'Caregiver',
    entityId: id,
    oldValue: null,
    newValue: `${caregiver.name}, ${caregiver.assignedUserIds.length} residents`,
  });

  db.reloadConfig();
  return { caregiver };
});

route('POST', '/caregivers', (ctx) => {
  const acc = require_(ctx, 'caregiver:write');
  const body = ctx.body as Record<string, never>;
  const caregiver = {
    id: `cg-${String(db.caregivers.length + 1).padStart(3, '0')}`,
    createdAt: new Date().toISOString(),
    ...body,
  } as unknown as (typeof db.caregivers)[number];

  db.caregivers.push(caregiver);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Created caregiver',
    actionZh: '新增照護者',
    entity: 'Caregiver',
    entityId: caregiver.id,
    oldValue: null,
    newValue: caregiver.name,
  });

  db.reloadConfig();
  return { caregiver };
});

route('POST', '/caregivers/:id/toggle-status', (ctx, { id }) => {
  const acc = require_(ctx, 'caregiver:write');
  const caregiver = db.caregivers.find((c) => c.id === id);
  if (!caregiver) throw notFound('找不到此照護者。');

  const before = caregiver.status;
  caregiver.status = caregiver.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: caregiver.status === 'ACTIVE' ? 'Reactivated caregiver' : 'Deactivated caregiver',
    actionZh: caregiver.status === 'ACTIVE' ? '恢復照護者' : '停用照護者',
    entity: 'Caregiver',
    entityId: id,
    oldValue: before,
    newValue: caregiver.status,
  });

  db.reloadConfig();
  return { caregiver };
});

route('POST', '/caregivers/assign', (ctx) => {
  require_(ctx, 'caregiver:write');
  const { caregiverId, userId } = ctx.body as { caregiverId: string; userId: string };
  const caregiver = db.caregivers.find((c) => c.id === caregiverId);
  if (!caregiver) throw notFound('找不到此照護者。');
  if (!caregiver.assignedUserIds.includes(userId)) caregiver.assignedUserIds.push(userId);
  db.reloadConfig();
  return { caregiver };
});

route('POST', '/caregivers/unassign', (ctx) => {
  require_(ctx, 'caregiver:write');
  const { caregiverId, userId } = ctx.body as { caregiverId: string; userId: string };
  const caregiver = db.caregivers.find((c) => c.id === caregiverId);
  if (!caregiver) throw notFound('找不到此照護者。');
  caregiver.assignedUserIds = caregiver.assignedUserIds.filter((id) => id !== userId);
  db.reloadConfig();
  return { caregiver };
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

route('GET', '/devices', (ctx) => {
  require_(ctx, 'device:read');
  const byId = new Map(db.users.map((u) => [u.id, u]));

  return {
    devices: db.devices.map((d) => ({
      ...d,
      userName: byId.get(d.userId)?.name ?? 'Unknown',
      userDistrict: byId.get(d.userId)?.district ?? '-',
    })),
    total: db.devices.length,
    summary: {
      online: db.devices.filter((d) => d.status === 'ONLINE').length,
      lowBattery: db.devices.filter((d) => d.status === 'LOW_BATTERY').length,
      offline: db.devices.filter((d) => d.status === 'OFFLINE').length,
      disabled: db.devices.filter((d) => d.status === 'DISABLED').length,
    },
  };
});

route('GET', '/devices/user/:userId', (ctx, { userId }) => {
  require_(ctx, 'device:read');
  requireScope(ctx, userId);
  return {
    devices: db.devices.filter((d) => d.userId === userId),
    smartHome: db.runtimes.get(userId)?.smartHome ?? null,
  };
});

route('GET', '/devices/:id', (ctx, { id }) => {
  require_(ctx, 'device:read');
  const device = db.devices.find((d) => d.id === id);
  if (!device) throw notFound('找不到此裝置。');
  return {
    device,
    user: db.users.find((u) => u.id === device.userId) ?? null,
    history: db.getSensorHistory(id, 120),
  };
});

route('POST', '/devices', (ctx) => {
  const acc = require_(ctx, 'device:write');
  const body = ctx.body as { deviceId: string; name: string; nameZh: string; type: Device['type']; userId: string; location: string; firmware: string };

  const actuator = ['SMART_AC', 'DEHUMIDIFIER', 'FAN'].includes(body.type);
  const device: Device = {
    id: `dev-new-${db.devices.length + 1}-${Date.now().toString(36)}`,
    deviceId: body.deviceId,
    name: body.name,
    nameZh: body.nameZh,
    type: body.type,
    userId: body.userId,
    status: 'ONLINE',
    batteryPct: actuator ? null : 100,
    signalPct: 90,
    lastSeen: new Date().toISOString(),
    firmware: body.firmware.startsWith('v') ? body.firmware : `v${body.firmware}`,
    location: body.location,
    power: false,
    isActuator: actuator,
    createdAt: new Date().toISOString(),
  };

  db.devices.push(device);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Registered device',
    actionZh: '註冊裝置',
    entity: 'Device',
    entityId: device.id,
    oldValue: null,
    newValue: `${device.deviceId} (${device.type})`,
  });

  db.reloadConfig();
  return { device };
});

route('POST', '/devices/:id/action', (ctx, { id }) => {
  const acc = require_(ctx, 'device:write');
  const { action } = ctx.body as { action: string };
  const device = db.devices.find((d) => d.id === id);
  if (!device) throw notFound('找不到此裝置。');

  const before = `${device.status} power=${device.power}`;
  let label = '';
  let labelZh = '';

  switch (action) {
    case 'disable':
      device.status = 'DISABLED';
      device.power = false;
      device.signalPct = 0;
      label = 'Disabled device';
      labelZh = '停用裝置';
      break;
    case 'enable':
    case 'reconnect':
      device.status = device.batteryPct !== null && device.batteryPct < 20 ? 'LOW_BATTERY' : 'ONLINE';
      device.signalPct = 88;
      device.lastSeen = new Date().toISOString();
      label = action === 'enable' ? 'Enabled device' : 'Reconnected device';
      labelZh = action === 'enable' ? '啟用裝置' : '重新連線裝置';
      break;
    case 'toggle-power':
      if (!device.isActuator) {
        throw new HttpError(400, 'NOT_AN_ACTUATOR', 'Only appliances can be switched.', '只有冷氣、電風扇與除濕機可以開關。');
      }
      if (device.status === 'DISABLED' || device.status === 'OFFLINE') {
        throw new HttpError(409, 'DEVICE_UNAVAILABLE', 'This appliance is offline or disabled.', '此設備離線或已停用，無法開關。');
      }
      device.power = !device.power;
      device.lastSeen = new Date().toISOString();
      label = device.power ? 'Switched appliance on' : 'Switched appliance off';
      labelZh = device.power ? '開啟設備' : '關閉設備';
      break;
    case 'configure':
      device.signalPct = 95;
      device.lastSeen = new Date().toISOString();
      label = 'Reconfigured device';
      labelZh = '重新設定裝置';
      break;
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'Unsupported device action.');
  }

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: label,
    actionZh: labelZh,
    entity: 'Device',
    entityId: device.id,
    oldValue: before,
    newValue: `${device.status} power=${device.power}`,
  });

  db.reloadConfig();
  return { device, action };
});

route('DELETE', '/devices/:id', (ctx, { id }) => {
  require_(ctx, 'device:write');
  db.devices = db.devices.filter((d) => d.id !== id);
  db.reloadConfig();
  return { deleted: true, id };
});

route('PATCH', '/devices/:id', (ctx, { id }) => {
  require_(ctx, 'device:write');
  const device = db.devices.find((d) => d.id === id);
  if (!device) throw notFound('找不到此裝置。');
  Object.assign(device, ctx.body);
  db.reloadConfig();
  return { device };
});

// --- ingest credentials -----------------------------------------------------

/**
 * Key management in the static build.
 *
 * The console behaves the same as against the real server - a key is issued,
 * shown once and never retrievable - but there is a difference worth being
 * straight about: this build has no HTTP server, so nothing can actually POST
 * to an ingest endpoint here. A key issued in the static demo proves the
 * workflow, not the data path. The full stack is where a real device connects.
 */
route('POST', '/devices/:id/ingest-key', (ctx, { id }) => {
  require_(ctx, 'device:write');
  const device = db.devices.find((d) => d.id === id);
  if (!device) throw notFound('找不到此裝置。');

  if (device.isActuator) {
    throw new HttpError(
      400,
      'NOT_A_SENSOR',
      'An actuator has nothing to report.',
      '此裝置為控制器，沒有可回報的量測值，不需要資料金鑰。',
    );
  }

  // Not a credential: this build cannot authenticate anything, and generating
  // something that looked like a working key would be the fiction the rest of
  // this system is built to avoid.
  const key = `hgk_demo_${Math.random().toString(36).slice(2, 10)}`;
  device.ingestKeyPrefix = key.slice(0, 12);
  device.ingestKeyIssuedAt = new Date().toISOString();

  db.audit({
    actorId: account(ctx).id,
    actorName: account(ctx).nameZh,
    actorRole: account(ctx).role,
    action: `Issued an ingest key for ${device.deviceId}`,
    actionZh: `為 ${device.deviceId} 產生資料回報金鑰`,
    entity: 'Device',
    entityId: device.id,
    // The key itself is never recorded - that would defeat hashing it.
    oldValue: null,
    newValue: null,
  });

  return {
    device,
    key,
    messageZh: '請立即複製此金鑰，離開後將無法再次顯示。（靜態展示版無法實際接收回報）',
  };
});

route('DELETE', '/devices/:id/ingest-key', (ctx, { id }) => {
  require_(ctx, 'device:write');
  const device = db.devices.find((d) => d.id === id);
  if (!device) throw notFound('找不到此裝置。');

  device.ingestKeyPrefix = null;
  device.ingestKeyIssuedAt = null;

  db.audit({
    actorId: account(ctx).id,
    actorName: account(ctx).nameZh,
    actorRole: account(ctx).role,
    action: `Revoked the ingest key for ${device.deviceId}`,
    actionZh: `撤銷 ${device.deviceId} 的資料回報金鑰`,
    entity: 'Device',
    entityId: device.id,
    oldValue: null,
    newValue: null,
  });

  return { device };
});

// --- smart home -------------------------------------------------------------

route('POST', '/devices/smart-home/:userId', (ctx, { userId }) => {
  requireScope(ctx, userId);
  const { appliance, on } = ctx.body as { appliance: 'ac' | 'fan' | 'dehumidifier'; on: boolean };
  const smartHome = db.setAppliance(userId, appliance, on);
  if (!smartHome) throw notFound('此長者未在監測中。');
  return { smartHome };
});

route('POST', '/devices/smart-home/:userId/cancel-automation', (ctx, { userId }) => {
  requireScope(ctx, userId);
  const smartHome = db.cancelAutomaticCooling(userId);
  if (!smartHome) throw notFound('此長者未在監測中。');
  return { smartHome };
});

route('POST', '/devices/smart-home/:userId/restore-automation', (ctx, { userId }) => {
  requireScope(ctx, userId);
  const smartHome = db.restoreAutomaticCooling(userId);
  if (!smartHome) throw notFound('此長者未在監測中。');
  return { smartHome };
});

// ---------------------------------------------------------------------------
// Sensors & readings
// ---------------------------------------------------------------------------

route('GET', '/sensors', (ctx) => {
  require_(ctx, 'sensor:read');
  const byId = new Map(db.users.map((u) => [u.id, u]));

  const metricFor = (type: Device['type']) =>
    type === 'TEMPERATURE_SENSOR'
      ? 'temperature'
      : type === 'HUMIDITY_SENSOR'
        ? 'humidity'
        : type === 'AIR_QUALITY_SENSOR'
          ? 'airQuality'
          : type === 'SMART_WATCH'
            ? 'heartRate'
            : 'heatIndex';

  const unitFor = (type: Device['type']) =>
    type === 'TEMPERATURE_SENSOR' ? 'C' : type === 'HUMIDITY_SENSOR' ? '%' : type === 'AIR_QUALITY_SENSOR' ? 'AQI' : type === 'SMART_WATCH' ? 'BPM' : 'C';

  const sensors = db.devices
    .filter((d) => !d.isActuator)
    .map((device) => {
      const runtime = db.runtimes.get(device.userId);
      const r = runtime?.reading;
      const value = !r
        ? null
        : device.type === 'TEMPERATURE_SENSOR'
          ? r.indoorTempC
          : device.type === 'HUMIDITY_SENSOR'
            ? r.indoorHumidityPct
            : device.type === 'AIR_QUALITY_SENSOR'
              ? r.airQualityIndex
              : device.type === 'SMART_WATCH'
                ? r.heartRateBpm
                : (runtime?.assessment.heatIndex ?? 0);

      // Same rule as the server: freshness is whatever the risk engine used.
      const field = primaryFieldForDevice(device.type);
      const provenance = field
        ? runtime?.assessment.provenance?.fields?.[field]
        : undefined;
      const quality: DataQuality =
        provenance?.quality ??
        (device.status === 'OFFLINE' || device.status === 'DISABLED' ? 'OFFLINE' : 'LIVE');

      return {
        device,
        userName: byId.get(device.userId)?.name ?? 'Unknown',
        metric: metricFor(device.type),
        value,
        unit: unitFor(device.type),
        quality,
        ageSec: provenance?.ageSec ?? null,
        origin: provenance?.origin ?? null,
        stale: isHeldQuality(quality),
        lastSeen: device.lastSeen,
        simulated: provenance?.simulated ?? true,
      };
    });

  return {
    sensors,
    total: sensors.length,
    metrics: {
      temperature: sensors.filter((s) => s.metric === 'temperature').length,
      humidity: sensors.filter((s) => s.metric === 'humidity').length,
      heartRate: sensors.filter((s) => s.metric === 'heartRate').length,
      airQuality: sensors.filter((s) => s.metric === 'airQuality').length,
    },
  };
});

route('GET', '/sensors/live', (ctx) => {
  require_(ctx, 'sensor:read');
  return {
    series: db.users
      .filter((u) => u.status === 'ACTIVE')
      .map((user) => ({
        userId: user.id,
        userName: user.name,
        district: user.district,
        history: (db.runtimes.get(user.id)?.history ?? []).slice(-60),
        assessment: db.runtimes.get(user.id)?.assessment ?? null,
      })),
    at: new Date().toISOString(),
    simulated: true,
  };
});

route('GET', '/readings/:userId/environment', (ctx, { userId }) => {
  require_(ctx, 'sensor:read');
  requireScope(ctx, userId);
  return { readings: db.getEnvironmentHistory(userId, Number(ctx.query.get('limit')) || 96) };
});

route('GET', '/readings/:userId/wearable', (ctx, { userId }) => {
  require_(ctx, 'sensor:read');
  requireScope(ctx, userId);
  return { readings: db.getWearableHistory(userId, Number(ctx.query.get('limit')) || 96) };
});

route('GET', '/readings/:userId/live', (ctx, { userId }) => {
  requireScope(ctx, userId);
  const runtime = db.runtimes.get(userId);
  if (!runtime) throw new HttpError(404, 'NOT_MONITORED', 'Not monitored.', '此長者目前未在監測中。');
  return { reading: runtime.reading, assessment: runtime.assessment, history: runtime.history };
});

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

route('GET', '/risk', (ctx) => {
  account(ctx);
  return {
    stats: db.buildStats(),
    simulation: { ...db.simulation },
    configVersion: db.configVersion,
    at: new Date().toISOString(),
  };
});

route('GET', '/risk/:userId', (ctx, { userId }) => {
  requireScope(ctx, userId);
  const runtime = db.runtimes.get(userId);
  if (!runtime) throw new HttpError(409, 'NOT_MONITORED', 'Not monitored.', '此長者目前未在監測中。');
  return {
    assessment: runtime.assessment,
    smartHome: runtime.smartHome,
    history: runtime.history,
    config: db.config,
  };
});

route('GET', '/risk/:userId/events', (ctx, { userId }) => {
  requireScope(ctx, userId);
  return { events: db.riskEvents.filter((e) => e.userId === userId).slice(0, 60) };
});

// --- risk rules -------------------------------------------------------------

route('GET', '/risk-rules', (ctx) => {
  require_(ctx, 'risk-rule:read');
  return { config: db.config, version: db.configVersion };
});

route('POST', '/risk-rules/preview', (ctx) => {
  require_(ctx, 'risk-rule:read');
  const candidate = mergeConfig(ctx.body as Partial<RiskRuleConfig>);

  const counts: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  const moved: { userId: string; name: string; from: string; to: string }[] = [];

  for (const runtime of db.runtimes.values()) {
    if (runtime.user.status !== 'ACTIVE') continue;

    // The real engine, against real current readings — nothing saved.
    const projected = assessWith(runtime, candidate);
    counts[projected]++;
    if (projected !== runtime.assessment.level) {
      moved.push({
        userId: runtime.user.id,
        name: runtime.user.name,
        from: runtime.assessment.level,
        to: projected,
      });
    }
  }

  return { current: db.buildStats(), projected: counts, moved, saved: false };
});

route('PATCH', '/risk-rules', (ctx) => {
  const acc = require_(ctx, 'risk-rule:write');
  const next = mergeConfig(ctx.body as Partial<RiskRuleConfig>);

  if (!(next.thresholds.low < next.thresholds.medium && next.thresholds.medium < next.thresholds.high)) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Thresholds must increase.', '門檻必須遞增：LOW < MEDIUM < HIGH。', {
      'thresholds.medium': 'Must sit between the LOW and HIGH thresholds',
    });
  }
  if (next.scoreEscalation.mediumScore >= next.scoreEscalation.highScore) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'MEDIUM score must be below HIGH.', 'MEDIUM 升級分數必須低於 HIGH 升級分數。', {
      'scoreEscalation.mediumScore': 'Must be below the HIGH score',
    });
  }

  for (const change of diffConfig(db.config, next)) {
    db.audit({
      actorId: acc.id,
      actorName: acc.nameZh,
      actorRole: acc.role,
      action: `Changed ${change.label}`,
      actionZh: `變更${change.labelZh}`,
      entity: 'RiskRuleConfig',
      entityId: change.path,
      oldValue: change.from,
      newValue: change.to,
    });
  }

  db.config = { ...next, updatedAt: new Date().toISOString(), updatedBy: acc.id };
  db.reloadConfig();

  return { config: db.config, version: db.configVersion, effect: db.buildStats() };
});

route('POST', '/risk-rules/reset', (ctx) => {
  const acc = require_(ctx, 'risk-rule:write');
  const before = db.config;
  db.config = cloneDefaultConfig();

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Reset risk rules to defaults',
    actionZh: '重設風險規則為預設值',
    entity: 'RiskRuleConfig',
    entityId: 'default',
    oldValue: `LOW ${before.thresholds.low} / MEDIUM ${before.thresholds.medium} / HIGH ${before.thresholds.high}`,
    newValue: `LOW ${db.config.thresholds.low} / MEDIUM ${db.config.thresholds.medium} / HIGH ${db.config.thresholds.high}`,
  });

  db.reloadConfig();
  return { config: db.config, version: db.configVersion, effect: db.buildStats() };
});

// --- action rules -----------------------------------------------------------

route('GET', '/actions/catalogue', (ctx) => {
  require_(ctx, 'action-rule:read');
  return {
    actions: Object.entries(ACTION_CATALOGUE).map(([type, def]) => ({ type, ...def })),
  };
});

route('GET', '/actions/rules', (ctx) => {
  require_(ctx, 'action-rule:read');
  const firing: Record<string, string[]> = {};

  for (const runtime of db.runtimes.values()) {
    if (runtime.user.status !== 'ACTIVE') continue;
    const c = buildRuleContext(runtime.assessment);
    for (const rule of db.actionRules) {
      if (evaluateRule(rule, c)) firing[rule.id] = [...(firing[rule.id] ?? []), runtime.user.name];
    }
  }

  return {
    rules: db.actionRules,
    firing,
    firingCounts: Object.fromEntries(db.actionRules.map((r) => [r.id, (firing[r.id] ?? []).length])),
  };
});

route('POST', '/actions/rules', (ctx) => {
  const acc = require_(ctx, 'action-rule:write');
  const rule = {
    id: `rule-${Date.now().toString(36)}`,
    builtIn: false,
    updatedAt: new Date().toISOString(),
    ...(ctx.body as Record<string, never>),
  } as unknown as ActionRule;

  db.actionRules.push(rule);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Created action rule',
    actionZh: '新增行動規則',
    entity: 'ActionRule',
    entityId: rule.id,
    oldValue: null,
    newValue: rule.name,
  });

  db.reloadConfig();
  return { rule };
});

route('PATCH', '/actions/rules/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'action-rule:write');
  const rule = db.actionRules.find((r) => r.id === id);
  if (!rule) throw notFound('找不到此規則。');

  const before = `${rule.enabled ? 'enabled' : 'disabled'}`;
  Object.assign(rule, ctx.body, { updatedAt: new Date().toISOString() });

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Updated action rule',
    actionZh: '更新行動規則',
    entity: 'ActionRule',
    entityId: id,
    oldValue: before,
    newValue: `${rule.enabled ? 'enabled' : 'disabled'}`,
  });

  db.reloadConfig();
  return { rule };
});

route('DELETE', '/actions/rules/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'action-rule:write');
  const rule = db.actionRules.find((r) => r.id === id);
  if (!rule) throw notFound('找不到此規則。');

  if (rule.builtIn) {
    throw new HttpError(
      409,
      'BUILT_IN_RULE',
      'Built-in rules cannot be deleted. Disable it instead.',
      '內建規則為平台基礎政策，無法刪除，請改為停用。',
    );
  }

  db.actionRules = db.actionRules.filter((r) => r.id !== id);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Deleted action rule',
    actionZh: '刪除行動規則',
    entity: 'ActionRule',
    entityId: id,
    oldValue: rule.name,
    newValue: 'deleted',
  });

  db.reloadConfig();
  return { deleted: true, id };
});

// ---------------------------------------------------------------------------
// Alerts & notifications
// ---------------------------------------------------------------------------

route('GET', '/alerts', (ctx) => {
  const acc = require_(ctx, 'alert:read');
  let alerts = db.alerts;

  if (acc.role === 'CAREGIVER' && acc.caregiverId) {
    const cg = db.caregivers.find((c) => c.id === acc.caregiverId);
    const allowed = new Set(cg?.assignedUserIds ?? []);
    alerts = alerts.filter((a) => allowed.has(a.userId));
  }

  const status = ctx.query.get('status');
  if (status && status !== 'ALL') alerts = alerts.filter((a) => a.status === status);

  return {
    alerts,
    total: alerts.length,
    counts: {
      NEW: alerts.filter((a) => a.status === 'NEW').length,
      ACKNOWLEDGED: alerts.filter((a) => a.status === 'ACKNOWLEDGED').length,
      ESCALATED: alerts.filter((a) => a.status === 'ESCALATED').length,
      RESOLVED: alerts.filter((a) => a.status === 'RESOLVED').length,
    },
  };
});

route('GET', '/alerts/:id', (ctx, { id }) => {
  require_(ctx, 'alert:read');
  const alert = db.alerts.find((a) => a.id === id);
  if (!alert) throw notFound('找不到此警示。');

  return {
    alert,
    user: db.users.find((u) => u.id === alert.userId) ?? null,
    caregivers: db.caregivers.filter((c) => c.assignedUserIds.includes(alert.userId)),
    currentAssessment: db.runtimes.get(alert.userId)?.assessment ?? null,
  };
});

route('PATCH', '/alerts/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'alert:write');
  const alert = db.alerts.find((a) => a.id === id);
  if (!alert) throw notFound('找不到此警示。');

  const body = ctx.body as { status: Alert['status']; assignedCaregiverId?: string | null; note?: string };
  const before = alert.status;
  const now = new Date().toISOString();

  alert.status = body.status;
  if (body.status === 'ACKNOWLEDGED' && !alert.acknowledgedAt) alert.acknowledgedAt = now;
  if (body.status === 'RESOLVED') alert.resolvedAt = now;

  if (body.assignedCaregiverId !== undefined) {
    alert.assignedCaregiverId = body.assignedCaregiverId;
    alert.assignedCaregiverName =
      db.caregivers.find((c) => c.id === body.assignedCaregiverId)?.name ?? null;
  }

  alert.timeline = [
    ...alert.timeline,
    {
      at: now,
      label: `Status changed ${before} to ${body.status}${body.note ? ` - ${body.note}` : ''}`,
      labelZh: `狀態由 ${before} 變更為 ${body.status}${body.note ? `：${body.note}` : ''}`,
      actor: acc.nameZh,
      kind: 'STATUS',
    },
  ];

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: `Alert ${body.status.toLowerCase()}`,
    actionZh: `警示狀態變更為 ${body.status}`,
    entity: 'Alert',
    entityId: id,
    oldValue: before,
    newValue: body.status,
  });

  db.broadcast();
  return { alert };
});

route('GET', '/notifications', (ctx) => {
  const acc = require_(ctx, 'notification:read');
  let list = db.notifications;
  if (acc.role === 'CAREGIVER' && acc.caregiverId) {
    list = list.filter((n) => n.recipientId === acc.caregiverId);
  }
  return { notifications: list, total: list.length, unread: list.filter((n) => !n.read).length };
});

route('POST', '/notifications/:id/read', (ctx, { id }) => {
  account(ctx);
  const n = db.notifications.find((x) => x.id === id);
  if (n) n.read = true;
  db.broadcast();
  return { read: true, id };
});

route('POST', '/notifications/read-all', (ctx) => {
  const acc = account(ctx);
  let count = 0;
  for (const n of db.notifications) {
    if (acc.caregiverId && n.recipientId !== acc.caregiverId) continue;
    if (!n.read) {
      n.read = true;
      count++;
    }
  }
  db.broadcast();
  return { markedRead: count };
});

route('GET', '/notifications/templates', (ctx) => {
  require_(ctx, 'notification:read');
  return {
    templates: db.templates,
    variables: [
      { key: 'user', description: "The resident's name", descriptionZh: '長者姓名' },
      { key: 'level', description: 'Current risk level', descriptionZh: '目前風險等級' },
      { key: 'heatIndex', description: 'Heat index', descriptionZh: '熱指數（°C）' },
      { key: 'indoorTemp', description: 'Indoor temperature', descriptionZh: '室內溫度' },
      { key: 'humidity', description: 'Indoor humidity', descriptionZh: '室內濕度' },
      { key: 'hr', description: 'Heart rate', descriptionZh: '心率（BPM）' },
      { key: 'deviation', description: '% above baseline', descriptionZh: '高於個人基準百分比' },
      { key: 'device', description: 'Device name', descriptionZh: '裝置名稱' },
      { key: 'time', description: 'Current time', descriptionZh: '目前時間' },
    ],
  };
});

route('POST', '/notifications/templates/:key/preview', (ctx, { key }) => {
  require_(ctx, 'notification:read');
  const template = db.templates.find((t) => t.key === key);
  if (!template) throw notFound('找不到此範本。');

  const draft = ctx.body as Partial<NotificationTemplate> & { userId?: string };
  const userId = draft.userId ?? 'user-001';
  const runtime = db.runtimes.get(userId);

  const vars = buildTemplateVars({
    userName: runtime?.user.name ?? '王奶奶',
    assessment: runtime?.assessment ?? null,
    deviceName: db.devices.find((d) => d.userId === userId)?.nameZh,
  });

  return {
    preview: {
      title: interpolate(draft.title ?? template.title, vars),
      titleZh: interpolate(draft.titleZh ?? template.titleZh, vars),
      body: interpolate(draft.body ?? template.body, vars),
      bodyZh: interpolate(draft.bodyZh ?? template.bodyZh, vars),
    },
    variables: vars,
    enabled: draft.enabled ?? template.enabled,
  };
});

route('PATCH', '/notifications/templates/:key', (ctx, { key }) => {
  const acc = require_(ctx, 'notification:write');
  const template = db.templates.find((t) => t.key === key);
  if (!template) throw notFound('找不到此範本。');

  const before = `${template.enabled ? 'enabled' : 'disabled'}: ${template.titleZh}`;
  Object.assign(template, ctx.body, { updatedAt: new Date().toISOString() });

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Updated notification template',
    actionZh: '更新通知範本',
    entity: 'NotificationTemplate',
    entityId: key,
    oldValue: before,
    newValue: `${template.enabled ? 'enabled' : 'disabled'}: ${template.titleZh}`,
  });

  db.broadcast();
  return { template };
});

route('POST', '/notifications/test', (ctx) => {
  const acc = require_(ctx, 'notification:write');
  const { templateKey, userId } = ctx.body as { templateKey: NotificationTemplate['key']; userId: string };
  const result = db.sendTestNotification(templateKey, userId);

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Sent test notification',
    actionZh: '發送測試通知',
    entity: 'Notification',
    entityId: templateKey,
    oldValue: null,
    newValue: result.sent ? `sent for ${userId}` : `suppressed: ${result.reason}`,
  });

  if (!result.sent) {
    throw new HttpError(409, 'SUPPRESSED', result.reason ?? 'Not sent.', result.reason ?? '通知未發送。');
  }

  return {
    sent: true,
    message: 'Notification sent to the assigned caregivers.',
    messageZh: '已發送給指派的照護者。',
  };
});

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

route('GET', '/cooling-spaces', (ctx) => {
  const acc = require_(ctx, 'cooling-space:read');
  const all = db.coolingSpaces;
  const spaces = isStaff(acc.role) ? all : all.filter((s) => s.status === 'ACTIVE');

  return {
    spaces: spaces.map((s) => ({ ...s, openNow: isOpenNow(s) })),
    total: spaces.length,
    types: COOLING_SPACE_LABELS,
    summary: {
      active: all.filter((s) => s.status === 'ACTIVE').length,
      disabled: all.filter((s) => s.status === 'DISABLED').length,
      airConditioned: all.filter((s) => s.airConditioned && s.status === 'ACTIVE').length,
      accessible: all.filter((s) => s.accessible && s.status === 'ACTIVE').length,
      openNow: all.filter((s) => s.status === 'ACTIVE' && isOpenNow(s)).length,
    },
  };
});

route('GET', '/cooling-spaces/recommend/:userId', (ctx, { userId }) => {
  requireScope(ctx, userId);
  const user = db.users.find((u) => u.id === userId);
  if (!user) throw notFound('找不到此長者。');

  if (!user.permissions.locationSharing) {
    return {
      recommendations: [],
      blocked: true,
      reason: 'Location sharing is switched off.',
      reasonZh: '位置分享已關閉，因此無法建議附近的涼適空間。',
    };
  }

  const maxDistanceKm = Number(ctx.query.get('maxDistanceKm')) || 5;
  const level = db.runtimes.get(userId)?.assessment.level ?? 'LOW';

  const recommendations = recommendCoolingSpaces({
    user,
    spaces: db.coolingSpaces,
    level,
    maxDistanceKm,
    limit: Number(ctx.query.get('limit')) || 8,
  });

  return {
    recommendations,
    blocked: false,
    level,
    reason: recommendations.length === 0 ? `No active cooling location within ${maxDistanceKm} km.` : undefined,
    reasonZh: recommendations.length === 0 ? `${maxDistanceKm} 公里內沒有啟用的涼適空間。` : undefined,
  };
});

route('POST', '/cooling-spaces', (ctx) => {
  const acc = require_(ctx, 'cooling-space:write');
  const space = {
    id: `cool-${db.coolingSpaces.length + 1}-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    ...(ctx.body as Record<string, never>),
  } as unknown as CoolingSpace;

  db.coolingSpaces.push(space);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Created cooling location',
    actionZh: '新增涼適空間',
    entity: 'CoolingSpace',
    entityId: space.id,
    oldValue: null,
    newValue: space.name,
  });

  db.reloadConfig();
  return { space };
});

route('PATCH', '/cooling-spaces/:id', (ctx, { id }) => {
  require_(ctx, 'cooling-space:write');
  const space = db.coolingSpaces.find((s) => s.id === id);
  if (!space) throw notFound('找不到此涼適空間。');
  Object.assign(space, ctx.body);
  db.reloadConfig();
  return { space };
});

route('POST', '/cooling-spaces/:id/toggle', (ctx, { id }) => {
  const acc = require_(ctx, 'cooling-space:write');
  const space = db.coolingSpaces.find((s) => s.id === id);
  if (!space) throw notFound('找不到此涼適空間。');

  const before = space.status;
  space.status = space.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: space.status === 'ACTIVE' ? 'Enabled cooling location' : 'Disabled cooling location',
    actionZh: space.status === 'ACTIVE' ? '啟用涼適空間' : '停用涼適空間',
    entity: 'CoolingSpace',
    entityId: id,
    oldValue: before,
    newValue: space.status,
  });

  db.reloadConfig();
  return { space, activeCount: db.buildStats().activeCoolingSpaces };
});

route('DELETE', '/cooling-spaces/:id', (ctx, { id }) => {
  require_(ctx, 'cooling-space:write');
  db.coolingSpaces = db.coolingSpaces.filter((s) => s.id !== id);
  db.reloadConfig();
  return { deleted: true, id };
});

route('POST', '/cooling-spaces/import', (ctx) => {
  require_(ctx, 'cooling-space:write');
  const { spaces } = ctx.body as { spaces: Record<string, never>[] };
  const existing = new Set(db.coolingSpaces.map((s) => s.name));
  const created: string[] = [];
  const skipped: string[] = [];

  spaces.forEach((incoming, index) => {
    const name = String((incoming as { name?: string }).name ?? '');
    if (existing.has(name)) {
      skipped.push(name);
      return;
    }
    db.coolingSpaces.push({
      id: `cool-import-${Date.now().toString(36)}-${index}`,
      createdAt: new Date().toISOString(),
      ...incoming,
    } as unknown as CoolingSpace);
    created.push(name);
    existing.add(name);
  });

  db.reloadConfig();
  return { created: created.length, skipped, createdNames: created };
});

route('GET', '/city-risk', (ctx) => {
  require_(ctx, 'city-risk:read');
  return {
    districts: db.cityRisk.map((d) => ({
      ...d,
      coolingSpaceCount: db.coolingSpaces.filter(
        (s) => s.district === d.district && s.status === 'ACTIVE',
      ).length,
    })),
    city: db.cityRisk[0]?.city ?? '台北市',
    stats: db.buildStats(),
    privacyNotice: 'District-level aggregates only.',
    privacyNoticeZh: '僅顯示行政區層級的彙總資料，城市地圖不會呈現任何個人生理資訊。',
  };
});

route('POST', '/city-risk/sync', (ctx) => {
  require_(ctx, 'city-risk:write');
  return { synced: db.cityRisk.length, districts: db.cityRisk };
});

// ---------------------------------------------------------------------------
// Content, data sources, system, settings, audit
// ---------------------------------------------------------------------------

const MEDICAL_CLAIM_PATTERNS = [
  /\b(cure|cures|cured|treat|treats|treatment for|diagnos)\b/i,
  /\b(guarantee|guaranteed|prevents? (heat ?stroke|illness|death))\b/i,
  /治療|療效|保證|治好|痊癒|診斷/,
];

const CLAIM_MESSAGE =
  'Content may not make medical claims (diagnosis, treatment or guarantees). Use safety-oriented wording instead.';

function checkClaims(body: Record<string, unknown>): void {
  const fieldErrors: Record<string, string> = {};
  for (const field of ['title', 'titleZh', 'summary', 'summaryZh', 'body', 'bodyZh']) {
    const value = body[field];
    if (typeof value === 'string' && MEDICAL_CLAIM_PATTERNS.some((p) => p.test(value))) {
      fieldErrors[field] = CLAIM_MESSAGE;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Some fields need attention.', '部分欄位需要修正。', fieldErrors);
  }
}

route('GET', '/content', (ctx) => {
  const acc = require_(ctx, 'content:read');
  const all = db.content;
  let articles = isStaff(acc.role) ? all : all.filter((a) => a.published);

  const level = ctx.query.get('level');
  if (level && level !== 'ALL') {
    articles = articles.filter((a) => a.showForLevels.includes(level as RiskLevel));
  }
  const category = ctx.query.get('category');
  if (category && category !== 'ALL') articles = articles.filter((a) => a.category === category);

  return {
    articles,
    total: articles.length,
    summary: {
      published: all.filter((a) => a.published).length,
      draft: all.filter((a) => !a.published).length,
    },
    contentPolicy: 'Articles must use safety-oriented wording.',
    contentPolicyZh: '文章必須採用安全導向的用語。診斷、療效或保證性字句會被驗證擋下。',
  };
});

route('GET', '/content/:id', (ctx, { id }) => {
  require_(ctx, 'content:read');
  const article = db.content.find((a) => a.id === id);
  if (!article) throw notFound('找不到此內容。');
  return { article };
});

route('POST', '/content', (ctx) => {
  const acc = require_(ctx, 'content:write');
  checkClaims(ctx.body);

  const article = {
    id: `art-${Date.now().toString(36)}`,
    updatedAt: new Date().toISOString(),
    updatedBy: acc.nameZh,
    ...(ctx.body as Record<string, never>),
  } as unknown as ContentArticle;

  db.content.unshift(article);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Created content article',
    actionZh: '新增教育內容',
    entity: 'ContentArticle',
    entityId: article.id,
    oldValue: null,
    newValue: article.titleZh,
  });

  return { article };
});

route('PATCH', '/content/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'content:write');
  checkClaims(ctx.body);

  const article = db.content.find((a) => a.id === id);
  if (!article) throw notFound('找不到此內容。');

  const before = `${article.titleZh} [${article.published ? 'published' : 'draft'}]`;
  Object.assign(article, ctx.body, {
    updatedAt: new Date().toISOString(),
    updatedBy: acc.nameZh,
  });

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Updated content article',
    actionZh: '更新教育內容',
    entity: 'ContentArticle',
    entityId: id,
    oldValue: before,
    newValue: `${article.titleZh} [${article.published ? 'published' : 'draft'}]`,
  });

  return { article };
});

route('DELETE', '/content/:id', (ctx, { id }) => {
  const acc = require_(ctx, 'content:write');
  const article = db.content.find((a) => a.id === id);
  if (!article) throw notFound('找不到此內容。');

  db.content = db.content.filter((a) => a.id !== id);
  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: 'Deleted content article',
    actionZh: '刪除教育內容',
    entity: 'ContentArticle',
    entityId: id,
    oldValue: article.titleZh,
    newValue: 'deleted',
  });

  return { deleted: true, id };
});

route('GET', '/data-sources', (ctx) => {
  require_(ctx, 'data-source:read');
  return {
    sources: db.dataSources,
    total: db.dataSources.length,
    summary: {
      online: db.dataSources.filter((s) => s.status === 'ONLINE').length,
      degraded: db.dataSources.filter((s) => s.status === 'DEGRADED').length,
      offline: db.dataSources.filter((s) => s.status === 'OFFLINE').length,
    },
    note: 'Credentials are never stored in this configuration.',
    noteZh: '此設定不會儲存任何憑證，密鑰均由環境變數提供。',
  };
});

route('PATCH', '/data-sources/:id', (ctx, { id }) => {
  require_(ctx, 'data-source:write');
  const source = db.dataSources.find((s) => s.id === id);
  if (!source) throw notFound('找不到此資料來源。');
  Object.assign(source, ctx.body as Partial<DataSource>);
  return { source };
});

route('POST', '/data-sources/:id/sync', (ctx, { id }) => {
  require_(ctx, 'data-source:write');
  const source = db.dataSources.find((s) => s.id === id);
  if (!source) throw notFound('找不到此資料來源。');

  if (!source.enabled) {
    throw new HttpError(409, 'SOURCE_DISABLED', 'This data source is disabled.', '此資料來源已停用，請先啟用後再同步。');
  }

  // Report what the platform actually holds, not an invented figure.
  const counts: Record<DataSource['kind'], number> = {
    WEATHER: [...db.environmentHistory.values()].reduce((s, v) => s + v.length, 0),
    SENSOR: db.devices.length * 60,
    WEARABLE: [...db.wearableHistory.values()].reduce((s, v) => s + v.length, 0),
    CITY: db.cityRisk.length,
    COOLING_LOCATION: db.coolingSpaces.length,
  };

  source.recordCount = counts[source.kind];
  source.lastSyncAt = new Date().toISOString();

  return {
    source,
    synced: true,
    records: source.recordCount,
    simulated: true,
    message: `Synchronised ${source.recordCount} records held locally.`,
    messageZh: `已同步此來源在本機的 ${source.recordCount} 筆資料。`,
  };
});

route('GET', '/system', (ctx) => {
  require_(ctx, 'system:read');

  const online = db.devices.filter((d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY').length;
  const onlinePct = db.devices.length ? (online / db.devices.length) * 100 : 0;
  const weather = db.dataSources.find((s) => s.kind === 'WEATHER');
  const enabledTemplates = db.templates.filter((t) => t.enabled).length;

  const services: SystemService[] = [
    { key: 'api', name: 'API Service', nameZh: 'API 服務', status: 'ONLINE', latencyMs: 1, detail: 'In-browser demo runtime (static build)' },
    { key: 'database', name: 'Database', nameZh: '資料庫', status: 'ONLINE', latencyMs: 1, detail: `In-memory store, ${db.users.length} resident records` },
    {
      key: 'sensors',
      name: 'Sensor Service',
      nameZh: '感測器服務',
      status: (onlinePct >= 90 ? 'ONLINE' : onlinePct >= 60 ? 'DEGRADED' : 'OFFLINE') as ServiceStatus,
      latencyMs: db.simulation.tickMs,
      detail: `${online} of ${db.devices.length} devices reporting (${Math.round(onlinePct)}%)`,
    },
    { key: 'weather', name: 'Weather Service', nameZh: '氣象服務', status: weather?.status ?? 'OFFLINE', latencyMs: 42, detail: weather ? `${weather.provider}` : 'No weather source' },
    { key: 'map', name: 'Map Service', nameZh: '地圖服務', status: db.cityRisk.length > 0 ? 'ONLINE' : 'DEGRADED', latencyMs: 18, detail: `${db.cityRisk.length} districts modelled, OpenStreetMap tiles` },
    {
      key: 'notifications',
      name: 'Notification Service',
      nameZh: '通知服務',
      status: (enabledTemplates === 0 ? 'OFFLINE' : enabledTemplates < db.templates.length ? 'DEGRADED' : 'ONLINE') as ServiceStatus,
      latencyMs: 8,
      detail: `${enabledTemplates} of ${db.templates.length} templates enabled`,
    },
    { key: 'risk-engine', name: 'Risk Engine', nameZh: '風險引擎', status: db.simulation.tickCount > 0 ? 'ONLINE' : 'DEGRADED', latencyMs: 3, detail: `${db.simulation.tickCount} evaluations, ${db.buildStats().activeUsers} residents, config v${db.configVersion}` },
    { key: 'ai-service', name: 'AI Explanation Service', nameZh: 'AI 說明服務', status: 'ONLINE', latencyMs: 5, detail: 'Rule-based explanation generator, deterministic and on-device' },
  ];

  return {
    health: {
      services,
      uptimeSec: db.getUptimeSec(),
      tickCount: db.simulation.tickCount,
      version: '1.0.0 (static demo)',
      checkedAt: new Date().toISOString(),
    },
    stats: db.buildStats(),
  };
});

route('GET', '/settings', (ctx) => {
  require_(ctx, 'system:read');
  return { settings: db.settings, groups: [...new Set(db.settings.map((s) => s.group))] };
});

route('PATCH', '/settings/:key', (ctx, { key }) => {
  const acc = require_(ctx, 'system:write');
  const setting = db.settings.find((s) => s.key === key);
  if (!setting) throw notFound('找不到此設定。');

  const { value } = ctx.body as { value: string };

  if (setting.type === 'number' && !Number.isFinite(Number(value))) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'This setting expects a number.', '此設定需要數值。', { value: 'Must be a number' });
  }
  if (setting.type === 'boolean' && value !== 'true' && value !== 'false') {
    throw new HttpError(400, 'VALIDATION_FAILED', 'This setting expects true or false.', '此設定需要 true 或 false。', { value: 'Must be true or false' });
  }

  // Individual physiological data must never reach the public city map.
  if (setting.key === 'privacy.showPhysiologyOnMap' && value === 'true') {
    throw new HttpError(
      422,
      'PRIVACY_CONSTRAINT',
      'Individual physiological data cannot be shown on the city map.',
      '個人生理資料不得顯示於城市地圖。此限制由平台強制執行，無法從管理後台變更。',
    );
  }

  const before = setting.value;
  setting.value = value;

  db.audit({
    actorId: acc.id,
    actorName: acc.nameZh,
    actorRole: acc.role,
    action: `Changed setting ${setting.key}`,
    actionZh: `變更系統設定 ${setting.labelZh}`,
    entity: 'SystemSetting',
    entityId: setting.key,
    oldValue: before,
    newValue: value,
  });

  if (setting.key === 'simulation.tickMs') db.setSimulation({ tickMs: Number(value) });

  return { setting };
});

route('GET', '/audit-log', (ctx) => {
  require_(ctx, 'audit:read');
  const entity = ctx.query.get('entity');
  const entries = entity && entity !== 'ALL' ? db.auditLog.filter((e) => e.entity === entity) : db.auditLog;
  return {
    entries,
    total: entries.length,
    entities: [...new Set(db.auditLog.map((e) => e.entity))].sort(),
  };
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

route('GET', '/simulation', (ctx) => {
  account(ctx);
  return {
    simulation: { ...db.simulation },
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
    simulated: true,
    notice: 'All sensor values in this prototype are simulated.',
    noticeZh: '本原型的所有感測數值皆為模擬資料，未使用任何真實裝置數據。',
  };
});

route('POST', '/simulation', (ctx) => {
  require_(ctx, 'simulation:control');
  const body = ctx.body as {
    action: string;
    scenario?: ScenarioName;
    speed?: number;
    focusUserId?: string;
    offsets?: Partial<{ tempC: number; humidityPct: number; heartRateBpm: number }>;
  };

  switch (body.action) {
    case 'start':
      return { simulation: db.startScenario(body.scenario ?? 'FULL_DEMO', body.focusUserId), started: true };
    case 'stop':
      return { simulation: db.setSimulation({ running: false }), running: false };
    case 'reset':
      return { simulation: db.resetSimulation(), reset: true };
    case 'set-scenario':
      return { simulation: db.startScenario(body.scenario ?? 'AMBIENT', body.focusUserId) };
    case 'set-speed':
      return { simulation: db.setSimulation({ speed: body.speed ?? 1 }) };
    case 'set-focus':
      return { simulation: db.setSimulation({ focusUserId: body.focusUserId }) };
    case 'set-offsets':
      return {
        simulation: db.setSimulation({
          manualOffsets: { ...db.simulation.manualOffsets, ...(body.offsets ?? {}) },
        }),
      };
    default:
      throw new HttpError(400, 'UNKNOWN_ACTION', 'Unsupported simulation action.');
  }
});

route('GET', '/health', () => ({
  status: 'ok',
  uptimeSec: db.getUptimeSec(),
  ticks: db.simulation.tickCount,
  version: '1.0.0 (static demo)',
}));

// ---------------------------------------------------------------------------
// Support functions
// ---------------------------------------------------------------------------

/** Level this runtime would have under a candidate config. */
function assessWith(
  runtime: { reading: Parameters<typeof assessRiskShim>[0]['reading']; baseline: Parameters<typeof assessRiskShim>[0]['baseline']; history: Parameters<typeof assessRiskShim>[0]['history']; user: { id: string } },
  config: RiskRuleConfig,
): RiskLevel {
  return assessRiskShim({
    userId: runtime.user.id,
    reading: runtime.reading,
    baseline: runtime.baseline,
    config,
    history: runtime.history,
    previousLevel: null,
  }).level;
}

// Imported lazily to keep the module graph tidy; it is the same engine.
import { assessRisk as assessRiskShim } from '@shared/domain/riskEngine';

interface ConfigChange {
  path: string;
  label: string;
  labelZh: string;
  from: string;
  to: string;
}

/** Field-level diff, so the audit log reads "32C → 33C" rather than a blob. */
function diffConfig(before: RiskRuleConfig, after: RiskRuleConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];

  const cmp = (path: string, label: string, labelZh: string, a: unknown, b: unknown, suffix = '') => {
    if (String(a) === String(b)) return;
    changes.push({ path, label, labelZh, from: `${a}${suffix}`, to: `${b}${suffix}` });
  };

  cmp('thresholds.low', 'LOW threshold', 'LOW 門檻', before.thresholds.low, after.thresholds.low, 'C');
  cmp('thresholds.medium', 'MEDIUM threshold', 'MEDIUM 門檻', before.thresholds.medium, after.thresholds.medium, 'C');
  cmp('thresholds.high', 'HIGH threshold', 'HIGH 門檻', before.thresholds.high, after.thresholds.high, 'C');

  const weightLabels: Record<string, string> = {
    environmental: '環境風險權重',
    physiological: '生理偏離權重',
    heatwave: '熱浪權重',
    ventilation: '通風權重',
    activity: '活動量權重',
  };
  for (const key of Object.keys(after.weights) as (keyof typeof after.weights)[]) {
    cmp(`weights.${key}`, `${key} weight`, weightLabels[key] ?? `${key} 權重`, before.weights[key], after.weights[key]);
  }

  cmp('scoreEscalation.mediumScore', 'MEDIUM escalation score', 'MEDIUM 升級分數', before.scoreEscalation.mediumScore, after.scoreEscalation.mediumScore);
  cmp('scoreEscalation.highScore', 'HIGH escalation score', 'HIGH 升級分數', before.scoreEscalation.highScore, after.scoreEscalation.highScore);
  cmp('scoreEscalation.enabled', 'score escalation', '分數升級機制', before.scoreEscalation.enabled, after.scoreEscalation.enabled);

  for (const level of ['LOW', 'MEDIUM', 'HIGH'] as const) {
    cmp(`monitoringIntervalSec.${level}`, `${level} monitoring interval`, `${level} 監測間隔`, before.monitoringIntervalSec[level], after.monitoringIntervalSec[level], 's');
  }

  cmp('physiology.minDeviationPct', 'minimum physiological deviation', '生理偏離下限', before.physiology.minDeviationPct, after.physiology.minDeviationPct, '%');
  cmp('physiology.maxDeviationPct', 'maximum physiological deviation', '生理偏離上限', before.physiology.maxDeviationPct, after.physiology.maxDeviationPct, '%');
  cmp('environment.humidityConcernPct', 'humidity concern level', '濕度關注門檻', before.environment.humidityConcernPct, after.environment.humidityConcernPct, '%');
  cmp('environment.ventilationDeltaC', 'ventilation delta', '通風溫差門檻', before.environment.ventilationDeltaC, after.environment.ventilationDeltaC, 'C');
  cmp('environment.heatwaveDayThreshold', 'heatwave day threshold', '熱浪天數門檻', before.environment.heatwaveDayThreshold, after.environment.heatwaveDayThreshold, ' days');
  cmp('smartHomePolicy.allowAutomaticCooling', 'automatic cooling policy', '自動降溫政策', before.smartHomePolicy.allowAutomaticCooling, after.smartHomePolicy.allowAutomaticCooling);
  cmp('smartHomePolicy.minLevelForCooling', 'minimum level for cooling', '自動降溫最低等級', before.smartHomePolicy.minLevelForCooling, after.smartHomePolicy.minLevelForCooling);
  cmp('smartHomePolicy.targetIndoorTempC', 'target indoor temperature', '目標室內溫度', before.smartHomePolicy.targetIndoorTempC, after.smartHomePolicy.targetIndoorTempC, 'C');
  cmp('notificationPolicy.minLevelForCaregiver', 'minimum caregiver notification level', '照護者通知最低等級', before.notificationPolicy.minLevelForCaregiver, after.notificationPolicy.minLevelForCaregiver);
  cmp('notificationPolicy.cooldownMinutes', 'notification cooldown', '通知冷卻時間', before.notificationPolicy.cooldownMinutes, after.notificationPolicy.cooldownMinutes, ' min');
  cmp('notificationPolicy.escalateAfterMinutes', 'escalation delay', '升級等待時間', before.notificationPolicy.escalateAfterMinutes, after.notificationPolicy.escalateAfterMinutes, ' min');

  return changes;
}

// ---------------------------------------------------------------------------
// The fetch shim
// ---------------------------------------------------------------------------

/**
 * Stand-in for `fetch` against `/api/*`. Returns a real `Response`, so
 * `src/lib/api.ts` needs no special cases beyond choosing this function.
 */
export async function demoFetch(input: string, init?: RequestInit): Promise<Response> {
  // The login screen calls the API before the live store connects, so the
  // backend boots itself on first contact rather than depending on ordering.
  db.ensureInitialised();

  const url = new URL(input, window.location.origin);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = (init?.method ?? 'GET').toUpperCase();

  const headers = new Headers(init?.headers);
  const accountId = headers.get('x-account-id');

  let body: Record<string, unknown> = {};
  if (typeof init?.body === 'string') {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }

  const ctx: Ctx = { method, path, query: url.searchParams, body, accountId };

  // Simulate a little latency so loading states are exercised rather than
  // flashing past instantly.
  await new Promise((resolve) => setTimeout(resolve, 40));

  for (const entry of routes) {
    if (entry.method !== method) continue;
    const params = match(entry.pattern, path);
    if (!params) continue;

    try {
      const payload = entry.handler(ctx, params);
      return jsonResponse(200, payload);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error.status, {
          error: error.code,
          message: error.message,
          messageZh: error.messageZh,
          fieldErrors: error.fieldErrors,
        });
      }
      console.error('[demo] Handler failed', error);
      return jsonResponse(500, {
        error: 'INTERNAL_ERROR',
        message: 'Something went wrong in the demo runtime.',
        messageZh: '示範執行環境發生問題。',
      });
    }
  }

  return jsonResponse(404, {
    error: 'NOT_FOUND',
    message: `No demo route matches ${method} ${path}.`,
    messageZh: '找不到對應的 API 路徑。',
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
