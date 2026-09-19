/**
 * Platform state and the simulation clock.
 *
 * This is the single source of truth for live data. The server - not the
 * browser - owns the readings, runs the risk engine, applies the policy
 * engine, drives the smart home and raises alerts. Every client (the elderly
 * app, the caregiver dashboard and the CMS) is a subscriber to the snapshot
 * this module broadcasts.
 *
 * That design is what makes the CMS a real control layer: an admin changing
 * the MEDIUM threshold mutates the config this loop reads, and the very next
 * tick recomputes every user's risk against the new value and pushes the
 * result to every connected screen. Nothing is recomputed client-side, so no
 * screen can disagree with another.
 *
 * High-frequency state is deliberately held in memory. Persisting every tick
 * would be poor engineering and would grow the database without bound; what
 * IS persisted is the meaningful record - risk events, alerts, notifications,
 * periodic readings and every administrative change.
 */

import type {
  ActionRule,
  ActionType,
  Alert,
  AlertTimelineEntry,
  Caregiver,
  CityRisk,
  Device,
  ElderlyUser,
  HouseholdState,
  LiveSnapshot,
  Notification,
  NotificationTemplate,
  PersonalBaseline,
  PlatformStats,
  ReadingProvenance,
  ReadingSnapshot,
  RiskAssessment,
  RiskHistoryPoint,
  RiskLevel,
  RiskRuleConfig,
  SensorMetric,
  SimulationState,
  SmartHomeState,
} from '../../shared/types/domain.js';
import { RISK_ORDER } from '../../shared/types/domain.js';
import { assessRisk } from '../../shared/domain/riskEngine.js';
import {
  decideCooling,
  executedActionTypes,
  getRecommendedActions,
} from '../../shared/domain/actionEngine.js';
import {
  buildTemplateVars,
  renderNotification,
  templateKeyForLevel,
} from '../../shared/domain/notificationEngine.js';
import {
  type AmbientProfile,
  initialHousehold,
  initialReading,
  scenarioDurationSec,
  resolvePhase,
  scenarioOfflineDevices,
  tickHousehold,
} from '../../shared/domain/simulationEngine.js';
import { calculateHeatIndex, clamp, round1 } from '../../shared/domain/heatIndex.js';
import { buildProvenance } from '../../shared/domain/provenance.js';
import {
  type AcceptedMeasurement,
  type IngestedReadings,
  deviceIsReal,
  ingestSource,
} from '../../shared/domain/ingest.js';
import type { ExternalSources, InputSource } from '../../shared/domain/inputSources.js';
import {
  scenarioOverridesWeather,
  weatherProviderSource,
} from '../../shared/domain/weather.js';
import { weatherService } from './weatherService.js';
import {
  mayContributeToCityStats,
  mayStorePhysiology,
  shouldEscalate,
} from '../../shared/domain/alertPolicy.js';
import {
  actionRuleRepo,
  alertRepo,
  caregiverRepo,
  cityRiskRepo,
  configRepo,
  coolingSpaceRepo,
  deviceRepo,
  notificationRepo,
  notificationTemplateRepo,
  readingRepo,
  riskEventRepo,
  userRepo,
} from '../db/repositories.js';

const HISTORY_LIMIT = 180;
/** Persist a reading to the database every Nth tick, not every tick. */
const PERSIST_EVERY_TICKS = 15;
/** Prune reading tables every Nth tick so a long demo cannot fill the disk. */
const PRUNE_EVERY_TICKS = 600;

interface UserRuntime {
  user: ElderlyUser;
  baseline: PersonalBaseline;
  profile: AmbientProfile;
  /**
   * What is physically true in the home.
   *
   * Kept separate from `reading` on purpose: the room goes on heating while
   * its thermometer is offline, and when that sensor comes back it must report
   * how hot the room is NOW rather than resuming from the value it froze at.
   * Held values belong to the reading; they never enter this.
   */
  household: HouseholdState;
  reading: ReadingSnapshot;
  assessment: RiskAssessment;
  smartHome: SmartHomeState;
  history: RiskHistoryPoint[];
  /** The user cancelled automatic cooling for the current episode. */
  userOverride: boolean;
  /** Timestamp of the last caregiver notification, for cooldown suppression. */
  lastNotifiedAt: number;
  /** Level at which the last caregiver notification was sent. */
  lastNotifiedLevel: RiskLevel | null;
  /** Open alert for the current episode, if any. */
  openAlertId: string | null;
}

export type SnapshotListener = (snapshot: LiveSnapshot) => void;

class PlatformState {
  private runtimes = new Map<string, UserRuntime>();
  private devices: Device[] = [];
  private caregivers: Caregiver[] = [];
  private templates: NotificationTemplate[] = [];
  private actionRules: ActionRule[] = [];
  private config!: RiskRuleConfig;
  private configVersion = 1;
  private cityRisk: CityRisk[] = [];
  private cityRiskBase = new Map<string, { temperatureC: number; humidityPct: number }>();
  private alerts: Alert[] = [];
  private notifications: Notification[] = [];
  private activeCoolingSpaceCount = 0;
  private notificationsToday = 0;

  /**
   * The most recent measurements posted by real devices, keyed by device id.
   *
   * Held in memory alongside the other live state, for the same reason: this
   * is the working set the tick loop reads, not the historical record. What is
   * persisted is the reading history, on the normal cadence.
   */
  private ingested = new Map<string, IngestedReadings>();

  /**
   * Devices this loop took offline for a scenario.
   *
   * Tracked so restoring them cannot undo a disable an administrator made for
   * their own reasons - the scenario may only give back what it took.
   */
  private scenarioDowned = new Set<string>();

  private simulation: SimulationState = {
    running: true,
    scenario: 'AMBIENT',
    phase: 'NORMAL',
    phaseProgress: 0,
    elapsedSec: 0,
    tickMs: Number(process.env.SIM_TICK_MS ?? 2000),
    speed: 1,
    focusUserId: 'user-001',
    tickCount: 0,
    manualOffsets: { tempC: 0, humidityPct: 0, heartRateBpm: 0 },
  };

