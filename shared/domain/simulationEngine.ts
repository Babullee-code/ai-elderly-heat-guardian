/**
 * Simulation engine.
 *
 * Produces the sensor readings that drive the demo. Two modes:
 *
 *  - AMBIENT: gentle random-walk drift around a per-user comfortable baseline,
 *    so the platform always looks alive without ever crossing into risk.
 *  - Scripted scenarios: a phase machine that walks NORMAL -> HEAT_INCREASING
 *    -> MEDIUM_RISK -> HIGH_RISK -> RECOVERY, which is the competition
 *    storyline in section 35 of the brief.
 *
 * Readings are physically coupled rather than independently randomised:
 * running the air conditioner actually pulls indoor temperature toward the
 * target, humidity tracks temperature, and heart rate follows the heat index
 * with lag. Judges asking "does the AC actually do anything?" get a yes.
 *
 * PHYSICS AND MEASUREMENT ARE SEPARATE
 * -----------------------------------
 * `advanceHousehold` computes what is physically true in the home. It knows
 * nothing about sensors, and it keeps running whether or not anything is
 * watching - a room goes on heating while its thermometer is offline. Turning
 * that truth into a reading is the job of the input sources in
 * `inputSources.ts`, which sample it and can individually fail.
 *
 * The point of the split is that the simulator imitates the SENSORS, not the
 * result. Nothing here can set a risk level, and nothing here decides what a
 * screen shows when a sensor goes quiet.
 */

import type {
  Device,
  DeviceType,
  HouseholdState,
  PersonalBaseline,
  ReadingProvenance,
  ReadingSnapshot,
  ScenarioName,
  ScenarioPhase,
  SimulationState,
  SmartHomeState,
} from '../types/domain.js';
import { clamp, round1 } from './heatIndex.js';
import {
  assembleReading,
  sourcesForResident,
  type ExternalSources,
} from './inputSources.js';
import { assimilate } from './ingest.js';

/**
 * How far below outdoor temperature a domestic air conditioner can hold the
 * room, in Celsius, for a home of average heat sensitivity. Scaled by each
 * home's heatSensitivity: a poorly insulated home gets less benefit.
 */
const AC_CAPACITY_DELTA = 6;

/** Per-user ambient conditions the simulation drifts around. */
export interface AmbientProfile {
  userId: string;
  baseIndoorTempC: number;
  baseIndoorHumidityPct: number;
  baseOutdoorTempC: number;
  baseOutdoorHumidityPct: number;
  baseAirQualityIndex: number;
  baseHeatwaveDays: number;
  /** Multiplier on how strongly this home heats up - poor insulation etc. */
  heatSensitivity: number;
}

/** Phase definitions for the scripted scenarios, in seconds. */
interface PhaseSpec {
  phase: ScenarioPhase;
  durationSec: number;
  /** Additive outdoor temperature offset reached by the end of the phase. */
  outdoorTempDelta: number;
  /** Additive humidity offset reached by the end of the phase. */
  humidityDelta: number;
  /** Additional heart-rate drive, on top of the heat-index response. */
  heartRateDrive: number;
  /** Multiplier on activity level - lethargy during high risk. */
  activityFactor: number;
  /**
   * Device types the focus resident's hardware should be failing during this
   * phase.
   *
   * The scenario takes a SENSOR away and lets the consequences follow: the
   * source stops reporting, the assembler holds the last value, provenance
   * says so, and the risk engine works with what is left. Nothing about the
   * outcome is scripted - which is the only way a rehearsal of a sensor
   * failure tells you anything about a real one.
   */
  offlineDevices?: DeviceType[];
}

/**
 * Phase offsets are calibrated against the NOAA heat-index curve AND the
 * air-conditioner capacity limit below, so each phase lands in its intended
 * risk band even once cooling engages. Raising a delta without re-checking
 * both will simply produce a different band.
 */
