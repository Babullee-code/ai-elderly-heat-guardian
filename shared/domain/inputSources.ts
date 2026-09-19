/**
 * Input sources and the reading assembler.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The monitoring loop used to call one function that returned all nine
 * measurements as a single blob, with device health handled as an afterthought
 * inside it. That shape had two consequences:
 *
 *  1. The simulator imitated the *result* - a finished reading - rather than
 *     imitating the sensors that would produce one. There was no object in the
 *     system corresponding to "the living-room temperature sensor", so there
 *     was nothing for a real sensor to replace.
 *  2. Device-down behaviour was decided twice: once when holding a value, and
 *     again when describing it. Two deciders drift.
 *
 * WHAT IT IS INSTEAD
 * ------------------
 * The household's physical state is advanced once per tick (see
 * `simulationEngine.advanceHousehold`). Sources then SAMPLE that state. Each
 * source owns a few fields, knows whether it can report right now, and says so.
 * The assembler combines their reports into one reading plus its provenance -
 * in one place, from one set of facts.
 *
 * WHY IT MATTERS BEYOND TIDINESS
 * ------------------------------
 * A source is an interface, not a simulation detail. An HTTP ingest endpoint
 * (Phase 3) and a weather provider (Phase 4) are additional sources with
 * higher priority than the simulated ones; nothing in the monitoring engine,
 * the risk engine or the UI has to change to accept them. That is the whole
 * point of doing this before connecting anything real.
 */

import type {
  DataOrigin,
  DataQuality,
  Device,
  FieldProvenance,
  HouseholdState,
  InputSourceKind,
  MeasurementField,
  ReadingProvenance,
  ReadingSnapshot,
  SourceReport,
} from '../types/domain.js';
import { MEASUREMENT_FIELDS, fieldProvenance } from './provenance.js';

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

/**
 * Priority bands. Lower wins.
 *
 * A real measurement always beats a simulated one, and any measurement beats a
 * modelled estimate. Expressed as bands rather than adjacent integers so a new
 * source can be slotted between two existing ones without renumbering.
 */
export const SOURCE_PRIORITY = {
  /** A real device posting to the ingest API (Phase 3). */
  INGEST: 10,
  /** A connected weather provider (Phase 4). */
  WEATHER_PROVIDER: 20,
  /** The simulator standing in for household hardware. */
  SIMULATED_DEVICE: 50,
  /** The simulator standing in for a weather feed. */
  SIMULATED_WEATHER: 55,
  /** Last resort: a value inferred from the environment model. */
  ENVIRONMENT_MODEL: 90,
} as const;

/** Which fields each kind of household device reports. */
const DEVICE_FIELDS: Partial<Record<Device['type'], MeasurementField[]>> = {
  TEMPERATURE_SENSOR: ['indoorTempC'],
  HUMIDITY_SENSOR: ['indoorHumidityPct'],
  AIR_QUALITY_SENSOR: ['airQualityIndex'],
  SMART_WATCH: ['heartRateBpm', 'activityStepsPerHour', 'skinTempC'],
};

const DEVICE_KIND: Partial<Record<Device['type'], InputSourceKind>> = {
  TEMPERATURE_SENSOR: 'HOUSEHOLD_SENSOR',
  HUMIDITY_SENSOR: 'HOUSEHOLD_SENSOR',
  AIR_QUALITY_SENSOR: 'HOUSEHOLD_SENSOR',
  SMART_WATCH: 'WEARABLE',
};

/** Fields a weather service is responsible for. */
export const WEATHER_SOURCE_FIELDS: MeasurementField[] = [
  'outdoorTempC',
  'outdoorHumidityPct',
  'heatwaveDays',
];

/**
 * A source of measurements.
 *
 * Deliberately a plain function of the household state rather than a class:
 * every source in the system so far is stateless, and the state it would hold
 * (the physical world) is owned elsewhere on purpose.
 */
export interface InputSource {
  id: string;
  kind: InputSourceKind;
  fields: MeasurementField[];
  priority: number;
  poll(household: HouseholdState): SourceReport;
}

/**
 * One simulated household device.
 *
 * Reports the fields its hardware would measure, by reading them out of the
 * shared physical state. When the device is offline or disabled it reports
 * nothing at all - it does not report a stale number, because a real sensor
 * that has lost power does not send anything either. Deciding what to show in
 * that case is the assembler's job, not the sensor's.
 */