  private listeners = new Set<SnapshotListener>();
  private timer: NodeJS.Timeout | null = null;
  private bootedAt = Date.now();
  private ready = false;

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async initialise(): Promise<void> {
    const { config, version } = await configRepo.get();
    this.config = config;
    this.configVersion = version;

    this.actionRules = await actionRuleRepo.list();
    this.templates = await notificationTemplateRepo.list();
    this.devices = await deviceRepo.list();
    this.caregivers = await caregiverRepo.list();
    this.alerts = await alertRepo.list(120);
    this.notifications = await notificationRepo.list(120);
    this.notificationsToday = await notificationRepo.countToday();

    const spaces = await coolingSpaceRepo.list();
    this.activeCoolingSpaceCount = spaces.filter((s) => s.status === 'ACTIVE').length;

    this.cityRisk = await cityRiskRepo.list();
    for (const c of this.cityRisk) {
      this.cityRiskBase.set(c.id, { temperatureC: c.temperatureC, humidityPct: c.humidityPct });
    }

    const users = await userRepo.list();
    const baselines = await userRepo.getAllBaselines();
    const profiles = await userRepo.getAmbientProfiles();

    for (const user of users) {
      const baseline = baselines[user.id];
      const profile = profiles[user.id];
      if (!baseline || !profile) {
        console.warn(`[state] Skipping ${user.id}: missing baseline or ambient profile`);
        continue;
      }

      const reading = initialReading(profile, baseline);
      const smartHome = this.deriveSmartHome(user.id, reading);

      // Seed the chart window from persisted history so the app opens with
      // real 24-hour context rather than an empty graph.
      const history = await this.loadHistory(user.id, baseline);

      const assessment = this.evaluate({
        user,
        baseline,
        reading,
        history,
        previousLevel: null,
        smartHome,
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
        openAlertId:
          this.alerts.find(
            (a) => a.userId === user.id && a.status !== 'RESOLVED',
          )?.id ?? null,
      });
    }

    this.ready = true;

    await this.establishBaselineAlerts();

    console.log(
      `[state] Initialised ${this.runtimes.size} users, ${this.devices.length} devices, config v${this.configVersion}`,
    );
  }

