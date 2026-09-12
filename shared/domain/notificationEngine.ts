/**
 * Notification rendering.
 *
 * Templates live in the database and are edited at /admin/notifications. This
 * module only interpolates them, which is what makes an admin editing the
 * HIGH_RISK wording change the text a caregiver actually receives.
 *
 * A disabled template sends nothing at all - the CMS switch is real.
 */

import type {
  NotificationTemplate,
  NotificationTemplateKey,
  RiskAssessment,
  RiskLevel,
} from '../types/domain.js';

/** Variables available to every template. */
export interface TemplateVars {
  user: string;
  level: string;
  heatIndex: string;
  indoorTemp: string;
  humidity: string;
  hr: string;
  deviation: string;
  device: string;
  time: string;
}

export function buildTemplateVars(args: {
  userName: string;
  assessment?: Pick<RiskAssessment, 'level' | 'heatIndex' | 'readings' | 'baseline'> | null;
  deviceName?: string;
  now?: Date;
}): TemplateVars {
  const { userName, assessment, deviceName, now = new Date() } = args;

  return {
    user: userName,
    level: assessment?.level ?? '-',
    heatIndex: assessment ? `${assessment.heatIndex}` : '-',
    indoorTemp: assessment ? `${assessment.readings.indoorTempC}` : '-',
    humidity: assessment ? `${Math.round(assessment.readings.indoorHumidityPct)}` : '-',
    hr: assessment ? `${assessment.baseline.heartRateBpm}` : '-',
    deviation: assessment ? `${assessment.baseline.deviationPct}` : '0',
    device: deviceName ?? '-',
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  };
}

/**
 * Replace {{var}} placeholders. Unknown placeholders are left visible rather
 * than blanked, so a typo in the CMS is obvious to the admin who made it
 * instead of silently producing a sentence with a hole in it.
 */
export function interpolate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = (vars as unknown as Record<string, string>)[key];
    return value === undefined ? match : value;
  });
}

export interface RenderedNotification {
  title: string;
  body: string;
  titleZh: string;
  bodyZh: string;
  channels: NotificationTemplate['channels'];
}

/**
 * Render a template, or return null when the admin has disabled it.
 */
export function renderNotification(
  template: NotificationTemplate | undefined,
  vars: TemplateVars,
): RenderedNotification | null {
  if (!template || !template.enabled) return null;

  return {
    title: interpolate(template.title, vars),
    body: interpolate(template.body, vars),
    titleZh: interpolate(template.titleZh, vars),
    bodyZh: interpolate(template.bodyZh, vars),
    channels: template.channels,
  };
}

/** Which template a risk level maps to. */
export function templateKeyForLevel(level: RiskLevel): NotificationTemplateKey {
  return level === 'HIGH' ? 'HIGH_RISK' : level === 'MEDIUM' ? 'MEDIUM_RISK' : 'LOW_RISK';
}

/** Default template set, seeded into the database on first run. */
export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  {
    key: 'LOW_RISK',
    name: 'Low risk advisory',
    nameZh: '低風險提醒',
    title: 'Heat advisory for {{user}}',
    titleZh: '{{user}} 熱風險提醒',
    body: 'Heat index is {{heatIndex}}C. {{user}} has been reminded to drink water and rest.',
    bodyZh: '目前熱指數 {{heatIndex}}°C。已提醒 {{user}} 補充水分並適度休息。',
    channels: ['IN_APP', 'PUSH'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  },
  {
    key: 'MEDIUM_RISK',
    name: 'Medium risk alert',
    nameZh: '中度風險警示',
    title: 'Rising heat risk for {{user}}',
    titleZh: '{{user}} 熱風險升高',
    body: 'Heat index {{heatIndex}}C, indoor {{indoorTemp}}C at {{humidity}}% humidity. Heart rate {{hr}} BPM, {{deviation}}% above personal baseline. Cooling measures are being applied.',
    bodyZh: '熱指數 {{heatIndex}}°C，室內 {{indoorTemp}}°C、濕度 {{humidity}}%。心率 {{hr}} BPM，高於個人平常基準 {{deviation}}%。系統正在採取降溫措施。',
    channels: ['IN_APP', 'PUSH', 'SMS'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  },
  {
    key: 'HIGH_RISK',
    name: 'High risk alert',
    nameZh: '高風險警示',
    title: 'High heat risk for {{user}} - please check in',
    titleZh: '{{user}} 高熱風險，請盡快關心',
    body: 'Heat index has reached {{heatIndex}}C with indoor temperature {{indoorTemp}}C. Heart rate {{hr}} BPM is {{deviation}}% above baseline. Monitoring has been increased and a cooling location has been suggested. Please contact {{user}}.',
    bodyZh: '熱指數已達 {{heatIndex}}°C，室內溫度 {{indoorTemp}}°C。心率 {{hr}} BPM，高於平常基準 {{deviation}}%。系統已提高監測頻率並建議前往涼適空間。請盡快聯繫 {{user}}。',
    channels: ['IN_APP', 'PUSH', 'SMS', 'VOICE_CALL'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  },
  {
    key: 'COOLING_ACTIVATED',
    name: 'Cooling activated',
    nameZh: '降溫設備已啟動',
    title: 'Cooling activated for {{user}}',
    titleZh: '已為 {{user}} 啟動降溫',
    body: 'Authorised cooling switched on at {{time}}. Indoor temperature was {{indoorTemp}}C.',
    bodyZh: '已於 {{time}} 依授權啟動降溫設備，當時室內溫度 {{indoorTemp}}°C。',
    channels: ['IN_APP', 'PUSH'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  },
  {
    key: 'DEVICE_OFFLINE',
    name: 'Device offline',
    nameZh: '裝置離線',
    title: 'Device offline: {{device}}',
    titleZh: '裝置離線：{{device}}',
    body: '{{device}} for {{user}} stopped reporting at {{time}}. Readings from this sensor are no longer being updated.',
    bodyZh: '{{user}} 的 {{device}} 於 {{time}} 停止回報，此感測器的數值已不再更新。',
    channels: ['IN_APP', 'EMAIL'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  },
  {
    key: 'RISK_RECOVERED',
    name: 'Risk recovered',
    nameZh: '風險已下降',
    title: 'Heat risk has fallen for {{user}}',
    titleZh: '{{user}} 熱風險已下降',
    body: 'Risk is now {{level}}. Heat index {{heatIndex}}C, heart rate {{hr}} BPM. Conditions are returning to normal.',
    bodyZh: '目前風險等級為 {{level}}，熱指數 {{heatIndex}}°C，心率 {{hr}} BPM。狀況正逐漸回到平常範圍。',
    channels: ['IN_APP', 'PUSH'],
    enabled: true,
    updatedAt: new Date().toISOString(),
  },
];
