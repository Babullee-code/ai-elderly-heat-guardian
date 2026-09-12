/**
 * Seed data definitions.
 *
 * Everything here is clearly simulated: every reading the platform generates
 * carries `simulated: true`, and the seeded devices, users and locations are
 * fictional. The Taipei districts and their coordinates are real so the map
 * is geographically coherent.
 *
 * The demo headline numbers (48 active users, 3 HIGH, 8 MEDIUM) are NOT
 * hard-coded anywhere. They emerge from the ambient profiles below being fed
 * through the real risk engine, which is the point: the counts on the CMS
 * dashboard are computed, not typed in.
 */

import type {
  Account,
  Caregiver,
  ContentArticle,
  CoolingSpace,
  DataSource,
  Device,
  DeviceType,
  ElderlyUser,
  PersonalBaseline,
  SystemSetting,
} from '../../shared/types/domain.js';
import type { AmbientProfile } from '../../shared/domain/simulationEngine.js';

// ---------------------------------------------------------------------------
// Taipei geography
// ---------------------------------------------------------------------------

export interface DistrictSpec {
  name: string;
  nameEn: string;
  lat: number;
  lng: number;
  /** Urban density index 0..100 - drives the urban heat island effect. */
  urbanDensity: number;
  greenCoveragePct: number;
}

export const TAIPEI_DISTRICTS: DistrictSpec[] = [
  { name: '中正區', nameEn: 'Zhongzheng', lat: 25.0324, lng: 121.5182, urbanDensity: 88, greenCoveragePct: 14 },
  { name: '大同區', nameEn: 'Datong', lat: 25.0631, lng: 121.5133, urbanDensity: 92, greenCoveragePct: 9 },
  { name: '中山區', nameEn: 'Zhongshan', lat: 25.0641, lng: 121.5335, urbanDensity: 86, greenCoveragePct: 16 },
  { name: '松山區', nameEn: 'Songshan', lat: 25.0497, lng: 121.5577, urbanDensity: 90, greenCoveragePct: 12 },
  { name: '大安區', nameEn: "Da'an", lat: 25.0263, lng: 121.5436, urbanDensity: 84, greenCoveragePct: 19 },
  { name: '萬華區', nameEn: 'Wanhua', lat: 25.0286, lng: 121.4995, urbanDensity: 94, greenCoveragePct: 8 },
  { name: '信義區', nameEn: 'Xinyi', lat: 25.0330, lng: 121.5654, urbanDensity: 82, greenCoveragePct: 22 },
  { name: '士林區', nameEn: 'Shilin', lat: 25.0928, lng: 121.5240, urbanDensity: 58, greenCoveragePct: 44 },
  { name: '北投區', nameEn: 'Beitou', lat: 25.1324, lng: 121.4982, urbanDensity: 46, greenCoveragePct: 57 },
  { name: '內湖區', nameEn: 'Neihu', lat: 25.0697, lng: 121.5946, urbanDensity: 62, greenCoveragePct: 38 },
  { name: '南港區', nameEn: 'Nangang', lat: 25.0554, lng: 121.6067, urbanDensity: 68, greenCoveragePct: 31 },
  { name: '文山區', nameEn: 'Wenshan', lat: 24.9889, lng: 121.5703, urbanDensity: 54, greenCoveragePct: 49 },
];

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

interface UserSpec {
  id: string;
  name: string;
  nameEn: string;
  age: number;
  gender: ElderlyUser['gender'];
  districtIndex: number;
  conditions: string[];
  medications: string[];
  /** Resting heart-rate band that defines this person's personal baseline. */
  hrMin: number;
  hrMax: number;
  /**
   * Ambient conditions - these determine the risk level the engine derives.
   *
   * `indoorTempC` and `humidityPct` are chosen against the NOAA heat-index
   * curve so the engine lands each resident in the intended band:
   *   heat index below 32C   -> LOW
   *   heat index 32C to 39C  -> MEDIUM
   *   heat index 39C upwards -> HIGH
   *
   * `outdoorTempC` is not free: the simulation drifts indoor temperature
   * toward `outdoor - 2.2 / heatSensitivity`, so outdoor is derived from the
   * intended indoor value by `outdoorFor()` below. Setting it independently
   * would let the live reading drift away from the seeded intent within a
   * minute of boot.
   */
  indoorTempC: number;
  humidityPct: number;
  heatwaveDays: number;
  /** How poorly the home resists heat. >1 heats up faster. */
  heatSensitivity: number;
  /** Resting heart rate as a fraction into the baseline band. */
  hrPosition: number;
  activityMean: number;
  permissions?: Partial<ElderlyUser['permissions']>;
  status?: ElderlyUser['status'];
  /** Device types this user actually has. */
  devices: DeviceType[];
  /** Devices seeded in a non-ONLINE state, so device health is not uniform. */
  offlineDevices?: DeviceType[];
}

/**
 * Hand-authored cohort.
 *
 * Ambient conditions are chosen so the engine derives exactly 3 HIGH and
 * 8 MEDIUM users at rest, matching the demo narrative, while the remaining
 * 37 sit at LOW.
 */
