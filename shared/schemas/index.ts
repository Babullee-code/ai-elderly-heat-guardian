/**
 * Zod validation schemas.
 *
 * Every mutating API route validates its body against one of these. The client
 * imports the same schemas so a form can validate before submitting, but the
 * server validation is the one that counts - client-side checks are a UX
 * nicety, not a trust boundary.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const riskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const roleSchema = z.enum(['SUPER_ADMIN', 'ADMIN', 'CAREGIVER', 'ELDER', 'VIEWER']);

export const notificationChannelSchema = z.enum(['PUSH', 'SMS', 'EMAIL', 'IN_APP', 'VOICE_CALL']);

export const actionTypeSchema = z.enum([
  'HYDRATE',
  'REST',
  'AVOID_OUTDOOR',
  'NOTIFY_CAREGIVER',
  'ACTIVATE_COOLING',
  'MONITOR_INDOOR',
  'INCREASE_MONITORING',
  'RECOMMEND_COOLING_SPACE',
  'EMERGENCY_ASSISTANCE',
]);

export const deviceTypeSchema = z.enum([
  'SMART_WATCH',
  'TEMPERATURE_SENSOR',
  'HUMIDITY_SENSOR',
  'AIR_QUALITY_SENSOR',
  'SMART_AC',
  'DEHUMIDIFIER',
  'FAN',
]);

export const deviceStatusSchema = z.enum(['ONLINE', 'OFFLINE', 'DISABLED', 'LOW_BATTERY']);

export const coolingSpaceTypeSchema = z.enum([
  'LIBRARY',
  'COMMUNITY_CENTER',
  'PUBLIC_BUILDING',
  'AIR_CONDITIONED_PUBLIC_SPACE',
  'PARK',
  'MRT_STATION',
  'HEALTH_CENTER',
]);

/** Rejects HTML-ish input so admin-authored strings cannot inject markup. */
const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Required')
    .max(max, `Must be ${max} characters or fewer`)
    .refine((v) => !/[<>]/.test(v), 'Angle brackets are not allowed');

const safeMultiline = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .refine((v) => !/<\s*script/i.test(v), 'Script tags are not allowed');

const timeString = z
  .string()
  .regex(/^([01]?\d|2[0-4]):[0-5]\d$/, 'Use HH:MM 24-hour format');

// ---------------------------------------------------------------------------
// Risk rules
// ---------------------------------------------------------------------------

export const riskRuleConfigUpdateSchema = z
  .object({
    thresholds: z
      .object({
        low: z.number().min(0).max(60),
        medium: z.number().min(0).max(60),
        high: z.number().min(0).max(70),
      })
      .refine((t) => t.low < t.medium && t.medium < t.high, {
        message: 'Thresholds must increase: LOW < MEDIUM < HIGH',
      }),
    weights: z.object({
      environmental: z.number().min(0).max(1),
      physiological: z.number().min(0).max(1),
      heatwave: z.number().min(0).max(1),
      ventilation: z.number().min(0).max(1),
      activity: z.number().min(0).max(1),
    }),
    scoreEscalation: z
      .object({
        mediumScore: z.number().min(0).max(100),
        highScore: z.number().min(0).max(100),
        enabled: z.boolean(),
      })
      .refine((s) => s.mediumScore < s.highScore, {
        message: 'The MEDIUM score must be below the HIGH score',
      }),
    monitoringIntervalSec: z.object({
      LOW: z.number().int().min(5).max(3600),
      MEDIUM: z.number().int().min(5).max(3600),
      HIGH: z.number().int().min(5).max(3600),
    }),
    physiology: z
      .object({
        minDeviationPct: z.number().min(0).max(100),
        maxDeviationPct: z.number().min(1).max(200),
      })
      .refine((p) => p.minDeviationPct < p.maxDeviationPct, {
        message: 'The minimum deviation must be below the maximum',
      }),
    environment: z.object({
      humidityConcernPct: z.number().min(0).max(100),
      ventilationDeltaC: z.number().min(0).max(20),
      heatwaveDayThreshold: z.number().int().min(1).max(30),
    }),
    smartHomePolicy: z.object({
      allowAutomaticCooling: z.boolean(),
      minLevelForCooling: riskLevelSchema,
      targetIndoorTempC: z.number().min(16).max(30),
    }),
    notificationPolicy: z.object({
      minLevelForCaregiver: riskLevelSchema,
      cooldownMinutes: z.number().min(0).max(240),
      escalateAfterMinutes: z.number().min(1).max(240),
    }),
  })
  .partial();

// ---------------------------------------------------------------------------
// Action rules
// ---------------------------------------------------------------------------

export const ruleConditionSchema = z.object({
  field: z.enum([
    'riskLevel',
    'riskScore',
    'heatIndex',
    'indoorTemp',
    'humidity',
    'heartRateDeviation',
    'activityLevel',
  ]),
  operator: z.enum(['is', 'isNot', 'gte', 'lte', 'gt', 'lt']),
  value: z.union([z.string(), z.number()]),
});