  /**
   * Open cases for residents who are already above threshold at startup.
   *
   * Alerts are normally raised on a level *transition*, but a monitoring
   * service that boots and finds someone already at MEDIUM or HIGH has found
   * a real, unattended situation. Without this the alert centre would sit
   * empty while the dashboard reported people at risk, which would be an
   * inconsistency rather than a quiet start.
   */
  private async establishBaselineAlerts(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      if (runtime.user.status !== 'ACTIVE') continue;
      if (RISK_ORDER[runtime.assessment.level] < RISK_ORDER.MEDIUM) continue;
      if (runtime.openAlertId) continue;

      const executed = executedActionTypes(runtime.assessment.actions);

      await this.raiseAlert(runtime, runtime.assessment, executed);
      await this.emitNotification({
        runtime,
        templateKey: templateKeyForLevel(runtime.assessment.level),
        assessment: runtime.assessment,
      });
    }
  }

  /** Rebuild the rolling chart window from persisted readings. */
  private async loadHistory(
    userId: string,
    baseline: PersonalBaseline,
  ): Promise<RiskHistoryPoint[]> {
    const env = await readingRepo.environmentHistory(userId, 60);
    const wear = await readingRepo.wearableHistory(userId, 60);

    return env.map((e, i) => {
      const w = wear[i] ?? wear[wear.length - 1];
      const heatIndex = e.heatIndex;

      const level: RiskLevel =
        heatIndex >= this.config.thresholds.high
          ? 'HIGH'
          : heatIndex >= this.config.thresholds.medium
            ? 'MEDIUM'
            : 'LOW';

      return {
        at: e.recordedAt,
        label: shortTime(e.recordedAt),
        // Historical points carry the heat-index band as an indicative score
        // rather than a recomputed composite: the factor inputs (activity,
        // heatwave day count) were not persisted for those older samples, so
        // a recomputed score would be misleadingly precise.
        score: Math.round(
          clamp(
            ((heatIndex - this.config.thresholds.low) /
              Math.max(1, this.config.thresholds.high - this.config.thresholds.low)) *
              100,
            0,
            100,
          ),
        ),
        level,
        heatIndex,
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

  // -------------------------------------------------------------------------
  // Derivation
  // -------------------------------------------------------------------------

  /** Build smart-home state for a user from their current actuator devices. */
  private deriveSmartHome(userId: string, reading: ReadingSnapshot): SmartHomeState {
    const userDevices = this.devices.filter((d) => d.userId === userId);

    const applianceFor = (type: Device['type']) => {
      const device = userDevices.find((d) => d.type === type);
      return {
        present: Boolean(device),
        on: device ? device.power && device.status !== 'DISABLED' && device.status !== 'OFFLINE' : false,
        deviceId: device?.id ?? null,
        disabled: device ? device.status === 'DISABLED' || device.status === 'OFFLINE' : false,
      };
    };

    const existing = this.runtimes.get(userId)?.smartHome;

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

  /** Run the risk engine and policy engine for one user. */
  private evaluate(args: {
    user: ElderlyUser;
    baseline: PersonalBaseline;
    reading: ReadingSnapshot;
    history: RiskHistoryPoint[];
    previousLevel: RiskLevel | null;
    smartHome: SmartHomeState;
    /** From the assembler, when this reading came from one. */
    provenance?: ReadingProvenance;
  }): RiskAssessment {
    const { user, baseline, reading, history, previousLevel } = args;

    const userDevices = this.devices.filter((d) => d.userId === user.id);

    /**
     * Prefer the assembler's provenance: it was produced from the same source
     * reports that produced the values, so the two cannot disagree.
     *
     * The fallback covers readings that did not come from a tick - boot, and
     * a paused simulation - where device status is the only evidence available.
     */
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
      coolingSpaceCount: this.activeCoolingSpaceCount,
      hasCaregiver: caregivers.length > 0,
    });

    return { ...core, actions };
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => console.error('[state] Tick failed:', error));
    }, this.simulation.tickMs);
    console.log(`[state] Simulation clock started at ${this.simulation.tickMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.ready) return;

    this.simulation.tickCount++;

    // Advance the scenario clock only while running.
    if (this.simulation.running && this.simulation.scenario && this.simulation.scenario !== 'AMBIENT') {
      this.simulation.elapsedSec += (this.simulation.tickMs / 1000) * this.simulation.speed;

      const total = scenarioDurationSec(this.simulation.scenario);
      const { spec, progress, finished } = resolvePhase(
        this.simulation.scenario,
        this.simulation.elapsedSec,
      );
      this.simulation.phase = spec.phase;
      this.simulation.phaseProgress = progress;

      // When a scenario completes, fall back to ambient drift rather than
      // freezing on the last frame.
      if (finished && this.simulation.elapsedSec > total + 4) {
        this.simulation.scenario = 'AMBIENT';
        this.simulation.elapsedSec = 0;
        this.simulation.phase = 'NORMAL';
        this.simulation.phaseProgress = 0;
      }
    }

    const persist = this.simulation.tickCount % PERSIST_EVERY_TICKS === 0;
    const sensorSamples: {
      deviceId: string;
      userId: string;
      metric: SensorMetric;
      value: number;
      unit: string;
      simulated: boolean;
      recordedAt: string;
    }[] = [];

    for (const runtime of this.runtimes.values()) {
      /**
       * Suspended and inactive residents are not monitored: no risk is
       * evaluated, no actions are taken and no alerts are raised for them.
       *
       * Their provenance is still refreshed, because the alternative is a
       * console that reports a two-minute-old reading for a resident nobody
       * has looked at since the server started. Not monitoring someone is a
       * decision; misreporting how old their data is, is a defect.
       */
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

      const userDevices = this.devices.filter((d) => d.userId === runtime.user.id);

      /**
       * Physics, then measurement. The simulator advances the home and the
       * input sources sample it; nothing here writes a value a source did not
       * produce, and nothing here can set a risk level.
       */
      const ticked = this.simulation.running
        ? tickHousehold({
            userId: runtime.user.id,
            profile: runtime.profile,
            baseline: runtime.baseline,
            previous: runtime.reading,
            previousProvenance: runtime.assessment.provenance,
            household: runtime.household,
            smartHome: runtime.smartHome,
            devices: userDevices,
            external: this.externalSourcesFor(userDevices, runtime.user.district, isFocus),
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
        smartHome: runtime.smartHome,
        // Built by the assembler from the same reports that produced the
        // values, so the numbers and the statement about them cannot disagree.
        provenance: ticked?.provenance,
      });

      runtime.assessment = assessment;

      // --- Smart home automation ------------------------------------------
      await this.applyCooling(runtime, assessment);

      // --- History ---------------------------------------------------------
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

      // --- Transitions -----------------------------------------------------
      if (assessment.escalated || assessment.recovered) {
        await this.handleTransition(runtime, assessment);
      }

      // --- Persistence -----------------------------------------------------
      if (persist) {
        // Environmental readings describe the home, not the person, and are
        // needed to explain a risk decision after the fact.
        await readingRepo.recordEnvironment(runtime.user.id, reading, assessment.heatIndex);

        /**
         * Physiological data is only stored with the resident's consent.
         *
         * `physiologicalDataStorage` previously gated the re-learn endpoint
         * but NOT this write, so a resident who declined storage had their
         * heart rate, skin temperature and activity persisted anyway. A
         * consent switch that does not do what it says is worse than not
         * offering one.
         *
         * Risk is still evaluated for them - the live reading is used and
         * discarded. What they lose is history and baseline learning, which
         * is exactly what they declined.
         */
        const storePhysiology = mayStorePhysiology(runtime.user);

        if (storePhysiology) {
          await readingRepo.recordWearable(runtime.user.id, reading);
        }

        for (const device of this.devices.filter(
          (d) => d.userId === runtime.user.id && d.status === 'ONLINE',
        )) {
          // A smart watch reports physiological metrics, so its samples fall
          // under the same consent as the wearable record above.
          if (device.type === 'SMART_WATCH' && !storePhysiology) continue;

          const sample = sensorSampleFor(device, reading, assessment.heatIndex);
          if (sample) sensorSamples.push(sample);
        }
      }
    }

    if (persist && sensorSamples.length > 0) {
      await readingRepo.recordSensorSamples(sensorSamples);
    }

    this.applyScenarioDeviceEffects();

    await this.touchReportingDevices(persist);

    /**
     * Ask the weather provider for an update.
     *
     * Deliberately not awaited: a slow or hanging provider must not stall the
     * monitoring loop for every resident. The service enforces its own poll
     * interval and backoff, so calling this every tick costs nothing when
     * there is nothing to do.
     */
    void weatherService.poll().catch(() => undefined);

    await this.escalateUnacknowledgedAlerts();

    if (this.simulation.tickCount % PRUNE_EVERY_TICKS === 0) {
      await readingRepo.prune();
      this.notificationsToday = await notificationRepo.countToday();
    }

    this.updateCityRisk();
    this.broadcast();
  }

  /**
   * Accept measurements posted by a real device.
   *
   * Validation has already happened at the route; by the time a measurement
   * arrives here it is one this platform is willing to score. The device's
   * contact time is updated because this IS contact - the heartbeat the
   * simulator fakes for its own devices is, for a real one, this call.
   */
  async acceptIngest(device: Device, measurements: AcceptedMeasurement[]): Promise<void> {
    const now = new Date();

    const existing = this.ingested.get(device.id);
    const byField = new Map<string, AcceptedMeasurement>(
      (existing?.measurements ?? []).map((m) => [m.field, m]),
    );
    for (const measurement of measurements) byField.set(measurement.field, measurement);

    this.ingested.set(device.id, {
      deviceId: device.deviceId,
      measurements: [...byField.values()],
      receivedAt: now.toISOString(),
    });

    // Reflect the contact in live state immediately, so the next tick - and
    // every connected screen - sees the device as reporting.
    const live = this.devices.find((d) => d.id === device.id);
    if (live) {
      live.lastSeen = now.toISOString();
      live.lastIngestAt = now.toISOString();
      if (live.status === 'OFFLINE') live.status = 'ONLINE';
    }

    await deviceRepo.markIngested(device.id, now);
  }

  /**
   * Everything supplying this resident from outside the simulator: their own
   * devices, and the weather provider covering their district.
   */
  private externalSourcesFor(
    devices: Device[],
    district: string,
    isFocus: boolean,
  ): ExternalSources | undefined {
    const byDeviceId = new Map<string, ReturnType<typeof ingestSource>>();
    const realDeviceIds = new Set<string>();

    for (const device of devices) {
      if (!device.ingestKeyPrefix && !deviceIsReal(device)) continue;
      byDeviceId.set(device.id, ingestSource(device, this.ingested.get(device.id)));
      if (deviceIsReal(device)) realDeviceIds.add(device.id);
    }

    /**
     * A scripted scenario works by driving outdoor temperature upward, which a
     * live feed would immediately overrule. Rather than add an offset to a real
     * value and keep calling it WEATHER_API - a lie about where the number came
     * from - the focus resident falls back to simulated weather for the
     * duration, labelled as the simulation it is. Every other resident keeps
     * the real feed.
     */
    const extra: InputSource[] = [];
    const scenarioRunning = scenarioOverridesWeather({
      isFocus,
      scenario: this.simulation.scenario,
    });

    const useProvider = weatherService.isEnabled() && !scenarioRunning;

    if (useProvider) {
      extra.push(
        weatherProviderSource(
          district,
          weatherService.getObservation(district),
          weatherService.getHealth(),
        ),
      );
    }

    /**
     * Once the provider has delivered, it owns outdoor conditions - including
     * when it fails. Letting the simulator resume would replace a real 25C
     * with an invented 34.5C and label it LIVE, which is precisely the failure
     * this platform is built to make impossible.
     */
    const suppressSimulatedWeather = useProvider && weatherService.hasDelivered();

    if (byDeviceId.size === 0 && extra.length === 0) return undefined;

    return { byDeviceId, realDeviceIds, extra, suppressSimulatedWeather };
  }

  /** Devices that have ever posted, for the ingest status endpoint. */
  getIngestStatus(): {
    deviceId: string;
    measurements: number;
    receivedAt: string;
  }[] {
    return [...this.ingested.values()].map((entry) => ({
      deviceId: entry.deviceId,
      measurements: entry.measurements.length,
      receivedAt: entry.receivedAt,
    }));
  }

  /**
   * Take the focus resident's hardware offline where the scenario says so.
   *
   * The scenario names a device type and nothing else. What follows - the
   * source reporting nothing, the assembler holding the last value, provenance
   * marking it OFFLINE, the risk engine scoring on what remains - is the
   * platform's ordinary behaviour, not a script. A rehearsal that scripted the
   * outcome would tell nobody anything about the real failure.
   *
   * Devices the scenario has released are restored only if this loop was what
   * took them down, so an administrator's own disable is never undone.
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
   * Record that every online sensor has just reported.
   *
   * `lastSeen` is the platform's answer to "when did we last hear from this
   * device", and it is what the age of a held value is measured against. Left
   * at its seeded value it made an online sensor look a day out of contact,
   * and - worse - a sensor that went offline a moment ago reported its held
   * value as a day old, understating how current the number really was.
   *
   * The database write is throttled to the existing persistence cadence; the
   * in-memory value advances every tick, because that is what clients read.
   * When Phase 3 introduces a real ingestion endpoint, this is the line that
   * moves into it: a device is last seen when it actually sends something.
   */
  private async touchReportingDevices(persist: boolean): Promise<void> {
    const now = new Date().toISOString();
    const monitored = new Set(
      [...this.runtimes.values()]
        .filter((r) => r.user.status === 'ACTIVE')
        .map((r) => r.user.id),
    );

    const reporting = this.devices.filter(
      (d) =>
        !d.isActuator &&
        d.status === 'ONLINE' &&
        monitored.has(d.userId) &&
        // A real device's contact time is set when it actually posts. Ticking
        // it here would report a silent sensor as having just been heard from.
        !deviceIsReal(d),
    );

    for (const device of reporting) device.lastSeen = now;

    if (!persist) return;

    await Promise.all(
      reporting.map((device) => deviceRepo.update(device.id, { lastSeen: now })),
    );
  }

  /**
   * Apply or withdraw automatic cooling.
   *
   * Only writes to the database when the appliance power state actually
   * changes, so the device table is not hammered every tick.
   */
  private async applyCooling(runtime: UserRuntime, assessment: RiskAssessment): Promise<void> {
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

    // Humid air blocks evaporative cooling, so the dehumidifier is engaged
    // alongside the AC when humidity is above the configured concern level.
    const shouldDehumidify =
      shouldCool && assessment.readings.indoorHumidityPct > this.config.environment.humidityConcernPct;

    const targets: { type: Device['type']; on: boolean }[] = [
      { type: 'SMART_AC', on: shouldCool },
      { type: 'DEHUMIDIFIER', on: shouldDehumidify },
      // A fan is only useful as a fallback when there is no usable AC.
      {
        type: 'FAN',
        on:
          shouldCool &&
          !userDevices.some(
            (d) => d.type === 'SMART_AC' && d.status !== 'DISABLED' && d.status !== 'OFFLINE',
          ),
      },
    ];

    let changed = false;

    for (const target of targets) {
      const device = userDevices.find((d) => d.type === target.type);
      if (!device) continue;
      if (device.status === 'DISABLED' || device.status === 'OFFLINE') continue;
      if (device.power === target.on) continue;

      await deviceRepo.update(device.id, { power: target.on, lastSeen: new Date().toISOString() });
      device.power = target.on;
      changed = true;

      if (target.on && target.type === 'SMART_AC') {
        await this.emitNotification({
          runtime,
          templateKey: 'COOLING_ACTIVATED',
          assessment,
          deviceName: device.nameZh,
        });
      }
    }

    const engaged = targets.some((t) => {
      const device = userDevices.find((d) => d.type === t.type);
      return device ? device.power : false;
    });

    runtime.smartHome.automaticallyEngaged = engaged && shouldCool;
    runtime.smartHome.targetTempC = this.config.smartHomePolicy.targetIndoorTempC;

    if (changed) {
      runtime.smartHome = {
        ...this.deriveSmartHome(runtime.user.id, runtime.reading),
        automaticallyEngaged: engaged && shouldCool,
        automationNote: decision.reason,
        automationNoteZh: decision.reasonZh,
        userOverride: runtime.userOverride,
      };
    }

    // Once risk clears, a user override is no longer meaningful and is reset
    // so the next episode starts from the authorised default.
    if (assessment.level === 'LOW' && runtime.userOverride) {
      runtime.userOverride = false;
    }
  }

  /** Record a risk event, raise or resolve alerts, and notify caregivers. */
  private async handleTransition(
    runtime: UserRuntime,
    assessment: RiskAssessment,
  ): Promise<void> {
    const executed = executedActionTypes(assessment.actions);

    await riskEventRepo.create({
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

    if (assessment.escalated && RISK_ORDER[assessment.level] >= RISK_ORDER.MEDIUM) {
      await this.raiseAlert(runtime, assessment, executed);
    }

    if (assessment.recovered) {
      await this.resolveAlertIfRecovered(runtime, assessment);
    }

    await this.emitNotification({
      runtime,
      templateKey: assessment.recovered && assessment.level === 'LOW'
        ? 'RISK_RECOVERED'
        : templateKeyForLevel(assessment.level),
      assessment,
    });
  }

  private async raiseAlert(
    runtime: UserRuntime,
    assessment: RiskAssessment,
    executed: ActionType[],
  ): Promise<void> {
    const caregiver = this.caregivers.find(
      (c) => c.status === 'ACTIVE' && c.assignedUserIds.includes(runtime.user.id),
    );

    const trigger = `Heat index ${assessment.heatIndex}C, HR ${assessment.baseline.heartRateBpm} BPM (${assessment.baseline.deviationPct}% over baseline)`;
    const triggerZh = `熱指數 ${assessment.heatIndex}°C、心率 ${assessment.baseline.heartRateBpm} BPM（高於基準 ${assessment.baseline.deviationPct}%）`;

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

    // An existing open alert is escalated rather than duplicated, so one heat
    // episode produces one alert thread instead of a flood.
    const existing = runtime.openAlertId
      ? this.alerts.find((a) => a.id === runtime.openAlertId && a.status !== 'RESOLVED')
      : undefined;

    if (existing) {
      const updated = await alertRepo.update(existing.id, {
        status: existing.status === 'NEW' ? 'NEW' : 'ESCALATED',
        actionsTaken: Array.from(new Set([...existing.actionsTaken, ...executed])),
        appendTimeline: timeline,
      });
      this.replaceAlert(updated);
      return;
    }

    const alert = await alertRepo.create({
      userId: runtime.user.id,
      userName: runtime.user.name,
      severity: assessment.level === 'HIGH' ? 'CRITICAL' : 'WARNING',
      level: assessment.level,
      trigger,
      triggerZh,
      status: 'NEW',
      assignedCaregiverId: caregiver?.id ?? null,
      assignedCaregiverName: caregiver?.name ?? null,
      assessment,
      actionsTaken: executed,
      timeline,
      createdAt: assessment.timestamp,
      acknowledgedAt: null,
      resolvedAt: null,
    });

    runtime.openAlertId = alert.id;
    this.alerts = [alert, ...this.alerts].slice(0, 150);
  }

  /**
   * Escalate HIGH alerts nobody has acknowledged.
   *
   * `notificationPolicy.escalateAfterMinutes` was configurable, audited and
   * displayed in the CMS while nothing acted on it - the worst kind of dead
   * control, because an operator would reasonably believe an unanswered
   * emergency was being chased.
   *
   * An alert escalates once. It moves to ESCALATED, the emergency contact is
   * recorded on the timeline, and a caregiver with emergency permission is
   * notified if one exists. Acknowledging it at any point stops this.
   */
  private async escalateUnacknowledgedAlerts(): Promise<void> {
    const now = new Date();

    for (const alert of this.alerts) {
      const decision = shouldEscalate(alert, this.config, now);
      if (!decision.escalate) continue;

      const runtime = this.runtimes.get(alert.userId);
      const contact = runtime?.user.emergencyContact;
      const minutes = decision.ageMinutes;

      const updated = await alertRepo.update(alert.id, {
        status: 'ESCALATED',
        appendTimeline: [
          {
            at: new Date().toISOString(),
            label: `No acknowledgement after ${minutes} minutes - escalated to emergency contact${
              contact ? ` (${contact.name}, ${contact.phone})` : ''
            }`,
            labelZh: `超過 ${minutes} 分鐘未有人確認，已升級並通知緊急聯絡人${
              contact ? `（${contact.name}，${contact.phone}）` : ''
            }`,
            actor: 'Escalation Policy',
            kind: 'STATUS',
          },
        ],
      });

      this.replaceAlert(updated);

      // Notify any caregiver holding emergency permission, over and above the
      // usual level and quiet-hour filtering - that is what the permission is
      // for.
      if (runtime) {
        const responders = this.caregivers.filter(
          (c) =>
            c.status === 'ACTIVE' &&
            c.emergencyPermission &&
            c.assignedUserIds.includes(runtime.user.id),
        );

        for (const responder of responders) {
          const notification = await notificationRepo.create({
            userId: runtime.user.id,
            userName: runtime.user.name,
            recipientId: responder.id,
            recipientName: responder.name,
            templateKey: 'HIGH_RISK',
            channel: 'VOICE_CALL',
            title: `緊急升級：${runtime.user.name} 的高風險警示未被確認`,
            body: `高風險警示已超過 ${minutes} 分鐘未有人確認，系統已升級處理。緊急聯絡人：${
              contact ? `${contact.name} ${contact.phone}` : '未設定'
            }。請立即聯繫。`,
            read: false,
            createdAt: new Date().toISOString(),
          });

          this.notifications = [notification, ...this.notifications].slice(0, 150);
          this.notificationsToday++;
        }
      }

      console.warn(
        `[escalation] Alert ${alert.id} for ${alert.userName} unacknowledged after ${minutes}min - escalated`,
      );
    }
  }

  /** Swap an updated alert into the in-memory list, preserving order. */
  private replaceAlert(updated: Alert): void {
    const index = this.alerts.findIndex((a) => a.id === updated.id);
    if (index === -1) {
      this.alerts = [updated, ...this.alerts].slice(0, 150);
      return;
    }
    this.alerts = [
      ...this.alerts.slice(0, index),
      updated,
      ...this.alerts.slice(index + 1),
    ];
  }

  private async resolveAlertIfRecovered(
    runtime: UserRuntime,
    assessment: RiskAssessment,
  ): Promise<void> {
    if (assessment.level !== 'LOW' || !runtime.openAlertId) return;

    const open = this.alerts.find((a) => a.id === runtime.openAlertId);
    if (!open || open.status === 'RESOLVED') return;

    const updated = await alertRepo.update(open.id, {
      status: 'RESOLVED',
      resolvedAt: assessment.timestamp,
      appendTimeline: [
        {
          at: assessment.timestamp,
          label: `Risk returned to LOW (heat index ${assessment.heatIndex}C)`,
          labelZh: `風險已回到低風險（熱指數 ${assessment.heatIndex}°C）`,
          actor: 'Risk Engine',
          kind: 'RECOVERY',
        },
      ],
    });

    this.replaceAlert(updated);
    runtime.openAlertId = null;
  }

  /**
   * Send a notification, respecting: the admin's template enable switch, the
   * user's consent, the caregiver's own minimum level and quiet hours, and the
   * configured cooldown. Any one of those can legitimately stop a send.
   */
  private async emitNotification(args: {
    runtime: UserRuntime;
    templateKey: NotificationTemplate['key'];
    assessment: RiskAssessment;
    deviceName?: string;
  }): Promise<void> {
    const { runtime, templateKey, assessment, deviceName } = args;

    const template = this.templates.find((t) => t.key === templateKey);
    const vars = buildTemplateVars({
      userName: runtime.user.name,
      assessment,
      deviceName,
    });

    const rendered = renderNotification(template, vars);
    if (!rendered) return;

    if (!runtime.user.permissions.caregiverNotifications) return;

    const isRiskNotification =
      templateKey === 'LOW_RISK' || templateKey === 'MEDIUM_RISK' || templateKey === 'HIGH_RISK';

    if (
      isRiskNotification &&
      RISK_ORDER[assessment.level] < RISK_ORDER[this.config.notificationPolicy.minLevelForCaregiver]
    ) {
      return;
    }

    // Cooldown: suppress a repeat notification at the same level.
    const now = Date.now();
    const withinCooldown =
      now - runtime.lastNotifiedAt < this.config.notificationPolicy.cooldownMinutes * 60_000;

    if (isRiskNotification && withinCooldown && runtime.lastNotifiedLevel === assessment.level) {
      return;
    }

    const recipients = this.caregivers.filter(
      (c) => c.status === 'ACTIVE' && c.assignedUserIds.includes(runtime.user.id),
    );

    for (const caregiver of recipients) {
      if (
        isRiskNotification &&
        RISK_ORDER[assessment.level] < RISK_ORDER[caregiver.notificationPreferences.minLevel]
      ) {
        continue;
      }

      // Quiet hours are overridden for HIGH risk: a life-safety alert should
      // still reach the caregiver overnight.
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
      const channel = channels[0] ?? rendered.channels[0];

      const notification = await notificationRepo.create({
        userId: runtime.user.id,
        userName: runtime.user.name,
        recipientId: caregiver.id,
        recipientName: caregiver.name,
        templateKey,
        channel,
        title: rendered.titleZh,
        body: rendered.bodyZh,
        read: false,
        createdAt: new Date().toISOString(),
      });

      this.notifications = [notification, ...this.notifications].slice(0, 150);
      this.notificationsToday++;

      if (runtime.openAlertId) {
        const open = this.alerts.find((a) => a.id === runtime.openAlertId);
        if (open) {
          const updated = await alertRepo.update(open.id, {
            appendTimeline: [
              {
                at: notification.createdAt,
                label: `Notified ${caregiver.name} via ${channel}`,
                labelZh: `已透過 ${channel} 通知 ${caregiver.name}`,
                actor: 'Notification Service',
                kind: 'NOTIFICATION',
              },
            ],
          });
          this.replaceAlert(updated);
        }
      }
    }

    if (isRiskNotification) {
      runtime.lastNotifiedAt = now;
      runtime.lastNotifiedLevel = assessment.level;
    }
  }

  /**
   * Recompute district heat risk.
   *
   * Districts respond to the running scenario, because a heatwave affecting a
   * resident affects their neighbourhood too - which is what makes the city
   * map move during the demo rather than sitting still.
   */
  private updateCityRisk(): void {
    const focus = this.runtimes.get(this.simulation.focusUserId);
    const focusDistrict = focus?.user.district;

    /**
     * District resident counts include only residents who consented to
     * contribute to city statistics.
     *
     * `cityDataContribution` was previously enforced nowhere: the privacy
     * centre told residents this switch controlled whether their data fed the
     * city aggregate, and it did not. Counting is recomputed here from live
     * consent so withdrawing it takes effect on the next tick.
     */
    const consentingByDistrict = new Map<string, number>();
    for (const runtime of this.runtimes.values()) {
      if (!mayContributeToCityStats(runtime.user)) continue;
      const district = runtime.user.district;
      consentingByDistrict.set(district, (consentingByDistrict.get(district) ?? 0) + 1);
    }

    // How far the scenario has pushed outdoor temperature above the profile
    // baseline, used as the citywide forcing term.
    const forcing =
      focus && this.simulation.scenario && this.simulation.scenario !== 'AMBIENT'
        ? focus.reading.outdoorTempC - focus.profile.baseOutdoorTempC
        : 0;

    this.cityRisk = this.cityRisk.map((district) => {
      const base = this.cityRiskBase.get(district.id);
      if (!base) return district;

      // The focus district feels the full forcing; the rest of the city feels
      // roughly half, since a heat episode is regional but not uniform.
      const localForcing = district.district === focusDistrict ? forcing : forcing * 0.45;

      const temperatureC = round1(base.temperatureC + localForcing);
      const humidityPct = round1(
        clamp(base.humidityPct + localForcing * 0.9, 40, 96),
      );
      const heatIndex = calculateHeatIndex(temperatureC, humidityPct);

      const riskLevel: RiskLevel =
        heatIndex >= this.config.thresholds.high
          ? 'HIGH'
          : heatIndex >= this.config.thresholds.medium
            ? 'MEDIUM'
            : 'LOW';

      return {
        ...district,
        temperatureC,
        humidityPct,
        heatIndex,
        riskLevel,
        elderlyUserCount: consentingByDistrict.get(district.district) ?? 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot & subscriptions
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

  private buildStats(): PlatformStats {
    const active = [...this.runtimes.values()].filter((r) => r.user.status === 'ACTIVE');

    const byLevel = (level: RiskLevel) =>
      active.filter((r) => r.assessment.level === level).length;

    const onlineDevices = this.devices.filter(
      (d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY',
    ).length;

    // City risk is the worst district level, since a platform-level indicator
    // should reflect the most exposed neighbourhood, not an average.
    const worst = this.cityRisk.reduce<RiskLevel>(
      (acc, d) => (RISK_ORDER[d.riskLevel] > RISK_ORDER[acc] ? d.riskLevel : acc),
      'LOW',
    );

    const cityHeatIndex = this.cityRisk.length
      ? round1(
          this.cityRisk.reduce((sum, d) => sum + d.heatIndex, 0) / this.cityRisk.length,
        )
      : 0;

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
      coolingSpaces: this.activeCoolingSpaceCount,
      activeCoolingSpaces: this.activeCoolingSpaceCount,
      cityRiskLevel: worst,
      cityHeatIndex,
      caregivers: this.caregivers.filter((c) => c.status === 'ACTIVE').length,
      notificationsToday: this.notificationsToday,
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.buildSnapshot());
    return () => this.listeners.delete(listener);
  }

  private broadcast(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[state] Listener failed:', error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cache invalidation - called by admin routes after a change
  // -------------------------------------------------------------------------

  /**
   * Reload configuration after the CMS changes risk rules or policy.
   * Bumping configVersion tells clients their cached config is stale.
   */
  async reloadConfig(): Promise<void> {
    const { config, version } = await configRepo.get();
    this.config = config;
    this.configVersion = version;
    this.actionRules = await actionRuleRepo.list();

    // Re-evaluate immediately so a threshold change is visible on the next
    // frame rather than after the next scheduled tick.
    for (const runtime of this.runtimes.values()) {
      runtime.smartHome = this.deriveSmartHome(runtime.user.id, runtime.reading);
      runtime.assessment = this.evaluate({
        user: runtime.user,
        baseline: runtime.baseline,
        reading: runtime.reading,
        history: runtime.history,
        previousLevel: runtime.assessment.level,
        smartHome: runtime.smartHome,
      });
    }

    this.updateCityRisk();
    this.broadcast();
  }

  async reloadDevices(): Promise<void> {
    this.devices = await deviceRepo.list();
    for (const runtime of this.runtimes.values()) {
      runtime.smartHome = this.deriveSmartHome(runtime.user.id, runtime.reading);
    }
    this.broadcast();
  }

  async reloadUsers(): Promise<void> {
    const users = await userRepo.list();
    const baselines = await userRepo.getAllBaselines();
    const profiles = await userRepo.getAmbientProfiles();

    for (const user of users) {
      const existing = this.runtimes.get(user.id);
      if (existing) {
        existing.user = user;
        if (baselines[user.id]) existing.baseline = baselines[user.id];
        continue;
      }

      // A user created through the CMS joins the live loop immediately.
      const baseline = baselines[user.id];
      const profile = profiles[user.id];
      if (!baseline || !profile) continue;

      const reading = initialReading(profile, baseline);
      const smartHome = this.deriveSmartHome(user.id, reading);
      const assessment = this.evaluate({
        user,
        baseline,
        reading,
        history: [],
        previousLevel: null,
        smartHome,
      });

      this.runtimes.set(user.id, {
        user,
        baseline,
        profile,
        household: initialHousehold(profile, baseline),
        reading,
        assessment,
        smartHome,
        history: [],
        userOverride: false,
        lastNotifiedAt: 0,
        lastNotifiedLevel: null,
        openAlertId: null,
      });
    }

    // Drop runtimes for users deleted through the CMS.
    const ids = new Set(users.map((u) => u.id));
    for (const id of [...this.runtimes.keys()]) {
      if (!ids.has(id)) this.runtimes.delete(id);
    }

    this.broadcast();
  }

  async reloadCaregivers(): Promise<void> {
    this.caregivers = await caregiverRepo.list();
    this.broadcast();
  }

  async reloadTemplates(): Promise<void> {
    this.templates = await notificationTemplateRepo.list();
    this.broadcast();
  }

  async reloadCoolingSpaces(): Promise<void> {
    const spaces = await coolingSpaceRepo.list();
    this.activeCoolingSpaceCount = spaces.filter((s) => s.status === 'ACTIVE').length;

    // Re-evaluate so a disabled location immediately withdraws the
    // RECOMMEND_COOLING_SPACE action where none remain.
    for (const runtime of this.runtimes.values()) {
      runtime.assessment = this.evaluate({
        user: runtime.user,
        baseline: runtime.baseline,
        reading: runtime.reading,
        history: runtime.history,
        previousLevel: runtime.assessment.level,
        smartHome: runtime.smartHome,
      });
    }

    this.broadcast();
  }

  async reloadAlerts(): Promise<void> {
    this.alerts = await alertRepo.list(120);
    this.broadcast();
  }

  async reloadNotifications(): Promise<void> {
    this.notifications = await notificationRepo.list(120);
    this.notificationsToday = await notificationRepo.countToday();
    this.broadcast();
  }

  // -------------------------------------------------------------------------
  // Accessors & commands
  // -------------------------------------------------------------------------

  getConfig(): RiskRuleConfig {
    return this.config;
  }

  getConfigVersion(): number {
    return this.configVersion;
  }

  getAssessment(userId: string): RiskAssessment | null {
    return this.runtimes.get(userId)?.assessment ?? null;
  }

  getSmartHome(userId: string): SmartHomeState | null {
    return this.runtimes.get(userId)?.smartHome ?? null;
  }

  getHistory(userId: string): RiskHistoryPoint[] {
    return this.runtimes.get(userId)?.history ?? [];
  }

  getReading(userId: string): ReadingSnapshot | null {
    return this.runtimes.get(userId)?.reading ?? null;
  }

  getSimulation(): SimulationState {
    return { ...this.simulation };
  }

  getStats(): PlatformStats {
    return this.buildStats();
  }

  getCityRisk(): CityRisk[] {
    return this.cityRisk;
  }

  getDevicesCache(): Device[] {
    return this.devices;
  }

  getUptimeSec(): number {
    return Math.round((Date.now() - this.bootedAt) / 1000);
  }

  getTickCount(): number {
    return this.simulation.tickCount;
  }

  /** Manually switch an appliance from the user-facing smart-home controls. */
  async setAppliance(
    userId: string,
    appliance: 'ac' | 'fan' | 'dehumidifier',
    on: boolean,
  ): Promise<SmartHomeState | null> {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return null;

    const typeMap = {
      ac: 'SMART_AC',
      fan: 'FAN',
      dehumidifier: 'DEHUMIDIFIER',
    } as const;

    const device = this.devices.find(
      (d) => d.userId === userId && d.type === typeMap[appliance],
    );
    if (!device) return runtime.smartHome;
    if (device.status === 'DISABLED' || device.status === 'OFFLINE') return runtime.smartHome;

    await deviceRepo.update(device.id, { power: on, lastSeen: new Date().toISOString() });
    device.power = on;

    runtime.smartHome = this.deriveSmartHome(userId, runtime.reading);
    this.broadcast();
    return runtime.smartHome;
  }

  /**
   * The user cancels automatic cooling for this episode. Appliances the
   * platform switched on are switched back off, and automation stays out of
   * the way until risk clears.
   */
  async cancelAutomaticCooling(userId: string): Promise<SmartHomeState | null> {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return null;

    runtime.userOverride = true;

    for (const device of this.devices.filter((d) => d.userId === userId && d.isActuator)) {
      if (!device.power) continue;
      await deviceRepo.update(device.id, { power: false });
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
      smartHome: runtime.smartHome,
    });

    this.broadcast();
    return runtime.smartHome;
  }

  /** Re-enable automation the user previously cancelled. */
  async restoreAutomaticCooling(userId: string): Promise<SmartHomeState | null> {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return null;
    runtime.userOverride = false;
    runtime.smartHome.userOverride = false;
    await this.applyCooling(runtime, runtime.assessment);
    this.broadcast();
    return runtime.smartHome;
  }

  setSimulation(patch: Partial<SimulationState>): SimulationState {
    const wasTick = this.simulation.tickMs;
    this.simulation = { ...this.simulation, ...patch };

    if (patch.tickMs && patch.tickMs !== wasTick) {
      this.stop();
      this.start();
    }

    this.broadcast();
    return this.getSimulation();
  }

  /** Start a named scenario from the beginning. */
  startScenario(scenario: SimulationState['scenario'], focusUserId?: string): SimulationState {
    this.simulation.scenario = scenario;
    this.simulation.elapsedSec = 0;
    this.simulation.phase = 'NORMAL';
    this.simulation.phaseProgress = 0;
    this.simulation.running = true;
    if (focusUserId) this.simulation.focusUserId = focusUserId;

    // Clear the previous episode's override so a fresh scenario is not blocked
    // by a cancellation from the last run.
    const runtime = this.runtimes.get(this.simulation.focusUserId);
    if (runtime) runtime.userOverride = false;

    this.broadcast();
    return this.getSimulation();
  }

  /** Return every user and appliance to the seeded starting condition. */
  async resetSimulation(): Promise<SimulationState> {
    this.simulation.scenario = 'AMBIENT';
    this.simulation.elapsedSec = 0;
    this.simulation.phase = 'NORMAL';
    this.simulation.phaseProgress = 0;
    this.simulation.running = true;
    this.simulation.speed = 1;
    this.simulation.manualOffsets = { tempC: 0, humidityPct: 0, heartRateBpm: 0 };

    // Give back every device the scenario took, before the runtimes reset.
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

      for (const device of this.devices.filter(
        (d) => d.userId === runtime.user.id && d.isActuator && d.power,
      )) {
        await deviceRepo.update(device.id, { power: false });
        device.power = false;
      }

      runtime.smartHome = this.deriveSmartHome(runtime.user.id, runtime.reading);
      runtime.assessment = this.evaluate({
        user: runtime.user,
        baseline: runtime.baseline,
        reading: runtime.reading,
        history: runtime.history,
        previousLevel: null,
        smartHome: runtime.smartHome,
      });
    }

    this.updateCityRisk();
    this.broadcast();
    return this.getSimulation();
  }

  /** Send a notification on demand from the CMS demo controls. */
  async sendTestNotification(args: {
    templateKey: NotificationTemplate['key'];
    userId: string;
  }): Promise<{ sent: boolean; reason?: string }> {
    const runtime = this.runtimes.get(args.userId);
    if (!runtime) return { sent: false, reason: 'User not found' };

    const template = this.templates.find((t) => t.key === args.templateKey);
    if (!template) return { sent: false, reason: 'Template not found' };
    if (!template.enabled) {
      return { sent: false, reason: 'This template is disabled in the notification centre' };
    }

    const before = this.notifications.length;
    await this.emitNotification({
      runtime,
      templateKey: args.templateKey,
      assessment: runtime.assessment,
      deviceName: this.devices.find((d) => d.userId === args.userId)?.nameZh,
    });

    const sent = this.notifications.length > before;
    return {
      sent,
      reason: sent
        ? undefined
        : 'Suppressed by user consent, caregiver preferences, quiet hours or the notification cooldown',
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function inQuietHours(quiet: { from: string; to: string }): boolean {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  const parse = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const from = parse(quiet.from);
  const to = parse(quiet.to);

  // Quiet hours usually wrap past midnight.
  return to <= from ? minutes >= from || minutes < to : minutes >= from && minutes < to;
}

/** Map a device to the sensor metric it reports. */
function sensorSampleFor(
  device: Device,
  reading: ReadingSnapshot,
  heatIndex: number,
): {
  deviceId: string;
  userId: string;
  metric: SensorMetric;
  value: number;
  unit: string;
  simulated: boolean;
  recordedAt: string;
} | null {
  const base = {
    deviceId: device.id,
    userId: device.userId,
    simulated: reading.simulated,
    recordedAt: reading.timestamp,
  };

  switch (device.type) {
    case 'TEMPERATURE_SENSOR':
      return { ...base, metric: 'temperature', value: reading.indoorTempC, unit: 'C' };
    case 'HUMIDITY_SENSOR':
      return { ...base, metric: 'humidity', value: reading.indoorHumidityPct, unit: '%' };
    case 'AIR_QUALITY_SENSOR':
      return { ...base, metric: 'airQuality', value: reading.airQualityIndex, unit: 'AQI' };
    case 'SMART_WATCH':
      return { ...base, metric: 'heartRate', value: reading.heartRateBpm, unit: 'BPM' };
    case 'SMART_AC':
      return { ...base, metric: 'heatIndex', value: heatIndex, unit: 'C' };
    default:
      return null;
  }
}

export const platformState = new PlatformState();
