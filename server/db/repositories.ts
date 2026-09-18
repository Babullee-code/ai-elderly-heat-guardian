/**
 * Repository layer - the database abstraction.
 *
 * Route handlers and services never touch Prisma directly; they call these
 * repositories, which own the row-to-domain mapping and the JSON
 * (de)serialisation. Swapping SQLite for PostgreSQL, or Prisma for anything
 * else, is a change confined to this file.
 */

import type {
  Account,
  ActionRule,
  Alert,
  AlertStatus,
  AlertTimelineEntry,
  AuditLogEntry,
  Caregiver,
  CityRisk,
  ContentArticle,
  CoolingSpace,
  DataSource,
  Device,
  ElderlyUser,
  EnvironmentReading,
  Notification,
  NotificationTemplate,
  PersonalBaseline,
  ReadingSnapshot,
  RiskEvent,
  RiskFactor,
  RiskLevel,
  RiskRuleConfig,
  SensorReading,
  SystemSetting,
  WearableReading,
  AIExplanation,
  ActionType,
  RiskAssessment,
  NotificationChannel,
} from '../../shared/types/domain.js';
import type { AmbientProfile } from '../../shared/domain/simulationEngine.js';
import { cloneDefaultActionRules, cloneDefaultConfig } from '../../shared/domain/config.js';
import { fromJson, prisma, toJson } from './client.js';

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const iso = (d: Date | null | undefined): string => (d ? d.toISOString() : new Date().toISOString());
const isoOrNull = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

type ElderlyRow = Awaited<ReturnType<typeof prisma.elderlyUser.findFirstOrThrow>>;
type CaregiverRow = Awaited<ReturnType<typeof prisma.caregiver.findFirstOrThrow>>;
type DeviceRow = Awaited<ReturnType<typeof prisma.device.findFirstOrThrow>>;
type AlertRow = Awaited<ReturnType<typeof prisma.alert.findFirstOrThrow>>;

function mapElderly(row: ElderlyRow): ElderlyUser {
  return {
    id: row.id,
    name: row.name,
    nameEn: row.nameEn,
    age: row.age,
    gender: row.gender as ElderlyUser['gender'],
    city: row.city,
    district: row.district,
    location: `${row.city} ${row.district}`,
    lat: row.lat,
    lng: row.lng,
    phone: row.phone,
    address: row.address,
    conditions: fromJson<string[]>(row.conditions, []),
    medications: fromJson<string[]>(row.medications, []),
    status: row.status as ElderlyUser['status'],
    permissions: fromJson<ElderlyUser['permissions']>(row.permissions, {
      automaticCooling: false,
      caregiverNotifications: false,
      locationSharing: false,
      physiologicalDataStorage: false,
      cityDataContribution: false,
    }),
    elderlyModeDefault: row.elderlyModeDefault,
    emergencyContact: fromJson<ElderlyUser['emergencyContact']>(row.emergencyContact, {
      name: '',
      relationship: '',
      phone: '',
    }),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mapCaregiver(row: CaregiverRow & { assignments?: { userId: string }[] }): Caregiver {
  return {
    id: row.id,
    name: row.name,
    nameEn: row.nameEn,
    relationship: row.relationship as Caregiver['relationship'],
    phone: row.phone,
    email: row.email,
    assignedUserIds: (row.assignments ?? []).map((a) => a.userId),
    notificationPreferences: fromJson<Caregiver['notificationPreferences']>(
      row.notificationPreferences,
      {
        channels: ['IN_APP'],
        minLevel: 'MEDIUM',
        quietHours: { enabled: false, from: '22:00', to: '07:00' },
      },
    ),
    emergencyPermission: row.emergencyPermission,
    status: row.status as Caregiver['status'],
    createdAt: iso(row.createdAt),
  };
}

function mapDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    deviceId: row.deviceId,
    name: row.name,
    nameZh: row.nameZh,
    type: row.type as Device['type'],
    userId: row.userId,
    status: row.status as Device['status'],
    batteryPct: row.batteryPct,
    signalPct: row.signalPct,
    lastSeen: iso(row.lastSeen),
    firmware: row.firmware,
    location: row.location,
    power: row.power,
    isActuator: row.isActuator,
    createdAt: iso(row.createdAt),
    // Never the key itself - only enough to identify which key is installed.
    ingestKeyPrefix: row.ingestKeyPrefix,
    ingestKeyIssuedAt: row.ingestKeyIssuedAt ? iso(row.ingestKeyIssuedAt) : null,
    lastIngestAt: row.lastIngestAt ? iso(row.lastIngestAt) : null,
  };
}

function mapAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.userName,
    severity: row.severity as Alert['severity'],
    level: row.level as RiskLevel,
    trigger: row.trigger,
    triggerZh: row.triggerZh,
    status: row.status as AlertStatus,
    assignedCaregiverId: row.assignedCaregiverId,
    assignedCaregiverName: row.assignedCaregiverName,
    assessment: row.assessment ? fromJson<RiskAssessment | null>(row.assessment, null) : null,
    actionsTaken: fromJson<ActionType[]>(row.actionsTaken, []),
    timeline: fromJson<AlertTimelineEntry[]>(row.timeline, []),
    createdAt: iso(row.createdAt),
    acknowledgedAt: isoOrNull(row.acknowledgedAt),
    resolvedAt: isoOrNull(row.resolvedAt),
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const accountRepo = {
  async list(): Promise<Account[]> {
    const rows = await prisma.account.findMany({ orderBy: { role: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      nameZh: r.nameZh,
      role: r.role as Account['role'],
      elderlyUserId: r.elderlyUserId,
      caregiverId: r.caregiverId,
      avatarColor: r.avatarColor,
    }));
  },

  async findByEmail(email: string): Promise<Account | null> {
    const r = await prisma.account.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!r) return null;
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      nameZh: r.nameZh,
      role: r.role as Account['role'],
      elderlyUserId: r.elderlyUserId,
      caregiverId: r.caregiverId,
      avatarColor: r.avatarColor,
    };
  },

  async findById(id: string): Promise<Account | null> {
    const r = await prisma.account.findUnique({ where: { id } });
    if (!r) return null;
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      nameZh: r.nameZh,
      role: r.role as Account['role'],
      elderlyUserId: r.elderlyUserId,
      caregiverId: r.caregiverId,
      avatarColor: r.avatarColor,
    };
  },
};

// ---------------------------------------------------------------------------
// Elderly users
// ---------------------------------------------------------------------------

export const userRepo = {
  async list(): Promise<ElderlyUser[]> {
    const rows = await prisma.elderlyUser.findMany({ orderBy: { name: 'asc' } });
    return rows.map(mapElderly);
  },

  async findById(id: string): Promise<ElderlyUser | null> {
    const row = await prisma.elderlyUser.findUnique({ where: { id } });
    return row ? mapElderly(row) : null;
  },

  /** The learned personal baseline, stored alongside the user. */
  async getBaseline(id: string): Promise<PersonalBaseline | null> {
    const row = await prisma.elderlyUser.findUnique({
      where: { id },
      select: { baseline: true },
    });
    return row ? fromJson<PersonalBaseline | null>(row.baseline, null) : null;
  },

  async getAllBaselines(): Promise<Record<string, PersonalBaseline>> {
    const rows = await prisma.elderlyUser.findMany({ select: { id: true, baseline: true } });
    const out: Record<string, PersonalBaseline> = {};
    for (const r of rows) {
      const b = fromJson<PersonalBaseline | null>(r.baseline, null);
      if (b) out[r.id] = b;
    }
    return out;
  },

  async setBaseline(id: string, baseline: PersonalBaseline): Promise<void> {
    await prisma.elderlyUser.update({ where: { id }, data: { baseline: toJson(baseline) } });
  },

  async getAmbientProfiles(): Promise<Record<string, AmbientProfile>> {
    const rows = await prisma.elderlyUser.findMany({ select: { id: true, ambientProfile: true } });
    const out: Record<string, AmbientProfile> = {};
    for (const r of rows) {
      const p = fromJson<AmbientProfile | null>(r.ambientProfile, null);
      if (p) out[r.id] = p;
    }
    return out;
  },

  async create(data: Omit<ElderlyUser, 'createdAt' | 'updatedAt' | 'location'> & {
    baseline: PersonalBaseline;
    ambientProfile: AmbientProfile;
  }): Promise<ElderlyUser> {
    const row = await prisma.elderlyUser.create({
      data: {
        id: data.id,
        name: data.name,
        nameEn: data.nameEn,
        age: data.age,
        gender: data.gender,
        city: data.city,
        district: data.district,
        lat: data.lat,
        lng: data.lng,
        phone: data.phone,
        address: data.address,
        conditions: toJson(data.conditions),
        medications: toJson(data.medications),
        status: data.status,
        permissions: toJson(data.permissions),
        elderlyModeDefault: data.elderlyModeDefault,
        emergencyContact: toJson(data.emergencyContact),
        baseline: toJson(data.baseline),
        ambientProfile: toJson(data.ambientProfile),
      },
    });
    return mapElderly(row);
  },

  async update(id: string, patch: Partial<ElderlyUser>): Promise<ElderlyUser> {
    const row = await prisma.elderlyUser.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn } : {}),
        ...(patch.age !== undefined ? { age: patch.age } : {}),
        ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
        ...(patch.city !== undefined ? { city: patch.city } : {}),
        ...(patch.district !== undefined ? { district: patch.district } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.conditions !== undefined ? { conditions: toJson(patch.conditions) } : {}),
        ...(patch.medications !== undefined ? { medications: toJson(patch.medications) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.permissions !== undefined ? { permissions: toJson(patch.permissions) } : {}),
        ...(patch.elderlyModeDefault !== undefined
          ? { elderlyModeDefault: patch.elderlyModeDefault }
          : {}),
        ...(patch.emergencyContact !== undefined
          ? { emergencyContact: toJson(patch.emergencyContact) }
          : {}),
      },
    });
    return mapElderly(row);
  },
};

// ---------------------------------------------------------------------------
// Caregivers
// ---------------------------------------------------------------------------