export const actionRuleCreateSchema = z.object({
  name: safeText(80),
  nameZh: safeText(80),
  description: safeMultiline(400),
  enabled: z.boolean().default(true),
  conditions: z.array(ruleConditionSchema).min(1, 'Add at least one condition').max(6),
  actions: z.array(actionTypeSchema).min(1, 'Select at least one action'),
  priority: z.number().int().min(1).max(100).default(50),
});

export const actionRuleUpdateSchema = actionRuleCreateSchema.partial();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const userPermissionsSchema = z.object({
  automaticCooling: z.boolean(),
  caregiverNotifications: z.boolean(),
  locationSharing: z.boolean(),
  physiologicalDataStorage: z.boolean(),
  cityDataContribution: z.boolean(),
});

export const elderlyUserCreateSchema = z.object({
  name: safeText(40),
  nameEn: safeText(60),
  age: z.number().int().min(50).max(120),
  gender: z.enum(['M', 'F', 'OTHER']),
  city: safeText(30),
  district: safeText(30),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  phone: z.string().trim().min(6).max(24),
  address: safeText(160),
  conditions: z.array(safeText(40)).max(12).default([]),
  medications: z.array(safeText(40)).max(12).default([]),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE']).default('ACTIVE'),
  elderlyModeDefault: z.boolean().default(true),
  permissions: userPermissionsSchema,
  emergencyContact: z.object({
    name: safeText(40),
    relationship: safeText(30),
    phone: z.string().trim().min(6).max(24),
  }),
});

export const elderlyUserUpdateSchema = elderlyUserCreateSchema.partial();

// ---------------------------------------------------------------------------
// Caregivers
// ---------------------------------------------------------------------------

export const caregiverCreateSchema = z.object({
  name: safeText(40),
  nameEn: safeText(60),
  relationship: z.enum(['SON', 'DAUGHTER', 'SPOUSE', 'NURSE', 'SOCIAL_WORKER', 'NEIGHBOUR', 'OTHER']),
  phone: z.string().trim().min(6).max(24),
  email: z.string().trim().email('Enter a valid email address').max(120),
  assignedUserIds: z.array(z.string().min(1)).max(50).default([]),
  notificationPreferences: z.object({
    channels: z.array(notificationChannelSchema).min(1, 'Select at least one channel'),
    minLevel: riskLevelSchema,
    quietHours: z.object({
      enabled: z.boolean(),
      from: timeString,
      to: timeString,
    }),
  }),
  emergencyPermission: z.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const caregiverUpdateSchema = caregiverCreateSchema.partial();

export const assignmentSchema = z.object({
  caregiverId: z.string().min(1),
  userId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export const deviceCreateSchema = z.object({
  deviceId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{4,32}$/, 'Use uppercase letters, digits and hyphens'),
  name: safeText(60),
  nameZh: safeText(60),
  type: deviceTypeSchema,
  userId: z.string().min(1),
  location: safeText(40),
  firmware: z
    .string()
    .trim()
    .regex(/^v?\d+\.\d+\.\d+$/, 'Use semantic version, e.g. 2.4.1'),
});

export const deviceUpdateSchema = z
  .object({
    name: safeText(60),
    nameZh: safeText(60),
    location: safeText(40),
    firmware: z.string().trim().regex(/^v?\d+\.\d+\.\d+$/),
    status: deviceStatusSchema,
    power: z.boolean(),
  })
  .partial();

export const deviceActionSchema = z.object({
  action: z.enum(['configure', 'reconnect', 'disable', 'enable', 'toggle-power']),
});

// ---------------------------------------------------------------------------
// Cooling spaces
// ---------------------------------------------------------------------------

export const coolingSpaceCreateSchema = z.object({
  name: safeText(80),
  nameEn: safeText(100),
  type: coolingSpaceTypeSchema,
  address: safeText(160),
  district: safeText(30),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  riskLevel: riskLevelSchema,
  airConditioned: z.boolean(),
  accessible: z.boolean(),
  accessibilityNotes: safeMultiline(200).default(''),
  openingHours: safeText(60),
  opensAt: timeString,
  closesAt: timeString,
  contact: z.string().trim().max(40).default(''),
  capacity: z.number().int().min(0).max(10000),
  status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
});

export const coolingSpaceUpdateSchema = coolingSpaceCreateSchema.partial();

/** Bulk import payload for /admin/cooling-spaces. */
export const coolingSpaceImportSchema = z.object({
  spaces: z.array(coolingSpaceCreateSchema).min(1).max(200),
});

// ---------------------------------------------------------------------------
// Notifications & content
// ---------------------------------------------------------------------------

export const notificationTemplateUpdateSchema = z
  .object({
    title: safeText(120),
    titleZh: safeText(120),
    body: safeMultiline(600),
    bodyZh: safeMultiline(600),
    channels: z.array(notificationChannelSchema).min(1),
    enabled: z.boolean(),
  })
  .partial();

/**
 * Content validation deliberately blocks medical claim language. Admins may
 * publish safety guidance, not diagnoses or treatment promises.
 */
const MEDICAL_CLAIM_PATTERNS = [
  /\b(cure|cures|cured|treat|treats|treatment for|diagnos)\b/i,
  /\b(guarantee|guaranteed|prevents? (heat ?stroke|illness|death))\b/i,
  /治療|療效|保證|治好|痊癒|診斷/,
];

const noMedicalClaims = (value: string) =>
  !MEDICAL_CLAIM_PATTERNS.some((pattern) => pattern.test(value));

const MEDICAL_CLAIM_MESSAGE =
  'Content may not make medical claims (diagnosis, treatment or guarantees). Use safety-oriented wording instead.';

export const contentArticleCreateSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{3,60}$/, 'Use lowercase letters, digits and hyphens'),
  title: safeText(120).refine(noMedicalClaims, MEDICAL_CLAIM_MESSAGE),
  titleZh: safeText(120).refine(noMedicalClaims, MEDICAL_CLAIM_MESSAGE),
  category: z.enum([
    'HEAT_PREVENTION',
    'HYDRATION',
    'COOLING',
    'HEATWAVE_WARNING',
    'ELDERLY_SAFETY',
    'HIGH_RISK_RESPONSE',
  ]),
  summary: safeMultiline(300).refine(noMedicalClaims, MEDICAL_CLAIM_MESSAGE),
  summaryZh: safeMultiline(300).refine(noMedicalClaims, MEDICAL_CLAIM_MESSAGE),
  body: safeMultiline(4000).refine(noMedicalClaims, MEDICAL_CLAIM_MESSAGE),
  bodyZh: safeMultiline(4000).refine(noMedicalClaims, MEDICAL_CLAIM_MESSAGE),
  showForLevels: z.array(riskLevelSchema).min(1),
  published: z.boolean().default(false),
});

