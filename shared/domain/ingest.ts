/**
 * Ingest: accepting measurements from something outside this process.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now every number in the platform originated inside it. That makes a
 * demo easy and a claim about readiness impossible: there was no way for a
 * real sensor to participate, so "it could take real data" was an assertion
 * rather than a property of the system.
 *
 * An ingested measurement enters through the same door as a simulated one -
 * it becomes an `InputSource` report, is ranked by priority, and is assembled
 * into a reading by the same code. Nothing downstream knows the difference,
 * which is the point: the simulator can be removed without the monitoring
 * engine noticing.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * ------------------------------
 * It does not trust what it is given. A device may post a value that is
 * physically impossible, wildly out of date, or for a field it has no business
 * measuring, and each of those is rejected with a reason rather than fed to the
 * risk engine. A monitoring system that scores whatever arrives is not
 * measuring anything.
 */

import type {
  DataOrigin,
  Device,
  DeviceType,
  HouseholdState,
  MeasurementField,
  SourceReport,
} from '../types/domain.js';
import { SOURCE_PRIORITY, type InputSource } from './inputSources.js';

// ---------------------------------------------------------------------------
// What a device is allowed to report
// ---------------------------------------------------------------------------

/** Which fields each device type may post. */
export const INGESTABLE_FIELDS: Partial<Record<DeviceType, MeasurementField[]>> = {
  TEMPERATURE_SENSOR: ['indoorTempC'],
  HUMIDITY_SENSOR: ['indoorHumidityPct'],
  AIR_QUALITY_SENSOR: ['airQualityIndex'],
  SMART_WATCH: ['heartRateBpm', 'activityStepsPerHour', 'skinTempC'],
};

/**
 * Physically plausible range for each field.
 *
 * These are not comfort bands - they are the limits outside which a value is
 * evidence of a broken sensor rather than a dangerous room. A thermometer
 * reporting 200C has failed; treating that as an emergency would be worse than
 * useless, because it would bury the real ones.
 */
export const PLAUSIBLE_RANGE: Record<MeasurementField, { min: number; max: number }> = {
  indoorTempC: { min: -10, max: 60 },
  indoorHumidityPct: { min: 0, max: 100 },
  outdoorTempC: { min: -30, max: 60 },
  outdoorHumidityPct: { min: 0, max: 100 },
  airQualityIndex: { min: 0, max: 500 },
  heartRateBpm: { min: 20, max: 240 },
  activityStepsPerHour: { min: 0, max: 20_000 },
  skinTempC: { min: 20, max: 45 },
  heatwaveDays: { min: 0, max: 60 },
};

/**
 * How far in the past a measurement may be and still be accepted.
 *
 * A device that has been offline and reconnects may legitimately have a short
 * backlog; one posting yesterday's temperature is not reporting the present.
 */
export const MAX_BACKDATE_SEC = 15 * 60;

/** How far into the future a measurement may be, allowing for clock skew. */
export const MAX_FUTURE_SEC = 60;

/**
 * How long an ingested value stays usable.
 *
 * After this the device is treated as having gone quiet, and the assembler
 * holds its last value rather than presenting it as current. Deliberately
 * longer than the freshness bands in `provenance.ts`: those decide how a value
 * is LABELLED, this decides when it stops counting as a report at all.
 */
export const INGEST_VALIDITY_SEC = 10 * 60;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IngestRejectionCode =
  | 'UNKNOWN_FIELD'
  | 'FIELD_NOT_PERMITTED'
  | 'NOT_A_NUMBER'
  | 'OUT_OF_RANGE'
  | 'TOO_OLD'
  | 'IN_FUTURE';

export interface IngestRejection {
  field: string;
  code: IngestRejectionCode;
  message: string;
  messageZh: string;
}

export interface AcceptedMeasurement {
  field: MeasurementField;
  value: number;
  observedAt: string;
}

export interface IngestValidation {
  accepted: AcceptedMeasurement[];
  rejected: IngestRejection[];
}

/**
 * Check one device's submission.
 *
 * Partial success is deliberate: a watch posting a good heart rate and a
 * nonsense skin temperature should have the heart rate used and the skin
 * temperature refused, with the refusal reported back. Rejecting the whole
 * batch would discard a genuine reading because of an unrelated fault.
 */