export const caregiverRepo = {
  async list(): Promise<Caregiver[]> {
    const rows = await prisma.caregiver.findMany({
      include: { assignments: { select: { userId: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map(mapCaregiver);
  },

  async findById(id: string): Promise<Caregiver | null> {
    const row = await prisma.caregiver.findUnique({
      where: { id },
      include: { assignments: { select: { userId: true } } },
    });
    return row ? mapCaregiver(row) : null;
  },

  /** Caregivers responsible for a given elderly user. */
  async forUser(userId: string): Promise<Caregiver[]> {
    const rows = await prisma.caregiver.findMany({
      where: { assignments: { some: { userId } } },
      include: { assignments: { select: { userId: true } } },
    });
    return rows.map(mapCaregiver);
  },

  async create(data: Omit<Caregiver, 'createdAt'>): Promise<Caregiver> {
    await prisma.caregiver.create({
      data: {
        id: data.id,
        name: data.name,
        nameEn: data.nameEn,
        relationship: data.relationship,
        phone: data.phone,
        email: data.email,
        notificationPreferences: toJson(data.notificationPreferences),
        emergencyPermission: data.emergencyPermission,
        status: data.status,
        assignments: {
          create: data.assignedUserIds.map((userId) => ({ userId })),
        },
      },
    });
    const created = await this.findById(data.id);
    if (!created) throw new Error('Caregiver creation failed');
    return created;
  },

  async update(id: string, patch: Partial<Caregiver>): Promise<Caregiver> {
    await prisma.caregiver.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn } : {}),
        ...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.email !== undefined ? { email: patch.email } : {}),
        ...(patch.notificationPreferences !== undefined
          ? { notificationPreferences: toJson(patch.notificationPreferences) }
          : {}),
        ...(patch.emergencyPermission !== undefined
          ? { emergencyPermission: patch.emergencyPermission }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    });

    // Assignments are replaced wholesale when provided, so the CMS form is the
    // single source of truth for who this caregiver covers.
    if (patch.assignedUserIds !== undefined) {
      await prisma.caregiverAssignment.deleteMany({ where: { caregiverId: id } });
      if (patch.assignedUserIds.length > 0) {
        await prisma.caregiverAssignment.createMany({
          data: patch.assignedUserIds.map((userId) => ({ caregiverId: id, userId })),
        });
      }
    }

    const updated = await this.findById(id);
    if (!updated) throw new Error('Caregiver not found after update');
    return updated;
  },

  async assign(caregiverId: string, userId: string): Promise<void> {
    await prisma.caregiverAssignment.upsert({
      where: { caregiverId_userId: { caregiverId, userId } },
      create: { caregiverId, userId },
      update: {},
    });
  },

  async unassign(caregiverId: string, userId: string): Promise<void> {
    await prisma.caregiverAssignment
      .delete({ where: { caregiverId_userId: { caregiverId, userId } } })
      .catch(() => undefined);
  },

  async delete(id: string): Promise<void> {
    await prisma.caregiver.delete({ where: { id } });
  },
};

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const deviceRepo = {
  async list(): Promise<Device[]> {
    const rows = await prisma.device.findMany({ orderBy: [{ userId: 'asc' }, { type: 'asc' }] });
    return rows.map(mapDevice);
  },

  async forUser(userId: string): Promise<Device[]> {
    const rows = await prisma.device.findMany({ where: { userId }, orderBy: { type: 'asc' } });
    return rows.map(mapDevice);
  },

  async findById(id: string): Promise<Device | null> {
    const row = await prisma.device.findUnique({ where: { id } });
    return row ? mapDevice(row) : null;
  },

  async create(data: Omit<Device, 'createdAt'>): Promise<Device> {
    const row = await prisma.device.create({
      data: {
        id: data.id,
        deviceId: data.deviceId,
        name: data.name,
        nameZh: data.nameZh,
        type: data.type,
        userId: data.userId,
        status: data.status,
        batteryPct: data.batteryPct,
        signalPct: data.signalPct,
        lastSeen: new Date(data.lastSeen),
        firmware: data.firmware,
        location: data.location,
        power: data.power,
        isActuator: data.isActuator,
      },
    });
    return mapDevice(row);
  },

  /**
   * Find a device by the hash of the key presented to the ingest endpoint.
   *
   * Lookup is BY HASH, so a stolen database yields no working credential and
   * the raw key never has to be held anywhere in order to authenticate.
   */
  async findByIngestKeyHash(hash: string): Promise<Device | null> {
    const row = await prisma.device.findFirst({ where: { ingestKeyHash: hash } });
    return row ? mapDevice(row) : null;
  },

  /** Install a new key, replacing any existing one. */
  async setIngestKey(
    id: string,
    key: { hash: string; prefix: string } | null,
  ): Promise<Device> {
    const row = await prisma.device.update({
      where: { id },
      data: {
        ingestKeyHash: key?.hash ?? null,
        ingestKeyPrefix: key?.prefix ?? null,
        ingestKeyIssuedAt: key ? new Date() : null,
      },
    });
    return mapDevice(row);
  },

  /** Record that a device has posted a real reading. */
  async markIngested(id: string, at: Date): Promise<void> {
    await prisma.device.update({
      where: { id },
      data: { lastIngestAt: at, lastSeen: at, status: 'ONLINE' },
    });
  },

  async update(id: string, patch: Partial<Device>): Promise<Device> {
    const row = await prisma.device.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.nameZh !== undefined ? { nameZh: patch.nameZh } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.firmware !== undefined ? { firmware: patch.firmware } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.power !== undefined ? { power: patch.power } : {}),
        ...(patch.batteryPct !== undefined ? { batteryPct: patch.batteryPct } : {}),
        ...(patch.signalPct !== undefined ? { signalPct: patch.signalPct } : {}),
        ...(patch.lastSeen !== undefined ? { lastSeen: new Date(patch.lastSeen) } : {}),
      },
    });
    return mapDevice(row);
  },

  async delete(id: string): Promise<void> {
    await prisma.device.delete({ where: { id } });
  },
};

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

