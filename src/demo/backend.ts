/**
 * In-browser platform backend for the static (GitHub Pages) build.
 *
 * WHY THIS EXISTS
 * ---------------
 * GitHub Pages serves static files only: no Node process, no WebSocket, no
 * database. The full application runs its risk engine on the server and pushes
 * a snapshot to every client, which is what lets three screens agree. That
 * design cannot run on a static host.
 *
 * WHAT IS AND IS NOT DUPLICATED
 * -----------------------------
 * Every piece of *domain* logic is imported from `shared/` and runs here
 * completely unchanged — the heat index, personal-baseline learning, the risk
 * engine, the policy engine, cooling-space ranking, notification rendering and
 * the simulation. That is the whole point of having kept `shared/` free of I/O.
 *
 * What is reimplemented here is only the *orchestration*: the tick loop, the
 * in-memory stores and the HTTP routing. Those mirror
 * `server/services/platformState.ts` and `server/routes/*`, and the two could
 * in principle drift — so the static build is explicitly a demo artefact, and
 * the Node server remains the reference implementation.
 *
 * KNOWN DIFFERENCES FROM THE FULL STACK
 * -------------------------------------
 *  - State lives in the tab. A refresh restarts the platform from seed.
 *  - Two browsers do not share state, so a CMS change in one is not visible in
 *    the other. Within a single browser every screen still agrees, because
 *    they all read this one store.
 *  - Nothing is persisted. Audit entries, alerts and notifications are real
 *    within the session and gone after it.
 */

import type {
  Account,
  ActionRule,
  Alert,
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
  HouseholdState,
  LiveSnapshot,
  Notification,
  NotificationTemplate,
  PersonalBaseline,
  PlatformStats,
  ReadingProvenance,
  ReadingSnapshot,
  RiskAssessment,
  RiskEvent,
  RiskHistoryPoint,
  RiskLevel,
  RiskRuleConfig,
  SensorReading,
  SimulationState,
  SmartHomeState,
  SystemSetting,
  WearableReading,
} from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';
import { assessRisk } from '@shared/domain/riskEngine';
import {
  decideCooling,
  executedActionTypes,
  getRecommendedActions,
} from '@shared/domain/actionEngine';
import { learnPersonalBaseline } from '@shared/domain/baselineEngine';
import {
  buildTemplateVars,
  renderNotification,
  templateKeyForLevel,
  DEFAULT_NOTIFICATION_TEMPLATES,
} from '@shared/domain/notificationEngine';
import {
  type AmbientProfile,
  initialHousehold,
  initialReading,
  resolvePhase,
  scenarioDurationSec,
  scenarioOfflineDevices,
  tickHousehold,
} from '@shared/domain/simulationEngine';
import { calculateHeatIndex, clamp, round1 } from '@shared/domain/heatIndex';
import { buildProvenance } from '@shared/domain/provenance';
import { cloneDefaultActionRules, cloneDefaultConfig } from '@shared/domain/config';
import {
  mayContributeToCityStats,
  shouldEscalate,
} from '@shared/domain/alertPolicy';

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
} from '@server/db/seedData';

