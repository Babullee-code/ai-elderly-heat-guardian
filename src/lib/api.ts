/**
 * API client.
 *
 * A thin typed wrapper over fetch. Every call attaches the demo account id
 * and normalises server errors into an ApiError that carries the field-level
 * validation messages, so forms can render errors inline instead of showing
 * a generic failure.
 */

import type {
  Account,
  ActionRule,
  Alert,
  AuditLogEntry,
  Caregiver,
  CityRisk,
  ContentArticle,
  CoolingSpace,
  CoolingSpaceRecommendation,
  DataSource,
  Device,
  ElderlyUser,
  EnvironmentReading,
  Notification,
  NotificationTemplate,
  PersonalBaseline,
  Permission,
  PlatformStats,
  RiskAssessment,
  RiskEvent,
  RiskHistoryPoint,
  RiskLevel,
  RiskRuleConfig,
  SensorReading,
  SimulationState,
  SmartHomeState,
  SystemHealth,
  SystemSetting,
  WearableReading,
} from '@shared/types/domain';

const ACCOUNT_STORAGE_KEY = 'heatguard.accountId';

/**
 * Static-demo mode.
 *
 * When built for GitHub Pages there is no server, so requests are served by
 * an in-browser backend instead. The switch lives here and nowhere else:
 * every api.* method, and therefore every page, is identical in both modes.
 */
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === 'true';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageZh?: string;
  readonly fieldErrors: Record<string, string>;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    messageZh?: string;
    fieldErrors?: Record<string, string>;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.status = args.status;
    this.code = args.code;
    this.messageZh = args.messageZh;
    this.fieldErrors = args.fieldErrors ?? {};
  }

  /** Prefer the Chinese message in the UI, falling back to English. */
  get displayMessage(): string {
    return this.messageZh || this.message;
  }
}

export function getStoredAccountId(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredAccountId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACCOUNT_STORAGE_KEY, id);
    else localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  } catch {
    // A browser with storage disabled still works; the session simply does
    // not survive a reload.
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {},
): Promise<T> {
  const { skipAuth, ...init } = options;

  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  const accountId = getStoredAccountId();
  if (accountId && !skipAuth) headers.set('x-account-id', accountId);

  let response: Response;
  try {
    if (STATIC_DEMO) {
      const { demoFetch } = await import('@/demo/routes');
      response = await demoFetch(`/api${path}`, { ...init, headers });
    } else {
      response = await fetch(`/api${path}`, { ...init, headers });
    }
  } catch {
    // A network-level failure is distinct from an API error and needs its own
    // message: the server is probably not running.
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server.',
      messageZh: '無法連線到伺服器，請確認後端服務是否啟動。',
    });
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = (payload ?? {}) as {
      error?: string;
      message?: string;
      messageZh?: string;
      fieldErrors?: Record<string, string>;
    };
    throw new ApiError({
      status: response.status,
      code: body.error ?? 'UNKNOWN',
      message: body.message ?? `Request failed with status ${response.status}`,
      messageZh: body.messageZh,
      fieldErrors: body.fieldErrors,
    });
  }

  return payload as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface UserRow extends ElderlyUser {
  assessment: RiskAssessment | null;
  deviceCount: number;
  devicesOnline: number;
  deviceStatus: 'NONE' | 'ALL_ONLINE' | 'ALL_OFFLINE' | 'PARTIAL';
  caregivers: { id: string; name: string; relationship: string; status: string }[];
  lastUpdate: string | null;
}

export interface UserDetail {
  user: ElderlyUser;
  baseline: PersonalBaseline | null;
  assessment: RiskAssessment | null;
  smartHome: SmartHomeState | null;
  history: RiskHistoryPoint[];
  devices: Device[];
  caregivers: Caregiver[];
  riskEvents: RiskEvent[];
  environmentHistory: EnvironmentReading[];
  wearableHistory: WearableReading[];
  alerts: Alert[];
  monitoringIntervalSec: number;
}

export interface CaregiverRow extends Caregiver {
  assignedUsers: { id: string; name: string; age: number; district: string; level: RiskLevel }[];
  riskCounts: { HIGH: number; MEDIUM: number; LOW: number };
}

export interface CaregiverDashboard {
  caregiver: Caregiver;
  residents: {
    user: ElderlyUser;
    assessment: RiskAssessment | null;
    smartHome: SmartHomeState | null;
    history: RiskHistoryPoint[];
    deviceCount: number;
    devicesOnline: number;
    lastUpdate: string | null;
  }[];
  alerts: Alert[];
}

