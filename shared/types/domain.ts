/**
 * Core domain types for AI 守護高齡者.
 * Shared verbatim between the Express server and the React client so the
 * risk engine can run identically on both sides.
 */

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Ordered so levels can be compared numerically (escalation logic). */
export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export const RISK_LABEL_ZH: Record<RiskLevel, string> = {
  LOW: '低風險',
  MEDIUM: '需要注意',
  HIGH: '高風險',
};

export const RISK_LABEL_EN: Record<RiskLevel, string> = {
  LOW: 'LOW RISK',
  MEDIUM: 'MEDIUM RISK',
  HIGH: 'HIGH RISK',
};

/** A single weighted contributor to the total risk score. */
export interface RiskFactor {
  /** Stable machine key, e.g. 'environmental'. */
  key: RiskFactorKey;
  /** Human label, English. */
  label: string;
  /** Human label, Traditional Chinese. */
  labelZh: string;
  /** Normalised 0..100 severity of this factor alone. */
  score: number;
  /** Weight applied from the active RiskRuleConfig (0..1). */
  weight: number;
  /** score * weight — this factor's contribution to the total. */
  contribution: number;
  /** Short explanation of the measured value, English. */
  detail: string;
  /** Short explanation of the measured value, Traditional Chinese. */
  detailZh: string;
}

export type RiskFactorKey =
  | 'environmental'
  | 'physiological'
  | 'heatwave'
  | 'ventilation'
  | 'activity';

/** Full output of the risk engine for one evaluation. */
export interface RiskAssessment {
  userId: string;
  /** ISO timestamp of the evaluation. */
  timestamp: string;
  /** 0..100 composite AI risk score. */
  score: number;
  level: RiskLevel;
  /** Heat index in Celsius, driver of the level thresholds. */
  heatIndex: number;
  factors: RiskFactor[];
  /** Ordered natural-language reasoning lines. */
  explanation: AIExplanation;
  /** Actions the policy engine produced for this assessment. */
  actions: RecommendedAction[];
  /** Deviation of heart rate from the personal baseline. */
  baseline: BaselineEvaluation;
  /** Level at the previous evaluation, for transition detection. */
  previousLevel: RiskLevel | null;
  /** True when level increased vs previousLevel. */
  escalated: boolean;
  /** True when level decreased vs previousLevel. */
  recovered: boolean;
  /** Snapshot of readings the assessment was computed from. */
  readings: ReadingSnapshot;
  /** How fresh and trustworthy each of those readings is. */
  provenance: ReadingProvenance;
  /** Monitoring cadence the policy engine selected, in seconds. */
  monitoringIntervalSec: number;
}

export interface AIExplanation {
  /** Headline conclusion, e.g. 熱風險正在升高. */
  headline: string;
  headlineEn: string;
  /** Individual reasoning lines shown as a list. */
  lines: AIExplanationLine[];
  /** Confidence of the assessment, 0..1. */
  confidence: number;
  /** Forward-looking projection statement. */
  forecast: string;
  forecastEn: string;
}

export interface AIExplanationLine {
  zh: string;
  en: string;
  /** Which factor produced this line, for UI grouping. */
  factor: RiskFactorKey | 'summary' | 'trend';
  /** 'up' worsening, 'down' improving, 'flat' steady. */
  direction: 'up' | 'down' | 'flat';
}

// ---------------------------------------------------------------------------
// Actions & policy
// ---------------------------------------------------------------------------

export type ActionType =
  | 'HYDRATE'
  | 'REST'
  | 'AVOID_OUTDOOR'
  | 'NOTIFY_CAREGIVER'
  | 'ACTIVATE_COOLING'
  | 'MONITOR_INDOOR'
  | 'INCREASE_MONITORING'
  | 'RECOMMEND_COOLING_SPACE'
  | 'EMERGENCY_ASSISTANCE';

