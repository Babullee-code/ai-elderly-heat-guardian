/**
 * Database seeding.
 *
 * Idempotent: running it twice wipes and rebuilds, so `npm run db:seed` is
 * always safe. Also generates 72 hours of historical readings per user so
 * charts have real history the moment the app opens, and so personal
 * baselines are *learned* from that history rather than asserted.
 */

import { calculateHeatIndex } from '../../shared/domain/heatIndex.js';
import { learnPersonalBaseline } from '../../shared/domain/baselineEngine.js';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../../shared/domain/notificationEngine.js';
import { cloneDefaultActionRules, cloneDefaultConfig } from '../../shared/domain/config.js';
import type { WearableReading } from '../../shared/types/domain.js';
import { prisma, toJson } from './client.js';
import {
  ACCOUNT_SEEDS,
  CAREGIVER_SEEDS,
  CONTENT_SEEDS,
  DATA_SOURCE_SEEDS,
  SETTING_SEEDS,
  TAIPEI_DISTRICTS,
  USER_SPECS,
  ambientProfileFor,
  baselineFor,
  coolingSpaceSeeds,
  devicesFor,
  elderlyUserFor,
} from './seedData.js';

/**
 * Historical samples generated per user: 72 hours at 30-minute spacing.
 *
 * Three days rather than one, because the personal baseline is learned from
 * the resting (overnight) samples only. A single night yields too few samples
 * for a confident baseline, and the engine correctly damps its physiological
 * risk score when confidence is low.
 */
const HISTORY_SAMPLES = 144;
const HISTORY_INTERVAL_MS = 30 * 60 * 1000;

async function clear(): Promise<void> {
  // Order matters: children before parents, because SQLite enforces the
  // foreign keys declared in the schema.
  await prisma.sensorReading.deleteMany();
  await prisma.environmentReading.deleteMany();
  await prisma.wearableReading.deleteMany();
  await prisma.riskEvent.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.caregiverAssignment.deleteMany();
  await prisma.device.deleteMany();
  await prisma.caregiver.deleteMany();
  await prisma.elderlyUser.deleteMany();
  await prisma.account.deleteMany();
  await prisma.coolingSpace.deleteMany();
  await prisma.cityRisk.deleteMany();
  await prisma.dataSource.deleteMany();
  await prisma.contentArticle.deleteMany();
  await prisma.notificationTemplate.deleteMany();
  await prisma.riskRuleConfigRecord.deleteMany();
  await prisma.actionRuleRecord.deleteMany();
  await prisma.systemSetting.deleteMany();
  await prisma.auditLog.deleteMany();
}

/**
 * Deterministic jitter so re-seeding produces identical history.
 * A fixed seed keeps the demo reproducible for judges.
 */
function makeRng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