const FULL_DEMO_PHASES: PhaseSpec[] = [
  { phase: 'NORMAL', durationSec: 12, outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
  { phase: 'HEAT_INCREASING', durationSec: 30, outdoorTempDelta: 2.3, humidityDelta: 4, heartRateDrive: 6, activityFactor: 0.8 },
  { phase: 'MEDIUM_RISK', durationSec: 30, outdoorTempDelta: 6.3, humidityDelta: 16, heartRateDrive: 14, activityFactor: 0.5 },
  // Long enough for indoor temperature to actually converge on the air
  // conditioner's capacity floor. A shorter phase would turn back before the
  // room reaches HIGH, which would understate the danger being demonstrated.
  { phase: 'HIGH_RISK', durationSec: 60, outdoorTempDelta: 9.8, humidityDelta: 20, heartRateDrive: 24, activityFactor: 0.25 },
  // Long enough for the room, and the resident's heart rate, to actually
  // come back down - the recovery is part of the story, not an epilogue.
  { phase: 'RECOVERY', durationSec: 80, outdoorTempDelta: 0.8, humidityDelta: 2, heartRateDrive: 0, activityFactor: 0.9 },
];

const HEATWAVE_PHASES: PhaseSpec[] = [
  { phase: 'NORMAL', durationSec: 10, outdoorTempDelta: 1.5, humidityDelta: 4, heartRateDrive: 2, activityFactor: 0.9 },
  { phase: 'HEAT_INCREASING', durationSec: 24, outdoorTempDelta: 4.5, humidityDelta: 12, heartRateDrive: 8, activityFactor: 0.7 },
  { phase: 'HIGH_RISK', durationSec: 60, outdoorTempDelta: 9.5, humidityDelta: 22, heartRateDrive: 26, activityFactor: 0.2 },
  { phase: 'RECOVERY', durationSec: 40, outdoorTempDelta: 2, humidityDelta: 6, heartRateDrive: 4, activityFactor: 0.8 },
];

const NIGHT_RECOVERY_PHASES: PhaseSpec[] = [
  { phase: 'MEDIUM_RISK', durationSec: 14, outdoorTempDelta: 6.3, humidityDelta: 14, heartRateDrive: 12, activityFactor: 0.5 },
  { phase: 'RECOVERY', durationSec: 60, outdoorTempDelta: -2, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
  { phase: 'NORMAL', durationSec: 30, outdoorTempDelta: -3, humidityDelta: -2, heartRateDrive: 0, activityFactor: 1 },
];

const DEVICE_FAILURE_PHASES: PhaseSpec[] = [
  { phase: 'NORMAL', durationSec: 10, outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
  { phase: 'HEAT_INCREASING', durationSec: 30, outdoorTempDelta: 2.5, humidityDelta: 12, heartRateDrive: 8, activityFactor: 0.7 },
  { phase: 'MEDIUM_RISK', durationSec: 45, outdoorTempDelta: 6.5, humidityDelta: 18, heartRateDrive: 16, activityFactor: 0.4 },
];

/**
 * A household sensor fails while the room is heating.
 *
 * The point is not that a value stops updating - it is what the platform does
 * next. Indoor temperature is held at its last reading and marked offline, the
 * heat index is therefore computed from a number that is no longer true, and
 * the resident's screen says so instead of showing a comfortable room. Rehearse
 * this before it happens at three in the afternoon in August.
 */
const SENSOR_OFFLINE_PHASES: PhaseSpec[] = [
  { phase: 'NORMAL', durationSec: 14, outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
  { phase: 'HEAT_INCREASING', durationSec: 30, outdoorTempDelta: 3.5, humidityDelta: 6, heartRateDrive: 7, activityFactor: 0.8 },
  // The thermometer dies just as the room starts to matter.
  {
    phase: 'MEDIUM_RISK',
    durationSec: 40,
    outdoorTempDelta: 7.5,
    humidityDelta: 16,
    heartRateDrive: 15,
    activityFactor: 0.5,
    offlineDevices: ['TEMPERATURE_SENSOR'],
  },
  {
    phase: 'HIGH_RISK',
    durationSec: 50,
    outdoorTempDelta: 10.5,
    humidityDelta: 20,
    heartRateDrive: 24,
    activityFactor: 0.25,
    offlineDevices: ['TEMPERATURE_SENSOR'],
  },
  // Restored, and the reading jumps to what the room actually is - not to
  // where it was when the sensor went dark.
  { phase: 'RECOVERY', durationSec: 60, outdoorTempDelta: 1, humidityDelta: 2, heartRateDrive: 0, activityFactor: 0.9 },
];

/**
 * The wearable drops out during a heat episode.
 *
 * Worse than losing a room sensor, because the physiological comparison is the
 * part of the model nothing else substitutes for: heart rate against this
 * person's own baseline is the signal that distinguishes a hot room from a
 * person in trouble. The platform must keep working on environmental evidence
 * alone and be visibly less certain, rather than quietly scoring as though the
 * missing signal were reassuring.
 */
const WEARABLE_OFFLINE_PHASES: PhaseSpec[] = [
  { phase: 'NORMAL', durationSec: 14, outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
  { phase: 'HEAT_INCREASING', durationSec: 30, outdoorTempDelta: 3.5, humidityDelta: 6, heartRateDrive: 8, activityFactor: 0.8 },
  {
    phase: 'MEDIUM_RISK',
    durationSec: 40,
    outdoorTempDelta: 7.5,
    humidityDelta: 16,
    heartRateDrive: 18,
    activityFactor: 0.5,
    offlineDevices: ['SMART_WATCH'],
  },
  {
    phase: 'HIGH_RISK',
    durationSec: 50,
    outdoorTempDelta: 10.5,
    humidityDelta: 20,
    heartRateDrive: 28,
    activityFactor: 0.25,
    offlineDevices: ['SMART_WATCH'],
  },
  { phase: 'RECOVERY', durationSec: 60, outdoorTempDelta: 1, humidityDelta: 2, heartRateDrive: 0, activityFactor: 0.9 },
];

/**
 * A newly enrolled resident, with no history to judge them against.
 *
 * Deliberately gentle on the environment: the subject here is the baseline,
 * not the weather. What should be visible is the platform saying plainly that
 * it does not yet know this person, comparing them against typical values for
 * their age group meanwhile, and then switching to their own range as the
 * nights accumulate.
 */
const NEW_RESIDENT_PHASES: PhaseSpec[] = [
  { phase: 'NORMAL', durationSec: 30, outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
  { phase: 'HEAT_INCREASING', durationSec: 40, outdoorTempDelta: 2.5, humidityDelta: 5, heartRateDrive: 6, activityFactor: 0.85 },
  { phase: 'MEDIUM_RISK', durationSec: 50, outdoorTempDelta: 6, humidityDelta: 14, heartRateDrive: 13, activityFactor: 0.6 },
  { phase: 'RECOVERY', durationSec: 60, outdoorTempDelta: 1, humidityDelta: 2, heartRateDrive: 0, activityFactor: 0.9 },
];

export const SCENARIOS: Record<ScenarioName, { phases: PhaseSpec[]; label: string; labelZh: string; description: string }> = {
  FULL_DEMO: {
    phases: FULL_DEMO_PHASES,
    label: 'Full demo',
    labelZh: '完整示範',
    description: 'NORMAL to HIGH_RISK and back - the complete competition storyline.',
  },
  HEATWAVE: {
    phases: HEATWAVE_PHASES,
    label: 'Sustained heatwave',
    labelZh: '持續熱浪',
    description: 'A long high-risk plateau, testing escalation and caregiver response.',
  },
  NIGHT_RECOVERY: {
    phases: NIGHT_RECOVERY_PHASES,
    label: 'Overnight recovery',
    labelZh: '夜間降溫',
    description: 'Starts at MEDIUM and cools down, demonstrating recovery messaging.',
  },
  DEVICE_FAILURE: {
    phases: DEVICE_FAILURE_PHASES,
    label: 'Cooling unavailable',
    labelZh: '降溫設備失效',
    description: 'Risk rises while cooling is offline, so blocked-action reporting is visible.',
  },
  SENSOR_OFFLINE: {
    phases: SENSOR_OFFLINE_PHASES,
    label: 'Sensor goes offline',
    labelZh: '感測器失聯',
    description: 'A room sensor stops reporting mid-episode; the value is held and marked, never replaced.',
  },
  WEARABLE_OFFLINE: {
    phases: WEARABLE_OFFLINE_PHASES,
    label: 'Wearable drops out',
    labelZh: '穿戴裝置失聯',
    description: 'The physiological signal is lost during a heat episode; risk continues on environment alone.',
  },
  NEW_RESIDENT: {
    phases: NEW_RESIDENT_PHASES,
    label: 'Newly enrolled resident',
    labelZh: '新進住戶',
    description: 'No history yet: the baseline is learned, and the platform says so until it is.',
  },
  AMBIENT: {
    phases: [],
    label: 'Ambient drift',
    labelZh: '環境自然變化',
    description: 'No scripted scenario - gentle realistic drift only.',
  },
};

export function scenarioDurationSec(scenario: ScenarioName): number {
  return SCENARIOS[scenario].phases.reduce((s, p) => s + p.durationSec, 0);
}

/**
 * Device types the scenario wants failing right now, for the focus resident.
 *
 * Returned rather than applied here: this module knows about physics, not
 * about the device table. The monitoring loop owns device state and is the
 * only thing that may change it.
 */
export function scenarioOfflineDevices(
  scenario: ScenarioName | null,
  elapsedSec: number,
): DeviceType[] {
  if (!scenario || scenario === 'AMBIENT') return [];
  const { spec, finished } = resolvePhase(scenario, elapsedSec);
  return finished ? [] : (spec.offlineDevices ?? []);
}

/** Resolve which phase a scenario is in at a given elapsed time. */
export function resolvePhase(
  scenario: ScenarioName,
  elapsedSec: number,
): { spec: PhaseSpec; progress: number; index: number; finished: boolean } {
  const phases = SCENARIOS[scenario].phases;
  if (phases.length === 0) {
    return {
      spec: { phase: 'NORMAL', durationSec: 1, outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 },
      progress: 0,
      index: 0,
      finished: false,
    };
  }

  let remaining = elapsedSec;
  for (let i = 0; i < phases.length; i++) {
    if (remaining < phases[i].durationSec) {
      return {
        spec: phases[i],
        progress: clamp(remaining / phases[i].durationSec, 0, 1),
        index: i,
        finished: false,
      };
    }
    remaining -= phases[i].durationSec;
  }

  return { spec: phases[phases.length - 1], progress: 1, index: phases.length - 1, finished: true };
}

/** Smooth ease-in-out so phase transitions do not look like step functions. */
function ease(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * Interpolate the scenario's target offsets at the current moment, blending
 * from the previous phase's endpoint into the current one.
 */
function scenarioOffsets(
  scenario: ScenarioName,
  elapsedSec: number,
): { tempDelta: number; humidityDelta: number; heartRateDrive: number; activityFactor: number; phase: ScenarioPhase; progress: number } {
  const phases = SCENARIOS[scenario].phases;
  const { spec, progress, index } = resolvePhase(scenario, elapsedSec);

  const prev = index > 0 ? phases[index - 1] : { outdoorTempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1 };
  const t = ease(progress);

  return {
    tempDelta: prev.outdoorTempDelta + (spec.outdoorTempDelta - prev.outdoorTempDelta) * t,
    humidityDelta: prev.humidityDelta + (spec.humidityDelta - prev.humidityDelta) * t,
    heartRateDrive: prev.heartRateDrive + (spec.heartRateDrive - prev.heartRateDrive) * t,
    activityFactor: prev.activityFactor + (spec.activityFactor - prev.activityFactor) * t,
    phase: spec.phase,
    progress,
  };
}

// ---------------------------------------------------------------------------
// Reading generation
// ---------------------------------------------------------------------------

export interface TickArgs {
  profile: AmbientProfile;
  baseline: PersonalBaseline;
  /** Previous reading, so the walk is continuous. */
  previous: ReadingSnapshot;
  /**
   * The household's previous physical state.
   *
   * Optional: when omitted the physics resumes from `previous` instead, which
   * is what callers holding only a reading can offer. That fallback carries a
   * real cost - a held value then feeds back into the model, so the simulated
   * room stops warming while its sensor is dark - so the monitoring loop
   * supplies the true state and only the unit tests rely on the fallback.
   */
  household?: HouseholdState;
  /** Live smart-home state - determines whether cooling is pulling temp down. */
  smartHome: SmartHomeState;
  devices: Device[];
  simulation: SimulationState;
  /** True when this user is the scenario's focus; others just drift. */
  isFocus: boolean;
}

/** Build the initial physical state for a home, at rest and comfortable. */
export function initialHousehold(
  profile: AmbientProfile,
  baseline: PersonalBaseline,
): HouseholdState {
  return {
    indoorTempC: profile.baseIndoorTempC,
    indoorHumidityPct: profile.baseIndoorHumidityPct,
    outdoorTempC: profile.baseOutdoorTempC,
    outdoorHumidityPct: profile.baseOutdoorHumidityPct,
    airQualityIndex: profile.baseAirQualityIndex,
    heartRateBpm: baseline.heartRate.mean,
    activityStepsPerHour: baseline.activityStepsPerHour.mean,
    skinTempC: baseline.skinTemp.mean,
    heatwaveDays: profile.baseHeatwaveDays,
    at: new Date().toISOString(),
  };
}

/** Read a physical state out of a reading, for callers that hold only one. */
export function householdFromReading(reading: ReadingSnapshot): HouseholdState {
  return {
    indoorTempC: reading.indoorTempC,
    indoorHumidityPct: reading.indoorHumidityPct,
    outdoorTempC: reading.outdoorTempC,
    outdoorHumidityPct: reading.outdoorHumidityPct,
    airQualityIndex: reading.airQualityIndex,
    heartRateBpm: reading.heartRateBpm,
    activityStepsPerHour: reading.activityStepsPerHour,
    skinTempC: reading.skinTempC,
    heatwaveDays: reading.heatwaveDays,
    at: reading.timestamp,
  };
}

/**
 * Advance the home's physical state by one tick.
 *
 * Physically coupled: the AC pulls indoor temperature toward the target, the
 * dehumidifier pulls humidity down, and heart rate chases the resulting heat
 * load with a lag so recovery is visibly gradual rather than instant.
 *
 * Deliberately knows nothing about sensors. Whether anyone is measuring the
 * room has no bearing on how hot it gets.
 */
export function advanceHousehold(args: {
  profile: AmbientProfile;
  baseline: PersonalBaseline;
  previous: HouseholdState;
  smartHome: SmartHomeState;
  simulation: SimulationState;
  isFocus: boolean;
}): HouseholdState {
  const { profile, baseline, previous, smartHome, simulation, isFocus } = args;

  const offsets =
    isFocus && simulation.scenario && simulation.scenario !== 'AMBIENT'
      ? scenarioOffsets(simulation.scenario, simulation.elapsedSec)
      : { tempDelta: 0, humidityDelta: 0, heartRateDrive: 0, activityFactor: 1, phase: 'NORMAL' as ScenarioPhase, progress: 0 };

  const manual = simulation.manualOffsets;
  const manualTemp = isFocus ? manual.tempC : 0;
  const manualHumidity = isFocus ? manual.humidityPct : 0;
  const manualHr = isFocus ? manual.heartRateBpm : 0;

  // --- Outdoor conditions: scenario + manual offsets + drift --------------
  const targetOutdoorTemp = profile.baseOutdoorTempC + offsets.tempDelta + manualTemp;
  const outdoorTempC = round1(
    approach(previous.outdoorTempC, targetOutdoorTemp, 0.3) + noise(0.12),
  );

  const targetOutdoorHumidity = profile.baseOutdoorHumidityPct + offsets.humidityDelta + manualHumidity;
  const outdoorHumidityPct = round1(
    clamp(approach(previous.outdoorHumidityPct, targetOutdoorHumidity, 0.25) + noise(0.4), 20, 100),
  );

  // --- Indoor conditions: driven by outdoor, modified by appliances --------
  const acOn = smartHome.ac.present && smartHome.ac.on && !smartHome.ac.disabled;
  const fanOn = smartHome.fan.present && smartHome.fan.on && !smartHome.fan.disabled;
  const dehumidifierOn =
    smartHome.dehumidifier.present && smartHome.dehumidifier.on && !smartHome.dehumidifier.disabled;

  // Without cooling, indoor tracks outdoor at a lag, offset by insulation.
  const passiveIndoorTarget = outdoorTempC - 2.2 / Math.max(0.4, profile.heatSensitivity);

  let indoorTarget = passiveIndoorTarget;
  let indoorRate = 0.06 * profile.heatSensitivity;

  if (acOn) {
    /**
     * An air conditioner has finite capacity. A domestic split unit in an
     * older, poorly insulated home cannot hold 26C against 38C outside - it
     * can pull the room down by roughly AC_CAPACITY_DELTA and no further.
     *
     * This is not a detail: it is precisely why people die of heat in homes
     * that HAVE air conditioning, and it is why the platform escalates to
     * recommending a cooling location rather than trusting the appliance.
     */
    const capacityFloor = outdoorTempC - AC_CAPACITY_DELTA / profile.heatSensitivity;
    indoorTarget = Math.max(smartHome.targetTempC, capacityFloor);
    indoorRate = 0.11;
  } else if (fanOn) {
    // A fan does not cool the air, it only improves apparent comfort a little.
    indoorTarget = passiveIndoorTarget - 0.6;
    indoorRate = 0.07;
  }

  const indoorTempC = round1(
    clamp(approach(previous.indoorTempC, indoorTarget, indoorRate) + noise(0.06), 16, 45),
  );

  // Humidity: tracks outdoor, but AC and dehumidifier both remove moisture.
  let humidityTarget = outdoorHumidityPct - 4;
  if (acOn) humidityTarget -= 8;
  if (dehumidifierOn) humidityTarget -= 12;

  const indoorHumidityPct = round1(
    clamp(approach(previous.indoorHumidityPct, humidityTarget, 0.09) + noise(0.3), 25, 99),
  );

  // --- Air quality --------------------------------------------------------
  const aqiTarget = profile.baseAirQualityIndex + offsets.tempDelta * 1.8;
  const airQualityIndex = Math.round(
    clamp(approach(previous.airQualityIndex, aqiTarget, 0.1) + noise(1.2), 10, 320),
  );

  // --- Physiology: heart rate chases heat load with lag -------------------
  // Above a comfortable indoor temperature, cardiovascular strain rises as the
  // body redirects blood flow to the skin to shed heat.
  const thermalDrive = Math.max(0, indoorTempC - 27) * 1.9 + Math.max(0, indoorHumidityPct - 65) * 0.16;
  const hrTarget = baseline.heartRate.mean + thermalDrive + offsets.heartRateDrive + manualHr;
  const heartRateBpm = Math.round(
    clamp(approach(previous.heartRateBpm, hrTarget, 0.12) + noise(0.8), 45, 180),
  );

  // Skin temperature follows indoor temperature closely but in a narrow band.
  const skinTarget = 32.6 + Math.max(0, indoorTempC - 24) * 0.14;
  const skinTempC = round1(clamp(approach(previous.skinTempC, skinTarget, 0.1) + noise(0.03), 30, 40));

  // Activity: lethargy under heat load is itself a warning sign.
  const activityTarget = baseline.activityStepsPerHour.mean * offsets.activityFactor;
  const activityStepsPerHour = Math.round(
    clamp(approach(previous.activityStepsPerHour, activityTarget, 0.15) + noise(6), 0, 2000),
  );

  // --- Heatwave day count -------------------------------------------------
  // Scenario phases that sustain heat also raise the cumulative day counter.
  const heatwaveDays =
    isFocus && (offsets.phase === 'HIGH_RISK' || offsets.phase === 'MEDIUM_RISK')
      ? profile.baseHeatwaveDays + 2
      : profile.baseHeatwaveDays;

  return {
    indoorTempC,
    indoorHumidityPct,
    outdoorTempC,
    outdoorHumidityPct,
    airQualityIndex,
    heartRateBpm,
    activityStepsPerHour,
    skinTempC,
    heatwaveDays,
    at: new Date().toISOString(),
  };
}

export interface TickResult {
  /** The home's new physical state, to be carried into the next tick. */
  household: HouseholdState;
  /** What the sensors managed to observe of it. */
  reading: ReadingSnapshot;
  /** Where each observed value came from, and how far it can be trusted. */
  provenance: ReadingProvenance;
}

/**
 * Advance one resident by a single tick: physics, then measurement.
 *
 * This is the function the monitoring loop calls. It never decides a risk
 * level, and it never writes a value the sources did not produce.
 */
export function tickHousehold(
  args: TickArgs & {
    userId: string;
    previousProvenance?: ReadingProvenance;
    /** Sources supplying data from outside this process. */
    external?: ExternalSources;
  },
): TickResult {
  const modelled = advanceHousehold({
    profile: args.profile,
    baseline: args.baseline,
    previous: args.household ?? householdFromReading(args.previous),
    smartHome: args.smartHome,
    simulation: args.simulation,
    isFocus: args.isFocus,
  });

  const sources = sourcesForResident(args.userId, args.devices, args.external);
  const reports = sources.map((source) => source.poll(modelled));

  /**
   * A real observation corrects the model rather than sitting beside it.
   *
   * Without this a real thermometer reporting 34C would change the screen and
   * the risk score while the simulated room went on believing it was 27C - and
   * heart rate, which the model drives from indoor temperature, would be
   * computed from the wrong number.
   */
  const household = assimilate(modelled, reports);

  const { reading, provenance } = assembleReading({
    reports,
    previous: args.previous,
    previousProvenance: args.previousProvenance,
  });

  return { household, reading, provenance };
}

/**
 * Advance one user's readings by a single tick.
 *
 * Retained for callers - chiefly the simulation tests - that care only about
 * what a resident's sensors report. Equivalent to `tickHousehold` without
 * carrying the physical state forward; see `TickArgs.household` for the cost
 * of that.
 */
export function tickReadings(args: TickArgs): ReadingSnapshot {
  return tickHousehold({ ...args, userId: args.profile.userId }).reading;
}

/** Move `current` a fraction `rate` of the way toward `target`. */
function approach(current: number, target: number, rate: number): number {
  return current + (target - current) * clamp(rate, 0, 1);
}

/** Symmetric random jitter of magnitude `amplitude`. */
function noise(amplitude: number): number {
  return (Math.random() - 0.5) * 2 * amplitude;
}

/** Build the initial reading for a user, at rest and comfortable. */
export function initialReading(
  profile: AmbientProfile,
  baseline: PersonalBaseline,
): ReadingSnapshot {
  return {
    indoorTempC: profile.baseIndoorTempC,
    indoorHumidityPct: profile.baseIndoorHumidityPct,
    outdoorTempC: profile.baseOutdoorTempC,
    outdoorHumidityPct: profile.baseOutdoorHumidityPct,
    airQualityIndex: profile.baseAirQualityIndex,
    heartRateBpm: baseline.heartRate.mean,
    activityStepsPerHour: baseline.activityStepsPerHour.mean,
    skinTempC: baseline.skinTemp.mean,
    heatwaveDays: profile.baseHeatwaveDays,
    simulated: true,
    timestamp: new Date().toISOString(),
  };
}

/** Phase display metadata for the demo controls. */
export const PHASE_LABELS: Record<ScenarioPhase, { label: string; labelZh: string }> = {
  NORMAL: { label: 'Normal', labelZh: '正常' },
  HEAT_INCREASING: { label: 'Heat increasing', labelZh: '熱度上升中' },
  MEDIUM_RISK: { label: 'Medium risk', labelZh: '中度風險' },
  HIGH_RISK: { label: 'High risk', labelZh: '高風險' },
  RECOVERY: { label: 'Recovery', labelZh: '風險下降' },
};
