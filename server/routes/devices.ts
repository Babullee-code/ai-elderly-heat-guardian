/**
 * /api/devices, /api/sensors, /api/readings
 *
 * Device state changes here are consequential rather than cosmetic: disabling
 * a temperature sensor stops it supplying readings (the simulation holds the
 * last value instead of inventing one), and disabling an air conditioner
 * makes the policy engine report cooling as blocked.
 */

import { Router } from 'express';
import {
  deviceActionSchema,
  deviceCreateSchema,
  deviceUpdateSchema,
  smartHomeCommandSchema,
} from '../../shared/schemas/index.js';
import type {
  DataQuality,
  Device,
  DeviceType,
  SensorMetric,
} from '../../shared/types/domain.js';
import {
  isHeldQuality,
  primaryFieldForDevice,
} from '../../shared/domain/provenance.js';
import { deviceRepo, readingRepo, userRepo } from '../db/repositories.js';
import { issueIngestKey } from './ingest.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, pathParam, recordAudit, validate } from '../middleware/common.js';
import { requireAuth, requirePermission, requireUserScope } from '../middleware/auth.js';

export const devicesRouter = Router();
export const sensorsRouter = Router();
export const readingsRouter = Router();

const ACTUATOR_TYPES: DeviceType[] = ['SMART_AC', 'DEHUMIDIFIER', 'FAN'];

const DEVICE_LABELS: Record<DeviceType, { name: string; nameZh: string }> = {
  SMART_WATCH: { name: 'Smart Watch', nameZh: '智慧手錶' },
  TEMPERATURE_SENSOR: { name: 'Temperature Sensor', nameZh: '溫度感測器' },
  HUMIDITY_SENSOR: { name: 'Humidity Sensor', nameZh: '濕度感測器' },
  AIR_QUALITY_SENSOR: { name: 'Air Quality Sensor', nameZh: '空氣品質感測器' },
  SMART_AC: { name: 'Smart Air Conditioner', nameZh: '智慧冷氣' },
  DEHUMIDIFIER: { name: 'Dehumidifier', nameZh: '除濕機' },
  FAN: { name: 'Smart Fan', nameZh: '智慧電風扇' },
};

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

devicesRouter.get(
  '/',
  requireAuth,
  requirePermission('device:read'),
  asyncHandler(async (_req, res) => {
    const [devices, users] = await Promise.all([deviceRepo.list(), userRepo.list()]);
    const userMap = new Map(users.map((u) => [u.id, u]));

    res.json({
      devices: devices.map((d) => ({
        ...d,
        userName: userMap.get(d.userId)?.name ?? 'Unknown',
        userDistrict: userMap.get(d.userId)?.district ?? '-',
      })),
      total: devices.length,
      summary: {
        online: devices.filter((d) => d.status === 'ONLINE').length,
        lowBattery: devices.filter((d) => d.status === 'LOW_BATTERY').length,
        offline: devices.filter((d) => d.status === 'OFFLINE').length,
        disabled: devices.filter((d) => d.status === 'DISABLED').length,
      },
    });
  }),
);

devicesRouter.get(
  '/user/:userId',
  requireAuth,
  requirePermission('device:read'),
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const devices = await deviceRepo.forUser(pathParam(req, 'userId'));
    res.json({ devices, smartHome: platformState.getSmartHome(pathParam(req, 'userId')) });
  }),
);

/** Device detail plus its recent sensor samples, for /admin/sensors drill-down. */
devicesRouter.get(
  '/:id',
  requireAuth,
  requirePermission('device:read'),
  asyncHandler(async (req, res) => {
    const device = await deviceRepo.findById(pathParam(req, 'id'));
    if (!device) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: 'That device does not exist.',
        messageZh: '找不到此裝置。',
      });
      return;
    }

    const [user, history] = await Promise.all([
      userRepo.findById(device.userId),
      readingRepo.sensorHistory(device.id, 120),
    ]);

    res.json({ device, user, history });
  }),
);

