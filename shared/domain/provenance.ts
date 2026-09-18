/**
 * Reading provenance.
 *
 * Answers, for each measured field: where did this number come from, how old
 * is it, and can it be trusted right now?
 *
 * WHY THIS IS SEPARATE FROM THE READING
 * ------------------------------------
 * `ReadingSnapshot` carries one `simulated` flag and one `timestamp` for all
 * nine fields, so it cannot express "indoor temperature is live from the living
 * room sensor three seconds ago, but the wearable went quiet four minutes ago".
 * Provenance travels alongside it instead of inside it, which keeps the risk
 * engine's signature - and its tests - untouched.
 *
 * WHY IT MATTERS
 * --------------
 * The platform already does the right thing when a sensor drops out: it holds
 * the last value rather than inventing one. But holding a value silently is
 * only half the job. A console that shows a four-minute-old heart rate as
 * though it were current is worse than one showing nothing, because a
 * caregiver will act on it. This module makes the difference visible.
 */

import type {
  DataOrigin,
  DataQuality,
  Device,
  DeviceType,
  FieldProvenance,
  MeasurementField,
  ReadingProvenance,
  ReadingSnapshot,
} from '../types/domain.js';

/**
 * Freshness bands, in seconds.
 *
 * LIVE is generous relative to the 2s tick because a real device reports on
 * its own schedule - a household temperature sensor that wakes every 30
 * seconds is behaving normally, not lagging.
 */
export const FRESHNESS = {
  /** At or under this age, the value is current. */
  liveSec: 60,
  /** Older than live but still usable for a risk decision. */
  recentSec: 300,
} as const;

/** Every measured field, in display order. */
export const MEASUREMENT_FIELDS: MeasurementField[] = [
  'indoorTempC',
  'indoorHumidityPct',
  'heartRateBpm',
  'activityStepsPerHour',
  'skinTempC',
  'outdoorTempC',
  'outdoorHumidityPct',
  'airQualityIndex',
  'heatwaveDays',
];

/** Which device type is responsible for each field. */
const FIELD_DEVICE: Partial<Record<MeasurementField, DeviceType>> = {
  indoorTempC: 'TEMPERATURE_SENSOR',
  indoorHumidityPct: 'HUMIDITY_SENSOR',
  airQualityIndex: 'AIR_QUALITY_SENSOR',
  heartRateBpm: 'SMART_WATCH',
  activityStepsPerHour: 'SMART_WATCH',
  skinTempC: 'SMART_WATCH',
};

/**
 * The field a device type is primarily responsible for.
 *
 * A smart watch supplies three fields; its heart rate is the one an operator
 * is watching, so that is what a per-device console row reports.
 */
export function primaryFieldForDevice(type: DeviceType): MeasurementField | null {
  const entry = (Object.entries(FIELD_DEVICE) as [MeasurementField, DeviceType][]).find(
    ([, deviceType]) => deviceType === type,
  );
  return entry ? entry[0] : null;
}

/** Whether a quality band means the displayed number is not current. */
export function isHeldQuality(quality: DataQuality): boolean {
  return quality === 'STALE' || quality === 'OFFLINE';
}

/** Fields supplied by a weather service rather than household hardware. */
const WEATHER_FIELDS = new Set<MeasurementField>([
  'outdoorTempC',
  'outdoorHumidityPct',
  'heatwaveDays',
]);

export const FIELD_LABELS_ZH: Record<MeasurementField, string> = {
  indoorTempC: '室內溫度',
  indoorHumidityPct: '室內濕度',
  outdoorTempC: '室外溫度',
  outdoorHumidityPct: '室外濕度',
  airQualityIndex: '空氣品質',
  heartRateBpm: '心率',
  activityStepsPerHour: '活動量',
  skinTempC: '體表溫度',
  heatwaveDays: '連續高溫天數',
};

export const QUALITY_LABELS_ZH: Record<DataQuality, string> = {
  LIVE: '即時',
  RECENT: '稍早',
  STALE: '已過時',
  OFFLINE: '離線',
};

const ORIGIN_LABELS_ZH: Record<DataOrigin, string> = {
  DEVICE: '裝置',
  WEATHER_API: '氣象服務',
  SIMULATOR: '模擬資料',
  HELD: '沿用上次讀值',
  DEFAULT: '預設值',
};

export function qualityLabelZh(quality: DataQuality): string {
  return QUALITY_LABELS_ZH[quality];
}

export function originLabelZh(origin: DataOrigin): string {
  return ORIGIN_LABELS_ZH[origin];
}