const HAND_AUTHORED: UserSpec[] = [
  // --- The demo protagonist. Starts LOW; the scenario drives her to HIGH. ---
  {
    id: 'user-001',
    name: '王奶奶',
    nameEn: 'Grandma Wang',
    age: 78,
    gender: 'F',
    districtIndex: 4,
    conditions: ['高血壓', '第二型糖尿病'],
    medications: ['氫氯噻嗪（利尿劑）', 'Metformin'],
    hrMin: 65,
    hrMax: 82,
    indoorTempC: 27.4,
    humidityPct: 62,
    heatwaveDays: 1,
    heatSensitivity: 1.25,
    hrPosition: 0.5,
    activityMean: 180,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SMART_AC', 'FAN'],
  },

  // --- The three HIGH-risk users the CMS dashboard reports at boot. --------
  {
    id: 'user-002',
    name: '陳爺爺',
    nameEn: 'Grandpa Chen',
    age: 83,
    gender: 'M',
    districtIndex: 5,
    conditions: ['心衰竭', '慢性腎病'],
    medications: ['Furosemide（利尿劑）', 'Carvedilol'],
    hrMin: 58,
    hrMax: 74,
    indoorTempC: 33.0,
    humidityPct: 78,
    heatwaveDays: 5,
    heatSensitivity: 1.5,
    hrPosition: 1.55,
    activityMean: 90,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'FAN'],
  },
  {
    id: 'user-003',
    name: '林阿嬤',
    nameEn: 'Grandma Lin',
    age: 87,
    gender: 'F',
    districtIndex: 1,
    conditions: ['失智症（輕度）', '骨關節炎'],
    medications: ['Donepezil'],
    hrMin: 62,
    hrMax: 80,
    indoorTempC: 32.8,
    humidityPct: 77,
    heatwaveDays: 5,
    heatSensitivity: 1.6,
    hrPosition: 1.5,
    activityMean: 70,
    permissions: { automaticCooling: false },
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR'],
  },
  {
    id: 'user-004',
    name: '黃伯伯',
    nameEn: 'Uncle Huang',
    age: 80,
    gender: 'M',
    districtIndex: 3,
    conditions: ['慢性阻塞性肺病'],
    medications: ['Salbutamol 吸入劑'],
    hrMin: 70,
    hrMax: 88,
    indoorTempC: 32.6,
    humidityPct: 80,
    heatwaveDays: 4,
    heatSensitivity: 1.45,
    hrPosition: 1.45,
    activityMean: 110,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'AIR_QUALITY_SENSOR', 'SMART_AC'],
    offlineDevices: ['SMART_AC'],
  },

  // --- The eight MEDIUM-risk users. ---------------------------------------
  {
    id: 'user-005',
    name: '張奶奶',
    nameEn: 'Grandma Zhang',
    age: 76,
    gender: 'F',
    districtIndex: 0,
    conditions: ['高血壓'],
    medications: ['Amlodipine'],
    hrMin: 66,
    hrMax: 84,
    indoorTempC: 30.2,
    humidityPct: 72,
    heatwaveDays: 3,
    heatSensitivity: 1.2,
    hrPosition: 1.15,
    activityMean: 200,
    // Has cooling, but has not authorised the platform to use it.
    permissions: { automaticCooling: false },
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SMART_AC', 'DEHUMIDIFIER'],
  },
  {
    id: 'user-006',
    name: '李爺爺',
    nameEn: 'Grandpa Li',
    age: 81,
    gender: 'M',
    districtIndex: 2,
    conditions: ['心房顫動'],
    medications: ['Apixaban'],
    hrMin: 60,
    hrMax: 78,
    indoorTempC: 30.0,
    humidityPct: 70,
    heatwaveDays: 3,
    heatSensitivity: 1.15,
    hrPosition: 1.2,
    activityMean: 160,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'FAN'],
  },
  {
    id: 'user-007',
    name: '吳阿嬤',
    nameEn: 'Grandma Wu',
    age: 79,
    gender: 'F',
    districtIndex: 6,
    conditions: ['甲狀腺功能低下'],
    medications: ['Levothyroxine'],
    hrMin: 64,
    hrMax: 80,
    indoorTempC: 30.4,
    humidityPct: 71,
    heatwaveDays: 2,
    heatSensitivity: 1.1,
    hrPosition: 1.1,
    activityMean: 210,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SMART_AC'],
    // The air conditioner has faulted, so the home cannot cool itself.
    offlineDevices: ['SMART_AC'],
  },
  {
    id: 'user-008',
    name: '劉伯伯',
    nameEn: 'Uncle Liu',
    age: 84,
    gender: 'M',
    districtIndex: 9,
    conditions: ['腦中風病史'],
    medications: ['Clopidogrel'],
    hrMin: 68,
    hrMax: 86,
    indoorTempC: 30.6,
    humidityPct: 70,
    heatwaveDays: 3,
    heatSensitivity: 1.2,
    hrPosition: 1.12,
    activityMean: 130,
    // No air conditioning in this home - a fan cannot lower air temperature.
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'FAN'],
  },
  {
    id: 'user-009',
    name: '蔡奶奶',
    nameEn: 'Grandma Tsai',
    age: 74,
    gender: 'F',
    districtIndex: 10,
    conditions: ['骨質疏鬆'],
    medications: ['Alendronate'],
    hrMin: 67,
    hrMax: 85,
    indoorTempC: 29.9,
    humidityPct: 73,
    heatwaveDays: 2,
    heatSensitivity: 1.08,
    hrPosition: 1.08,
    activityMean: 240,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'DEHUMIDIFIER'],
    offlineDevices: ['DEHUMIDIFIER'],
  },
  {
    id: 'user-010',
    name: '鄭爺爺',
    nameEn: 'Grandpa Zheng',
    age: 86,
    gender: 'M',
    districtIndex: 7,
    conditions: ['前列腺疾病', '高血壓'],
    medications: ['Tamsulosin', 'Losartan'],
    hrMin: 59,
    hrMax: 76,
    indoorTempC: 30.3,
    humidityPct: 71,
    heatwaveDays: 3,
    heatSensitivity: 1.18,
    hrPosition: 1.18,
    activityMean: 100,
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR'],
    offlineDevices: ['HUMIDITY_SENSOR'],
  },
  {
    id: 'user-011',
    name: '許阿嬤',
    nameEn: 'Grandma Xu',
    age: 77,
    gender: 'F',
    districtIndex: 11,
    conditions: ['憂鬱症'],
    medications: ['Sertraline'],
    hrMin: 70,
    hrMax: 88,
    indoorTempC: 30.1,
    humidityPct: 72,
    heatwaveDays: 2,
    heatSensitivity: 1.05,
    hrPosition: 1.1,
    activityMean: 150,
    permissions: { automaticCooling: false },
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'SMART_AC'],
  },
  {
    id: 'user-012',
    name: '謝伯伯',
    nameEn: 'Uncle Xie',
    age: 82,
    gender: 'M',
    districtIndex: 8,
    conditions: ['帕金森氏症'],
    medications: ['Levodopa'],
    hrMin: 63,
    hrMax: 81,
    indoorTempC: 30.5,
    humidityPct: 69,
    heatwaveDays: 2,
    heatSensitivity: 1.12,
    hrPosition: 1.14,
    activityMean: 85,
    permissions: { locationSharing: false },
    devices: ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'FAN'],
  },
];

/** Surnames and given-name fragments for the generated remainder. */
const SURNAMES = ['周', '徐', '孫', '馬', '朱', '胡', '郭', '何', '高', '羅', '梁', '宋', '唐', '韓', '曹', '曾', '彭', '呂', '蘇', '盧'];
const SURNAMES_EN = ['Zhou', 'Xu', 'Sun', 'Ma', 'Zhu', 'Hu', 'Guo', 'He', 'Gao', 'Luo', 'Liang', 'Song', 'Tang', 'Han', 'Cao', 'Zeng', 'Peng', 'Lyu', 'Su', 'Lu'];

const CONDITION_POOL = [
  ['高血壓'],
  ['第二型糖尿病'],
  ['高血壓', '高血脂'],
  ['骨關節炎'],
  ['白內障'],
  ['輕度貧血'],
  ['慢性胃炎'],
  [],
];

const MEDICATION_POOL = [
  ['Amlodipine'],
  ['Metformin'],
  ['Atorvastatin'],
  ['Acetaminophen'],
  [],
  ['Losartan'],
];

