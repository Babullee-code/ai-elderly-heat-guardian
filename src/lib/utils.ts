import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { RiskLevel } from '@shared/types/domain';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Risk presentation
// ---------------------------------------------------------------------------

/**
 * Visual treatment per risk level.
 *
 * `icon` is part of the contract, not decoration: every risk indicator in the
 * product pairs colour with an icon and a text label so the level is legible
 * to a user with colour vision deficiency or on a poor screen.
 */
export const RISK_STYLES: Record<
  RiskLevel,
  {
    text: string;
    bg: string;
    border: string;
    solid: string;
    solidText: string;
    ring: string;
    icon: 'shield-check' | 'alert-triangle' | 'alert-octagon';
    labelZh: string;
    labelEn: string;
    /** Short plain-language summary for the elderly interface. */
    plainZh: string;
  }
> = {
  LOW: {
    text: 'text-risk-low',
    bg: 'bg-risk-low-bg',
    border: 'border-risk-low-border',
    solid: 'bg-risk-low',
    solidText: 'text-white',
    ring: 'ring-risk-low',
    icon: 'shield-check',
    labelZh: '低風險',
    labelEn: 'LOW',
    plainZh: '目前安全',
  },
  MEDIUM: {
    text: 'text-risk-medium',
    bg: 'bg-risk-medium-bg',
    border: 'border-risk-medium-border',
    solid: 'bg-risk-medium',
    solidText: 'text-white',
    ring: 'ring-risk-medium',
    icon: 'alert-triangle',
    labelZh: '需要注意',
    labelEn: 'MEDIUM',
    plainZh: '目前需要注意',
  },
  HIGH: {
    text: 'text-risk-high',
    bg: 'bg-risk-high-bg',
    border: 'border-risk-high-border',
    solid: 'bg-risk-high',
    solidText: 'text-white',
    ring: 'ring-risk-high',
    icon: 'alert-octagon',
    labelZh: '高風險',
    labelEn: 'HIGH',
    plainZh: '請立即採取行動',
  },
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTemp(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value.toFixed(digits)}°C`;
}

export function formatPct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return `${value.toFixed(digits)}%`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Human "time ago" in Traditional Chinese. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '尚無資料';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '尚無資料';

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return '剛剛';
  if (seconds < 60) return `${seconds} 秒前`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;

  return `${Math.round(hours / 24)} 天前`;
}

export function formatDistance(km: number): string {
  if (!Number.isFinite(km)) return '--';
  return km < 1 ? `${Math.round(km * 1000)} 公尺` : `${km.toFixed(1)} 公里`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Initials for an avatar, handling CJK names sensibly. */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // For CJK, the surname is the leading character and reads better alone.
  if (/[一-鿿]/.test(trimmed)) return trimmed.slice(0, 1);
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export const DEVICE_LABELS_ZH: Record<string, string> = {
  SMART_WATCH: '智慧手錶',
  TEMPERATURE_SENSOR: '溫度感測器',
  HUMIDITY_SENSOR: '濕度感測器',
  AIR_QUALITY_SENSOR: '空氣品質感測器',
  SMART_AC: '智慧冷氣',
  DEHUMIDIFIER: '除濕機',
  FAN: '智慧電風扇',
};

export const DEVICE_STATUS_ZH: Record<string, string> = {
  ONLINE: '連線中',
  OFFLINE: '離線',
  DISABLED: '已停用',
  LOW_BATTERY: '電量偏低',
};

export const RELATIONSHIP_ZH: Record<string, string> = {
  SON: '兒子',
  DAUGHTER: '女兒',
  SPOUSE: '配偶',
  NURSE: '護理人員',
  SOCIAL_WORKER: '社工',
  NEIGHBOUR: '鄰居',
  OTHER: '其他',
};

export const CHANNEL_ZH: Record<string, string> = {
  PUSH: '推播',
  SMS: '簡訊',
  EMAIL: '電子郵件',
  IN_APP: '應用程式內',
  VOICE_CALL: '語音來電',
};

export const ALERT_STATUS_ZH: Record<string, string> = {
  NEW: '新警示',
  ACKNOWLEDGED: '已確認',
  RESOLVED: '已解除',
  ESCALATED: '已升級',
};

export const CONTENT_CATEGORY_ZH: Record<string, string> = {
  HEAT_PREVENTION: '防暑準備',
  HYDRATION: '補充水分',
  COOLING: '降溫方法',
  HEATWAVE_WARNING: '熱浪預警',
  ELDERLY_SAFETY: '長者安全',
  HIGH_RISK_RESPONSE: '高風險應變',
};