export function simulatedDeviceSource(device: Device): InputSource | null {
  const fields = DEVICE_FIELDS[device.type];
  const kind = DEVICE_KIND[device.type];
  if (!fields || !kind) return null;

  return {
    id: `device:${device.deviceId}`,
    kind,
    fields,
    priority: SOURCE_PRIORITY.SIMULATED_DEVICE,
    poll(household) {
      const down = device.status === 'OFFLINE' || device.status === 'DISABLED';

      return {
        sourceId: `device:${device.deviceId}`,
        kind,
        origin: 'SIMULATOR',
        fields,
        measurements: down
          ? []
          : fields.map((field) => ({
              field,
              value: household[field as keyof HouseholdState] as number,
              observedAt: household.at,
            })),
        available: !down,
        simulated: true,
        deviceId: device.deviceId,
        deviceName: device.nameZh,
        unavailableReasonZh: !down
          ? undefined
          : device.status === 'DISABLED'
            ? '裝置已由管理者停用'
            : '裝置離線',
        unavailableReason: !down
          ? undefined
          : device.status === 'DISABLED'
            ? 'Device disabled by an administrator'
            : 'Device offline',
        priority: SOURCE_PRIORITY.SIMULATED_DEVICE,
      };
    },
  };
}

/**
 * Outdoor conditions.
 *
 * Labelled SIMULATOR rather than WEATHER_API because no provider is connected
 * yet. Phase 4 adds a real one at a higher priority; this source then stops
 * winning without anything else changing.
 */
export function simulatedWeatherSource(userId: string): InputSource {
  const id = `weather:sim:${userId}`;

  return {
    id,
    kind: 'WEATHER',
    fields: WEATHER_SOURCE_FIELDS,
    priority: SOURCE_PRIORITY.SIMULATED_WEATHER,
    poll(household) {
      return {
        sourceId: id,
        kind: 'WEATHER',
        origin: 'SIMULATOR',
        fields: WEATHER_SOURCE_FIELDS,
        measurements: WEATHER_SOURCE_FIELDS.map((field) => ({
          field,
          value: household[field as keyof HouseholdState] as number,
          observedAt: household.at,
        })),
        available: true,
        simulated: true,
        priority: SOURCE_PRIORITY.SIMULATED_WEATHER,
      };
    },
  };
}

/**
 * The fallback that keeps the risk engine computable.
 *
 * Most households have no air-quality sensor and some have no humidity sensor,
 * yet both feed the risk calculation - humidity through the heat index. A real
 * deployment would infer those from the local environment, and so does this.
 *
 * It is the lowest-priority source by a wide margin, and everything it supplies
 * is marked DEFAULT so no screen can present an inference as a measurement.
 */
export function environmentModelSource(userId: string): InputSource {
  const id = `model:${userId}`;

  return {
    id,
    kind: 'ENVIRONMENT_MODEL',
    fields: [...MEASUREMENT_FIELDS],
    priority: SOURCE_PRIORITY.ENVIRONMENT_MODEL,
    poll(household) {
      return {
        sourceId: id,
        kind: 'ENVIRONMENT_MODEL',
        origin: 'DEFAULT',
        fields: [...MEASUREMENT_FIELDS],
        measurements: MEASUREMENT_FIELDS.map((field) => ({
          field,
          value: household[field as keyof HouseholdState] as number,
          observedAt: household.at,
        })),
        available: true,
        simulated: true,
        fallback: true,
        priority: SOURCE_PRIORITY.ENVIRONMENT_MODEL,
      };
    },
  };
}

/**
 * Anything that supplies measurements from outside this process.
 *
 * Passed in rather than imported so this module keeps no opinion about where
 * real data comes from - an HTTP endpoint today, a message queue later.
 */