/**
 * Deterministic pseudo-random generator.
 *
 * The seed must be reproducible: judges re-running `npm run db:reset` should
 * get the same cohort, so Math.random is not used here.
 */
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * Generate the remaining 38 LOW-risk users.
 *
 * Total cohort is 50 registered residents, of which 48 are ACTIVE - the figure
 * the CMS dashboard reports. The two non-active records exist so that "active
 * users" is a genuine status filter rather than a table row count.
 */
function generateRemainder(): UserSpec[] {
  const rng = makeRng(20260903);
  const specs: UserSpec[] = [];

  for (let i = 0; i < 38; i++) {
    const n = i + 13;
    const surnameIdx = i % SURNAMES.length;
    const isFemale = i % 2 === 0;
    const hrMin = 58 + Math.floor(rng() * 12);

    const status: ElderlyUser['status'] =
      i === 36 ? 'SUSPENDED' : i === 37 ? 'INACTIVE' : 'ACTIVE';

    const deviceSets: DeviceType[][] = [
      ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SMART_AC'],
      ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR'],
      ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'FAN'],
      ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'SMART_AC', 'DEHUMIDIFIER'],
      ['SMART_WATCH', 'TEMPERATURE_SENSOR', 'HUMIDITY_SENSOR', 'AIR_QUALITY_SENSOR', 'FAN'],
    ];

    specs.push({
      id: `user-${String(n).padStart(3, '0')}`,
      name: `${SURNAMES[surnameIdx]}${isFemale ? '奶奶' : '爺爺'}`,
      nameEn: `${isFemale ? 'Grandma' : 'Grandpa'} ${SURNAMES_EN[surnameIdx]}`,
      age: 68 + Math.floor(rng() * 22),
      gender: isFemale ? 'F' : 'M',
      districtIndex: i % TAIPEI_DISTRICTS.length,
      conditions: CONDITION_POOL[i % CONDITION_POOL.length],
      medications: MEDICATION_POOL[i % MEDICATION_POOL.length],
      hrMin,
      hrMax: hrMin + 16 + Math.floor(rng() * 6),
      // Comfortable: heat index lands below the 27C LOW advisory floor or just
      // above it, never near the 32C MEDIUM threshold.
      indoorTempC: 24.5 + rng() * 2.5,
      humidityPct: 48 + rng() * 12,
      heatwaveDays: rng() > 0.75 ? 1 : 0,
      heatSensitivity: 0.85 + rng() * 0.3,
      hrPosition: 0.25 + rng() * 0.5,
      activityMean: 140 + Math.floor(rng() * 180),
      status,
      devices: deviceSets[i % deviceSets.length],
      // A handful of offline devices so "96% online" is a computed figure.
      offlineDevices: i === 3 ? ['TEMPERATURE_SENSOR'] : i === 17 ? ['SMART_WATCH'] : undefined,
    });
  }

  return specs;
}

export const USER_SPECS: UserSpec[] = [...HAND_AUTHORED, ...generateRemainder()];

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

export function baselineFor(spec: UserSpec): PersonalBaseline {
  const mean = Math.round((spec.hrMin + spec.hrMax) / 2);
  return {
    userId: spec.id,
    heartRate: { min: spec.hrMin, max: spec.hrMax, mean },
    skinTemp: { min: 32.8, max: 34.4, mean: 33.6 },
    activityStepsPerHour: {
      min: Math.round(spec.activityMean * 0.35),
      max: Math.round(spec.activityMean * 1.8),
      mean: spec.activityMean,
    },
    // A seeded baseline represents ~14 days of learning at 12 samples/day.
    sampleCount: 168,
    confidence: 0.93,
    learnedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  };
}

/**
 * Outdoor temperature that holds a home at its intended indoor temperature.
 *
 * The simulation drifts indoor temperature toward
 * `outdoor - 2.2 / heatSensitivity` (see `tickReadings`), so outdoor is the
 * dependent variable here. Deriving it keeps the live readings consistent
 * with the seeded intent instead of drifting away from it after boot.
 */
function outdoorFor(spec: UserSpec): number {
  return Math.round((spec.indoorTempC + 2.2 / spec.heatSensitivity) * 10) / 10;
}

export function ambientProfileFor(spec: UserSpec): AmbientProfile {
  return {
    userId: spec.id,
    baseIndoorTempC: spec.indoorTempC,
    baseIndoorHumidityPct: spec.humidityPct,
    baseOutdoorTempC: outdoorFor(spec),
    // Indoor humidity settles at outdoor minus 4 with no appliance running,
    // so outdoor is set 4 points above the intended indoor value.
    baseOutdoorHumidityPct: Math.min(96, spec.humidityPct + 4),
    baseAirQualityIndex: 42 + Math.round(TAIPEI_DISTRICTS[spec.districtIndex].urbanDensity * 0.5),
    baseHeatwaveDays: spec.heatwaveDays,
    heatSensitivity: spec.heatSensitivity,
  };
}

export function elderlyUserFor(spec: UserSpec): Omit<ElderlyUser, 'createdAt' | 'updatedAt' | 'location'> {
  const district = TAIPEI_DISTRICTS[spec.districtIndex];

  // Spread users within their district so map markers do not overlap exactly.
  const jitter = makeRng(hashCode(spec.id));
  const lat = district.lat + (jitter() - 0.5) * 0.012;
  const lng = district.lng + (jitter() - 0.5) * 0.012;

  return {
    id: spec.id,
    name: spec.name,
    nameEn: spec.nameEn,
    age: spec.age,
    gender: spec.gender,
    city: '台北市',
    district: district.name,
    lat: Math.round(lat * 10000) / 10000,
    lng: Math.round(lng * 10000) / 10000,
    phone: `09${String(hashCode(spec.id) % 100000000).padStart(8, '0')}`,
    address: `台北市${district.name}示範路 ${(hashCode(spec.id) % 200) + 1} 號`,
    conditions: spec.conditions,
    medications: spec.medications,
    status: spec.status ?? 'ACTIVE',
    permissions: {
      automaticCooling: true,
      caregiverNotifications: true,
      locationSharing: true,
      physiologicalDataStorage: true,
      cityDataContribution: true,
      ...spec.permissions,
    },
    elderlyModeDefault: true,
    emergencyContact: {
      name: `${spec.name.slice(0, 1)}先生`,
      relationship: '家人',
      phone: `09${String((hashCode(spec.id) * 7) % 100000000).padStart(8, '0')}`,
    },
  };
}