export interface SensorRow {
  device: Device;
  userName: string;
  metric: string;
  value: number | null;
  unit: string;
  stale: boolean;
  lastSeen: string;
  simulated: boolean;
}

export interface ScenarioInfo {
  name: string;
  label: string;
  labelZh: string;
  description: string;
  durationSec: number;
  phases: { phase: string; label: string; labelZh: string; durationSec: number }[];
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const api = {
  // --- auth ---------------------------------------------------------------
  listAccounts: () =>
    get<{ accounts: Account[]; demo: boolean; notice: string; noticeZh: string }>('/auth/accounts'),

  login: (email: string) =>
    request<{ account: Account; permissions: Permission[]; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email }),
      skipAuth: true,
    }),

  me: () =>
    get<{
      account: Account;
      permissions: Permission[];
      elderlyUser: ElderlyUser | null;
      caregiver: Caregiver | null;
    }>('/auth/me'),

  // --- users --------------------------------------------------------------
  listUsers: () => get<{ users: UserRow[]; total: number }>('/users'),
  getUser: (id: string) => get<UserDetail>(`/users/${id}`),
  createUser: (body: unknown) => post<{ user: ElderlyUser }>('/users', body),
  updateUser: (id: string, body: unknown) => patch<{ user: ElderlyUser }>(`/users/${id}`, body),
  updateUserPermissions: (id: string, body: unknown) =>
    patch<{ user: ElderlyUser }>(`/users/${id}/permissions`, body),
  suspendUser: (id: string) => post<{ user: ElderlyUser }>(`/users/${id}/suspend`),
  relearnBaseline: (id: string) =>
    post<{ baseline: PersonalBaseline; sampleCount: number }>(`/users/${id}/relearn-baseline`),

  // --- caregivers ---------------------------------------------------------
  listCaregivers: () => get<{ caregivers: CaregiverRow[]; total: number }>('/caregivers'),
  caregiverDashboard: (id: string) => get<CaregiverDashboard>(`/caregivers/${id}/dashboard`),
  createCaregiver: (body: unknown) => post<{ caregiver: Caregiver }>('/caregivers', body),
  updateCaregiver: (id: string, body: unknown) =>
    patch<{ caregiver: Caregiver }>(`/caregivers/${id}`, body),
  toggleCaregiverStatus: (id: string) =>
    post<{ caregiver: Caregiver }>(`/caregivers/${id}/toggle-status`),
  assignCaregiver: (caregiverId: string, userId: string) =>
    post<{ caregiver: Caregiver }>('/caregivers/assign', { caregiverId, userId }),
  unassignCaregiver: (caregiverId: string, userId: string) =>
    post<{ caregiver: Caregiver }>('/caregivers/unassign', { caregiverId, userId }),

  // --- devices ------------------------------------------------------------
  listDevices: () =>
    get<{
      devices: (Device & { userName: string; userDistrict: string })[];
      total: number;
      summary: { online: number; lowBattery: number; offline: number; disabled: number };
    }>('/devices'),
  getDevice: (id: string) =>
    get<{ device: Device; user: ElderlyUser | null; history: SensorReading[] }>(`/devices/${id}`),
  userDevices: (userId: string) =>
    get<{ devices: Device[]; smartHome: SmartHomeState | null }>(`/devices/user/${userId}`),
  createDevice: (body: unknown) => post<{ device: Device }>('/devices', body),
  updateDevice: (id: string, body: unknown) => patch<{ device: Device }>(`/devices/${id}`, body),
  deviceAction: (id: string, action: string) =>
    post<{ device: Device; action: string }>(`/devices/${id}/action`, { action }),
  deleteDevice: (id: string) => del<{ deleted: boolean }>(`/devices/${id}`),

  // --- smart home ---------------------------------------------------------
  setAppliance: (userId: string, appliance: 'ac' | 'fan' | 'dehumidifier', on: boolean) =>
    post<{ smartHome: SmartHomeState }>(`/devices/smart-home/${userId}`, { appliance, on }),
  cancelAutomation: (userId: string) =>
    post<{ smartHome: SmartHomeState }>(`/devices/smart-home/${userId}/cancel-automation`),
  restoreAutomation: (userId: string) =>
    post<{ smartHome: SmartHomeState }>(`/devices/smart-home/${userId}/restore-automation`),

  // --- sensors ------------------------------------------------------------
  listSensors: () =>
    get<{ sensors: SensorRow[]; total: number; metrics: Record<string, number> }>('/sensors'),
  liveSensors: () =>
    get<{
      series: {
        userId: string;
        userName: string;
        district: string;
        history: RiskHistoryPoint[];
        assessment: RiskAssessment | null;
      }[];
      at: string;
      simulated: boolean;
    }>('/sensors/live'),

  // --- readings -----------------------------------------------------------
  environmentHistory: (userId: string, limit = 96) =>
    get<{ readings: EnvironmentReading[] }>(`/readings/${userId}/environment?limit=${limit}`),
  wearableHistory: (userId: string, limit = 96) =>
    get<{ readings: WearableReading[] }>(`/readings/${userId}/wearable?limit=${limit}`),

  // --- risk ---------------------------------------------------------------
  riskOverview: () =>
    get<{
      stats: PlatformStats;
      simulation: SimulationState;
      configVersion: number;
      at: string;
    }>('/risk'),
  userRisk: (userId: string) =>
    get<{
      assessment: RiskAssessment;
      smartHome: SmartHomeState | null;
      history: RiskHistoryPoint[];
      config: RiskRuleConfig;
    }>(`/risk/${userId}`),
  riskEvents: (userId: string) => get<{ events: RiskEvent[] }>(`/risk/${userId}/events`),

  // --- risk rules ---------------------------------------------------------
  getRiskRules: () => get<{ config: RiskRuleConfig; version: number }>('/risk-rules'),
  updateRiskRules: (body: unknown) =>
    patch<{ config: RiskRuleConfig; version: number; effect: PlatformStats }>('/risk-rules', body),
  previewRiskRules: (body: unknown) =>
    post<{
      current: PlatformStats;
      projected: Record<RiskLevel, number>;
      moved: { userId: string; name: string; from: string; to: string }[];
      saved: boolean;
    }>('/risk-rules/preview', body),
  resetRiskRules: () =>
    post<{ config: RiskRuleConfig; version: number; effect: PlatformStats }>('/risk-rules/reset'),

  // --- action rules -------------------------------------------------------
  actionCatalogue: () =>
    get<{ actions: { type: string; titleZh: string; title: string; icon: string }[] }>(
      '/actions/catalogue',
    ),
  listActionRules: () =>
    get<{
      rules: ActionRule[];
      firing: Record<string, string[]>;
      firingCounts: Record<string, number>;
    }>('/actions/rules'),
  createActionRule: (body: unknown) => post<{ rule: ActionRule }>('/actions/rules', body),
  updateActionRule: (id: string, body: unknown) =>
    patch<{ rule: ActionRule }>(`/actions/rules/${id}`, body),
  deleteActionRule: (id: string) => del<{ deleted: boolean }>(`/actions/rules/${id}`),

  // --- alerts -------------------------------------------------------------
  listAlerts: (status?: string) =>
    get<{ alerts: Alert[]; total: number; counts: Record<string, number> }>(
      `/alerts${status && status !== 'ALL' ? `?status=${status}` : ''}`,
    ),
  getAlert: (id: string) =>
    get<{
      alert: Alert;
      user: ElderlyUser | null;
      caregivers: Caregiver[];
      currentAssessment: RiskAssessment | null;
    }>(`/alerts/${id}`),
  updateAlert: (id: string, body: unknown) => patch<{ alert: Alert }>(`/alerts/${id}`, body),

  // --- notifications ------------------------------------------------------
  listNotifications: () =>
    get<{ notifications: Notification[]; total: number; unread: number }>('/notifications'),
  markNotificationRead: (id: string) => post<{ read: boolean }>(`/notifications/${id}/read`),
  markAllNotificationsRead: () => post<{ markedRead: number }>('/notifications/read-all'),
  listTemplates: () =>
    get<{
      templates: NotificationTemplate[];
      variables: { key: string; description: string; descriptionZh: string }[];
    }>('/notifications/templates'),
  previewTemplate: (key: string, body: unknown) =>
    post<{
      preview: { title: string; titleZh: string; body: string; bodyZh: string };
      variables: Record<string, string>;
      enabled: boolean;
    }>(`/notifications/templates/${key}/preview`, body),
  updateTemplate: (key: string, body: unknown) =>
    patch<{ template: NotificationTemplate }>(`/notifications/templates/${key}`, body),
  sendTestNotification: (templateKey: string, userId: string) =>
    post<{ sent: boolean; reason?: string; message: string; messageZh: string }>(
      '/notifications/test',
      { templateKey, userId },
    ),

  // --- cooling spaces -----------------------------------------------------
  listCoolingSpaces: () =>
    get<{
      spaces: (CoolingSpace & { openNow: boolean })[];
      total: number;
      types: Record<string, { label: string; labelZh: string; icon: string }>;
      summary: {
        active: number;
        disabled: number;
        airConditioned: number;
        accessible: number;
        openNow: number;
      };
    }>('/cooling-spaces'),
  recommendCoolingSpaces: (userId: string) =>
    get<{
      recommendations: CoolingSpaceRecommendation[];
      blocked: boolean;
      level?: RiskLevel;
      reason?: string;
      reasonZh?: string;
    }>(`/cooling-spaces/recommend/${userId}`),
  createCoolingSpace: (body: unknown) => post<{ space: CoolingSpace }>('/cooling-spaces', body),
  updateCoolingSpace: (id: string, body: unknown) =>
    patch<{ space: CoolingSpace }>(`/cooling-spaces/${id}`, body),
  toggleCoolingSpace: (id: string) =>
    post<{ space: CoolingSpace; activeCount: number }>(`/cooling-spaces/${id}/toggle`),
  deleteCoolingSpace: (id: string) => del<{ deleted: boolean }>(`/cooling-spaces/${id}`),
  importCoolingSpaces: (spaces: unknown[]) =>
    post<{ created: number; skipped: string[]; createdNames: string[] }>('/cooling-spaces/import', {
      spaces,
    }),

  // --- city risk ----------------------------------------------------------
  cityRisk: () =>
    get<{
      districts: CityRisk[];
      city: string;
      stats: PlatformStats;
      privacyNotice: string;
      privacyNoticeZh: string;
    }>('/city-risk'),
  syncCityRisk: () => post<{ synced: number; districts: CityRisk[] }>('/city-risk/sync'),

  // --- content ------------------------------------------------------------
  listContent: (params?: { level?: string; category?: string }) => {
    const q = new URLSearchParams();
    if (params?.level) q.set('level', params.level);
    if (params?.category) q.set('category', params.category);
    const qs = q.toString();
    return get<{
      articles: ContentArticle[];
      total: number;
      summary: { published: number; draft: number };
      contentPolicy: string;
      contentPolicyZh: string;
    }>(`/content${qs ? `?${qs}` : ''}`);
  },
  getArticle: (id: string) => get<{ article: ContentArticle }>(`/content/${id}`),
  createArticle: (body: unknown) => post<{ article: ContentArticle }>('/content', body),
  updateArticle: (id: string, body: unknown) =>
    patch<{ article: ContentArticle }>(`/content/${id}`, body),
  deleteArticle: (id: string) => del<{ deleted: boolean }>(`/content/${id}`),

  // --- data sources -------------------------------------------------------
  listDataSources: () =>
    get<{
      sources: DataSource[];
      total: number;
      summary: { online: number; degraded: number; offline: number };
      note: string;
      noteZh: string;
    }>('/data-sources'),
  updateDataSource: (id: string, body: unknown) =>
    patch<{ source: DataSource }>(`/data-sources/${id}`, body),
  syncDataSource: (id: string) =>
    post<{
      source: DataSource;
      synced: boolean;
      records: number;
      message: string;
      messageZh: string;
    }>(`/data-sources/${id}/sync`),

  // --- system -------------------------------------------------------------
  systemHealth: () => get<{ health: SystemHealth; stats: PlatformStats }>('/system'),
  listSettings: () => get<{ settings: SystemSetting[]; groups: string[] }>('/settings'),
  updateSetting: (key: string, value: string) =>
    patch<{ setting: SystemSetting }>(`/settings/${key}`, { value }),

  // --- audit --------------------------------------------------------------
  auditLog: (entity?: string) =>
    get<{ entries: AuditLogEntry[]; total: number; entities: string[] }>(
      `/audit-log${entity && entity !== 'ALL' ? `?entity=${entity}` : ''}`,
    ),

  // --- simulation ---------------------------------------------------------
  getSimulation: () =>
    get<{
      simulation: SimulationState;
      scenarios: ScenarioInfo[];
      phaseLabels: Record<string, { label: string; labelZh: string }>;
      simulated: boolean;
      notice: string;
      noticeZh: string;
    }>('/simulation'),
  simulationCommand: (body: unknown) => post<{ simulation: SimulationState }>('/simulation', body),
};