export const contentArticleUpdateSchema = contentArticleCreateSchema.partial();

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const alertUpdateSchema = z.object({
  status: z.enum(['NEW', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED']),
  assignedCaregiverId: z.string().min(1).nullable().optional(),
  note: safeMultiline(300).optional(),
});

// ---------------------------------------------------------------------------
// Data sources & system
// ---------------------------------------------------------------------------

export const dataSourceUpdateSchema = z
  .object({
    enabled: z.boolean(),
    status: z.enum(['ONLINE', 'DEGRADED', 'OFFLINE']),
    config: z.object({
      endpoint: z
        .string()
        .trim()
        .max(200)
        .refine((v) => /^https?:\/\//.test(v), 'Endpoint must be an http(s) URL'),
      intervalSec: z.number().int().min(5).max(86400),
      retries: z.number().int().min(0).max(10),
    }),
  })
  .partial();

export const systemSettingUpdateSchema = z.object({
  value: z.string().max(200),
});

// ---------------------------------------------------------------------------
// Smart home & user-facing controls
// ---------------------------------------------------------------------------

export const smartHomeCommandSchema = z.object({
  appliance: z.enum(['ac', 'fan', 'dehumidifier']),
  on: z.boolean(),
});

export const smartHomeTargetSchema = z.object({
  targetTempC: z.number().min(16).max(30),
});

export const userPermissionsUpdateSchema = userPermissionsSchema.partial();

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export const simulationCommandSchema = z.object({
  action: z.enum(['start', 'stop', 'reset', 'set-scenario', 'set-speed', 'set-offsets', 'set-focus']),
  scenario: z
    .enum(['FULL_DEMO', 'HEATWAVE', 'NIGHT_RECOVERY', 'DEVICE_FAILURE', 'AMBIENT'])
    .optional(),
  speed: z.number().min(0.25).max(8).optional(),
  focusUserId: z.string().min(1).optional(),
  offsets: z
    .object({
      tempC: z.number().min(-15).max(20),
      humidityPct: z.number().min(-40).max(40),
      heartRateBpm: z.number().min(-30).max(60),
    })
    .partial()
    .optional(),
});

export const testNotificationSchema = z.object({
  templateKey: z.enum([
    'LOW_RISK',
    'MEDIUM_RISK',
    'HIGH_RISK',
    'COOLING_ACTIVATED',
    'DEVICE_OFFLINE',
    'RISK_RECOVERED',
  ]),
  userId: z.string().min(1),
  caregiverId: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RiskRuleConfigUpdate = z.infer<typeof riskRuleConfigUpdateSchema>;
export type ActionRuleCreate = z.infer<typeof actionRuleCreateSchema>;
export type ElderlyUserCreate = z.infer<typeof elderlyUserCreateSchema>;
export type ElderlyUserUpdate = z.infer<typeof elderlyUserUpdateSchema>;
export type CaregiverCreate = z.infer<typeof caregiverCreateSchema>;
export type DeviceCreate = z.infer<typeof deviceCreateSchema>;
export type CoolingSpaceCreate = z.infer<typeof coolingSpaceCreateSchema>;
export type ContentArticleCreate = z.infer<typeof contentArticleCreateSchema>;
export type SimulationCommand = z.infer<typeof simulationCommandSchema>;