const DEVICE_META: Record<DeviceType, { name: string; nameZh: string; location: string; actuator: boolean; battery: boolean }> = {
  SMART_WATCH: { name: 'Smart Watch', nameZh: '智慧手錶', location: '隨身', actuator: false, battery: true },
  TEMPERATURE_SENSOR: { name: 'Temperature Sensor', nameZh: '溫度感測器', location: '客廳', actuator: false, battery: true },
  HUMIDITY_SENSOR: { name: 'Humidity Sensor', nameZh: '濕度感測器', location: '客廳', actuator: false, battery: true },
  AIR_QUALITY_SENSOR: { name: 'Air Quality Sensor', nameZh: '空氣品質感測器', location: '臥室', actuator: false, battery: true },
  SMART_AC: { name: 'Smart Air Conditioner', nameZh: '智慧冷氣', location: '客廳', actuator: true, battery: false },
  DEHUMIDIFIER: { name: 'Dehumidifier', nameZh: '除濕機', location: '臥室', actuator: true, battery: false },
  FAN: { name: 'Smart Fan', nameZh: '智慧電風扇', location: '客廳', actuator: true, battery: false },
};

const DEVICE_PREFIX: Record<DeviceType, string> = {
  SMART_WATCH: 'HG-WATCH',
  TEMPERATURE_SENSOR: 'HG-TEMP',
  HUMIDITY_SENSOR: 'HG-HUMI',
  AIR_QUALITY_SENSOR: 'HG-AIRQ',
  SMART_AC: 'HG-AC',
  DEHUMIDIFIER: 'HG-DEHU',
  FAN: 'HG-FAN',
};