const HISTORY_LIMIT = 180;
const HISTORY_SAMPLES = 144;
const HISTORY_INTERVAL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Runtime shape (mirrors the server's UserRuntime)
// ---------------------------------------------------------------------------

interface UserRuntime {
  user: ElderlyUser;
  baseline: PersonalBaseline;
  profile: AmbientProfile;
  /** The home's physical state, which evolves whether or not it is measured. */
  household: HouseholdState;
  reading: ReadingSnapshot;
  assessment: RiskAssessment;
  smartHome: SmartHomeState;
  history: RiskHistoryPoint[];
  userOverride: boolean;
  lastNotifiedAt: number;
  lastNotifiedLevel: RiskLevel | null;
  openAlertId: string | null;
}

/** Deterministic PRNG, so the demo is reproducible between reloads. */
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

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${(idCounter++).toString(36)}-${Date.now().toString(36)}`;

const shortTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function inQuietHours(quiet: { from: string; to: string }): boolean {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const parse = (v: string) => {
    const [h, m] = v.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const from = parse(quiet.from);
  const to = parse(quiet.to);
  return to <= from ? minutes >= from || minutes < to : minutes >= from && minutes < to;
}

// ---------------------------------------------------------------------------

export class DemoBackend {
  // --- persisted-equivalent stores -----------------------------------------
  accounts: Account[] = [];
  users: ElderlyUser[] = [];
  caregivers: Caregiver[] = [];
  devices: Device[] = [];
  coolingSpaces: CoolingSpace[] = [];
  cityRisk: CityRisk[] = [];
  content: ContentArticle[] = [];
  dataSources: DataSource[] = [];
  settings: SystemSetting[] = [];
  templates: NotificationTemplate[] = [];
  actionRules: ActionRule[] = [];
  config: RiskRuleConfig = cloneDefaultConfig();
  configVersion = 1;

  alerts: Alert[] = [];
  notifications: Notification[] = [];
  auditLog: AuditLogEntry[] = [];
  riskEvents: RiskEvent[] = [];

  environmentHistory = new Map<string, EnvironmentReading[]>();
  wearableHistory = new Map<string, WearableReading[]>();
  sensorHistory = new Map<string, SensorReading[]>();

  // --- live state -----------------------------------------------------------
  runtimes = new Map<string, UserRuntime>();
  private cityRiskBase = new Map<string, { temperatureC: number; humidityPct: number }>();

  simulation: SimulationState = {
    running: true,
    scenario: 'AMBIENT',
    phase: 'NORMAL',
    phaseProgress: 0,
    elapsedSec: 0,
    tickMs: 2000,
    speed: 1,
    focusUserId: 'user-001',
    tickCount: 0,
    manualOffsets: { tempC: 0, humidityPct: 0, heartRateBpm: 0 },
  };

  /** Devices this loop took offline for a scenario, and may give back. */
  private scenarioDowned = new Set<string>();

  private initialised = false;
  private listeners = new Set<(snapshot: LiveSnapshot) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootedAt = Date.now();

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Idempotent boot.
   *
   * Called from both the live store and the fetch shim, because the login
   * screen queries the account list before anything has "connected" — without
   * this the first request would hit an empty store.
   */
  ensureInitialised(): void {
    if (this.initialised) return;
    this.initialised = true;
    this.initialise();
  }

  initialise(): void {
    this.accounts = ACCOUNT_SEEDS.map((a) => ({ ...a }));
    this.config = cloneDefaultConfig();
    this.actionRules = cloneDefaultActionRules();
    this.templates = DEFAULT_NOTIFICATION_TEMPLATES.map((t) => ({ ...t }));
    this.settings = SETTING_SEEDS.map((s) => ({ ...s }));
    this.dataSources = DATA_SOURCE_SEEDS.map((s) => ({ ...s }));

    this.content = CONTENT_SEEDS.map((a) => ({ ...a, updatedAt: new Date().toISOString() }));

    this.coolingSpaces = coolingSpaceSeeds().map((s) => ({
      ...s,
      createdAt: new Date().toISOString(),
    }));

    // --- residents, devices and learned baselines --------------------------
    for (const spec of USER_SPECS) {
      const base = elderlyUserFor(spec);
      const now = new Date().toISOString();

      const user: ElderlyUser = {
        ...base,
        location: `${base.city} ${base.district}`,
        createdAt: now,
        updatedAt: now,
      };
      this.users.push(user);

      for (const device of devicesFor(spec)) {
        this.devices.push({ ...device, createdAt: now });
      }

      const profile = ambientProfileFor(spec);
      const seeded = baselineFor(spec);
      const { env, wear } = this.generateHistory(spec, profile, seeded);

      this.environmentHistory.set(user.id, env);
      this.wearableHistory.set(user.id, wear);

      // Learn the baseline from the generated resting samples, exactly as the
      // server seed does — the same function, the same filtering.
      const resting = wear.filter((r) => {
        const hour = new Date(r.recordedAt).getHours();
        return hour >= 22 || hour <= 6;
      });

      const baseline = learnPersonalBaseline(
        user.id,
        resting.length >= 12 ? resting : wear,
        seeded,
      );

      const reading = initialReading(profile, baseline);
      const smartHome = this.deriveSmartHome(user.id, reading);
      const history = this.buildHistory(env, wear, baseline);

      const assessment = this.evaluate({
        user,
        baseline,
        reading,
        history,
        previousLevel: null,
      });

      this.runtimes.set(user.id, {
        user,
        baseline,
        profile,
        household: initialHousehold(profile, baseline),
        reading,
        assessment,
        smartHome,
        history,
        userOverride: false,
        lastNotifiedAt: 0,
        lastNotifiedLevel: null,
        openAlertId: null,
      });
    }

    // --- caregivers ---------------------------------------------------------
    this.caregivers = CAREGIVER_SEEDS.map((c) => ({
      ...c,
      assignedUserIds: [...c.assignedUserIds],
      createdAt: new Date().toISOString(),
    }));

    const assigned = new Set(this.caregivers.flatMap((c) => c.assignedUserIds));
    const rotation = ['cg-001', 'cg-002', 'cg-003', 'cg-004'];
    let i = 0;
    for (const user of this.users) {
      if (user.status !== 'ACTIVE' || assigned.has(user.id)) continue;
      const cg = this.caregivers.find((c) => c.id === rotation[i % rotation.length]);
      if (cg) cg.assignedUserIds.push(user.id);
      i++;
    }

    this.buildCityRisk();

    this.auditLog.push({
      id: nextId('audit'),
      actorId: 'system',
      actorName: 'System',
      actorRole: 'SUPER_ADMIN',
      action: 'Seeded platform data',
      actionZh: '初始化平台資料',
      entity: 'System',
      entityId: 'seed',
      oldValue: null,
      newValue: `${this.users.length} users, ${this.coolingSpaces.length} cooling spaces`,
      at: new Date().toISOString(),
    });

    this.establishBaselineAlerts();
  }

  /** 72 hours of history, mirroring the server seed. */
  private generateHistory(
    spec: (typeof USER_SPECS)[number],
    profile: AmbientProfile,
    seeded: PersonalBaseline,
  ): { env: EnvironmentReading[]; wear: WearableReading[] } {
    const rng = makeRng(hash(spec.id));
    const now = Date.now();
    const env: EnvironmentReading[] = [];
    const wear: WearableReading[] = [];

    for (let i = HISTORY_SAMPLES; i > 0; i--) {
      const at = new Date(now - i * HISTORY_INTERVAL_MS);
      const hour = at.getHours();
      const diurnal = Math.sin(((hour - 5) / 24) * Math.PI * 2) * 3.2;

      const outdoorTempC = round1(profile.baseOutdoorTempC + diurnal + (rng() - 0.5) * 0.8);
      const indoorTempC = round1(profile.baseIndoorTempC + diurnal * 0.55 + (rng() - 0.5) * 0.5);
      const indoorHumidityPct = round1(
        clamp(profile.baseIndoorHumidityPct - diurnal * 1.2 + (rng() - 0.5) * 3, 30, 98),
      );
      const outdoorHumidityPct = round1(clamp(indoorHumidityPct + 5 + (rng() - 0.5) * 3, 30, 99));
      const airQualityIndex = Math.round(
        clamp(profile.baseAirQualityIndex + (rng() - 0.5) * 12, 10, 300),
      );

      env.push({
        id: `env-${spec.id}-${i}`,
        userId: spec.id,
        indoorTempC,
        indoorHumidityPct,
        outdoorTempC,
        outdoorHumidityPct,
        airQualityIndex,
        heatIndex: calculateHeatIndex(indoorTempC, indoorHumidityPct),
        simulated: true,
        recordedAt: at.toISOString(),
      });

      const band = seeded.heartRate.max - seeded.heartRate.min;
      const isResting = hour >= 22 || hour <= 6;

      const restingPosition = isResting
        ? clamp(0.5 + (rng() - 0.5) * 1.05, 0.02, 0.98)
        : clamp(spec.hrPosition + (rng() - 0.5) * 0.4, 0.02, 2.2);

      const thermal = Math.max(0, indoorTempC - 27) * (isResting ? 0.4 : 1.4);

      wear.push({
        id: `wear-${spec.id}-${i}`,
        userId: spec.id,
        heartRateBpm: Math.round(
          clamp(seeded.heartRate.min + band * restingPosition + thermal, 45, 175),
        ),
        skinTempC: round1(32.9 + Math.max(0, indoorTempC - 24) * 0.12 + (rng() - 0.5) * 0.2),
        activityStepsPerHour: Math.round(
          clamp(
            (hour >= 7 && hour <= 21 ? seeded.activityStepsPerHour.mean : 20) * (0.6 + rng() * 0.8),
            0,
            1500,
          ),
        ),
        simulated: true,
        recordedAt: at.toISOString(),
      });
    }

    return { env, wear };
  }

  private buildHistory(
    env: EnvironmentReading[],
    wear: WearableReading[],
    baseline: PersonalBaseline,
  ): RiskHistoryPoint[] {
    const recent = env.slice(-60);
    const recentWear = wear.slice(-60);

    return recent.map((e, i) => {
      const w = recentWear[i] ?? recentWear[recentWear.length - 1];
      const level: RiskLevel =
        e.heatIndex >= this.config.thresholds.high
          ? 'HIGH'
          : e.heatIndex >= this.config.thresholds.medium
            ? 'MEDIUM'
            : 'LOW';

      return {
        at: e.recordedAt,
        label: shortTime(e.recordedAt),
        score: Math.round(
          clamp(
            ((e.heatIndex - this.config.thresholds.low) /
              Math.max(1, this.config.thresholds.high - this.config.thresholds.low)) *
              100,
            0,
            100,
          ),
        ),
        level,
        heatIndex: e.heatIndex,
        indoorTempC: e.indoorTempC,
        outdoorTempC: e.outdoorTempC,
        humidityPct: e.indoorHumidityPct,
        heartRateBpm: w?.heartRateBpm ?? baseline.heartRate.mean,
        baselineMin: baseline.heartRate.min,
        baselineMax: baseline.heartRate.max,
        activityStepsPerHour: w?.activityStepsPerHour ?? baseline.activityStepsPerHour.mean,
        targetTempC: this.config.smartHomePolicy.targetIndoorTempC,
        coolingOn: false,
      };
    });
  }

  private buildCityRisk(): void {
    this.cityRisk = TAIPEI_DISTRICTS.map((district) => {
      const temperatureC = round1(
        30.5 + (district.urbanDensity / 100) * 3.4 - (district.greenCoveragePct / 100) * 2.6,
      );
      const humidityPct = round1(clamp(72 - district.greenCoveragePct * 0.08, 55, 88));
      const heatIndex = calculateHeatIndex(temperatureC, humidityPct);

      const riskLevel: RiskLevel =
        heatIndex >= this.config.thresholds.high
          ? 'HIGH'
          : heatIndex >= this.config.thresholds.medium
            ? 'MEDIUM'
            : 'LOW';

      const id = `city-taipei-${district.nameEn.toLowerCase().replace(/[^a-z]/g, '')}`;
      this.cityRiskBase.set(id, { temperatureC, humidityPct });

      return {
        id,
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
        coolingSpaceCount: this.coolingSpaces.filter(
          (s) => s.district === district.name && s.status === 'ACTIVE',
        ).length,
        // Only residents who consented to contribute to city statistics.
        elderlyUserCount: this.users.filter(
          (u) => u.district === district.name && mayContributeToCityStats(u),
        ).length,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private establishBaselineAlerts(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.user.status !== 'ACTIVE') continue;
      if (RISK_ORDER[runtime.assessment.level] < RISK_ORDER.MEDIUM) continue;
      this.raiseAlert(runtime, runtime.assessment, executedActionTypes(runtime.assessment.actions));
      this.emitNotification(runtime, templateKeyForLevel(runtime.assessment.level), runtime.assessment);
    }
  }

  // -------------------------------------------------------------------------
  // Derivation — mirrors platformState
  // -------------------------------------------------------------------------

  private deriveSmartHome(userId: string, reading: ReadingSnapshot): SmartHomeState {
    const userDevices = this.devices.filter((d) => d.userId === userId);
    const existing = this.runtimes.get(userId)?.smartHome;

    const applianceFor = (type: Device['type']) => {
      const device = userDevices.find((d) => d.type === type);
      return {
        present: Boolean(device),
        on: device ? device.power && device.status !== 'DISABLED' && device.status !== 'OFFLINE' : false,
        deviceId: device?.id ?? null,
        disabled: device ? device.status === 'DISABLED' || device.status === 'OFFLINE' : false,
      };
    };

    return {
      userId,
      ac: applianceFor('SMART_AC'),
      fan: applianceFor('FAN'),
      dehumidifier: applianceFor('DEHUMIDIFIER'),
      indoorTempC: reading.indoorTempC,
      indoorHumidityPct: reading.indoorHumidityPct,
      targetTempC: this.config.smartHomePolicy.targetIndoorTempC,
      automaticallyEngaged: existing?.automaticallyEngaged ?? false,
      automationNote: existing?.automationNote ?? '',
      automationNoteZh: existing?.automationNoteZh ?? '',
      userOverride: existing?.userOverride ?? false,
    };
  }

  private evaluate(args: {
    user: ElderlyUser;
    baseline: PersonalBaseline;
    reading: ReadingSnapshot;
    history: RiskHistoryPoint[];
    previousLevel: RiskLevel | null;
    /** From the assembler, when this reading came from one. */
    provenance?: ReadingProvenance;
  }): RiskAssessment {
    const { user, baseline, reading, history, previousLevel } = args;

    const userDevices = this.devices.filter((d) => d.userId === user.id);

    // Prefer the assembler's answer; fall back to device status for readings
    // that did not come from a tick (boot, and a paused simulation).
    const provenance =
      args.provenance ??
      buildProvenance({
        reading,
        devices: userDevices,
        simulated: reading.simulated,
      });

    const core = assessRisk({
      userId: user.id,
      reading,
      baseline,
      config: this.config,
      history,
      previousLevel,
      provenance,
    });
    const caregivers = this.caregivers.filter(
      (c) => c.status === 'ACTIVE' && c.assignedUserIds.includes(user.id),
    );

    const actions = getRecommendedActions({
      assessment: core,
      config: this.config,
      rules: this.actionRules,
      user,
      devices: userDevices,
      userOverride: this.runtimes.get(user.id)?.userOverride ?? false,
      coolingSpaceCount: this.coolingSpaces.filter((s) => s.status === 'ACTIVE').length,
      hasCaregiver: caregivers.length > 0,
    });

    return { ...core, actions };
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.simulation.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.simulation.tickCount++;

    if (this.simulation.running && this.simulation.scenario && this.simulation.scenario !== 'AMBIENT') {
      this.simulation.elapsedSec += (this.simulation.tickMs / 1000) * this.simulation.speed;
      const total = scenarioDurationSec(this.simulation.scenario);
      const { spec, progress, finished } = resolvePhase(
        this.simulation.scenario,
        this.simulation.elapsedSec,
      );
      this.simulation.phase = spec.phase;
      this.simulation.phaseProgress = progress;

      if (finished && this.simulation.elapsedSec > total + 4) {
        this.simulation.scenario = 'AMBIENT';
        this.simulation.elapsedSec = 0;
        this.simulation.phase = 'NORMAL';
        this.simulation.phaseProgress = 0;
      }
    }

    for (const runtime of this.runtimes.values()) {
      // Same rule as the server: no risk evaluation for an unmonitored
      // resident, but their data age is still reported truthfully.
      if (runtime.user.status !== 'ACTIVE') {
        runtime.assessment = {
          ...runtime.assessment,
          provenance: buildProvenance({
            reading: runtime.reading,
            devices: this.devices.filter((d) => d.userId === runtime.user.id),
            simulated: runtime.reading.simulated,
            monitored: false,
          }),
        };
        continue;
      }

      const isFocus = runtime.user.id === this.simulation.focusUserId;

      // Physics, then measurement - the same two steps as the server.
      const ticked = this.simulation.running
        ? tickHousehold({
            userId: runtime.user.id,
            profile: runtime.profile,
            baseline: runtime.baseline,
            previous: runtime.reading,
            previousProvenance: runtime.assessment.provenance,
            household: runtime.household,
            smartHome: runtime.smartHome,
            devices: this.devices.filter((d) => d.userId === runtime.user.id),
            simulation: this.simulation,
            isFocus,
          })
        : null;

      const reading = ticked
        ? ticked.reading
        : { ...runtime.reading, timestamp: new Date().toISOString() };

      if (ticked) runtime.household = ticked.household;
      runtime.reading = reading;

      const previousLevel = runtime.assessment.level;
      runtime.smartHome = this.deriveSmartHome(runtime.user.id, reading);

      const assessment = this.evaluate({
        user: runtime.user,
        baseline: runtime.baseline,
        reading,
        history: runtime.history,
        previousLevel,
        provenance: ticked?.provenance,
      });

      runtime.assessment = assessment;
      this.applyCooling(runtime, assessment);

      runtime.history.push({
        at: reading.timestamp,
        label: shortTime(reading.timestamp),
        score: assessment.score,
        level: assessment.level,
        heatIndex: assessment.heatIndex,
        indoorTempC: reading.indoorTempC,
        outdoorTempC: reading.outdoorTempC,
        humidityPct: reading.indoorHumidityPct,
        heartRateBpm: reading.heartRateBpm,
        baselineMin: runtime.baseline.heartRate.min,
        baselineMax: runtime.baseline.heartRate.max,
        activityStepsPerHour: reading.activityStepsPerHour,
        targetTempC: runtime.smartHome.targetTempC,
        coolingOn: runtime.smartHome.ac.on || runtime.smartHome.dehumidifier.on,
      });
      if (runtime.history.length > HISTORY_LIMIT) runtime.history.shift();

      if (assessment.escalated || assessment.recovered) {
        this.handleTransition(runtime, assessment);
      }
    }

    this.applyScenarioDeviceEffects();
    this.touchReportingDevices();
    this.escalateUnacknowledgedAlerts();
    this.updateCityRisk();
    this.broadcast();
  }

  /**
   * Escalate HIGH alerts nobody has acknowledged, using the same shared policy
   * as the server so the two backends cannot disagree about when an
   * unanswered emergency gets chased.
   */
  /**
   * Mirror of the server's scenario device effects.
   *
   * The scenario names a device type; everything after that - held values,
   * provenance, the risk the engine can still compute - is ordinary behaviour
   * rather than a script.
   */
  private applyScenarioDeviceEffects(): void {
    const focusId = this.simulation.focusUserId;
    if (!focusId) return;

    const wanted = new Set(
      this.simulation.running
        ? scenarioOfflineDevices(this.simulation.scenario, this.simulation.elapsedSec)
        : [],
    );

    for (const device of this.devices) {
      if (device.userId !== focusId || device.isActuator) continue;

      const shouldBeDown = wanted.has(device.type);

      if (shouldBeDown && device.status === 'ONLINE') {
        device.status = 'OFFLINE';
        this.scenarioDowned.add(device.id);
      } else if (!shouldBeDown && this.scenarioDowned.has(device.id)) {
        device.status = 'ONLINE';
        device.lastSeen = new Date().toISOString();
        this.scenarioDowned.delete(device.id);
      }
    }
  }

  /**
   * Mirror of the server's device heartbeat: an online sensor that just
   * reported was, in fact, just seen. The age of a held value is measured
   * against this, so leaving it at its seeded value would make a sensor that
   * dropped out moments ago look a day stale.
   */
  private touchReportingDevices(): void {
    const now = new Date().toISOString();
    const monitored = new Set(
      [...this.runtimes.values()]
        .filter((r) => r.user.status === 'ACTIVE')
        .map((r) => r.user.id),
    );

    for (const device of this.devices) {
      if (device.isActuator || device.status !== 'ONLINE') continue;
      if (!monitored.has(device.userId)) continue;
      device.lastSeen = now;
    }
  }

  private escalateUnacknowledgedAlerts(): void {
    const now = new Date();

    for (const alert of this.alerts) {
      const decision = shouldEscalate(alert, this.config, now);
      if (!decision.escalate) continue;

      const runtime = this.runtimes.get(alert.userId);
      const contact = runtime?.user.emergencyContact;

      alert.status = 'ESCALATED';
      alert.timeline = [
        ...alert.timeline,
        {
          at: now.toISOString(),
          label: `No acknowledgement after ${decision.ageMinutes} minutes - escalated to emergency contact${
            contact ? ` (${contact.name}, ${contact.phone})` : ''
          }`,
          labelZh: `超過 ${decision.ageMinutes} 分鐘未有人確認，已升級並通知緊急聯絡人${
            contact ? `（${contact.name}，${contact.phone}）` : ''
          }`,
          actor: 'Escalation Policy',
          kind: 'STATUS',
        },
      ];
    }
  }

  private applyCooling(runtime: UserRuntime, assessment: RiskAssessment): void {
    const userDevices = this.devices.filter((d) => d.userId === runtime.user.id);

    const decision = decideCooling({
      level: assessment.level,
      config: this.config,
      user: runtime.user,
      devices: userDevices,
      userOverride: runtime.userOverride,
    });

    runtime.smartHome.automationNote = decision.reason;
    runtime.smartHome.automationNoteZh = decision.reasonZh;
    runtime.smartHome.userOverride = runtime.userOverride;

    const shouldCool = decision.allowed;
    const shouldDehumidify =
      shouldCool && assessment.readings.indoorHumidityPct > this.config.environment.humidityConcernPct;

    const targets: { type: Device['type']; on: boolean }[] = [
      { type: 'SMART_AC', on: shouldCool },
      { type: 'DEHUMIDIFIER', on: shouldDehumidify },
      {
        type: 'FAN',
        on:
          shouldCool &&
          !userDevices.some(
            (d) => d.type === 'SMART_AC' && d.status !== 'DISABLED' && d.status !== 'OFFLINE',
          ),
      },
    ];

    for (const target of targets) {
      const device = userDevices.find((d) => d.type === target.type);
      if (!device) continue;
      if (device.status === 'DISABLED' || device.status === 'OFFLINE') continue;
      if (device.power === target.on) continue;

      device.power = target.on;
      device.lastSeen = new Date().toISOString();

      if (target.on && target.type === 'SMART_AC') {
        this.emitNotification(runtime, 'COOLING_ACTIVATED', assessment, device.nameZh);
      }
    }

    const engaged = targets.some((t) => {
      const device = userDevices.find((d) => d.type === t.type);
      return device ? device.power : false;
    });

    runtime.smartHome = {
      ...this.deriveSmartHome(runtime.user.id, runtime.reading),
      automaticallyEngaged: engaged && shouldCool,
      automationNote: decision.reason,
      automationNoteZh: decision.reasonZh,
      userOverride: runtime.userOverride,
    };

    if (assessment.level === 'LOW' && runtime.userOverride) runtime.userOverride = false;
  }

  private handleTransition(runtime: UserRuntime, assessment: RiskAssessment): void {
    const executed = executedActionTypes(assessment.actions);

    this.riskEvents.unshift({
      id: nextId('evt'),
      userId: runtime.user.id,
      level: assessment.level,
      previousLevel: assessment.previousLevel,
      score: assessment.score,
      heatIndex: assessment.heatIndex,
      reason: assessment.escalated ? 'ESCALATION' : 'RECOVERY',
      factors: assessment.factors,
      explanation: assessment.explanation,
      actionsTaken: executed,
      readings: assessment.readings,
      recordedAt: assessment.timestamp,
    });
    this.riskEvents = this.riskEvents.slice(0, 400);

    if (assessment.escalated && RISK_ORDER[assessment.level] >= RISK_ORDER.MEDIUM) {
      this.raiseAlert(runtime, assessment, executed);
    }
    if (assessment.recovered) this.resolveAlertIfRecovered(runtime, assessment);

    this.emitNotification(
      runtime,
      assessment.recovered && assessment.level === 'LOW'
        ? 'RISK_RECOVERED'
        : templateKeyForLevel(assessment.level),
      assessment,
    );
  }

  private raiseAlert(
    runtime: UserRuntime,
    assessment: RiskAssessment,
    executed: RiskEvent['actionsTaken'],
  ): void {
    const caregiver = this.caregivers.find(
      (c) => c.status === 'ACTIVE' && c.assignedUserIds.includes(runtime.user.id),
    );

    const timeline: AlertTimelineEntry[] = [
      {
        at: assessment.timestamp,
        label: `Risk escalated ${assessment.previousLevel ?? 'LOW'} to ${assessment.level}`,
        labelZh: `風險由 ${assessment.previousLevel ?? 'LOW'} 升至 ${assessment.level}`,
        actor: 'Risk Engine',
        kind: 'TRIGGER',
      },
      ...executed.map((action) => ({
        at: assessment.timestamp,
        label: `Action executed: ${action}`,
        labelZh: `已執行動作：${action}`,
        actor: 'Policy Engine',
        kind: 'ACTION' as const,
      })),
    ];

    const existing = runtime.openAlertId
      ? this.alerts.find((a) => a.id === runtime.openAlertId && a.status !== 'RESOLVED')
      : undefined;

    if (existing) {
      existing.status = existing.status === 'NEW' ? 'NEW' : 'ESCALATED';
      existing.actionsTaken = Array.from(new Set([...existing.actionsTaken, ...executed]));
      existing.timeline = [...existing.timeline, ...timeline];
      return;
    }

    const alert: Alert = {
      id: nextId('alert'),
      userId: runtime.user.id,
      userName: runtime.user.name,
      severity: assessment.level === 'HIGH' ? 'CRITICAL' : 'WARNING',
      level: assessment.level,
      trigger: `Heat index ${assessment.heatIndex}C, HR ${assessment.baseline.heartRateBpm} BPM (${assessment.baseline.deviationPct}% over baseline)`,
      triggerZh: `熱指數 ${assessment.heatIndex}°C、心率 ${assessment.baseline.heartRateBpm} BPM（高於基準 ${assessment.baseline.deviationPct}%）`,
      status: 'NEW',
      assignedCaregiverId: caregiver?.id ?? null,
      assignedCaregiverName: caregiver?.name ?? null,
      assessment,
      actionsTaken: executed,
      timeline,
      createdAt: assessment.timestamp,
      acknowledgedAt: null,
      resolvedAt: null,
    };

    runtime.openAlertId = alert.id;
    this.alerts = [alert, ...this.alerts].slice(0, 150);
  }

  private resolveAlertIfRecovered(runtime: UserRuntime, assessment: RiskAssessment): void {
    if (assessment.level !== 'LOW' || !runtime.openAlertId) return;
    const open = this.alerts.find((a) => a.id === runtime.openAlertId);
    if (!open || open.status === 'RESOLVED') return;

    open.status = 'RESOLVED';
    open.resolvedAt = assessment.timestamp;
    open.timeline = [
      ...open.timeline,
      {
        at: assessment.timestamp,
        label: `Risk returned to LOW (heat index ${assessment.heatIndex}C)`,
        labelZh: `風險已回到低風險（熱指數 ${assessment.heatIndex}°C）`,
        actor: 'Risk Engine',
        kind: 'RECOVERY',
      },
    ];
    runtime.openAlertId = null;
  }

  emitNotification(
    runtime: UserRuntime,
    templateKey: NotificationTemplate['key'],
    assessment: RiskAssessment,
    deviceName?: string,
  ): boolean {
    const template = this.templates.find((t) => t.key === templateKey);
    const vars = buildTemplateVars({ userName: runtime.user.name, assessment, deviceName });
    const rendered = renderNotification(template, vars);
    if (!rendered) return false;
    if (!runtime.user.permissions.caregiverNotifications) return false;

    const isRisk =
      templateKey === 'LOW_RISK' || templateKey === 'MEDIUM_RISK' || templateKey === 'HIGH_RISK';

    if (
      isRisk &&
      RISK_ORDER[assessment.level] < RISK_ORDER[this.config.notificationPolicy.minLevelForCaregiver]
    ) {
      return false;
    }

    const now = Date.now();
    const withinCooldown =
      now - runtime.lastNotifiedAt < this.config.notificationPolicy.cooldownMinutes * 60_000;
    if (isRisk && withinCooldown && runtime.lastNotifiedLevel === assessment.level) return false;

    const recipients = this.caregivers.filter(
      (c) => c.status === 'ACTIVE' && c.assignedUserIds.includes(runtime.user.id),
    );

    let sent = false;

    for (const caregiver of recipients) {
      if (isRisk && RISK_ORDER[assessment.level] < RISK_ORDER[caregiver.notificationPreferences.minLevel]) {
        continue;
      }
      if (
        caregiver.notificationPreferences.quietHours.enabled &&
        assessment.level !== 'HIGH' &&
        inQuietHours(caregiver.notificationPreferences.quietHours)
      ) {
        continue;
      }

      const channels = rendered.channels.filter((c) =>
        caregiver.notificationPreferences.channels.includes(c),
      );

      const notification: Notification = {
        id: nextId('notif'),
        userId: runtime.user.id,
        userName: runtime.user.name,
        recipientId: caregiver.id,
        recipientName: caregiver.name,
        templateKey,
        channel: channels[0] ?? rendered.channels[0],
        title: rendered.titleZh,
        body: rendered.bodyZh,
        read: false,
        createdAt: new Date().toISOString(),
      };

      this.notifications = [notification, ...this.notifications].slice(0, 150);
      sent = true;

      if (runtime.openAlertId) {
        const open = this.alerts.find((a) => a.id === runtime.openAlertId);
        if (open) {
          open.timeline = [
            ...open.timeline,
            {
              at: notification.createdAt,
              label: `Notified ${caregiver.name} via ${notification.channel}`,
              labelZh: `已透過 ${notification.channel} 通知 ${caregiver.name}`,
              actor: 'Notification Service',
              kind: 'NOTIFICATION',
            },
          ];
        }
      }
    }

    if (isRisk && sent) {
      runtime.lastNotifiedAt = now;
      runtime.lastNotifiedLevel = assessment.level;
    }

    return sent;
  }

  private updateCityRisk(): void {
    const focus = this.runtimes.get(this.simulation.focusUserId);
    const focusDistrict = focus?.user.district;

    const forcing =
      focus && this.simulation.scenario && this.simulation.scenario !== 'AMBIENT'
        ? focus.reading.outdoorTempC - focus.profile.baseOutdoorTempC
        : 0;

    this.cityRisk = this.cityRisk.map((district) => {
      const base = this.cityRiskBase.get(district.id);
      if (!base) return district;

      const localForcing = district.district === focusDistrict ? forcing : forcing * 0.45;
      const temperatureC = round1(base.temperatureC + localForcing);
      const humidityPct = round1(clamp(base.humidityPct + localForcing * 0.9, 40, 96));
      const heatIndex = calculateHeatIndex(temperatureC, humidityPct);

      const riskLevel: RiskLevel =
        heatIndex >= this.config.thresholds.high
          ? 'HIGH'
          : heatIndex >= this.config.thresholds.medium
            ? 'MEDIUM'
            : 'LOW';

      return { ...district, temperatureC, humidityPct, heatIndex, riskLevel };
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot & subscription
  // -------------------------------------------------------------------------

  buildSnapshot(): LiveSnapshot {
    const assessments: Record<string, RiskAssessment> = {};
    const smartHome: Record<string, SmartHomeState> = {};
    const history: Record<string, RiskHistoryPoint[]> = {};

    for (const [id, runtime] of this.runtimes) {
      assessments[id] = runtime.assessment;
      smartHome[id] = runtime.smartHome;
      history[id] = runtime.history;
    }

    return {
      at: new Date().toISOString(),
      assessments,
      smartHome,
      simulation: { ...this.simulation },
      history,
      stats: this.buildStats(),
      cityRisk: this.cityRisk,
      alerts: this.alerts.slice(0, 60),
      notifications: this.notifications.slice(0, 60),
      devices: this.devices,
      configVersion: this.configVersion,
    };
  }

  buildStats(): PlatformStats {
    const active = [...this.runtimes.values()].filter((r) => r.user.status === 'ACTIVE');
    const byLevel = (level: RiskLevel) => active.filter((r) => r.assessment.level === level).length;

    const onlineDevices = this.devices.filter(
      (d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY',
    ).length;

    const worst = this.cityRisk.reduce<RiskLevel>(
      (acc, d) => (RISK_ORDER[d.riskLevel] > RISK_ORDER[acc] ? d.riskLevel : acc),
      'LOW',
    );

    const activeSpaces = this.coolingSpaces.filter((s) => s.status === 'ACTIVE').length;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    return {
      activeUsers: active.length,
      highRiskUsers: byLevel('HIGH'),
      mediumRiskUsers: byLevel('MEDIUM'),
      lowRiskUsers: byLevel('LOW'),
      totalDevices: this.devices.length,
      onlineDevices,
      offlineDevices: this.devices.length - onlineDevices,
      devicesOnlinePct: this.devices.length
        ? Math.round((onlineDevices / this.devices.length) * 100)
        : 0,
      activeAlerts: this.alerts.filter((a) => a.status !== 'RESOLVED').length,
      newAlerts: this.alerts.filter((a) => a.status === 'NEW').length,
      coolingSpaces: activeSpaces,
      activeCoolingSpaces: activeSpaces,
      cityRiskLevel: worst,
      cityHeatIndex: this.cityRisk.length
        ? round1(this.cityRisk.reduce((s, d) => s + d.heatIndex, 0) / this.cityRisk.length)
        : 0,
      caregivers: this.caregivers.filter((c) => c.status === 'ACTIVE').length,
      notificationsToday: this.notifications.filter((n) => new Date(n.createdAt) >= startOfDay)
        .length,
    };
  }

  subscribe(listener: (snapshot: LiveSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.buildSnapshot());
    return () => this.listeners.delete(listener);
  }

  broadcast(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  // -------------------------------------------------------------------------
  // Helpers used by the route layer
  // -------------------------------------------------------------------------

  /** Re-evaluate everyone immediately after a configuration change. */
  reloadConfig(): void {
    this.configVersion++;
    for (const runtime of this.runtimes.values()) {
      runtime.smartHome = this.deriveSmartHome(runtime.user.id, runtime.reading);
      runtime.assessment = this.evaluate({
        user: runtime.user,
        baseline: runtime.baseline,
        reading: runtime.reading,
        history: runtime.history,
        previousLevel: runtime.assessment.level,
      });
    }
    this.updateCityRisk();
    this.broadcast();
  }

  refreshRuntimeUsers(): void {
    for (const runtime of this.runtimes.values()) {
      const user = this.users.find((u) => u.id === runtime.user.id);
      if (user) runtime.user = user;
    }
    this.reloadConfig();
  }

  audit(entry: Omit<AuditLogEntry, 'id' | 'at'>): void {
    this.auditLog.unshift({ ...entry, id: nextId('audit'), at: new Date().toISOString() });
    this.auditLog = this.auditLog.slice(0, 500);
  }

  getUptimeSec(): number {
    return Math.round((Date.now() - this.bootedAt) / 1000);
  }

  getEnvironmentHistory(userId: string, limit: number): EnvironmentReading[] {
    return (this.environmentHistory.get(userId) ?? []).slice(-limit);
  }

  getWearableHistory(userId: string, limit: number): WearableReading[] {
    return (this.wearableHistory.get(userId) ?? []).slice(-limit);
  }

  /** Synthesised sensor samples for a device, from its owner's history. */
  getSensorHistory(deviceId: string, limit = 120): SensorReading[] {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) return [];

    const env = this.getEnvironmentHistory(device.userId, limit);
    const wear = this.getWearableHistory(device.userId, limit);

    const pick = (i: number): { value: number; unit: string; metric: SensorReading['metric'] } | null => {
      switch (device.type) {
        case 'TEMPERATURE_SENSOR':
          return { value: env[i].indoorTempC, unit: 'C', metric: 'temperature' };
        case 'HUMIDITY_SENSOR':
          return { value: env[i].indoorHumidityPct, unit: '%', metric: 'humidity' };
        case 'AIR_QUALITY_SENSOR':
          return { value: env[i].airQualityIndex, unit: 'AQI', metric: 'airQuality' };
        case 'SMART_WATCH':
          return wear[i] ? { value: wear[i].heartRateBpm, unit: 'BPM', metric: 'heartRate' } : null;
        case 'SMART_AC':
          return { value: env[i].heatIndex, unit: 'C', metric: 'heatIndex' };
        default:
          return null;
      }
    };

    const samples: SensorReading[] = [];

    env.forEach((e, i) => {
      const picked = pick(i);
      if (!picked) return;
      samples.push({
        id: `sensor-${deviceId}-${i}`,
        deviceId,
        userId: device.userId,
        metric: picked.metric,
        value: picked.value,
        unit: picked.unit,
        simulated: true,
        recordedAt: e.recordedAt,
      });
    });

    return samples;
  }

  setSimulation(patch: Partial<SimulationState>): SimulationState {
    const wasTick = this.simulation.tickMs;
    this.simulation = { ...this.simulation, ...patch };
    if (patch.tickMs && patch.tickMs !== wasTick) {
      this.stop();
      this.start();
    }
    this.broadcast();
    return { ...this.simulation };
  }

  startScenario(scenario: SimulationState['scenario'], focusUserId?: string): SimulationState {
    this.simulation.scenario = scenario;
    this.simulation.elapsedSec = 0;
    this.simulation.phase = 'NORMAL';
    this.simulation.phaseProgress = 0;
    this.simulation.running = true;
    if (focusUserId) this.simulation.focusUserId = focusUserId;

    const runtime = this.runtimes.get(this.simulation.focusUserId);
    if (runtime) runtime.userOverride = false;

    this.broadcast();
    return { ...this.simulation };
  }

  resetSimulation(): SimulationState {
    this.simulation.scenario = 'AMBIENT';
    this.simulation.elapsedSec = 0;
    this.simulation.phase = 'NORMAL';
    this.simulation.phaseProgress = 0;
    this.simulation.running = true;
    this.simulation.speed = 1;
    this.simulation.manualOffsets = { tempC: 0, humidityPct: 0, heartRateBpm: 0 };

    for (const device of this.devices) {
      if (!this.scenarioDowned.has(device.id)) continue;
      device.status = 'ONLINE';
      device.lastSeen = new Date().toISOString();
    }
    this.scenarioDowned.clear();

    for (const runtime of this.runtimes.values()) {
      // Reset the world as well as the record of it, or the next scenario
      // would resume the physics from wherever the last one left the room.
      runtime.household = initialHousehold(runtime.profile, runtime.baseline);
      runtime.reading = initialReading(runtime.profile, runtime.baseline);
      runtime.userOverride = false;
      runtime.lastNotifiedAt = 0;
      runtime.lastNotifiedLevel = null;
      runtime.openAlertId = null;

      for (const device of this.devices.filter((d) => d.userId === runtime.user.id && d.isActuator)) {
        device.power = false;
      }

      runtime.smartHome = this.deriveSmartHome(runtime.user.id, runtime.reading);
      runtime.assessment = this.evaluate({
        user: runtime.user,
        baseline: runtime.baseline,
        reading: runtime.reading,
        history: runtime.history,
        previousLevel: null,
      });
    }

    this.updateCityRisk();
    this.broadcast();
    return { ...this.simulation };
  }

  setAppliance(userId: string, appliance: 'ac' | 'fan' | 'dehumidifier', on: boolean): SmartHomeState | null {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return null;

    const typeMap = { ac: 'SMART_AC', fan: 'FAN', dehumidifier: 'DEHUMIDIFIER' } as const;
    const device = this.devices.find((d) => d.userId === userId && d.type === typeMap[appliance]);
    if (!device || device.status === 'DISABLED' || device.status === 'OFFLINE') {
      return runtime.smartHome;
    }

    device.power = on;
    device.lastSeen = new Date().toISOString();
    runtime.smartHome = this.deriveSmartHome(userId, runtime.reading);
    this.broadcast();
    return runtime.smartHome;
  }

  cancelAutomaticCooling(userId: string): SmartHomeState | null {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return null;

    runtime.userOverride = true;
    for (const device of this.devices.filter((d) => d.userId === userId && d.isActuator)) {
      device.power = false;
    }

    runtime.smartHome = this.deriveSmartHome(userId, runtime.reading);
    runtime.smartHome.userOverride = true;
    runtime.smartHome.automaticallyEngaged = false;
    runtime.smartHome.automationNote = 'The user cancelled automatic cooling for this episode.';
    runtime.smartHome.automationNoteZh = '使用者已取消本次自動降溫。';

    runtime.assessment = this.evaluate({
      user: runtime.user,
      baseline: runtime.baseline,
      reading: runtime.reading,
      history: runtime.history,
      previousLevel: runtime.assessment.level,
    });

    this.broadcast();
    return runtime.smartHome;
  }

  restoreAutomaticCooling(userId: string): SmartHomeState | null {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return null;
    runtime.userOverride = false;
    runtime.smartHome.userOverride = false;
    this.applyCooling(runtime, runtime.assessment);
    this.broadcast();
    return runtime.smartHome;
  }

  sendTestNotification(templateKey: NotificationTemplate['key'], userId: string): { sent: boolean; reason?: string } {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return { sent: false, reason: 'User not found' };

    const template = this.templates.find((t) => t.key === templateKey);
    if (!template) return { sent: false, reason: 'Template not found' };
    if (!template.enabled) {
      return { sent: false, reason: 'This template is disabled in the notification centre' };
    }

    const sent = this.emitNotification(runtime, templateKey, runtime.assessment);
    this.broadcast();

    return {
      sent,
      reason: sent
        ? undefined
        : 'Suppressed by user consent, caregiver preferences, quiet hours or the notification cooldown',
    };
  }
}

export const demoBackend = new DemoBackend();