export const readingRepo = {
  async recordEnvironment(
    userId: string,
    reading: ReadingSnapshot,
    heatIndex: number,
  ): Promise<void> {
    await prisma.environmentReading.create({
      data: {
        userId,
        indoorTempC: reading.indoorTempC,
        indoorHumidityPct: reading.indoorHumidityPct,
        outdoorTempC: reading.outdoorTempC,
        outdoorHumidityPct: reading.outdoorHumidityPct,
        airQualityIndex: reading.airQualityIndex,
        heatIndex,
        simulated: reading.simulated,
        recordedAt: new Date(reading.timestamp),
      },
    });
  },

  async recordWearable(userId: string, reading: ReadingSnapshot): Promise<void> {
    await prisma.wearableReading.create({
      data: {
        userId,
        heartRateBpm: Math.round(reading.heartRateBpm),
        skinTempC: reading.skinTempC,
        activityStepsPerHour: Math.round(reading.activityStepsPerHour),
        simulated: reading.simulated,
        recordedAt: new Date(reading.timestamp),
      },
    });
  },

  async recordSensorSamples(samples: Omit<SensorReading, 'id'>[]): Promise<void> {
    if (samples.length === 0) return;
    await prisma.sensorReading.createMany({
      data: samples.map((s) => ({
        deviceId: s.deviceId,
        userId: s.userId,
        metric: s.metric,
        value: s.value,
        unit: s.unit,
        simulated: s.simulated,
        recordedAt: new Date(s.recordedAt),
      })),
    });
  },

  async environmentHistory(userId: string, limit = 200): Promise<EnvironmentReading[]> {
    const rows = await prisma.environmentReading.findMany({
      where: { userId },
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      id: r.id,
      userId: r.userId,
      indoorTempC: r.indoorTempC,
      indoorHumidityPct: r.indoorHumidityPct,
      outdoorTempC: r.outdoorTempC,
      outdoorHumidityPct: r.outdoorHumidityPct,
      airQualityIndex: r.airQualityIndex,
      heatIndex: r.heatIndex,
      simulated: r.simulated,
      recordedAt: iso(r.recordedAt),
    }));
  },

  async wearableHistory(userId: string, limit = 200): Promise<WearableReading[]> {
    const rows = await prisma.wearableReading.findMany({
      where: { userId },
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      id: r.id,
      userId: r.userId,
      heartRateBpm: r.heartRateBpm,
      skinTempC: r.skinTempC,
      activityStepsPerHour: r.activityStepsPerHour,
      simulated: r.simulated,
      recordedAt: iso(r.recordedAt),
    }));
  },

  async sensorHistory(deviceId: string, limit = 120): Promise<SensorReading[]> {
    const rows = await prisma.sensorReading.findMany({
      where: { deviceId },
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      userId: r.userId,
      metric: r.metric as SensorReading['metric'],
      value: r.value,
      unit: r.unit,
      simulated: r.simulated,
      recordedAt: iso(r.recordedAt),
    }));
  },

  /**
   * Trim reading tables so a long-running demo cannot grow the SQLite file
   * without bound. Keeps the most recent `keep` rows per table.
   */
  async prune(keep = 4000): Promise<void> {
    for (const table of ['environmentReading', 'wearableReading', 'sensorReading'] as const) {
      const total = await (prisma[table] as { count: () => Promise<number> }).count();
      if (total <= keep) continue;

      const cutoff = await (
        prisma[table] as unknown as {
          findMany: (a: unknown) => Promise<{ recordedAt: Date }[]>;
        }
      ).findMany({
        orderBy: { recordedAt: 'desc' },
        skip: keep,
        take: 1,
        select: { recordedAt: true },
      });

      if (cutoff[0]) {
        await (
          prisma[table] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }
        ).deleteMany({ where: { recordedAt: { lt: cutoff[0].recordedAt } } });
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Risk events
// ---------------------------------------------------------------------------

export const riskEventRepo = {
  async create(event: Omit<RiskEvent, 'id'>): Promise<RiskEvent> {
    const row = await prisma.riskEvent.create({
      data: {
        userId: event.userId,
        level: event.level,
        previousLevel: event.previousLevel,
        score: event.score,
        heatIndex: event.heatIndex,
        reason: event.reason,
        factors: toJson(event.factors),
        explanation: toJson(event.explanation),
        actionsTaken: toJson(event.actionsTaken),
        readings: toJson(event.readings),
        recordedAt: new Date(event.recordedAt),
      },
    });
    return { ...event, id: row.id };
  },

  async forUser(userId: string, limit = 60): Promise<RiskEvent[]> {
    const rows = await prisma.riskEvent.findMany({
      where: { userId },
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      level: r.level as RiskLevel,
      previousLevel: r.previousLevel as RiskLevel | null,
      score: r.score,
      heatIndex: r.heatIndex,
      reason: r.reason as RiskEvent['reason'],
      factors: fromJson<RiskFactor[]>(r.factors, []),
      explanation: fromJson<AIExplanation>(r.explanation, {
        headline: '',
        headlineEn: '',
        lines: [],
        confidence: 0,
        forecast: '',
        forecastEn: '',
      }),
      actionsTaken: fromJson<ActionType[]>(r.actionsTaken, []),
      readings: fromJson<ReadingSnapshot>(r.readings, {} as ReadingSnapshot),
      recordedAt: iso(r.recordedAt),
    }));
  },

  async recent(limit = 100): Promise<RiskEvent[]> {
    const rows = await prisma.riskEvent.findMany({
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      level: r.level as RiskLevel,
      previousLevel: r.previousLevel as RiskLevel | null,
      score: r.score,
      heatIndex: r.heatIndex,
      reason: r.reason as RiskEvent['reason'],
      factors: fromJson<RiskFactor[]>(r.factors, []),
      explanation: fromJson<AIExplanation>(r.explanation, {
        headline: '',
        headlineEn: '',
        lines: [],
        confidence: 0,
        forecast: '',
        forecastEn: '',
      }),
      actionsTaken: fromJson<ActionType[]>(r.actionsTaken, []),
      readings: fromJson<ReadingSnapshot>(r.readings, {} as ReadingSnapshot),
      recordedAt: iso(r.recordedAt),
    }));
  },
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const alertRepo = {
  async list(limit = 200): Promise<Alert[]> {
    const rows = await prisma.alert.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(mapAlert);
  },

  async findById(id: string): Promise<Alert | null> {
    const row = await prisma.alert.findUnique({ where: { id } });
    return row ? mapAlert(row) : null;
  },

  async forUser(userId: string, limit = 50): Promise<Alert[]> {
    const rows = await prisma.alert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(mapAlert);
  },

  /** Open alerts are anything not yet resolved. */
  async openForUser(userId: string): Promise<Alert[]> {
    const rows = await prisma.alert.findMany({
      where: { userId, status: { in: ['NEW', 'ACKNOWLEDGED', 'ESCALATED'] } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(mapAlert);
  },

  async create(alert: Omit<Alert, 'id'>): Promise<Alert> {
    const row = await prisma.alert.create({
      data: {
        userId: alert.userId,
        userName: alert.userName,
        severity: alert.severity,
        level: alert.level,
        trigger: alert.trigger,
        triggerZh: alert.triggerZh,
        status: alert.status,
        assignedCaregiverId: alert.assignedCaregiverId,
        assignedCaregiverName: alert.assignedCaregiverName,
        assessment: alert.assessment ? toJson(alert.assessment) : null,
        actionsTaken: toJson(alert.actionsTaken),
        timeline: toJson(alert.timeline),
        createdAt: new Date(alert.createdAt),
        acknowledgedAt: alert.acknowledgedAt ? new Date(alert.acknowledgedAt) : null,
        resolvedAt: alert.resolvedAt ? new Date(alert.resolvedAt) : null,
      },
    });
    return mapAlert(row);
  },

  async update(
    id: string,
    patch: Partial<Pick<Alert, 'status' | 'assignedCaregiverId' | 'assignedCaregiverName' | 'acknowledgedAt' | 'resolvedAt'>> & {
      appendTimeline?: AlertTimelineEntry[];
      actionsTaken?: ActionType[];
    },
  ): Promise<Alert> {
    const existing = await prisma.alert.findUniqueOrThrow({ where: { id } });
    const timeline = fromJson<AlertTimelineEntry[]>(existing.timeline, []);

    const row = await prisma.alert.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.assignedCaregiverId !== undefined
          ? { assignedCaregiverId: patch.assignedCaregiverId }
          : {}),
        ...(patch.assignedCaregiverName !== undefined
          ? { assignedCaregiverName: patch.assignedCaregiverName }
          : {}),
        ...(patch.acknowledgedAt !== undefined
          ? { acknowledgedAt: patch.acknowledgedAt ? new Date(patch.acknowledgedAt) : null }
          : {}),
        ...(patch.resolvedAt !== undefined
          ? { resolvedAt: patch.resolvedAt ? new Date(patch.resolvedAt) : null }
          : {}),
        ...(patch.actionsTaken !== undefined ? { actionsTaken: toJson(patch.actionsTaken) } : {}),
        ...(patch.appendTimeline
          ? { timeline: toJson([...timeline, ...patch.appendTimeline]) }
          : {}),
      },
    });
    return mapAlert(row);
  },
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationRepo = {
  async list(limit = 200): Promise<Notification[]> {
    const rows = await prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: r.userName,
      recipientId: r.recipientId,
      recipientName: r.recipientName,
      templateKey: r.templateKey as Notification['templateKey'],
      channel: r.channel as NotificationChannel,
      title: r.title,
      body: r.body,
      read: r.read,
      createdAt: iso(r.createdAt),
    }));
  },

  async create(n: Omit<Notification, 'id'>): Promise<Notification> {
    const row = await prisma.notification.create({
      data: {
        userId: n.userId,
        userName: n.userName,
        recipientId: n.recipientId,
        recipientName: n.recipientName,
        templateKey: n.templateKey,
        channel: n.channel,
        title: n.title,
        body: n.body,
        read: n.read,
        createdAt: new Date(n.createdAt),
      },
    });
    return { ...n, id: row.id };
  },

  async markRead(id: string): Promise<void> {
    await prisma.notification.update({ where: { id }, data: { read: true } });
  },

  async markAllRead(recipientId: string | null): Promise<number> {
    const res = await prisma.notification.updateMany({
      where: { recipientId, read: false },
      data: { read: true },
    });
    return res.count;
  },

  async countToday(): Promise<number> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return prisma.notification.count({ where: { createdAt: { gte: start } } });
  },
};