export interface RecommendedAction {
  type: ActionType;
  /** Display title, Traditional Chinese. */
  titleZh: string;
  title: string;
  /** Supporting sentence. */
  bodyZh: string;
  body: string;
  /** Lowest risk level that produces this action (actions are cumulative). */
  fromLevel: RiskLevel;
  /** 1 = highest priority, used for display ordering. */
  priority: number;
  /** Whether the platform performs this automatically vs advising the user. */
  automatic: boolean;
  /**
   * Set when an automatic action was suppressed. Explains why - e.g. the admin
   * policy disallows auto-cooling, or the user has not authorised it.
   */
  blockedReason?: string;
  blockedReasonZh?: string;
  /** Icon key resolved by the UI to a Lucide icon. */
  icon: string;
}

// ---------------------------------------------------------------------------
// Configuration (owned by the CMS, consumed by the risk engine)
// ---------------------------------------------------------------------------

/**
 * The single configuration object the CMS edits and the risk engine reads.
 * No threshold or weight may appear anywhere else in the codebase.
 */
export interface RiskRuleConfig {
  id: string;
  /** Heat-index thresholds in Celsius. */
  thresholds: {
    /** Heat index at or above which the LOW advisory band begins. */
    low: number;
    /** Heat index at or above which risk becomes MEDIUM. */
    medium: number;
    /** Heat index at or above which risk becomes HIGH. */
    high: number;
  };
  /** Factor weights. Should sum to ~1 but the engine normalises defensively. */
  weights: Record<RiskFactorKey, number>;
  /** Composite-score overrides - score can escalate a level on its own. */
  scoreEscalation: {
    /** Score at or above which level is forced to at least MEDIUM. */
    mediumScore: number;
    /** Score at or above which level is forced to HIGH. */
    highScore: number;
    enabled: boolean;
  };
  /** Monitoring cadence in seconds, per risk level. */
  monitoringIntervalSec: Record<RiskLevel, number>;
  /** Physiological deviation (% above personal baseline) treated as maximal. */
  physiology: {
    /** % above baseline at which physiological risk = 100. */
    maxDeviationPct: number;
    /** % above baseline below which physiological risk = 0. */
    minDeviationPct: number;
  };
  /** Environmental shaping. */
  environment: {
    /** Humidity % above which ventilation risk starts climbing. */
    humidityConcernPct: number;
    /** Indoor-outdoor delta (Celsius) below which ventilation is poor. */
    ventilationDeltaC: number;
    /** Consecutive hot days that counts as a full heatwave. */
    heatwaveDayThreshold: number;
  };
  /** Global smart-home policy switch. When false the platform never auto-cools. */
  smartHomePolicy: {
    allowAutomaticCooling: boolean;
    /** Minimum level at which auto-cooling may engage. */
    minLevelForCooling: RiskLevel;
    /** Target indoor temperature in Celsius when cooling engages. */
    targetIndoorTempC: number;
  };
  /** Notification escalation policy. */
  notificationPolicy: {
    /** Minimum level that notifies a caregiver. */
    minLevelForCaregiver: RiskLevel;
    /** Repeat-notification suppression window, minutes. */
    cooldownMinutes: number;
    /** Escalate to emergency contact if a HIGH alert is unacknowledged this long. */
    escalateAfterMinutes: number;
  };
  updatedAt: string;
  updatedBy: string;
}

/** A CMS-authored conditional policy rule (the rule builder). */
export interface ActionRule {
  id: string;
  name: string;
  nameZh: string;
  description: string;
  enabled: boolean;
  /** All conditions must hold (AND) for the rule to fire. */
  conditions: RuleCondition[];
  /** Actions emitted when the rule fires. */
  actions: ActionType[];
  priority: number;
  /** Built-in rules mirror the proposal and cannot be deleted, only disabled. */
  builtIn: boolean;
  updatedAt: string;
}

export interface RuleCondition {
  field: RuleField;
  operator: RuleOperator;
  /** Compared value - a RiskLevel string or a number depending on field. */
  value: string | number;
}

export type RuleField =
  | 'riskLevel'
  | 'riskScore'
  | 'heatIndex'
  | 'indoorTemp'
  | 'humidity'
  | 'heartRateDeviation'
  | 'activityLevel';