export function validateIngest(args: {
  device: Device;
  values: Record<string, unknown>;
  observedAt?: string;
  now?: Date;
}): IngestValidation {
  const { device, values, now = new Date() } = args;

  const accepted: AcceptedMeasurement[] = [];
  const rejected: IngestRejection[] = [];

  const permitted = INGESTABLE_FIELDS[device.type] ?? [];

  // --- Timestamp ----------------------------------------------------------
  const observedAt = args.observedAt ? new Date(args.observedAt) : now;

  if (Number.isNaN(observedAt.getTime())) {
    return {
      accepted: [],
      rejected: [
        {
          field: 'observedAt',
          code: 'NOT_A_NUMBER',
          message: 'observedAt is not a valid ISO timestamp',
          messageZh: 'observedAt 不是有效的時間格式',
        },
      ],
    };
  }

  const ageSec = (now.getTime() - observedAt.getTime()) / 1000;

  if (ageSec > MAX_BACKDATE_SEC) {
    return {
      accepted: [],
      rejected: [
        {
          field: 'observedAt',
          code: 'TOO_OLD',
          message: `Measurement is ${Math.round(ageSec / 60)} minutes old; the limit is ${MAX_BACKDATE_SEC / 60}`,
          messageZh: `此筆量測已是 ${Math.round(ageSec / 60)} 分鐘前的資料，超過 ${MAX_BACKDATE_SEC / 60} 分鐘上限`,
        },
      ],
    };
  }

  if (ageSec < -MAX_FUTURE_SEC) {
    return {
      accepted: [],
      rejected: [
        {
          field: 'observedAt',
          code: 'IN_FUTURE',
          message: 'Measurement is dated in the future',
          messageZh: '此筆量測的時間在未來',
        },
      ],
    };
  }

  // --- Values -------------------------------------------------------------
  for (const [field, raw] of Object.entries(values)) {
    const range = PLAUSIBLE_RANGE[field as MeasurementField];

    if (!range) {
      rejected.push({
        field,
        code: 'UNKNOWN_FIELD',
        message: `${field} is not a measurement this platform records`,
        messageZh: `${field} 不是本平台記錄的量測項目`,
      });
      continue;
    }

    if (!permitted.includes(field as MeasurementField)) {
      rejected.push({
        field,
        code: 'FIELD_NOT_PERMITTED',
        message: `A ${device.type} may not report ${field}`,
        messageZh: `此裝置類型不得回報 ${field}`,
      });
      continue;
    }

    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      rejected.push({
        field,
        code: 'NOT_A_NUMBER',
        message: `${field} must be a finite number`,
        messageZh: `${field} 必須是有效的數值`,
      });
      continue;
    }

    if (raw < range.min || raw > range.max) {
      rejected.push({
        field,
        code: 'OUT_OF_RANGE',
        message: `${field} ${raw} is outside the plausible range ${range.min}..${range.max}`,
        messageZh: `${field} 的數值 ${raw} 超出合理範圍 ${range.min}..${range.max}`,
      });
      continue;
    }

    accepted.push({ field: field as MeasurementField, value: raw, observedAt: observedAt.toISOString() });
  }

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// The ingest source
// ---------------------------------------------------------------------------

/** What the platform is currently holding from one ingesting device. */
export interface IngestedReadings {
  deviceId: string;
  measurements: AcceptedMeasurement[];
  receivedAt: string;
}

/**
 * A device that posts its own readings.
 *
 * Outranks every simulated source, and unlike them it can be *responsible but
 * unavailable*: a real sensor that has stopped posting blocks the simulator
 * from covering for it, so its values are held and labelled offline. Inventing
 * a plausible replacement for a sensor that has failed is the specific thing
 * this whole layer exists to prevent.
 */
export function ingestSource(
  device: Device,
  ingested: IngestedReadings | undefined,
  now: Date = new Date(),
): InputSource {
  const fields = INGESTABLE_FIELDS[device.type] ?? [];
  const id = `ingest:${device.deviceId}`;

  const fresh = (ingested?.measurements ?? []).filter((m) => {
    const ageSec = (now.getTime() - new Date(m.observedAt).getTime()) / 1000;
    return ageSec <= INGEST_VALIDITY_SEC;
  });

  const down = device.status === 'OFFLINE' || device.status === 'DISABLED';
  const available = !down && fresh.length > 0;

  return {
    id,
    kind: 'INGEST',
    fields,
    priority: SOURCE_PRIORITY.INGEST,
    poll(): SourceReport {
      return {
        sourceId: id,
        kind: 'INGEST',
        origin: 'DEVICE' as DataOrigin,
        fields,
        measurements: available ? fresh : [],
        available,
        // The defining property: this value was measured elsewhere, by
        // something this process does not control.
        simulated: false,
        deviceId: device.deviceId,
        deviceName: device.nameZh,
        unavailableReasonZh: available
          ? undefined
          : down
            ? device.status === 'DISABLED'
              ? '裝置已由管理者停用'
              : '裝置離線'
            : '裝置已註冊但尚未回報新資料',
        unavailableReason: available
          ? undefined
          : down
            ? device.status === 'DISABLED'
              ? 'Device disabled by an administrator'
              : 'Device offline'
            : 'Device registered but has not posted recent data',
        priority: SOURCE_PRIORITY.INGEST,
      };
    },
  };
}

/**
 * Whether the simulator should still stand in for this device.
 *
 * Once a device has posted a real reading it owns its fields for good. If it
 * later goes quiet the honest answer is "we have not heard from it", not a
 * simulated number that looks exactly like a measurement.
 */
export function deviceIsReal(device: Device): boolean {
  return Boolean(device.lastIngestAt);
}

/**
 * Fold ingested measurements back into the household's physical state.
 *
 * Without this, a real thermometer reporting 34C would change what the screen
 * shows and what the risk engine scores, but the simulated room would go on
 * believing it is 27C - and heart rate, which the model drives from indoor
 * temperature, would be computed from the wrong number. A real observation
 * should correct the model, not sit alongside it.
 *
 * Only ingested fields are overwritten; everything else keeps evolving.
 */
export function assimilate(
  household: HouseholdState,
  reports: SourceReport[],
): HouseholdState {
  const corrected = { ...household };
  let changed = false;

  for (const report of reports) {
    if (report.kind !== 'INGEST' || !report.available) continue;
    for (const measurement of report.measurements) {
      if (measurement.field in corrected) {
        (corrected as unknown as Record<string, number>)[measurement.field] = measurement.value;
        changed = true;
      }
    }
  }

  return changed ? corrected : household;
}