devicesRouter.post(
  '/',
  requireAuth,
  requirePermission('device:write'),
  validate(deviceCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as typeof deviceCreateSchema._output;

    const user = await userRepo.findById(body.userId);
    if (!user) {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'That resident does not exist.',
        fieldErrors: { userId: 'Unknown resident' },
      });
      return;
    }

    const isActuator = ACTUATOR_TYPES.includes(body.type);
    const existing = await deviceRepo.list();

    const device = await deviceRepo.create({
      id: `dev-new-${existing.length + 1}-${Date.now().toString(36)}`,
      deviceId: body.deviceId,
      name: body.name || DEVICE_LABELS[body.type].name,
      nameZh: body.nameZh || DEVICE_LABELS[body.type].nameZh,
      type: body.type,
      userId: body.userId,
      status: 'ONLINE',
      batteryPct: isActuator ? null : 100,
      signalPct: 90,
      lastSeen: new Date().toISOString(),
      firmware: body.firmware.startsWith('v') ? body.firmware : `v${body.firmware}`,
      location: body.location,
      power: false,
      isActuator,
    });

    await recordAudit(req, {
      action: 'Registered device',
      actionZh: '註冊裝置',
      entity: 'Device',
      entityId: device.id,
      newValue: `${device.deviceId} (${device.type}) for ${user.name}`,
    });

    await platformState.reloadDevices();
    res.status(201).json({ device });
  }),
);

devicesRouter.patch(
  '/:id',
  requireAuth,
  requirePermission('device:write'),
  validate(deviceUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await deviceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That device does not exist.' });
      return;
    }

    const device = await deviceRepo.update(pathParam(req, 'id'), req.body as Partial<Device>);

    await recordAudit(req, {
      action: 'Updated device configuration',
      actionZh: '更新裝置設定',
      entity: 'Device',
      entityId: device.id,
      oldValue: summarise(before),
      newValue: summarise(device),
    });

    await platformState.reloadDevices();
    await platformState.reloadConfig();

    res.json({ device });
  }),
);

/**
 * POST /api/devices/:id/action
 *
 * The Configure / Reconnect / Disable / Enable actions from the CMS device
 * table. Each has a real effect on the running platform.
 */
devicesRouter.post(
  '/:id/action',
  requireAuth,
  requirePermission('device:write'),
  validate(deviceActionSchema),
  asyncHandler(async (req, res) => {
    const { action } = req.body as { action: string };
    const before = await deviceRepo.findById(pathParam(req, 'id'));

    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That device does not exist.' });
      return;
    }

    let patch: Partial<Device> = {};
    let label = '';
    let labelZh = '';

    switch (action) {
      case 'disable':
        // A disabled device stops reporting and cannot be actuated.
        patch = { status: 'DISABLED', power: false, signalPct: 0 };
        label = 'Disabled device';
        labelZh = '停用裝置';
        break;

      case 'enable':
      case 'reconnect':
        patch = {
          status: before.batteryPct !== null && before.batteryPct < 20 ? 'LOW_BATTERY' : 'ONLINE',
          signalPct: 88,
          lastSeen: new Date().toISOString(),
        };
        label = action === 'enable' ? 'Enabled device' : 'Reconnected device';
        labelZh = action === 'enable' ? '啟用裝置' : '重新連線裝置';
        break;

      case 'toggle-power':
        if (!before.isActuator) {
          res.status(400).json({
            error: 'NOT_AN_ACTUATOR',
            message: 'Only air conditioners, fans and dehumidifiers can be switched on or off.',
            messageZh: '只有冷氣、電風扇與除濕機可以開關。',
          });
          return;
        }
        if (before.status === 'DISABLED' || before.status === 'OFFLINE') {
          res.status(409).json({
            error: 'DEVICE_UNAVAILABLE',
            message: 'This appliance is offline or disabled and cannot be switched.',
            messageZh: '此設備離線或已停用，無法開關。',
          });
          return;
        }
        patch = { power: !before.power, lastSeen: new Date().toISOString() };
        label = before.power ? 'Switched appliance off' : 'Switched appliance on';
        labelZh = before.power ? '關閉設備' : '開啟設備';
        break;

      case 'configure':
        // Configure applies a firmware refresh and restores full signal, which
        // is the observable outcome a technician would expect.
        patch = { signalPct: 95, lastSeen: new Date().toISOString() };
        label = 'Reconfigured device';
        labelZh = '重新設定裝置';
        break;

      default:
        res.status(400).json({ error: 'UNKNOWN_ACTION', message: 'Unsupported device action.' });
        return;
    }

    const device = await deviceRepo.update(pathParam(req, 'id'), patch);

    await recordAudit(req, {
      action: label,
      actionZh: labelZh,
      entity: 'Device',
      entityId: device.id,
      oldValue: summarise(before),
      newValue: summarise(device),
    });

    await platformState.reloadDevices();
    await platformState.reloadConfig();

    res.json({ device, action });
  }),
);

devicesRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('device:write'),
  asyncHandler(async (req, res) => {
    const before = await deviceRepo.findById(pathParam(req, 'id'));
    if (!before) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That device does not exist.' });
      return;
    }

    await deviceRepo.delete(pathParam(req, 'id'));

    await recordAudit(req, {
      action: 'Removed device',
      actionZh: '移除裝置',
      entity: 'Device',
      entityId: pathParam(req, 'id'),
      oldValue: summarise(before),
      newValue: 'removed',
    });

    await platformState.reloadDevices();
    res.json({ deleted: true, id: pathParam(req, 'id') });
  }),
);

// ---------------------------------------------------------------------------
// Smart home (user-facing appliance control)
// ---------------------------------------------------------------------------

devicesRouter.post(
  '/smart-home/:userId',
  requireAuth,
  validate(smartHomeCommandSchema),
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const { appliance, on } = req.body as {
      appliance: 'ac' | 'fan' | 'dehumidifier';
      on: boolean;
    };

    const smartHome = await platformState.setAppliance(pathParam(req, 'userId'), appliance, on);

    if (!smartHome) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident is not being monitored.' });
      return;
    }

    await recordAudit(req, {
      action: `Manually switched ${appliance} ${on ? 'on' : 'off'}`,
      actionZh: `手動${on ? '開啟' : '關閉'}${appliance === 'ac' ? '冷氣' : appliance === 'fan' ? '電風扇' : '除濕機'}`,
      entity: 'SmartHome',
      entityId: pathParam(req, 'userId'),
      newValue: `${appliance}=${on}`,
    });

    res.json({ smartHome });
  }),
);

/** The [Cancel Automatic Cooling] control on the smart-home card. */
devicesRouter.post(
  '/smart-home/:userId/cancel-automation',
  requireAuth,
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const smartHome = await platformState.cancelAutomaticCooling(pathParam(req, 'userId'));

    if (!smartHome) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident is not being monitored.' });
      return;
    }

    await recordAudit(req, {
      action: 'Cancelled automatic cooling',
      actionZh: '取消自動降溫',
      entity: 'SmartHome',
      entityId: pathParam(req, 'userId'),
      newValue: 'automation cancelled for this episode',
    });

    res.json({ smartHome });
  }),
);

devicesRouter.post(
  '/smart-home/:userId/restore-automation',
  requireAuth,
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const smartHome = await platformState.restoreAutomaticCooling(pathParam(req, 'userId'));

    if (!smartHome) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That resident is not being monitored.' });
      return;
    }

    await recordAudit(req, {
      action: 'Restored automatic cooling',
      actionZh: '恢復自動降溫',
      entity: 'SmartHome',
      entityId: pathParam(req, 'userId'),
      newValue: 'automation restored',
    });

    res.json({ smartHome });
  }),
);

// ---------------------------------------------------------------------------
// Ingest credentials
// ---------------------------------------------------------------------------

/**
 * POST /api/devices/:id/ingest-key
 *
 * Issue (or rotate) the key a real device uses to post its own readings.
 *
 * The key is returned in THIS RESPONSE AND NOWHERE ELSE. Only its hash is
 * stored, so it cannot be looked up later, redisplayed, or recovered from a
 * database copy - if it is lost the fix is to issue another one, which also
 * revokes the old. That is the ordinary handling for a credential, and the
 * console is written to match: it shows the key once and then only a prefix.
 */