export type RuleOperator = 'is' | 'isNot' | 'gte' | 'lte' | 'gt' | 'lt';

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** Everything the engine needs for one evaluation, already normalised. */
export interface ReadingSnapshot {
  /** Indoor air temperature in Celsius. */
  indoorTempC: number;
  /** Indoor relative humidity %. */
  indoorHumidityPct: number;
  /** Outdoor air temperature in Celsius. */
  outdoorTempC: number;
  /** Outdoor relative humidity %. */
  outdoorHumidityPct: number;
  /** Air quality index, 0..500. */
  airQualityIndex: number;
  /** Heart rate BPM from the wearable. */
  heartRateBpm: number;
  /** Steps in the last hour - proxy for activity. */
  activityStepsPerHour: number;
  /** Skin temperature in Celsius from the wearable. */
  skinTempC: number;
  /** Consecutive days of heatwave conditions in the user's city. */
  heatwaveDays: number;
  /** True when values are simulated rather than from real hardware. */
  simulated: boolean;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Data provenance
// ---------------------------------------------------------------------------

/**
 * How fresh a single measurement is.
 *
 * Distinguishing these matters more here than in most products: a monitoring
 * console that shows a four-minute-old heart rate as though it were current is
 * worse than one that shows nothing, because a caregiver will act on it.
 */
export type DataQuality = 'LIVE' | 'RECENT' | 'STALE' | 'OFFLINE';

/** Where a single measurement came from. */
export type DataOrigin =
  /** A household sensor or wearable reported it. */
  | 'DEVICE'
  /** An external weather service supplied it. */
  | 'WEATHER_API'
  /** The simulator produced it - no real hardware is attached. */
  | 'SIMULATOR'
  /** The source went quiet; this is the last value it gave, not a new one. */
  | 'HELD'
  /** No source exists for this field; a population default is standing in. */
  | 'DEFAULT';

/**
 * The nine measured fields of a ReadingSnapshot.
 *
 * Deliberately excludes `simulated` and `timestamp`, which are metadata about
 * the snapshot rather than measurements that can go stale independently.
 */
export type MeasurementField =
  | 'indoorTempC'
  | 'indoorHumidityPct'
  | 'outdoorTempC'
  | 'outdoorHumidityPct'
  | 'airQualityIndex'
  | 'heartRateBpm'
  | 'activityStepsPerHour'
  | 'skinTempC'
  | 'heatwaveDays';

/**
 * The true physical state of one household.
 *
 * This is the world, not the record of it. Sensors SAMPLE this state; they do
 * not constitute it. The distinction matters: a room keeps heating while its
 * temperature sensor is offline, and when the sensor comes back it must report
 * how hot the room actually is now - not resume from the value it froze at.
 *
 * Held values therefore live on `ReadingSnapshot`, never here.
 */
export interface HouseholdState {
  indoorTempC: number;
  indoorHumidityPct: number;
  outdoorTempC: number;
  outdoorHumidityPct: number;
  airQualityIndex: number;
  heartRateBpm: number;
  activityStepsPerHour: number;
  skinTempC: number;
  heatwaveDays: number;
  /** When this physical state was computed. */
  at: string;
}

/** What kind of thing produced a measurement. */
export type InputSourceKind =
  | 'HOUSEHOLD_SENSOR'
  | 'WEARABLE'
  | 'WEATHER'
  | 'ENVIRONMENT_MODEL'
  | 'INGEST';

/** One value, from one source, at one moment. */
export interface Measurement {
  field: MeasurementField;
  value: number;
  observedAt: string;
}

/**
 * What one input source has to say this tick.
 *
 * A source that cannot report says so explicitly rather than returning
 * nothing, because "the watch is offline" and "there is no watch" call for
 * different words on screen.
 */
export interface SourceReport {
  sourceId: string;
  kind: InputSourceKind;
  origin: DataOrigin;
  /** Fields this source is responsible for, whether or not it reported them. */
  fields: MeasurementField[];
  measurements: Measurement[];
  available: boolean;
  simulated: boolean;
  deviceId?: string;
  deviceName?: string;
  /** Why the source could not report, when it could not. */
  unavailableReasonZh?: string;
  unavailableReason?: string;
  /**
   * Lower wins. A real device outranks a modelled estimate, so a household
   * that later gains a sensor stops using the estimate automatically.
   */
  priority: number;
  /**
   * The best quality this source's values may be labelled with.
   *
   * For a source that is still returning real data but can no longer refresh
   * it - a weather provider that has started failing while its last
   * observation is still recent. The measurement is genuine, so holding it is
   * right; calling it LIVE is not, because nothing is keeping it current.
   */
  qualityCap?: DataQuality;
  /**
   * True for a source that only fills gaps nothing else covers.
   *
   * A fallback must never stand in for a sensor that has failed: replacing a
   * dead thermometer with a modelled guess would hide the failure behind a
   * plausible number, which is the one thing a safety system must not do.
   */
  fallback?: boolean;
}

export interface FieldProvenance {
  field: MeasurementField;
  origin: DataOrigin;
  quality: DataQuality;
  /** When the SOURCE produced this value - not when the snapshot was built. */
  observedAt: string;
  ageSec: number;
  deviceId?: string;
  deviceName?: string;
  simulated: boolean;
  /** Plain-language reason this field is not live, shown to the user. */
  noteZh?: string;
  note?: string;
}

/**
 * Per-field provenance for one ReadingSnapshot.
 *
 * Carried ALONGSIDE the snapshot rather than inside it, so `ReadingSnapshot`
 * keeps its shape and the risk engine signature is unchanged. The engine scores
 * the numbers; this describes how much they can be trusted.
 */
export interface ReadingProvenance {
  at: string;
  fields: Record<MeasurementField, FieldProvenance>;
  /** The worst quality across every field - the headline for the UI. */
  worstQuality: DataQuality;
  /** Fields with no sensor behind them, estimated from the environment model. */
  estimatedFields: MeasurementField[];
  /** Fields that are held, stale or offline. */
  degradedFields: MeasurementField[];
  anySimulated: boolean;
}

export interface EnvironmentReading {
  id: string;
  userId: string;
  indoorTempC: number;
  indoorHumidityPct: number;
  outdoorTempC: number;
  outdoorHumidityPct: number;
  airQualityIndex: number;
  heatIndex: number;
  simulated: boolean;
  recordedAt: string;
}

export interface WearableReading {
  id: string;
  userId: string;
  heartRateBpm: number;
  skinTempC: number;
  activityStepsPerHour: number;
  simulated: boolean;
  recordedAt: string;
}

/** Generic per-device sensor sample used by /admin/sensors. */
export interface SensorReading {
  id: string;
  deviceId: string;
  userId: string;
  metric: SensorMetric;
  value: number;
  unit: string;
  simulated: boolean;
  recordedAt: string;
}

export type SensorMetric =
  | 'temperature'
  | 'humidity'
  | 'heartRate'
  | 'activity'
  | 'heatIndex'
  | 'airQuality';

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/** A user's learned personal physiological baseline. */
/**
 * How far along a personal baseline is.
 *
 *   LEARNING     too few samples; the platform is using typical ranges for
 *                this age group, NOT this person's own
 *   PROVISIONAL  learned from their own data, but over too short a span to be
 *                confident it captured their normal
 *   READY        enough samples across enough nights
 *
 * The distinction is not cosmetic. The whole clinical premise is that 98 BPM
 * means different things for different people; until the platform has learned
 * what it means for THIS person, saying "above your personal baseline" is a
 * claim it has not earned.
 */
export type BaselineState = 'LEARNING' | 'PROVISIONAL' | 'READY';

export interface PersonalBaseline {
  userId: string;
  heartRate: { min: number; max: number; mean: number };
  skinTemp: { min: number; max: number; mean: number };
  activityStepsPerHour: { min: number; max: number; mean: number };
  /** Number of samples the baseline was learned from. */
  sampleCount: number;
  /**
   * Distinct days the samples span.
   *
   * Twelve samples from one evening are twelve samples from one evening. A
   * resting heart rate varies night to night, and a band drawn from a single
   * one will be too narrow - which produces false deviations later, on the
   * screen a caregiver is meant to trust.
   *
   * Optional for baselines persisted before this was recorded.
   */
  nightsCovered?: number;
  /** Confidence in the baseline, 0..1 - grows with sampleCount. */
  confidence: number;
  learnedAt: string;
}

export interface BaselineEvaluation {
  /** Current heart rate BPM. */
  heartRateBpm: number;
  /** The user's normal range. */
  range: { min: number; max: number };
  /** Percentage above the top of the range (0 when within range). */
  deviationPct: number;
  /** Absolute BPM above the top of the range. */
  deviationBpm: number;
  /** True when heart rate exceeds the personal range. */
  aboveBaseline: boolean;
  /** True when heart rate falls below the personal range. */
  belowBaseline: boolean;
  /** Localised description, e.g. 高於個人平常基準 24%. */
  descriptionZh: string;
  description: string;
  confidence: number;
  /**
   * Whether this comparison is against the person's own learned range.
   *
   * False while the baseline is still LEARNING, when the range comes from
   * typical values for the age group. The evaluation is still useful - it is
   * what any system would do on day one - but it must not be described as
   * personal, because it is not.
   */
  personal: boolean;
  state: BaselineState;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';

export interface ElderlyUser {
  id: string;
  name: string;
  nameEn: string;
  age: number;
  gender: 'M' | 'F' | 'OTHER';
  /** District plus city, e.g. 台北市 大安區. */
  location: string;
  district: string;
  city: string;
  lat: number;
  lng: number;
  phone: string;
  address: string;
  /** Chronic conditions relevant to heat vulnerability. */
  conditions: string[];
  /** Medications that affect thermoregulation. */
  medications: string[];
  status: UserStatus;
  /** Per-user consent switches. */
  permissions: UserPermissions;
  /** Whether the elderly-friendly simplified UI is on by default. */
  elderlyModeDefault: boolean;
  emergencyContact: { name: string; relationship: string; phone: string };
  createdAt: string;
  updatedAt: string;
}

export interface UserPermissions {
  /** User authorises the platform to switch on cooling appliances. */
  automaticCooling: boolean;
  /** User authorises caregiver notifications. */
  caregiverNotifications: boolean;
  /** User shares coarse location for cooling-space recommendations. */
  locationSharing: boolean;
  /** User allows physiological data to be stored for baseline learning. */
  physiologicalDataStorage: boolean;
  /** User allows anonymised contribution to city heat statistics. */
  cityDataContribution: boolean;
}

export type CaregiverRelationship =
  | 'SON'
  | 'DAUGHTER'
  | 'SPOUSE'
  | 'NURSE'
  | 'SOCIAL_WORKER'
  | 'NEIGHBOUR'
  | 'OTHER';

export interface Caregiver {
  id: string;
  name: string;
  nameEn: string;
  relationship: CaregiverRelationship;
  phone: string;
  email: string;
  /** Elderly user ids this caregiver is responsible for. */
  assignedUserIds: string[];
  notificationPreferences: {
    channels: NotificationChannel[];
    /** Minimum risk level that reaches this caregiver. */
    minLevel: RiskLevel;
    quietHours: { enabled: boolean; from: string; to: string };
  };
  /** May trigger emergency escalation. */
  emergencyPermission: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DeviceType =
  | 'SMART_WATCH'
  | 'TEMPERATURE_SENSOR'
  | 'HUMIDITY_SENSOR'
  | 'AIR_QUALITY_SENSOR'
  | 'SMART_AC'
  | 'DEHUMIDIFIER'
  | 'FAN';

export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'DISABLED' | 'LOW_BATTERY';

export interface Device {
  id: string;
  /** Human-readable hardware id, e.g. HG-WATCH-0231. */
  deviceId: string;
  name: string;
  nameZh: string;
  type: DeviceType;
  userId: string;
  status: DeviceStatus;
  /** Battery %, null for mains-powered appliances. */
  batteryPct: number | null;
  /** Signal strength %, 0..100. */
  signalPct: number;
  lastSeen: string;
  firmware: string;
  /** Room placement, e.g. 客廳. */
  location: string;
  /** Appliance power state - only meaningful for actuators. */
  power: boolean;
  /** True for AC / fan / dehumidifier. */
  isActuator: boolean;
  createdAt: string;