export const notificationTemplateRepo = {
  async list(): Promise<NotificationTemplate[]> {
    const rows = await prisma.notificationTemplate.findMany({ orderBy: { key: 'asc' } });
    return rows.map((r) => ({
      key: r.key as NotificationTemplate['key'],
      name: r.name,
      nameZh: r.nameZh,
      title: r.title,
      titleZh: r.titleZh,
      body: r.body,
      bodyZh: r.bodyZh,
      channels: fromJson<NotificationChannel[]>(r.channels, ['IN_APP']),
      enabled: r.enabled,
      updatedAt: iso(r.updatedAt),
    }));
  },

  async update(key: string, patch: Partial<NotificationTemplate>): Promise<NotificationTemplate> {
    const row = await prisma.notificationTemplate.update({
      where: { key },
      data: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.titleZh !== undefined ? { titleZh: patch.titleZh } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.bodyZh !== undefined ? { bodyZh: patch.bodyZh } : {}),
        ...(patch.channels !== undefined ? { channels: toJson(patch.channels) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    });
    return {
      key: row.key as NotificationTemplate['key'],
      name: row.name,
      nameZh: row.nameZh,
      title: row.title,
      titleZh: row.titleZh,
      body: row.body,
      bodyZh: row.bodyZh,
      channels: fromJson<NotificationChannel[]>(row.channels, ['IN_APP']),
      enabled: row.enabled,
      updatedAt: iso(row.updatedAt),
    };
  },
};

// ---------------------------------------------------------------------------
// Cooling spaces & city risk
// ---------------------------------------------------------------------------

export const coolingSpaceRepo = {
  async list(): Promise<CoolingSpace[]> {
    const rows = await prisma.coolingSpace.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameEn: r.nameEn,
      type: r.type as CoolingSpace['type'],
      address: r.address,
      district: r.district,
      lat: r.lat,
      lng: r.lng,
      riskLevel: r.riskLevel as RiskLevel,
      airConditioned: r.airConditioned,
      accessible: r.accessible,
      accessibilityNotes: r.accessibilityNotes,
      openingHours: r.openingHours,
      opensAt: r.opensAt,
      closesAt: r.closesAt,
      contact: r.contact,
      capacity: r.capacity,
      status: r.status as CoolingSpace['status'],
      createdAt: iso(r.createdAt),
    }));
  },

  async findById(id: string): Promise<CoolingSpace | null> {
    const all = await this.list();
    return all.find((s) => s.id === id) ?? null;
  },

  async create(space: Omit<CoolingSpace, 'createdAt'>): Promise<CoolingSpace> {
    await prisma.coolingSpace.create({
      data: {
        id: space.id,
        name: space.name,
        nameEn: space.nameEn,
        type: space.type,
        address: space.address,
        district: space.district,
        lat: space.lat,
        lng: space.lng,
        riskLevel: space.riskLevel,
        airConditioned: space.airConditioned,
        accessible: space.accessible,
        accessibilityNotes: space.accessibilityNotes,
        openingHours: space.openingHours,
        opensAt: space.opensAt,
        closesAt: space.closesAt,
        contact: space.contact,
        capacity: space.capacity,
        status: space.status,
      },
    });
    const created = await this.findById(space.id);
    if (!created) throw new Error('Cooling space creation failed');
    return created;
  },

  async update(id: string, patch: Partial<CoolingSpace>): Promise<CoolingSpace> {
    await prisma.coolingSpace.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.nameEn !== undefined ? { nameEn: patch.nameEn } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.district !== undefined ? { district: patch.district } : {}),
        ...(patch.lat !== undefined ? { lat: patch.lat } : {}),
        ...(patch.lng !== undefined ? { lng: patch.lng } : {}),
        ...(patch.riskLevel !== undefined ? { riskLevel: patch.riskLevel } : {}),
        ...(patch.airConditioned !== undefined ? { airConditioned: patch.airConditioned } : {}),
        ...(patch.accessible !== undefined ? { accessible: patch.accessible } : {}),
        ...(patch.accessibilityNotes !== undefined
          ? { accessibilityNotes: patch.accessibilityNotes }
          : {}),
        ...(patch.openingHours !== undefined ? { openingHours: patch.openingHours } : {}),
        ...(patch.opensAt !== undefined ? { opensAt: patch.opensAt } : {}),
        ...(patch.closesAt !== undefined ? { closesAt: patch.closesAt } : {}),
        ...(patch.contact !== undefined ? { contact: patch.contact } : {}),
        ...(patch.capacity !== undefined ? { capacity: patch.capacity } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
    });
    const updated = await this.findById(id);
    if (!updated) throw new Error('Cooling space not found after update');
    return updated;
  },

  async delete(id: string): Promise<void> {
    await prisma.coolingSpace.delete({ where: { id } });
  },
};