devicesRouter.post(
  '/:id/ingest-key',
  requireAuth,
  requirePermission('device:write'),
  asyncHandler(async (req, res) => {
    const device = await deviceRepo.findById(pathParam(req, 'id'));

    if (!device) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That device does not exist.' });
      return;
    }

    if (device.isActuator) {
      res.status(400).json({
        error: 'NOT_A_SENSOR',
        message: 'An actuator has nothing to report; it does not need an ingest key.',
        messageZh: '此裝置為控制器，沒有可回報的量測值，不需要資料金鑰。',
      });
      return;
    }

    const issued = issueIngestKey();
    const updated = await deviceRepo.setIngestKey(device.id, {
      hash: issued.hash,
      prefix: issued.prefix,
    });

    await platformState.reloadDevices();

    // The audit trail records that a key was issued and by whom - never the
    // key, which would defeat hashing it in the first place.
    await recordAudit(req, {
      action: `Issued an ingest key for ${device.deviceId}`,
      actionZh: `為 ${device.deviceId} 產生資料回報金鑰`,
      entity: 'Device',
      entityId: device.id,
    });

    res.status(201).json({
      device: updated,
      /** Shown once. Not retrievable afterwards. */
      key: issued.key,
      messageZh: '請立即複製此金鑰，離開後將無法再次顯示。',
    });
  }),
);

/**
 * DELETE /api/devices/:id/ingest-key
 *
 * Revoke a device's credential. It can no longer post; the simulator does not
 * resume standing in for it if it has ever reported real data, so its values
 * read as held rather than quietly reverting to invented ones.
 */
devicesRouter.delete(
  '/:id/ingest-key',
  requireAuth,
  requirePermission('device:write'),
  asyncHandler(async (req, res) => {
    const device = await deviceRepo.findById(pathParam(req, 'id'));

    if (!device) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'That device does not exist.' });
      return;
    }

    const updated = await deviceRepo.setIngestKey(device.id, null);
    await platformState.reloadDevices();

    await recordAudit(req, {
      action: `Revoked the ingest key for ${device.deviceId}`,
      actionZh: `撤銷 ${device.deviceId} 的資料回報金鑰`,
      entity: 'Device',
      entityId: device.id,
    });

    res.json({ device: updated });
  }),
);

// ---------------------------------------------------------------------------
// Sensors (/admin/sensors)
// ---------------------------------------------------------------------------

/**
 * GET /api/sensors
 *
 * Live sensor readings across the platform, one row per reporting device,
 * with the value each device is currently supplying.
 */
sensorsRouter.get(
  '/',
  requireAuth,
  requirePermission('sensor:read'),
  asyncHandler(async (_req, res) => {
    const [devices, users] = await Promise.all([deviceRepo.list(), userRepo.list()]);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const rows = devices
      .filter((d) => !d.isActuator)
      .map((device) => {
        const reading = platformState.getReading(device.userId);
        const assessment = platformState.getAssessment(device.userId);

        const metric = metricFor(device.type);
        const value = reading ? valueFor(device.type, reading, assessment?.heatIndex ?? 0) : null;

        /**
         * Freshness comes from the assessment the risk engine actually used,
         * so this console cannot disagree with the resident's own screen about
         * whether a value is current.
         */
        const field = primaryFieldForDevice(device.type);
        const provenance = field ? assessment?.provenance?.fields?.[field] : undefined;
        const quality: DataQuality =
          provenance?.quality ??
          (device.status === 'OFFLINE' || device.status === 'DISABLED' ? 'OFFLINE' : 'LIVE');

        return {
          device,
          userName: userMap.get(device.userId)?.name ?? 'Unknown',
          metric,
          value,
          unit: unitFor(device.type),
          quality,
          ageSec: provenance?.ageSec ?? null,
          origin: provenance?.origin ?? null,
          // Retained for callers that only need the binary answer: a held
          // value must never be shown as a current one.
          stale: isHeldQuality(quality),
          lastSeen: device.lastSeen,
          simulated: provenance?.simulated ?? true,
        };
      });

    res.json({
      sensors: rows,
      total: rows.length,
      metrics: {
        temperature: rows.filter((r) => r.metric === 'temperature').length,
        humidity: rows.filter((r) => r.metric === 'humidity').length,
        heartRate: rows.filter((r) => r.metric === 'heartRate').length,
        airQuality: rows.filter((r) => r.metric === 'airQuality').length,
      },
    });
  }),
);