const QUALITY_ORDER: Record<DataQuality, number> = {
  LIVE: 0,
  RECENT: 1,
  STALE: 2,
  OFFLINE: 3,
};

/** Freshness from age alone. Device availability is applied separately. */
export function qualityFromAge(ageSec: number): DataQuality {
  if (ageSec <= FRESHNESS.liveSec) return 'LIVE';
  if (ageSec <= FRESHNESS.recentSec) return 'RECENT';
  return 'STALE';
}

/**
 * Turn one field's situation into its provenance record.
 *
 * Both the live assembler and `buildProvenance` route through here, so there
 * is exactly one answer in the codebase to "is this value current, and what
 * produced it". Phase 1 removed three competing answers from the UI; adding a
 * second one on the server would put the problem straight back.
 */
export function fieldProvenance(args: {
  field: MeasurementField;
  origin: DataOrigin;
  observedAt: string;
  now: Date;
  simulated: boolean;
  /** Set when the value is held because its source could not report. */
  held?: boolean;
  deviceId?: string;
  deviceName?: string;
  noteZh?: string;
  note?: string;
}): FieldProvenance {
  const ageSec = Math.max(
    0,
    Math.round((args.now.getTime() - new Date(args.observedAt).getTime()) / 1000),
  );

  return {
    field: args.field,
    origin: args.origin,
    quality: args.held ? 'OFFLINE' : qualityFromAge(ageSec),
    observedAt: args.observedAt,
    ageSec,
    deviceId: args.deviceId,
    deviceName: args.deviceName,
    simulated: args.simulated,
    noteZh: args.noteZh,
    note: args.note,
  };
}

export interface BuildProvenanceArgs {
  reading: ReadingSnapshot;
  /** The resident's devices, whose status decides whether a field is live. */
  devices: Device[];
  /**
   * True when the values came from the simulator rather than real hardware.
   * Until a real ingestion path exists this is the normal case, and the UI
   * says so rather than implying a device is attached.
   */
  simulated: boolean;
  /**
   * False when the platform is not monitoring this resident (suspended or
   * inactive). Their last reading is real but nothing is refreshing it, and
   * saying "2 minutes old" about a value frozen since boot would be a lie of
   * exactly the kind this module exists to prevent.
   */
  monitored?: boolean;
  now?: Date;
}

/**
 * Build per-field provenance for one reading.
 *
 * A field is OFFLINE when the device responsible for it is offline or
 * disabled - in that case the simulator has held the previous value, so the
 * number on screen is real but old, and is labelled HELD.
 */
export function buildProvenance(args: BuildProvenanceArgs): ReadingProvenance {
  const { reading, devices, simulated, monitored = true, now = new Date() } = args;

  const fields = {} as Record<MeasurementField, FieldProvenance>;
  const degradedFields: MeasurementField[] = [];
  const estimatedFields: MeasurementField[] = [];
  let worst: DataQuality = 'LIVE';

  for (const field of MEASUREMENT_FIELDS) {
    const provenance = buildField(field, reading, devices, simulated, now, monitored);
    fields[field] = provenance;

    if (provenance.quality !== 'LIVE') degradedFields.push(field);
    if (provenance.origin === 'DEFAULT') estimatedFields.push(field);
    if (QUALITY_ORDER[provenance.quality] > QUALITY_ORDER[worst]) worst = provenance.quality;
  }

  return {
    at: now.toISOString(),
    fields,
    worstQuality: worst,
    degradedFields,
    estimatedFields,
    anySimulated: simulated,
  };
}