export const cityRiskRepo = {
  async list(): Promise<CityRisk[]> {
    const rows = await prisma.cityRisk.findMany({ orderBy: { district: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      city: r.city,
      district: r.district,
      lat: r.lat,
      lng: r.lng,
      temperatureC: r.temperatureC,
      humidityPct: r.humidityPct,
      heatIndex: r.heatIndex,
      riskLevel: r.riskLevel as RiskLevel,
      urbanDensity: r.urbanDensity,
      greenCoveragePct: r.greenCoveragePct,
      coolingSpaceCount: r.coolingSpaceCount,
      elderlyUserCount: r.elderlyUserCount,
      updatedAt: iso(r.updatedAt),
    }));
  },

  async upsertMany(items: CityRisk[]): Promise<void> {
    for (const item of items) {
      await prisma.cityRisk.upsert({
        where: { id: item.id },
        create: {
          id: item.id,
          city: item.city,
          district: item.district,
          lat: item.lat,
          lng: item.lng,
          temperatureC: item.temperatureC,
          humidityPct: item.humidityPct,
          heatIndex: item.heatIndex,
          riskLevel: item.riskLevel,
          urbanDensity: item.urbanDensity,
          greenCoveragePct: item.greenCoveragePct,
          coolingSpaceCount: item.coolingSpaceCount,
          elderlyUserCount: item.elderlyUserCount,
        },
        update: {
          temperatureC: item.temperatureC,
          humidityPct: item.humidityPct,
          heatIndex: item.heatIndex,
          riskLevel: item.riskLevel,
          coolingSpaceCount: item.coolingSpaceCount,
          elderlyUserCount: item.elderlyUserCount,
        },
      });
    }
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const configRepo = {
  /** Read the live config, seeding the default on first access. */
  async get(): Promise<{ config: RiskRuleConfig; version: number }> {
    const row = await prisma.riskRuleConfigRecord.findUnique({ where: { id: 'default' } });

    if (!row) {
      const config = cloneDefaultConfig();
      await prisma.riskRuleConfigRecord.create({
        data: { id: 'default', payload: toJson(config), version: 1, updatedBy: 'system' },
      });
      return { config, version: 1 };
    }

    return {
      config: fromJson<RiskRuleConfig>(row.payload, cloneDefaultConfig()),
      version: row.version,
    };
  },

  async save(config: RiskRuleConfig, updatedBy: string): Promise<{ config: RiskRuleConfig; version: number }> {
    const row = await prisma.riskRuleConfigRecord.update({
      where: { id: 'default' },
      data: {
        payload: toJson({ ...config, updatedAt: new Date().toISOString(), updatedBy }),
        version: { increment: 1 },
        updatedBy,
      },
    });
    return {
      config: fromJson<RiskRuleConfig>(row.payload, cloneDefaultConfig()),
      version: row.version,
    };
  },

  async reset(updatedBy: string): Promise<{ config: RiskRuleConfig; version: number }> {
    return this.save(cloneDefaultConfig(), updatedBy);
  },
};

export const actionRuleRepo = {
  async list(): Promise<ActionRule[]> {
    const rows = await prisma.actionRuleRecord.findMany({ orderBy: { priority: 'asc' } });

    if (rows.length === 0) {
      const defaults = cloneDefaultActionRules();
      for (const rule of defaults) await this.create(rule);
      return defaults;
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameZh: r.nameZh,
      description: r.description,
      enabled: r.enabled,
      conditions: fromJson<ActionRule['conditions']>(r.conditions, []),
      actions: fromJson<ActionType[]>(r.actions, []),
      priority: r.priority,
      builtIn: r.builtIn,
      updatedAt: iso(r.updatedAt),
    }));
  },

  async findById(id: string): Promise<ActionRule | null> {
    const all = await this.list();
    return all.find((r) => r.id === id) ?? null;
  },

  async create(rule: ActionRule): Promise<ActionRule> {
    await prisma.actionRuleRecord.create({
      data: {
        id: rule.id,
        name: rule.name,
        nameZh: rule.nameZh,
        description: rule.description,
        enabled: rule.enabled,
        conditions: toJson(rule.conditions),
        actions: toJson(rule.actions),
        priority: rule.priority,
        builtIn: rule.builtIn,
      },
    });
    return rule;
  },

  async update(id: string, patch: Partial<ActionRule>): Promise<ActionRule> {
    await prisma.actionRuleRecord.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.nameZh !== undefined ? { nameZh: patch.nameZh } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.conditions !== undefined ? { conditions: toJson(patch.conditions) } : {}),
        ...(patch.actions !== undefined ? { actions: toJson(patch.actions) } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      },
    });
    const updated = await this.findById(id);
    if (!updated) throw new Error('Action rule not found after update');
    return updated;
  },

  async delete(id: string): Promise<void> {
    await prisma.actionRuleRecord.delete({ where: { id } });
  },
};