/** Aggregate live series across all monitored residents, for the sensor charts. */
sensorsRouter.get(
  '/live',
  requireAuth,
  requirePermission('sensor:read'),
  asyncHandler(async (_req, res) => {
    const users = await userRepo.list();
    const active = users.filter((u) => u.status === 'ACTIVE');

    const series = active.map((user) => ({
      userId: user.id,
      userName: user.name,
      district: user.district,
      history: platformState.getHistory(user.id).slice(-60),
      assessment: platformState.getAssessment(user.id),
    }));

    res.json({ series, at: new Date().toISOString(), simulated: true });
  }),
);

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

readingsRouter.get(
  '/:userId/environment',
  requireAuth,
  requirePermission('sensor:read'),
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const limit = clampLimit(req.query.limit);
    res.json({ readings: await readingRepo.environmentHistory(pathParam(req, 'userId'), limit) });
  }),
);

readingsRouter.get(
  '/:userId/wearable',
  requireAuth,
  requirePermission('sensor:read'),
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const limit = clampLimit(req.query.limit);
    res.json({ readings: await readingRepo.wearableHistory(pathParam(req, 'userId'), limit) });
  }),
);

readingsRouter.get(
  '/:userId/live',
  requireAuth,
  requireUserScope((req) => pathParam(req, 'userId')),
  asyncHandler(async (req, res) => {
    const reading = platformState.getReading(pathParam(req, 'userId'));

    if (!reading) {
      res.status(404).json({
        error: 'NOT_MONITORED',
        message: 'This resident is not currently being monitored.',
        messageZh: '此長者目前未在監測中。',
      });
      return;
    }

    res.json({
      reading,
      assessment: platformState.getAssessment(pathParam(req, 'userId')),
      history: platformState.getHistory(pathParam(req, 'userId')),
    });
  }),
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function summarise(device: Device): string {
  return `${device.deviceId} status=${device.status} power=${device.power} signal=${device.signalPct}% fw=${device.firmware}`;
}

function metricFor(type: DeviceType): SensorMetric {
  switch (type) {
    case 'TEMPERATURE_SENSOR':
      return 'temperature';
    case 'HUMIDITY_SENSOR':
      return 'humidity';
    case 'AIR_QUALITY_SENSOR':
      return 'airQuality';
    case 'SMART_WATCH':
      return 'heartRate';
    default:
      return 'heatIndex';
  }
}

function unitFor(type: DeviceType): string {
  switch (type) {
    case 'TEMPERATURE_SENSOR':
      return 'C';
    case 'HUMIDITY_SENSOR':
      return '%';
    case 'AIR_QUALITY_SENSOR':
      return 'AQI';
    case 'SMART_WATCH':
      return 'BPM';
    default:
      return 'C';
  }
}

function valueFor(
  type: DeviceType,
  reading: { indoorTempC: number; indoorHumidityPct: number; airQualityIndex: number; heartRateBpm: number },
  heatIndex: number,
): number {
  switch (type) {
    case 'TEMPERATURE_SENSOR':
      return reading.indoorTempC;
    case 'HUMIDITY_SENSOR':
      return reading.indoorHumidityPct;
    case 'AIR_QUALITY_SENSOR':
      return reading.airQualityIndex;
    case 'SMART_WATCH':
      return reading.heartRateBpm;
    default:
      return heatIndex;
  }
}

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 96;
  return Math.min(400, Math.max(1, Math.floor(n)));
}