export function devicesFor(spec: UserSpec): Omit<Device, 'createdAt'>[] {
  const rng = makeRng(hashCode(spec.id) + 7);
  const userNumber = spec.id.replace('user-', '');

  return spec.devices.map((type, index) => {
    const meta = DEVICE_META[type];
    const isOffline = spec.offlineDevices?.includes(type) ?? false;
    const battery = meta.battery ? 18 + Math.floor(rng() * 80) : null;

    // Battery below 20% reports LOW_BATTERY rather than plain ONLINE, so the
    // device table shows a realistic spread of states.
    const status: Device['status'] = isOffline
      ? 'OFFLINE'
      : battery !== null && battery < 20
        ? 'LOW_BATTERY'
        : 'ONLINE';

    return {
      id: `dev-${userNumber}-${index + 1}`,
      deviceId: `${DEVICE_PREFIX[type]}-${userNumber}${index + 1}`,
      name: meta.name,
      nameZh: meta.nameZh,
      type,
      userId: spec.id,
      status,
      batteryPct: battery,
      signalPct: isOffline ? 0 : 55 + Math.floor(rng() * 45),
      lastSeen: isOffline
        ? new Date(Date.now() - 1000 * 60 * (30 + Math.floor(rng() * 300))).toISOString()
        : new Date().toISOString(),
      firmware: `v${2 + (index % 2)}.${1 + (index % 5)}.${Math.floor(rng() * 9)}`,
      location: meta.location,
      // Actuators start off; the policy engine decides when they run.
      power: false,
      isActuator: meta.actuator,
    };
  });
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// Caregivers
// ---------------------------------------------------------------------------

export const CAREGIVER_SEEDS: Omit<Caregiver, 'createdAt'>[] = [
  {
    id: 'cg-001',
    name: '王先生',
    nameEn: 'Mr. Wang',
    relationship: 'SON',
    phone: '0912345678',
    email: 'wang.son@example.com',
    assignedUserIds: ['user-001', 'user-005'],
    notificationPreferences: {
      channels: ['PUSH', 'SMS', 'IN_APP'],
      minLevel: 'LOW',
      quietHours: { enabled: false, from: '23:00', to: '06:00' },
    },
    emergencyPermission: true,
    status: 'ACTIVE',
  },
  {
    id: 'cg-002',
    name: '陳小姐',
    nameEn: 'Ms. Chen',
    relationship: 'DAUGHTER',
    phone: '0923456789',
    email: 'chen.daughter@example.com',
    assignedUserIds: ['user-002', 'user-006', 'user-010'],
    notificationPreferences: {
      channels: ['PUSH', 'IN_APP'],
      minLevel: 'MEDIUM',
      quietHours: { enabled: true, from: '23:00', to: '07:00' },
    },
    emergencyPermission: true,
    status: 'ACTIVE',
  },
  {
    id: 'cg-003',
    name: '護理師 周雅婷',
    nameEn: 'Nurse Zhou Ya-ting',
    relationship: 'NURSE',
    phone: '0934567890',
    email: 'zhou.nurse@example.com',
    assignedUserIds: ['user-003', 'user-004', 'user-012'],
    notificationPreferences: {
      channels: ['PUSH', 'SMS', 'EMAIL', 'IN_APP'],
      minLevel: 'LOW',
      quietHours: { enabled: false, from: '22:00', to: '07:00' },
    },
    emergencyPermission: true,
    status: 'ACTIVE',
  },
  {
    id: 'cg-004',
    name: '社工 林建宏',
    nameEn: 'Social Worker Lin Jian-hong',
    relationship: 'SOCIAL_WORKER',
    phone: '0945678901',
    email: 'lin.social@example.com',
    assignedUserIds: ['user-007', 'user-008', 'user-009', 'user-011'],
    notificationPreferences: {
      channels: ['EMAIL', 'IN_APP'],
      minLevel: 'MEDIUM',
      quietHours: { enabled: true, from: '18:00', to: '08:00' },
    },
    emergencyPermission: false,
    status: 'ACTIVE',
  },
  {
    id: 'cg-005',
    name: '鄰居 高美玲',
    nameEn: 'Neighbour Gao Mei-ling',
    relationship: 'NEIGHBOUR',
    phone: '0956789012',
    email: 'gao.neighbour@example.com',
    assignedUserIds: [],
    notificationPreferences: {
      channels: ['IN_APP'],
      minLevel: 'HIGH',
      quietHours: { enabled: true, from: '21:00', to: '08:00' },
    },
    emergencyPermission: false,
    status: 'INACTIVE',
  },
];

// ---------------------------------------------------------------------------
// Accounts (demo authentication)
// ---------------------------------------------------------------------------

export const ACCOUNT_SEEDS: Account[] = [
  {
    id: 'acc-elder',
    email: 'elder@example.com',
    name: 'Grandma Wang',
    nameZh: '王奶奶',
    role: 'ELDER',
    elderlyUserId: 'user-001',
    caregiverId: null,
    avatarColor: '#0d9488',
  },
  {
    id: 'acc-caregiver',
    email: 'caregiver@example.com',
    name: 'Mr. Wang',
    nameZh: '王先生',
    role: 'CAREGIVER',
    elderlyUserId: null,
    caregiverId: 'cg-001',
    avatarColor: '#2563eb',
  },
  {
    id: 'acc-admin',
    email: 'admin@example.com',
    name: 'Platform Admin',
    nameZh: '平台管理者',
    role: 'SUPER_ADMIN',
    elderlyUserId: null,
    caregiverId: null,
    avatarColor: '#7c3aed',
  },
  {
    id: 'acc-viewer',
    email: 'viewer@example.com',
    name: 'Observer',
    nameZh: '檢視者',
    role: 'VIEWER',
    elderlyUserId: null,
    caregiverId: null,
    avatarColor: '#64748b',
  },
];

// ---------------------------------------------------------------------------
// Cooling spaces
// ---------------------------------------------------------------------------

interface CoolingSeed {
  name: string;
  nameEn: string;
  type: CoolingSpace['type'];
  districtIndex: number;
  latOffset: number;
  lngOffset: number;
  ac: boolean;
  accessible: boolean;
  opensAt: string;
  closesAt: string;
  capacity: number;
  status?: CoolingSpace['status'];
  notes?: string;
}

const COOLING_SEEDS: CoolingSeed[] = [
  { name: '台北市立圖書館 總館', nameEn: 'Taipei Public Library Main Branch', type: 'LIBRARY', districtIndex: 4, latOffset: 0.002, lngOffset: -0.003, ac: true, accessible: true, opensAt: '08:30', closesAt: '21:00', capacity: 400 },
  { name: '大安區行政中心', nameEn: "Da'an District Office", type: 'PUBLIC_BUILDING', districtIndex: 4, latOffset: -0.004, lngOffset: 0.005, ac: true, accessible: true, opensAt: '08:30', closesAt: '17:30', capacity: 150 },
  { name: '大安森林公園', nameEn: "Da'an Forest Park", type: 'PARK', districtIndex: 4, latOffset: 0.005, lngOffset: 0.001, ac: false, accessible: true, opensAt: '00:00', closesAt: '24:00', capacity: 2000, notes: '樹蔭多，但無空調' },
  { name: '古亭捷運站', nameEn: 'Guting MRT Station', type: 'MRT_STATION', districtIndex: 4, latOffset: -0.007, lngOffset: -0.008, ac: true, accessible: true, opensAt: '06:00', closesAt: '24:00', capacity: 600 },
  { name: '大安社區活動中心', nameEn: "Da'an Community Centre", type: 'COMMUNITY_CENTER', districtIndex: 4, latOffset: 0.003, lngOffset: 0.006, ac: true, accessible: true, opensAt: '09:00', closesAt: '20:00', capacity: 120 },
  { name: '中正紀念堂', nameEn: 'CKS Memorial Hall', type: 'PUBLIC_BUILDING', districtIndex: 0, latOffset: 0.002, lngOffset: 0.002, ac: true, accessible: true, opensAt: '09:00', closesAt: '18:00', capacity: 800 },
  { name: '中正區健康服務中心', nameEn: 'Zhongzheng Health Centre', type: 'HEALTH_CENTER', districtIndex: 0, latOffset: -0.003, lngOffset: 0.004, ac: true, accessible: true, opensAt: '08:00', closesAt: '17:00', capacity: 80 },
  { name: '台北車站大廳', nameEn: 'Taipei Main Station Concourse', type: 'AIR_CONDITIONED_PUBLIC_SPACE', districtIndex: 0, latOffset: 0.014, lngOffset: -0.001, ac: true, accessible: true, opensAt: '05:30', closesAt: '24:00', capacity: 3000 },
  { name: '大同區圖書館', nameEn: 'Datong District Library', type: 'LIBRARY', districtIndex: 1, latOffset: 0.001, lngOffset: 0.002, ac: true, accessible: true, opensAt: '08:30', closesAt: '20:30', capacity: 180 },
  { name: '大同社區活動中心', nameEn: 'Datong Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 1, latOffset: -0.004, lngOffset: -0.002, ac: true, accessible: false, opensAt: '09:00', closesAt: '18:00', capacity: 90, notes: '二樓無電梯' },
  { name: '迪化街休憩站', nameEn: 'Dihua Street Rest Stop', type: 'AIR_CONDITIONED_PUBLIC_SPACE', districtIndex: 1, latOffset: 0.003, lngOffset: -0.005, ac: true, accessible: true, opensAt: '10:00', closesAt: '19:00', capacity: 40 },
  { name: '中山區行政中心', nameEn: 'Zhongshan District Office', type: 'PUBLIC_BUILDING', districtIndex: 2, latOffset: 0.002, lngOffset: 0.003, ac: true, accessible: true, opensAt: '08:30', closesAt: '17:30', capacity: 160 },
  { name: '中山捷運站地下街', nameEn: 'Zhongshan MRT Underground Mall', type: 'MRT_STATION', districtIndex: 2, latOffset: -0.002, lngOffset: -0.004, ac: true, accessible: true, opensAt: '06:00', closesAt: '24:00', capacity: 900 },
  { name: '中山區健康服務中心', nameEn: 'Zhongshan Health Centre', type: 'HEALTH_CENTER', districtIndex: 2, latOffset: 0.005, lngOffset: 0.001, ac: true, accessible: true, opensAt: '08:00', closesAt: '17:00', capacity: 70 },
  { name: '松山區圖書館', nameEn: 'Songshan District Library', type: 'LIBRARY', districtIndex: 3, latOffset: -0.001, lngOffset: 0.004, ac: true, accessible: true, opensAt: '08:30', closesAt: '21:00', capacity: 200 },
  { name: '松山社區活動中心', nameEn: 'Songshan Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 3, latOffset: 0.004, lngOffset: -0.003, ac: true, accessible: true, opensAt: '09:00', closesAt: '20:00', capacity: 110 },
  { name: '民生公園', nameEn: 'Minsheng Park', type: 'PARK', districtIndex: 3, latOffset: 0.006, lngOffset: 0.002, ac: false, accessible: true, opensAt: '00:00', closesAt: '24:00', capacity: 500, notes: '無空調，建議傍晚前往' },
  { name: '萬華區圖書館', nameEn: 'Wanhua District Library', type: 'LIBRARY', districtIndex: 5, latOffset: 0.002, lngOffset: 0.003, ac: true, accessible: true, opensAt: '08:30', closesAt: '20:30', capacity: 170 },
  { name: '龍山寺捷運站', nameEn: 'Longshan Temple MRT Station', type: 'MRT_STATION', districtIndex: 5, latOffset: -0.003, lngOffset: 0.001, ac: true, accessible: true, opensAt: '06:00', closesAt: '24:00', capacity: 700 },
  { name: '萬華社區活動中心', nameEn: 'Wanhua Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 5, latOffset: 0.004, lngOffset: -0.004, ac: true, accessible: true, opensAt: '09:00', closesAt: '19:00', capacity: 130 },
  { name: '萬華區健康服務中心', nameEn: 'Wanhua Health Centre', type: 'HEALTH_CENTER', districtIndex: 5, latOffset: -0.005, lngOffset: -0.002, ac: true, accessible: true, opensAt: '08:00', closesAt: '17:00', capacity: 60 },
  { name: '信義區公民會館', nameEn: 'Xinyi Civic Centre', type: 'PUBLIC_BUILDING', districtIndex: 6, latOffset: 0.001, lngOffset: 0.002, ac: true, accessible: true, opensAt: '09:00', closesAt: '17:00', capacity: 220 },
  { name: '信義區圖書館', nameEn: 'Xinyi District Library', type: 'LIBRARY', districtIndex: 6, latOffset: -0.003, lngOffset: 0.005, ac: true, accessible: true, opensAt: '08:30', closesAt: '21:00', capacity: 190 },
  { name: '象山公園', nameEn: 'Xiangshan Park', type: 'PARK', districtIndex: 6, latOffset: -0.006, lngOffset: 0.007, ac: false, accessible: false, opensAt: '00:00', closesAt: '24:00', capacity: 300, notes: '山坡地形，行動不便者不建議' },
  { name: '士林區圖書館', nameEn: 'Shilin District Library', type: 'LIBRARY', districtIndex: 7, latOffset: 0.002, lngOffset: 0.001, ac: true, accessible: true, opensAt: '08:30', closesAt: '20:30', capacity: 160 },
  { name: '士林社區活動中心', nameEn: 'Shilin Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 7, latOffset: -0.004, lngOffset: 0.003, ac: true, accessible: true, opensAt: '09:00', closesAt: '20:00', capacity: 100 },
  { name: '士林區健康服務中心', nameEn: 'Shilin Health Centre', type: 'HEALTH_CENTER', districtIndex: 7, latOffset: 0.005, lngOffset: -0.002, ac: true, accessible: true, opensAt: '08:00', closesAt: '17:00', capacity: 65 },
  { name: '北投圖書館', nameEn: 'Beitou Branch Library', type: 'LIBRARY', districtIndex: 8, latOffset: 0.001, lngOffset: 0.002, ac: true, accessible: true, opensAt: '08:30', closesAt: '17:00', capacity: 140 },
  { name: '北投社區活動中心', nameEn: 'Beitou Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 8, latOffset: -0.003, lngOffset: -0.003, ac: true, accessible: true, opensAt: '09:00', closesAt: '18:00', capacity: 95 },
  { name: '北投公園', nameEn: 'Beitou Park', type: 'PARK', districtIndex: 8, latOffset: 0.004, lngOffset: 0.001, ac: false, accessible: true, opensAt: '00:00', closesAt: '24:00', capacity: 600 },
  { name: '內湖區圖書館', nameEn: 'Neihu District Library', type: 'LIBRARY', districtIndex: 9, latOffset: 0.002, lngOffset: -0.002, ac: true, accessible: true, opensAt: '08:30', closesAt: '21:00', capacity: 175 },
  { name: '內湖區行政中心', nameEn: 'Neihu District Office', type: 'PUBLIC_BUILDING', districtIndex: 9, latOffset: -0.002, lngOffset: 0.004, ac: true, accessible: true, opensAt: '08:30', closesAt: '17:30', capacity: 140 },
  { name: '大湖公園', nameEn: 'Dahu Park', type: 'PARK', districtIndex: 9, latOffset: 0.007, lngOffset: 0.005, ac: false, accessible: true, opensAt: '00:00', closesAt: '24:00', capacity: 800 },
  { name: '內湖社區活動中心', nameEn: 'Neihu Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 9, latOffset: -0.005, lngOffset: -0.004, ac: true, accessible: true, opensAt: '09:00', closesAt: '20:00', capacity: 105 },
  { name: '南港區圖書館', nameEn: 'Nangang District Library', type: 'LIBRARY', districtIndex: 10, latOffset: 0.001, lngOffset: 0.003, ac: true, accessible: true, opensAt: '08:30', closesAt: '20:30', capacity: 150 },
  { name: '南港展覽館', nameEn: 'Nangang Exhibition Centre', type: 'AIR_CONDITIONED_PUBLIC_SPACE', districtIndex: 10, latOffset: 0.004, lngOffset: 0.006, ac: true, accessible: true, opensAt: '09:00', closesAt: '18:00', capacity: 2500 },
  { name: '南港社區活動中心', nameEn: 'Nangang Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 10, latOffset: -0.003, lngOffset: -0.002, ac: true, accessible: false, opensAt: '09:00', closesAt: '19:00', capacity: 85, notes: '入口有三階台階' },
  { name: '文山區圖書館', nameEn: 'Wenshan District Library', type: 'LIBRARY', districtIndex: 11, latOffset: 0.002, lngOffset: 0.002, ac: true, accessible: true, opensAt: '08:30', closesAt: '21:00', capacity: 165 },
  { name: '木柵公園', nameEn: 'Muzha Park', type: 'PARK', districtIndex: 11, latOffset: -0.004, lngOffset: 0.004, ac: false, accessible: true, opensAt: '00:00', closesAt: '24:00', capacity: 450 },
  { name: '文山區健康服務中心', nameEn: 'Wenshan Health Centre', type: 'HEALTH_CENTER', districtIndex: 11, latOffset: 0.003, lngOffset: -0.003, ac: true, accessible: true, opensAt: '08:00', closesAt: '17:00', capacity: 70 },
  { name: '文山社區活動中心', nameEn: 'Wenshan Community Centre', type: 'COMMUNITY_CENTER', districtIndex: 11, latOffset: -0.006, lngOffset: -0.001, ac: true, accessible: true, opensAt: '09:00', closesAt: '20:00', capacity: 115 },
  // Seeded as DISABLED so the CMS "active spaces" count is a real filter and
  // there is an existing example of a location withdrawn from recommendations.
  { name: '舊松山活動中心（整修中）', nameEn: 'Old Songshan Centre (under renovation)', type: 'COMMUNITY_CENTER', districtIndex: 3, latOffset: -0.005, lngOffset: 0.006, ac: true, accessible: false, opensAt: '09:00', closesAt: '17:00', capacity: 60, status: 'DISABLED', notes: '整修中，暫不開放' },
];

export function coolingSpaceSeeds(): Omit<CoolingSpace, 'createdAt'>[] {
  return COOLING_SEEDS.map((seed, index) => {
    const district = TAIPEI_DISTRICTS[seed.districtIndex];

    // A space's own risk level follows its district's urban heat character and
    // whether it is air conditioned.
    const riskLevel: CoolingSpace['riskLevel'] = seed.ac
      ? 'LOW'
      : district.urbanDensity > 80
        ? 'HIGH'
        : district.greenCoveragePct > 40
          ? 'LOW'
          : 'MEDIUM';

    return {
      id: `cool-${String(index + 1).padStart(3, '0')}`,
      name: seed.name,
      nameEn: seed.nameEn,
      type: seed.type,
      address: `台北市${district.name}`,
      district: district.name,
      lat: Math.round((district.lat + seed.latOffset) * 10000) / 10000,
      lng: Math.round((district.lng + seed.lngOffset) * 10000) / 10000,
      riskLevel,
      airConditioned: seed.ac,
      accessible: seed.accessible,
      accessibilityNotes: seed.notes ?? (seed.accessible ? '無障礙坡道、電梯與無障礙廁所' : ''),
      openingHours:
        seed.opensAt === '00:00' && seed.closesAt === '24:00'
          ? '全天開放'
          : `${seed.opensAt} - ${seed.closesAt}`,
      opensAt: seed.opensAt,
      closesAt: seed.closesAt,
      contact: `02-2${String(1000000 + index * 137).slice(0, 7)}`,
      capacity: seed.capacity,
      status: seed.status ?? 'ACTIVE',
    };
  });
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

export const DATA_SOURCE_SEEDS: DataSource[] = [
  {
    id: 'ds-weather',
    name: 'Central Weather Administration',
    nameZh: '中央氣象署 開放資料',
    kind: 'WEATHER',
    provider: 'CWA Open Data',
    status: 'ONLINE',
    lastSyncAt: new Date().toISOString(),
    recordCount: 128_450,
    errorRatePct: 0.2,
    config: { endpoint: 'https://opendata.cwa.gov.tw/api', intervalSec: 600, retries: 3 },
    enabled: true,
  },
  {
    id: 'ds-sensor',
    name: 'Home Sensor Gateway',
    nameZh: '居家感測器閘道',
    kind: 'SENSOR',
    provider: 'HeatGuard Gateway',
    status: 'ONLINE',
    lastSyncAt: new Date().toISOString(),
    recordCount: 2_048_912,
    errorRatePct: 1.4,
    config: { endpoint: 'https://gateway.internal/sensors', intervalSec: 30, retries: 5 },
    enabled: true,
  },
  {
    id: 'ds-wearable',
    name: 'Wearable Sync Service',
    nameZh: '穿戴裝置同步服務',
    kind: 'WEARABLE',
    provider: 'HeatGuard Wear SDK',
    status: 'DEGRADED',
    lastSyncAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    recordCount: 987_331,
    errorRatePct: 6.8,
    config: { endpoint: 'https://wear.internal/sync', intervalSec: 60, retries: 4 },
    enabled: true,
  },
  {
    id: 'ds-city',
    name: 'Taipei Open Data Platform',
    nameZh: '臺北市資料大平台',
    kind: 'CITY',
    provider: 'data.taipei',
    status: 'ONLINE',
    lastSyncAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    recordCount: 12_884,
    errorRatePct: 0.5,
    config: { endpoint: 'https://data.taipei/api/v1', intervalSec: 3600, retries: 3 },
    enabled: true,
  },
  {
    id: 'ds-cooling',
    name: 'Public Cooling Facility Registry',
    nameZh: '公共涼適空間名錄',
    kind: 'COOLING_LOCATION',
    provider: 'Municipal Social Affairs Bureau',
    status: 'ONLINE',
    lastSyncAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
    recordCount: 42,
    errorRatePct: 0,
    config: { endpoint: 'https://data.taipei/api/v1/cooling-spaces', intervalSec: 86400, retries: 2 },
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// System settings
// ---------------------------------------------------------------------------

export const SETTING_SEEDS: SystemSetting[] = [
  { key: 'platform.name', label: 'Platform name', labelZh: '平台名稱', value: 'AI 守護高齡者', type: 'string', group: 'General', description: 'Shown in the header and notification signatures.' },
  { key: 'platform.city', label: 'Default city', labelZh: '預設城市', value: '台北市', type: 'string', group: 'General', description: 'The city the heat map centres on.' },
  { key: 'simulation.tickMs', label: 'Simulation tick (ms)', labelZh: '模擬更新間隔（毫秒）', value: '2000', type: 'number', group: 'Simulation', description: 'How often the server recomputes risk for every user.' },
  { key: 'simulation.historyPoints', label: 'History points retained', labelZh: '保留歷史點數', value: '180', type: 'number', group: 'Simulation', description: 'Rolling in-memory chart window per user.' },
  { key: 'alerts.autoResolveOnRecovery', label: 'Auto-resolve on recovery', labelZh: '風險下降時自動結案', value: 'true', type: 'boolean', group: 'Alerts', description: 'Resolve open alerts automatically once a user returns to LOW risk.' },
  { key: 'privacy.showPhysiologyOnMap', label: 'Show physiology on city map', labelZh: '在城市地圖顯示生理資料', value: 'false', type: 'boolean', group: 'Privacy', description: 'Must stay off: individual physiological data is never shown on a public map.' },
  { key: 'privacy.retentionDays', label: 'Reading retention (days)', labelZh: '感測資料保留天數', value: '30', type: 'number', group: 'Privacy', description: 'How long individual sensor readings are kept.' },
];

// ---------------------------------------------------------------------------
// Educational content
// ---------------------------------------------------------------------------

export const CONTENT_SEEDS: Omit<ContentArticle, 'updatedAt'>[] = [
  {
    id: 'art-001',
    slug: 'hydration-basics',
    title: 'Drinking enough water in hot weather',
    titleZh: '高溫時如何補充足夠水分',
    category: 'HYDRATION',
    summary: 'Older adults feel thirst less strongly, so drinking on a schedule works better than drinking when thirsty.',
    summaryZh: '長者的口渴感較不明顯，定時喝水比等到口渴才喝更有幫助。',
    body: 'Thirst becomes a weaker signal with age, so waiting until you feel thirsty often means drinking too late. Aim for a small glass of water every hour while you are awake, rather than a large amount at once. Keep a filled bottle where you sit most often so it is always within reach. If your doctor has limited how much fluid you should drink, follow their instruction and ask them what to do on hot days.',
    bodyZh: '隨著年齡增長，口渴的感覺會變得比較不敏銳，等到覺得渴才喝水往往已經太晚。建議清醒時每小時喝一小杯水，而不是一次喝很多。可以把裝滿水的水壺放在最常坐的位置旁邊，隨時拿得到。如果醫師有限制您每天的飲水量，請依照醫師指示，並主動詢問高溫天氣該如何調整。',
    showForLevels: ['LOW', 'MEDIUM', 'HIGH'],
    published: true,
    updatedBy: 'system',
  },
  {
    id: 'art-002',
    slug: 'cooling-your-home',
    title: 'Keeping your home cooler',
    titleZh: '讓家裡更涼爽的方法',
    category: 'COOLING',
    summary: 'Closing curtains during the day and opening windows after sunset makes a measurable difference indoors.',
    summaryZh: '白天拉上窗簾、日落後開窗通風，室內溫度會有明顯差異。',
    body: 'Direct sunlight through windows is one of the largest sources of indoor heat. Close curtains or blinds on the sunny side of the home during the day, and open windows once the outdoor air has cooled below the indoor temperature, usually after sunset. A fan helps you feel cooler but does not lower the air temperature, so on very humid days a fan alone may not be enough. If you have an air conditioner, using it at a moderate setting for part of the afternoon is more effective than waiting until the room is already hot.',
    bodyZh: '透過窗戶進入的陽光是室內熱量的主要來源之一。白天請將向陽面的窗簾或百葉窗拉上，等到室外空氣比室內涼（通常是日落之後）再開窗通風。電風扇能讓您感覺涼快，但不會降低空氣溫度，因此在非常潮濕的日子，單靠電風扇可能不夠。如果家中有冷氣，下午時段以適中溫度使用，比等到房間已經很熱才開更有效。',
    showForLevels: ['LOW', 'MEDIUM', 'HIGH'],
    published: true,
    updatedBy: 'system',
  },
  {
    id: 'art-003',
    slug: 'warning-signs',
    title: 'Warning signs that need attention',
    titleZh: '需要注意的身體警訊',
    category: 'HIGH_RISK_RESPONSE',
    summary: 'Dizziness, nausea, confusion, or stopping sweating are signals to seek help rather than wait.',
    summaryZh: '頭暈、噁心、意識混亂或突然不再流汗，都是應該立即求助的訊號。',
    body: 'Certain signs mean you should contact your family or emergency services rather than wait and see: feeling dizzy or faint, nausea, a headache that will not ease, confusion or difficulty concentrating, muscle cramps, or skin that has stopped sweating and feels hot and dry. These signs matter more, not less, if you also feel too tired to act on them. Use the help button in the app, or call 119. It is always reasonable to ask for help when you are unsure.',
    bodyZh: '出現以下情況時，請立即聯繫家人或緊急服務，不要再等待觀察：頭暈或快要昏倒、噁心想吐、持續不緩解的頭痛、意識混亂或難以集中注意力、肌肉抽筋，或皮膚不再流汗且摸起來又熱又乾。如果同時覺得非常疲倦、不想動，這些訊號更需要重視，而不是可以忽略。請使用應用程式中的求助按鈕，或撥打 119。當您不確定時，尋求協助永遠是合理的。',
    showForLevels: ['MEDIUM', 'HIGH'],
    published: true,
    updatedBy: 'system',
  },
  {
    id: 'art-004',
    slug: 'heatwave-preparation',
    title: 'Preparing before a heatwave arrives',
    titleZh: '熱浪來臨前的準備',
    category: 'HEATWAVE_WARNING',
    summary: 'A short checklist to work through when several hot days are forecast.',
    summaryZh: '當氣象預報連續高溫時，可以先完成的準備清單。',
    body: 'When several hot days are forecast, prepare in advance: check that your fan or air conditioner works, fill water bottles and put them where you sit, agree with a family member or neighbour who will check on you and how often, keep your phone charged and within reach, and note the nearest air-conditioned public space you could walk to. Sustained heat over several days is harder on the body than a single hot afternoon, because nights that stay warm do not allow recovery.',
    bodyZh: '當氣象預報連續高溫時，請提前準備：確認電風扇或冷氣可以正常運作；將水壺裝滿並放在常坐的位置旁；與家人或鄰居約定好由誰來關心您、多久聯絡一次；手機保持充電並放在拿得到的地方；並記下最近、走得到的公共冷氣空間。連續數日的高溫對身體的負擔比單一個炎熱午後更大，因為夜間溫度不降，身體無法充分恢復。',
    showForLevels: ['LOW', 'MEDIUM', 'HIGH'],
    published: true,
    updatedBy: 'system',
  },
  {
    id: 'art-005',
    slug: 'medication-and-heat',
    title: 'Some medicines change how you handle heat',
    titleZh: '部分藥物會影響身體對熱的反應',
    category: 'ELDERLY_SAFETY',
    summary: 'Diuretics and several other common medicines affect fluid balance and sweating. Ask your pharmacist.',
    summaryZh: '利尿劑與部分常見藥物會影響體液平衡與排汗，建議諮詢藥師。',
    body: 'Several widely prescribed medicines change how the body responds to heat. Diuretics increase fluid loss, some blood pressure medicines affect how blood vessels respond, and certain medicines reduce sweating. This does not mean you should stop or change any medicine: it means your personal heat risk may be higher than someone else in the same room, which is worth knowing. Take your medication list to your pharmacist or doctor and ask specifically what to watch for on hot days.',
    bodyZh: '有幾類常見處方藥會改變身體對熱的反應。利尿劑會增加水分流失，部分血壓藥會影響血管的調節反應，某些藥物則會減少排汗。這並不表示您應該自行停藥或改變劑量，而是表示在同一個環境中，您的個人熱風險可能比別人更高，這件事值得知道。請帶著您的用藥清單詢問藥師或醫師，在高溫天氣特別需要注意什麼。',
    showForLevels: ['LOW', 'MEDIUM', 'HIGH'],
    published: true,
    updatedBy: 'system',
  },
  {
    id: 'art-006',
    slug: 'checking-on-neighbours',
    title: 'Checking on an older neighbour',
    titleZh: '如何關心獨居的長輩鄰居',
    category: 'HEAT_PREVENTION',
    summary: 'What to look for and ask when you visit someone living alone during hot weather.',
    summaryZh: '高溫期間探訪獨居長輩時，可以觀察與詢問的重點。',
    body: 'If you check on an older neighbour during hot weather, notice the room as well as the person: is it noticeably hotter than outside, are windows shut with no fan running, is there drinking water within reach. Ask whether they have had anything to drink in the last few hours and whether they have been sleeping well, since poor sleep during warm nights is an early sign of heat strain. Agree a specific time you will come back, so a missed check is noticeable.',
    bodyZh: '在高溫期間探訪獨居長輩時，除了關心人，也請留意環境：房間是否明顯比室外更熱、窗戶是否緊閉且沒有開電扇、飲用水是否放在拿得到的地方。可以詢問他們過去幾小時有沒有喝水，以及最近睡得好不好——悶熱夜晚導致的睡眠不佳，是熱負荷累積的早期訊號。離開前約定下次探訪的具體時間，這樣一旦沒有出現就會被察覺。',
    showForLevels: ['LOW', 'MEDIUM', 'HIGH'],
    published: true,
    updatedBy: 'system',
  },
  {
    id: 'art-007',
    slug: 'draft-night-cooling',
    title: 'Sleeping through warm nights (draft)',
    titleZh: '悶熱夜晚的睡眠建議（草稿）',
    category: 'COOLING',
    summary: 'Draft article on overnight comfort. Not yet published.',
    summaryZh: '關於夜間舒適度的草稿文章，尚未發布。',
    body: 'Draft. Content under review by the community health team before publication.',
    bodyZh: '草稿。內容正由社區健康團隊審閱，尚未發布。',
    showForLevels: ['LOW'],
    published: false,
    updatedBy: 'system',
  },
];