// ---------------------------------------------------------------------------
// Content, data sources, settings, audit
// ---------------------------------------------------------------------------

export const contentRepo = {
  async list(): Promise<ContentArticle[]> {
    const rows = await prisma.contentArticle.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      titleZh: r.titleZh,
      category: r.category as ContentArticle['category'],
      summary: r.summary,
      summaryZh: r.summaryZh,
      body: r.body,
      bodyZh: r.bodyZh,
      showForLevels: fromJson<RiskLevel[]>(r.showForLevels, ['LOW', 'MEDIUM', 'HIGH']),
      published: r.published,
      updatedAt: iso(r.updatedAt),
      updatedBy: r.updatedBy,
    }));
  },

  async findById(id: string): Promise<ContentArticle | null> {
    const all = await this.list();
    return all.find((a) => a.id === id) ?? null;
  },

  async create(article: Omit<ContentArticle, 'updatedAt'>): Promise<ContentArticle> {
    await prisma.contentArticle.create({
      data: {
        id: article.id,
        slug: article.slug,
        title: article.title,
        titleZh: article.titleZh,
        category: article.category,
        summary: article.summary,
        summaryZh: article.summaryZh,
        body: article.body,
        bodyZh: article.bodyZh,
        showForLevels: toJson(article.showForLevels),
        published: article.published,
        updatedBy: article.updatedBy,
      },
    });
    const created = await this.findById(article.id);
    if (!created) throw new Error('Article creation failed');
    return created;
  },

  async update(id: string, patch: Partial<ContentArticle>): Promise<ContentArticle> {
    await prisma.contentArticle.update({
      where: { id },
      data: {
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.titleZh !== undefined ? { titleZh: patch.titleZh } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.summaryZh !== undefined ? { summaryZh: patch.summaryZh } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.bodyZh !== undefined ? { bodyZh: patch.bodyZh } : {}),
        ...(patch.showForLevels !== undefined
          ? { showForLevels: toJson(patch.showForLevels) }
          : {}),
        ...(patch.published !== undefined ? { published: patch.published } : {}),
        ...(patch.updatedBy !== undefined ? { updatedBy: patch.updatedBy } : {}),
      },
    });
    const updated = await this.findById(id);
    if (!updated) throw new Error('Article not found after update');
    return updated;
  },

  async delete(id: string): Promise<void> {
    await prisma.contentArticle.delete({ where: { id } });
  },
};