  /**
   * First characters of this device's ingest key, or null if it has none.
   *
   * The key itself is never stored or returned - only its hash, server side.
   * This prefix exists so an operator can tell two keys apart without the
   * console ever holding a usable credential.
   */
  ingestKeyPrefix?: string | null;
  ingestKeyIssuedAt?: string | null;
  /**
   * When this device last posted a real reading.
   *
   * Once set, the simulator stops standing in for this device: a real sensor
   * that has gone quiet must read as offline rather than be replaced by
   * invented data that looks just as plausible.
   */
  lastIngestAt?: string | null;
}

/** Live smart-home state derived from actuator devices. */
export interface SmartHomeState {
  userId: string;
  ac: SmartHomeAppliance;
  fan: SmartHomeAppliance;
  dehumidifier: SmartHomeAppliance;
  indoorTempC: number;
  indoorHumidityPct: number;
  targetTempC: number;
  /** True when the platform engaged cooling automatically. */
  automaticallyEngaged: boolean;
  /** Why automation did or did not act - surfaced in the UI. */
  automationNote: string;
  automationNoteZh: string;
  /** The user cancelled automation for this episode. */
  userOverride: boolean;
}

export interface SmartHomeAppliance {
  present: boolean;
  on: boolean;
  deviceId: string | null;
  disabled: boolean;
}

// ---------------------------------------------------------------------------
// Events, alerts, notifications
// ---------------------------------------------------------------------------

export interface RiskEvent {
  id: string;
  userId: string;
  level: RiskLevel;
  previousLevel: RiskLevel | null;
  score: number;
  heatIndex: number;
  reason: 'ESCALATION' | 'RECOVERY' | 'PERIODIC';
  factors: RiskFactor[];
  explanation: AIExplanation;
  actionsTaken: ActionType[];
  readings: ReadingSnapshot;
  recordedAt: string;
}

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ESCALATED';

export interface Alert {
  id: string;
  userId: string;
  userName: string;
  severity: AlertSeverity;
  level: RiskLevel;
  /** Short trigger summary, e.g. Heat index 40.2C, HR +31% over baseline. */
  trigger: string;
  triggerZh: string;
  status: AlertStatus;
  assignedCaregiverId: string | null;
  assignedCaregiverName: string | null;
  /** Snapshot of the assessment that produced the alert. */
  assessment: RiskAssessment | null;
  actionsTaken: ActionType[];
  timeline: AlertTimelineEntry[];
  createdAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface AlertTimelineEntry {
  at: string;
  label: string;
  labelZh: string;
  actor: string;
  kind: 'TRIGGER' | 'ACTION' | 'NOTIFICATION' | 'STATUS' | 'RECOVERY';
}

export type NotificationChannel = 'PUSH' | 'SMS' | 'EMAIL' | 'IN_APP' | 'VOICE_CALL';

export type NotificationTemplateKey =
  | 'LOW_RISK'
  | 'MEDIUM_RISK'
  | 'HIGH_RISK'
  | 'COOLING_ACTIVATED'
  | 'DEVICE_OFFLINE'
  | 'RISK_RECOVERED';

export interface NotificationTemplate {
  key: NotificationTemplateKey;
  name: string;
  nameZh: string;
  /** Supports {{user}}, {{heatIndex}}, {{level}}, {{hr}}, {{deviation}}, {{indoorTemp}}, {{device}}. */
  title: string;
  titleZh: string;
  body: string;
  bodyZh: string;
  channels: NotificationChannel[];
  enabled: boolean;
  updatedAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  userName: string;
  /** Caregiver who received it, or null for user-facing notifications. */
  recipientId: string | null;
  recipientName: string;
  templateKey: NotificationTemplateKey;
  channel: NotificationChannel;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Places & city data
// ---------------------------------------------------------------------------

export type CoolingSpaceType =
  | 'LIBRARY'
  | 'COMMUNITY_CENTER'
  | 'PUBLIC_BUILDING'
  | 'AIR_CONDITIONED_PUBLIC_SPACE'
  | 'PARK'
  | 'MRT_STATION'
  | 'HEALTH_CENTER';

export interface CoolingSpace {
  id: string;
  name: string;
  nameEn: string;
  type: CoolingSpaceType;
  address: string;
  district: string;
  lat: number;
  lng: number;
  /** Local heat risk at the space itself. */
  riskLevel: RiskLevel;
  airConditioned: boolean;
  /** Wheelchair access, lifts, accessible toilets. */
  accessible: boolean;
  accessibilityNotes: string;
  openingHours: string;
  /** Parsed open/close in 24h local time for open-now computation. */
  opensAt: string;
  closesAt: string;
  contact: string;
  capacity: number;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

/** A cooling space enriched with distance for a specific user. */
export interface CoolingSpaceRecommendation extends CoolingSpace {
  distanceKm: number;
  walkingMinutes: number;
  openNow: boolean;
  /** Ranking score - nearer, cooler, accessible and open scores higher. */
  matchScore: number;
  reasonZh: string;
  reason: string;
}

/** District-level heat risk used by the map and the CMS. */
export interface CityRisk {
  id: string;
  city: string;
  district: string;
  lat: number;
  lng: number;
  temperatureC: number;
  humidityPct: number;
  heatIndex: number;
  riskLevel: RiskLevel;
  /** Population density index 0..100 - proxy for urban heat island. */
  urbanDensity: number;
  /** Green coverage %, inverse contributor to heat. */
  greenCoveragePct: number;
  /** Count of active cooling spaces in the district. */
  coolingSpaceCount: number;
  /** Registered elderly users in this district. */
  elderlyUserCount: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Platform administration
// ---------------------------------------------------------------------------

export type DataSourceStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface DataSource {
  id: string;
  name: string;
  nameZh: string;
  kind: 'WEATHER' | 'SENSOR' | 'WEARABLE' | 'CITY' | 'COOLING_LOCATION';
  provider: string;
  status: DataSourceStatus;
  lastSyncAt: string;
  recordCount: number;
  /** Error rate %, 0..100. */
  errorRatePct: number;
  /** Non-secret configuration shown in the CMS. */
  config: { endpoint: string; intervalSec: number; retries: number };
  enabled: boolean;
}

export type ServiceStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface SystemHealth {
  services: SystemService[];
  uptimeSec: number;
  /** Server-side simulation tick count since boot. */
  tickCount: number;
  version: string;
  checkedAt: string;
}

export interface SystemService {
  key: string;
  name: string;
  nameZh: string;
  status: ServiceStatus;
  latencyMs: number;
  detail: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorRole: Role;
  action: string;
  actionZh: string;
  entity: string;
  entityId: string;
  oldValue: string | null;
  newValue: string | null;
  at: string;
}

export type ContentCategory =
  | 'HEAT_PREVENTION'
  | 'HYDRATION'
  | 'COOLING'
  | 'HEATWAVE_WARNING'
  | 'ELDERLY_SAFETY'
  | 'HIGH_RISK_RESPONSE';

export interface ContentArticle {
  id: string;
  slug: string;
  title: string;
  titleZh: string;
  category: ContentCategory;
  summary: string;
  summaryZh: string;
  body: string;
  bodyZh: string;
  /** Risk levels this article is surfaced for. */
  showForLevels: RiskLevel[];
  published: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface SystemSetting {
  key: string;
  label: string;
  labelZh: string;
  value: string;
  type: 'string' | 'number' | 'boolean';
  group: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Auth & permissions
// ---------------------------------------------------------------------------

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'CAREGIVER' | 'ELDER' | 'VIEWER';

export interface Account {
  id: string;
  email: string;
  name: string;
  nameZh: string;
  role: Role;
  /** Linked elderly user for ELDER accounts. */
  elderlyUserId: string | null;
  /** Linked caregiver record for CAREGIVER accounts. */
  caregiverId: string | null;
  avatarColor: string;
}

export type Permission =
  | 'user:read' | 'user:write' | 'user:suspend'
  | 'caregiver:read' | 'caregiver:write'
  | 'device:read' | 'device:write'
  | 'sensor:read'
  | 'risk-rule:read' | 'risk-rule:write'
  | 'action-rule:read' | 'action-rule:write'
  | 'alert:read' | 'alert:write'
  | 'notification:read' | 'notification:write'
  | 'cooling-space:read' | 'cooling-space:write'
  | 'city-risk:read' | 'city-risk:write'
  | 'content:read' | 'content:write'
  | 'data-source:read' | 'data-source:write'
  | 'system:read' | 'system:write'
  | 'audit:read'
  | 'account:write'
  | 'simulation:control';

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export type ScenarioPhase = 'NORMAL' | 'HEAT_INCREASING' | 'MEDIUM_RISK' | 'HIGH_RISK' | 'RECOVERY';

export type ScenarioName =
  | 'FULL_DEMO'
  | 'HEATWAVE'
  | 'NIGHT_RECOVERY'
  | 'DEVICE_FAILURE'
  /** A sensor stops reporting while the heat rises. */
  | 'SENSOR_OFFLINE'
  /** The wearable drops out, taking the physiological signal with it. */
  | 'WEARABLE_OFFLINE'
  /** Somebody is enrolled with no history, and the baseline is learned. */
  | 'NEW_RESIDENT'
  | 'AMBIENT';

export interface SimulationState {
  running: boolean;
  /** Named scenario currently playing, or null for free-running ambient drift. */
  scenario: ScenarioName | null;
  phase: ScenarioPhase;
  /** 0..1 progress through the current phase. */
  phaseProgress: number;
  /** Seconds elapsed in the scenario. */
  elapsedSec: number;
  /** Tick interval in ms. */
  tickMs: number;
  /** Speed multiplier applied to scenario progression. */
  speed: number;
  /** The user the scenario is focused on. */
  focusUserId: string;
  tickCount: number;
  /** Manual sensor offsets an admin has dialled in. */
  manualOffsets: { tempC: number; humidityPct: number; heartRateBpm: number };
}

// ---------------------------------------------------------------------------
// Aggregates the client subscribes to
// ---------------------------------------------------------------------------

export interface RiskHistoryPoint {
  at: string;
  /** Short display time, HH:mm. */
  label: string;
  score: number;
  level: RiskLevel;
  heatIndex: number;
  indoorTempC: number;
  outdoorTempC: number;
  humidityPct: number;
  heartRateBpm: number;
  baselineMin: number;
  baselineMax: number;
  activityStepsPerHour: number;
  targetTempC: number;
  coolingOn: boolean;
}

export interface PlatformStats {
  activeUsers: number;
  highRiskUsers: number;
  mediumRiskUsers: number;
  lowRiskUsers: number;
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  devicesOnlinePct: number;
  activeAlerts: number;
  newAlerts: number;
  coolingSpaces: number;
  activeCoolingSpaces: number;
  cityRiskLevel: RiskLevel;
  cityHeatIndex: number;
  caregivers: number;
  notificationsToday: number;
}

/** The complete live snapshot pushed over WebSocket on every tick. */
export interface LiveSnapshot {
  at: string;
  /** Assessment per elderly user, keyed by user id. */
  assessments: Record<string, RiskAssessment>;
  smartHome: Record<string, SmartHomeState>;
  simulation: SimulationState;
  /** Rolling history for charts, per user, most recent last. */
  history: Record<string, RiskHistoryPoint[]>;
  /** Counts for the CMS dashboard. */
  stats: PlatformStats;
  cityRisk: CityRisk[];
  /** Newest alerts, most recent first. */
  alerts: Alert[];
  /** Newest notifications, most recent first. */
  notifications: Notification[];
  /** Device status, so the CMS disabling a device shows up everywhere. */
  devices: Device[];
  /** Config version - bumps when the CMS changes rules, so clients refetch. */
  configVersion: number;
}