function buildField(
  field: MeasurementField,
  reading: ReadingSnapshot,
  devices: Device[],
  simulated: boolean,
  now: Date,
  monitored: boolean,
): FieldProvenance {
  const base = {
    field,
    simulated,
    observedAt: reading.timestamp,
    ageSec: Math.max(0, Math.round((now.getTime() - new Date(reading.timestamp).getTime()) / 1000)),
  };

  /**
   * A resident who is not being monitored has no current data by definition.
   * This is stated before anything else, because "the sensor is fine, we are
   * simply not looking" is a different situation from a hardware fault and
   * calls for a different response.
   */
  if (!monitored) {
    return {
      ...base,
      origin: 'HELD',
      quality: 'OFFLINE',
      noteZh: '此住戶目前未納入監測，數值為最後一次讀值',
      note: 'This resident is not being monitored; showing the last reading',
    };
  }

  // --- Weather-derived fields ---------------------------------------------
  if (WEATHER_FIELDS.has(field)) {
    /**
     * No weather provider is connected yet (Phase 4). These values come from
     * the resident's ambient profile, so they are labelled SIMULATOR rather
     * than WEATHER_API - claiming a live weather feed would be the same kind
     * of fiction the data-sources page used to print.
     */
    return {
      ...base,
      origin: simulated ? 'SIMULATOR' : 'WEATHER_API',
      quality: qualityFromAge(base.ageSec),
      noteZh: simulated ? '尚未連接氣象服務，目前使用模擬資料' : undefined,
      note: simulated ? 'No weather service connected; simulated value' : undefined,
    };
  }

  // --- Device-backed fields ------------------------------------------------
  const deviceType = FIELD_DEVICE[field];
  const device = deviceType ? devices.find((d) => d.type === deviceType) : undefined;

  if (!device) {
    /**
     * No sensor of this type is installed, so the value is a current estimate
     * from the household's environmental model rather than a measurement.
     *
     * It is deliberately NOT reported as OFFLINE. Nothing has failed, the
     * number is fresh, and marking 42 of 50 households permanently degraded
     * would train every reader to ignore the badge. What must be visible is
     * that this is an estimate - which the DEFAULT origin says, and which the
     * summary states separately from any freshness problem.
     */
    return {
      ...base,
      origin: 'DEFAULT',
      quality: qualityFromAge(base.ageSec),
      noteZh: '未安裝感測器，此為環境模型推估值',
      note: 'No sensor installed; value estimated from the environment model',
    };
  }

  const down = device.status === 'OFFLINE' || device.status === 'DISABLED';

  if (down) {
    /**
     * The simulator holds the previous value when a device is down, so the
     * displayed number is a real past measurement rather than a fabrication.
     * Its age is measured from the device's last contact, not the snapshot.
     */
    const heldAgeSec = Math.max(
      0,
      Math.round((now.getTime() - new Date(device.lastSeen).getTime()) / 1000),
    );

    return {
      ...base,
      origin: 'HELD',
      quality: 'OFFLINE',
      observedAt: device.lastSeen,
      ageSec: heldAgeSec,
      deviceId: device.deviceId,
      deviceName: device.nameZh,
      noteZh:
        device.status === 'DISABLED'
          ? '裝置已由管理者停用，數值為最後一次讀值'
          : '裝置離線，數值為最後一次讀值',
      note:
        device.status === 'DISABLED'
          ? 'Device disabled by an administrator; showing its last value'
          : 'Device offline; showing its last value',
    };
  }

  return {
    ...base,
    origin: simulated ? 'SIMULATOR' : 'DEVICE',
    quality: qualityFromAge(base.ageSec),
    deviceId: device.deviceId,
    deviceName: device.nameZh,
    noteZh: simulated ? '模擬感測資料' : undefined,
    note: simulated ? 'Simulated sensor data' : undefined,
  };
}

/**
 * Provenance for a reading with no device context.
 *
 * Used as the default when `assessRisk` is called without provenance - chiefly
 * by unit tests, which care about scoring rather than data quality. Everything
 * is reported as simulated and live, which is exactly what it is.
 */
export function defaultProvenance(
  reading: ReadingSnapshot,
  now: Date = new Date(),
): ReadingProvenance {
  return buildProvenance({ reading, devices: [], simulated: reading.simulated, now });
}

/**
 * Whether the assessment rests on data good enough to act on confidently.
 *
 * Physiological fields going offline matters more than air quality going
 * offline, because the personal-baseline comparison is the part of the model
 * that cannot be substituted by anything else.
 */
export function provenanceSummaryZh(provenance: ReadingProvenance): string | null {
  const offline = provenance.degradedFields.filter(
    (f) => provenance.fields[f].quality === 'OFFLINE',
  );

  if (offline.length > 0) {
    const names = offline.map((f) => FIELD_LABELS_ZH[f]).join('、');
    return `${names} 目前無法更新，畫面顯示的是最後一次讀值。`;
  }

  if (provenance.degradedFields.length > 0) return '部分數值稍早取得，仍在可用範圍內。';

  return null;
}

/**
 * Which values are modelled rather than measured.
 *
 * Kept separate from the freshness summary on purpose: an estimate is not a
 * fault, and mixing the two would either raise a false alarm or bury a real
 * one. Returns null when every field has a sensor behind it.
 */
export function estimatedSummaryZh(provenance: ReadingProvenance): string | null {
  if (provenance.estimatedFields.length === 0) return null;

  const names = provenance.estimatedFields.map((f) => FIELD_LABELS_ZH[f]).join('、');
  return `${names} 未安裝感測器，數值由環境模型推估。`;
}