export const dataSourceRepo = {
  async list(): Promise<DataSource[]> {
    const rows = await prisma.dataSource.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameZh: r.nameZh,
      kind: r.kind as DataSource['kind'],
      provider: r.provider,
      status: r.status as DataSource['status'],
      lastSyncAt: iso(r.lastSyncAt),
      recordCount: r.recordCount,
      errorRatePct: r.errorRatePct,
      config: fromJson<DataSource['config']>(r.config, {
        endpoint: '',
        intervalSec: 60,
        retries: 3,
      }),
      enabled: r.enabled,
    }));
  },

  async findById(id: string): Promise<DataSource | null> {
    const all = await this.list();
    return all.find((d) => d.id === id) ?? null;
  },

  async update(id: string, patch: Partial<DataSource>): Promise<DataSource> {
    await prisma.dataSource.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.config !== undefined ? { config: toJson(patch.config) } : {}),
        ...(patch.lastSyncAt !== undefined ? { lastSyncAt: new Date(patch.lastSyncAt) } : {}),
        ...(patch.recordCount !== undefined ? { recordCount: patch.recordCount } : {}),
        ...(patch.errorRatePct !== undefined ? { errorRatePct: patch.errorRatePct } : {}),
      },
    });
    const updated = await this.findById(id);
    if (!updated) throw new Error('Data source not found after update');
    return updated;
  },
};

export const settingRepo = {
  async list(): Promise<SystemSetting[]> {
    const rows = await prisma.systemSetting.findMany({ orderBy: [{ group: 'asc' }, { key: 'asc' }] });
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      labelZh: r.labelZh,
      value: r.value,
      type: r.type as SystemSetting['type'],
      group: r.group,
      description: r.description,
    }));
  },

  async update(key: string, value: string): Promise<SystemSetting> {
    const row = await prisma.systemSetting.update({ where: { key }, data: { value } });
    return {
      key: row.key,
      label: row.label,
      labelZh: row.labelZh,
      value: row.value,
      type: row.type as SystemSetting['type'],
      group: row.group,
      description: row.description,
    };
  },
};

export const auditRepo = {
  async list(limit = 300): Promise<AuditLogEntry[]> {
    const rows = await prisma.auditLog.findMany({ orderBy: { at: 'desc' }, take: limit });
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorName: r.actorName,
      actorRole: r.actorRole as AuditLogEntry['actorRole'],
      action: r.action,
      actionZh: r.actionZh,
      entity: r.entity,
      entityId: r.entityId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      at: iso(r.at),
    }));
  },

  async create(entry: Omit<AuditLogEntry, 'id' | 'at'> & { at?: string }): Promise<AuditLogEntry> {
    const row = await prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        actorName: entry.actorName,
        actorRole: entry.actorRole,
        action: entry.action,
        actionZh: entry.actionZh,
        entity: entry.entity,
        entityId: entry.entityId,
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        ...(entry.at ? { at: new Date(entry.at) } : {}),
      },
    });
    return { ...entry, id: row.id, at: iso(row.at) };
  },
};