export interface ExternalSources {
  /** A source per device that reports for itself, keyed by `device.id`. */
  byDeviceId: Map<string, InputSource>;
  /**
   * Devices that have posted real data at least once.
   *
   * The simulator must not stand in for these. A real sensor that has gone
   * quiet has to read as offline; replacing it with a plausible invented
   * number would hide the failure, which is the one outcome this layer exists
   * to prevent.
   */
  realDeviceIds: Set<string>;
  /**
   * External sources that belong to the resident rather than to one device -
   * the weather provider covering their district, for instance.
   */
  extra?: InputSource[];
  /**
   * Stop the simulator standing in for outdoor conditions.
   *
   * Set once a real weather provider has delivered at least one observation.
   * From then on its silence is information: if it fails, the outdoor values
   * are held and labelled, not quietly replaced by a simulated number that
   * looks exactly like a measurement. Identical in spirit to
   * `realDeviceIds` - a source that has proved it reports for itself keeps
   * that responsibility, including when it stops.
   */
  suppressSimulatedWeather?: boolean;
}

/**
 * The standard source set for one resident.
 *
 * Order is irrelevant - the assembler sorts by priority - but the set is
 * built here so every caller assembles a reading from the same inputs.
 */
export function sourcesForResident(
  userId: string,
  devices: Device[],
  external?: ExternalSources,
): InputSource[] {
  const sources: InputSource[] = [];

  for (const device of devices) {
    if (device.isActuator) continue;

    const ingest = external?.byDeviceId.get(device.id);
    if (ingest) sources.push(ingest);

    // A device that has proved it can report for itself keeps that
    // responsibility even while silent.
    if (external?.realDeviceIds.has(device.id)) continue;

    const simulated = simulatedDeviceSource(device);
    if (simulated) sources.push(simulated);
  }

  if (external?.extra) sources.push(...external.extra);

  if (!external?.suppressSimulatedWeather) sources.push(simulatedWeatherSource(userId));

  sources.push(environmentModelSource(userId));

  return sources;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface AssembleArgs {
  reports: SourceReport[];
  /**
   * The last reading, used to hold a value whose source has gone quiet. This
   * is where held values live - never in the household state, which continues
   * to evolve whether or not anything is watching it.
   */
  previous: ReadingSnapshot;
  /** Provenance of the previous reading, so a held value keeps its true age. */
  previousProvenance?: ReadingProvenance;
  now?: Date;
  /**
   * False when the platform is not monitoring this resident at all. Nothing is
   * refreshing their reading, so no field can honestly be called current.
   */
  monitored?: boolean;
}

export interface AssembledReading {
  reading: ReadingSnapshot;
  provenance: ReadingProvenance;
}

/**
 * Build one reading, and its provenance, from what the sources reported.
 *
 * For each field: take the highest-priority source that actually reported it.
 * If none did, hold the previous value and say why. The value and the
 * statement about the value are produced together, from the same facts, so
 * they cannot disagree.
 */
export function assembleReading(args: AssembleArgs): AssembledReading {
  const { reports, previous, previousProvenance, now = new Date(), monitored = true } = args;

  const ranked = [...reports].sort((a, b) => a.priority - b.priority);

  const values = {} as Record<MeasurementField, number>;
  const fields = {} as Record<MeasurementField, FieldProvenance>;
  const degradedFields: MeasurementField[] = [];
  const estimatedFields: MeasurementField[] = [];
  let anySimulated = false;

  for (const field of MEASUREMENT_FIELDS) {
    /**
     * Pick the source for this field.
     *
     * A measuring source that is responsible for the field but cannot report
     * BLOCKS the fallback: if the living-room thermometer is dead, the answer
     * is "we do not know", not a modelled guess wearing the same clothes. The
     * environment model only covers fields nothing measures at all.
     */
    const responsible = ranked.filter((r) => !r.fallback && r.fields.includes(field));
    const measured = responsible.find(
      (r) => r.available && r.measurements.some((m) => m.field === field),
    );

    const winner =
      measured ??
      (responsible.length > 0
        ? undefined
        : ranked.find((r) => r.available && r.measurements.some((m) => m.field === field)));

    if (winner && monitored) {
      const measurement = winner.measurements.find((m) => m.field === field)!;
      values[field] = measurement.value;

      const provenance = fieldProvenance({
        field,
        origin: winner.origin,
        observedAt: measurement.observedAt,
        now,
        simulated: winner.simulated,
        deviceId: winner.deviceId,
        deviceName: winner.deviceName,
        noteZh: winner.unavailableReasonZh ?? noteForOrigin(winner.origin),
        note: winner.unavailableReason ?? noteForOriginEn(winner.origin),
      });

      // A source that is still returning real data but can no longer refresh
      // it says so, and its values are labelled no better than that.
      fields[field] = winner.qualityCap
        ? { ...provenance, quality: worseQuality(provenance.quality, winner.qualityCap) }
        : provenance;
      if (winner.simulated) anySimulated = true;
      if (winner.origin === 'DEFAULT') estimatedFields.push(field);
    } else {
      // Nothing reported this field. Hold the last value rather than invent
      // one, and carry its original observation time so its age keeps running.
      const reason = monitored
        ? reasonForMissingField(field, ranked)
        : {
            zh: '此住戶目前未納入監測，數值為最後一次讀值',
            en: 'This resident is not being monitored; showing the last reading',
          };

      const heldSince = previousProvenance?.fields?.[field]?.observedAt ?? previous.timestamp;

      values[field] = previous[field as keyof ReadingSnapshot] as number;
      fields[field] = fieldProvenance({
        field,
        origin: 'HELD',
        observedAt: heldSince,
        now,
        simulated: previous.simulated,
        held: true,
        deviceId: reason.deviceId,
        deviceName: reason.deviceName,
        noteZh: reason.zh,
        note: reason.en,
      });
      anySimulated = anySimulated || previous.simulated;
    }

    if (fields[field].quality !== 'LIVE') degradedFields.push(field);
  }

  const reading: ReadingSnapshot = {
    indoorTempC: values.indoorTempC,
    indoorHumidityPct: values.indoorHumidityPct,
    outdoorTempC: values.outdoorTempC,
    outdoorHumidityPct: values.outdoorHumidityPct,
    airQualityIndex: values.airQualityIndex,
    heartRateBpm: values.heartRateBpm,
    activityStepsPerHour: values.activityStepsPerHour,
    skinTempC: values.skinTempC,
    heatwaveDays: values.heatwaveDays,
    simulated: anySimulated,
    timestamp: now.toISOString(),
  };

  return {
    reading,
    provenance: {
      at: now.toISOString(),
      fields,
      worstQuality: worstOf(fields),
      degradedFields,
      estimatedFields,
      anySimulated,
    },
  };
}

/**
 * Why a field has no reading, in the words the resident should see.
 *
 * Prefers the specific reason a responsible source gave ("the watch is
 * disabled") over the generic one, because those call for different actions.
 */
function reasonForMissingField(
  field: MeasurementField,
  ranked: SourceReport[],
): { zh: string; en: string; deviceId?: string; deviceName?: string } {
  const responsible = ranked.find((r) => r.fields.includes(field) && !r.available);

  if (responsible) {
    return {
      zh: `${responsible.unavailableReasonZh ?? '來源無法回報'}，數值為最後一次讀值`,
      en: `${responsible.unavailableReason ?? 'Source unavailable'}; showing its last value`,
      deviceId: responsible.deviceId,
      deviceName: responsible.deviceName,
    };
  }

  return {
    zh: '沒有任何來源提供此數值，顯示最後一次讀值',
    en: 'No source supplied this value; showing the last reading',
  };
}

const ORIGIN_NOTES_ZH: Partial<Record<DataOrigin, string>> = {
  SIMULATOR: '模擬感測資料',
  DEFAULT: '未安裝感測器，此為環境模型推估值',
};

const ORIGIN_NOTES_EN: Partial<Record<DataOrigin, string>> = {
  SIMULATOR: 'Simulated sensor data',
  DEFAULT: 'No sensor installed; estimated from the environment model',
};

function noteForOrigin(origin: DataOrigin): string | undefined {
  return ORIGIN_NOTES_ZH[origin];
}

function noteForOriginEn(origin: DataOrigin): string | undefined {
  return ORIGIN_NOTES_EN[origin];
}

const QUALITY_RANK = { LIVE: 0, RECENT: 1, STALE: 2, OFFLINE: 3 } as const;

/** The worse of two quality bands. */
function worseQuality(a: DataQuality, b: DataQuality): DataQuality {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

function worstOf(fields: Record<MeasurementField, FieldProvenance>) {
  let worst: FieldProvenance['quality'] = 'LIVE';
  for (const field of MEASUREMENT_FIELDS) {
    if (QUALITY_RANK[fields[field].quality] > QUALITY_RANK[worst]) worst = fields[field].quality;
  }
  return worst;
}