async function main(): Promise<void> {
  console.log('[seed] Clearing existing data...');
  await clear();

  // --- Configuration ------------------------------------------------------
  console.log('[seed] Writing platform configuration...');
  await prisma.riskRuleConfigRecord.create({
    data: {
      id: 'default',
      payload: toJson(cloneDefaultConfig()),
      version: 1,
      updatedBy: 'system',
    },
  });

  for (const rule of cloneDefaultActionRules()) {
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
  }

  for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
    await prisma.notificationTemplate.create({
      data: {
        key: template.key,
        name: template.name,
        nameZh: template.nameZh,
        title: template.title,
        titleZh: template.titleZh,
        body: template.body,
        bodyZh: template.bodyZh,
        channels: toJson(template.channels),
        enabled: template.enabled,
      },
    });
  }

  for (const setting of SETTING_SEEDS) {
    await prisma.systemSetting.create({ data: setting });
  }

  for (const source of DATA_SOURCE_SEEDS) {
    await prisma.dataSource.create({
      data: {
        id: source.id,
        name: source.name,
        nameZh: source.nameZh,
        kind: source.kind,
        provider: source.provider,
        status: source.status,
        lastSyncAt: new Date(source.lastSyncAt),
        recordCount: source.recordCount,
        errorRatePct: source.errorRatePct,
        config: toJson(source.config),
        enabled: source.enabled,
      },
    });
  }

  // --- Content ------------------------------------------------------------
  console.log('[seed] Writing educational content...');
  for (const article of CONTENT_SEEDS) {
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
  }

  // --- Cooling spaces -----------------------------------------------------
  const spaces = coolingSpaceSeeds();
  console.log(`[seed] Writing ${spaces.length} cooling spaces...`);
  for (const space of spaces) {
    await prisma.coolingSpace.create({ data: space });
  }

  // --- Users, devices, history -------------------------------------------
  console.log(`[seed] Writing ${USER_SPECS.length} elderly users with 72h history...`);

  for (const spec of USER_SPECS) {
    const user = elderlyUserFor(spec);
    const seededBaseline = baselineFor(spec);
    const profile = ambientProfileFor(spec);

    // Generate the wearable history first, then LEARN the baseline from it.
    // This exercises the real learning path rather than trusting the seed
    // values, so the baseline shown in the UI is genuinely derived from data.
    const rng = makeRng(hash(spec.id));
    const now = Date.now();
    const wearableHistory: WearableReading[] = [];
    const envRows: {
      userId: string;
      indoorTempC: number;
      indoorHumidityPct: number;
      outdoorTempC: number;
      outdoorHumidityPct: number;
      airQualityIndex: number;
      heatIndex: number;
      simulated: boolean;
      recordedAt: Date;
    }[] = [];

    for (let i = HISTORY_SAMPLES; i > 0; i--) {
      const at = new Date(now - i * HISTORY_INTERVAL_MS);
      const hour = at.getHours();

      // Diurnal curve: warmest at ~15:00, coolest at ~05:00.
      const diurnal = Math.sin(((hour - 5) / 24) * Math.PI * 2) * 3.2;

      const outdoorTempC = round1(profile.baseOutdoorTempC + diurnal + (rng() - 0.5) * 0.8);
      const indoorTempC = round1(
        profile.baseIndoorTempC + diurnal * 0.55 + (rng() - 0.5) * 0.5,
      );
      const indoorHumidityPct = round1(
        clamp(profile.baseIndoorHumidityPct - diurnal * 1.2 + (rng() - 0.5) * 3, 30, 98),
      );
      const outdoorHumidityPct = round1(clamp(indoorHumidityPct + 5 + (rng() - 0.5) * 3, 30, 99));
      const airQualityIndex = Math.round(
        clamp(profile.baseAirQualityIndex + (rng() - 0.5) * 12, 10, 300),
      );

      envRows.push({
        userId: spec.id,
        indoorTempC,
        indoorHumidityPct,
        outdoorTempC,
        outdoorHumidityPct,
        airQualityIndex,
        heatIndex: calculateHeatIndex(indoorTempC, indoorHumidityPct),
        simulated: true,
        recordedAt: at,
      });

      // Resting heart rate within the personal band, plus a small thermal
      // response so the history is physiologically coherent.
      const band = seededBaseline.heartRate.max - seededBaseline.heartRate.min;
      const isResting = hour >= 22 || hour <= 6;

      /**
       * Overnight samples sit inside the person's OWN normal band, spread
       * widely enough that the learned 10th-90th percentile range reproduces
       * it. Daytime samples carry the elevation from `hrPosition`.
       *
       * The split matters: a resident who is currently at risk is elevated
       * *now*, not chronically. Learning the baseline from their elevated
       * readings would teach the engine that their stressed state is normal,
       * and their deviation would then read as 0% exactly when it matters
       * most - which is the precise failure the personal-baseline approach
       * exists to avoid.
       */
      const restingPosition = isResting
        ? clamp(0.5 + (rng() - 0.5) * 1.05, 0.02, 0.98)
        : clamp(spec.hrPosition + (rng() - 0.5) * 0.4, 0.02, 2.2);

      /**
       * Thermal contribution is damped for overnight samples.
       *
       * A baseline learned from a chronically hot bedroom would absorb the
       * heat response into the person's "normal", and their deviation would
       * then read near zero at exactly the moment they are most at risk.
       * Real baseline learning filters for thermally representative rest
       * periods; damping the overnight term models that filtering.
       */
      const thermal = Math.max(0, indoorTempC - 27) * (isResting ? 0.4 : 1.4);

      const heartRateBpm = Math.round(
        clamp(seededBaseline.heartRate.min + band * restingPosition + thermal, 45, 175),
      );

      wearableHistory.push({
        id: `hist-${spec.id}-${i}`,
        userId: spec.id,
        heartRateBpm,
        skinTempC: round1(32.9 + Math.max(0, indoorTempC - 24) * 0.12 + (rng() - 0.5) * 0.2),
        activityStepsPerHour: Math.round(
          clamp(
            // Night-time activity is near zero; daytime follows the mean.
            (hour >= 7 && hour <= 21 ? seededBaseline.activityStepsPerHour.mean : 20) *
              (0.6 + rng() * 0.8),
            0,
            1500,
          ),
        ),
        simulated: true,
        recordedAt: at.toISOString(),
      });
    }

    // Learn the baseline from the history we just generated. Restrict learning
    // to resting samples (night-time), which is how a real baseline would be
    // established - a daytime average would be contaminated by activity.
    const restingSamples = wearableHistory.filter((r) => {
      const hour = new Date(r.recordedAt).getHours();
      return hour >= 22 || hour <= 6;
    });

    const learned = learnPersonalBaseline(
      spec.id,
      restingSamples.length >= 12 ? restingSamples : wearableHistory,
      seededBaseline,
    );

    await prisma.elderlyUser.create({
      data: {
        id: user.id,
        name: user.name,
        nameEn: user.nameEn,
        age: user.age,
        gender: user.gender,
        city: user.city,
        district: user.district,
        lat: user.lat,
        lng: user.lng,
        phone: user.phone,
        address: user.address,
        conditions: toJson(user.conditions),
        medications: toJson(user.medications),
        status: user.status,
        permissions: toJson(user.permissions),
        elderlyModeDefault: user.elderlyModeDefault,
        emergencyContact: toJson(user.emergencyContact),
        baseline: toJson(learned),
        ambientProfile: toJson(profile),
      },
    });

    for (const device of devicesFor(spec)) {
      await prisma.device.create({
        data: {
          id: device.id,
          deviceId: device.deviceId,
          name: device.name,
          nameZh: device.nameZh,
          type: device.type,
          userId: device.userId,
          status: device.status,
          batteryPct: device.batteryPct,
          signalPct: device.signalPct,
          lastSeen: new Date(device.lastSeen),
          firmware: device.firmware,
          location: device.location,
          power: device.power,
          isActuator: device.isActuator,
        },
      });
    }

    await prisma.environmentReading.createMany({ data: envRows });
    await prisma.wearableReading.createMany({
      data: wearableHistory.map((r) => ({
        userId: r.userId,
        heartRateBpm: r.heartRateBpm,
        skinTempC: r.skinTempC,
        activityStepsPerHour: r.activityStepsPerHour,
        simulated: r.simulated,
        recordedAt: new Date(r.recordedAt),
      })),
    });
  }

  // --- Caregivers ---------------------------------------------------------
  console.log(`[seed] Writing ${CAREGIVER_SEEDS.length} caregivers...`);
  for (const cg of CAREGIVER_SEEDS) {
    await prisma.caregiver.create({
      data: {
        id: cg.id,
        name: cg.name,
        nameEn: cg.nameEn,
        relationship: cg.relationship,
        phone: cg.phone,
        email: cg.email,
        notificationPreferences: toJson(cg.notificationPreferences),
        emergencyPermission: cg.emergencyPermission,
        status: cg.status,
        assignments: { create: cg.assignedUserIds.map((userId) => ({ userId })) },
      },
    });
  }

  // Every remaining ACTIVE user gets a caregiver, because an elderly user with
  // no caregiver at all would be an unrealistic gap in the cohort.
  const allUsers = await prisma.elderlyUser.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  });
  const assigned = new Set(CAREGIVER_SEEDS.flatMap((c) => c.assignedUserIds));
  const rotation = ['cg-001', 'cg-002', 'cg-003', 'cg-004'];

  let rotationIndex = 0;
  for (const u of allUsers) {
    if (assigned.has(u.id)) continue;
    await prisma.caregiverAssignment.create({
      data: { caregiverId: rotation[rotationIndex % rotation.length], userId: u.id },
    });
    rotationIndex++;
  }

  // --- Accounts -----------------------------------------------------------
  for (const account of ACCOUNT_SEEDS) {
    await prisma.account.create({ data: account });
  }

  // --- City risk ----------------------------------------------------------
  console.log('[seed] Writing city heat-risk districts...');
  const userCounts = await prisma.elderlyUser.groupBy({
    by: ['district'],
    _count: { id: true },
  });
  const spaceCounts = await prisma.coolingSpace.groupBy({
    by: ['district'],
    where: { status: 'ACTIVE' },
    _count: { id: true },
  });

  for (const district of TAIPEI_DISTRICTS) {
    // District temperature reflects the urban heat island: denser and less
    // green districts run hotter than the city's base temperature.
    const baseTemp = 30.5;
    const densityEffect = (district.urbanDensity / 100) * 3.4;
    const greenEffect = (district.greenCoveragePct / 100) * 2.6;
    const temperatureC = round1(baseTemp + densityEffect - greenEffect);
    const humidityPct = round1(clamp(72 - district.greenCoveragePct * 0.08, 55, 88));
    const heatIndex = calculateHeatIndex(temperatureC, humidityPct);

    const config = cloneDefaultConfig();
    const riskLevel =
      heatIndex >= config.thresholds.high
        ? 'HIGH'
        : heatIndex >= config.thresholds.medium
          ? 'MEDIUM'
          : 'LOW';

    await prisma.cityRisk.create({
      data: {
        id: `city-taipei-${district.nameEn.toLowerCase().replace(/[^a-z]/g, '')}`,
        city: '台北市',
        district: district.name,
        lat: district.lat,
        lng: district.lng,
        temperatureC,
        humidityPct,
        heatIndex,
        riskLevel,
        urbanDensity: district.urbanDensity,
        greenCoveragePct: district.greenCoveragePct,
        coolingSpaceCount:
          spaceCounts.find((s) => s.district === district.name)?._count.id ?? 0,
        elderlyUserCount: userCounts.find((u) => u.district === district.name)?._count.id ?? 0,
      },
    });
  }

  // --- Audit trail --------------------------------------------------------
  await prisma.auditLog.create({
    data: {
      actorId: 'system',
      actorName: 'System',
      actorRole: 'SUPER_ADMIN',
      action: 'Seeded platform data',
      actionZh: '初始化平台資料',
      entity: 'System',
      entityId: 'seed',
      oldValue: null,
      newValue: `${USER_SPECS.length} users, ${spaces.length} cooling spaces`,
    },
  });

  const counts = {
    users: await prisma.elderlyUser.count(),
    activeUsers: await prisma.elderlyUser.count({ where: { status: 'ACTIVE' } }),
    caregivers: await prisma.caregiver.count(),
    devices: await prisma.device.count(),
    coolingSpaces: await prisma.coolingSpace.count(),
    environmentReadings: await prisma.environmentReading.count(),
    wearableReadings: await prisma.wearableReading.count(),
  };

  console.log('[seed] Done:', counts);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

main()
  .catch((error) => {
    console.error('[seed] Failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
