/**
 * 系統健康 - service status and platform settings.
 *
 * These are real checks, not decorations: the database service pings SQLite,
 * the sensor service reports the actual proportion of devices reporting, and
 * the risk engine reports its real evaluation count.
 *
 * One setting is deliberately locked. `privacy.showPhysiologyOnMap` cannot be
 * enabled at all - the server returns 422 - because individual physiological
 * data must never reach the public city map. A constraint an administrator
 * cannot override is the only kind worth making.
 */

import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  Cloud,
  Cpu,
  Database,
  Gauge,
  Lock,
  Map as MapIcon,
  RefreshCw,
  Server,
  Bell,
  ShieldCheck,
  Timer,
} from 'lucide-react';

import type { ServiceStatus, SystemHealth, SystemSetting } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { cn, formatDateTime, formatNumber } from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Skeleton,
  Switch,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, LiveIndicator, StatusIndicator } from '@/components/domain/RiskIndicators';

const SERVICE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  api: Server,
  database: Database,
  sensors: Cpu,
  weather: Cloud,
  map: MapIcon,
  notifications: Bell,
  'risk-engine': Gauge,
  'ai-service': Brain,
};

/** Settings the platform refuses to let an administrator change. */
const LOCKED_SETTINGS: Record<string, string> = {
  'privacy.showPhysiologyOnMap':
    '個人生理資料不得顯示於城市地圖。此限制由平台強制執行，無法從管理後台開啟。',
};

export default function AdminSystem() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const editable = can('system:write');

  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);
  const configVersion = useLiveStore((s) => s.configVersion);

  const [health, setHealth] = React.useState<SystemHealth | null>(null);
  const [settings, setSettings] = React.useState<SystemSetting[]>([]);
  const [groups, setGroups] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [savingKey, setSavingKey] = React.useState<string | null>(null);

  /** Local edit buffer, so a text field is not fighting the refresh loop. */
  const [edits, setEdits] = React.useState<Record<string, string>>({});

  const loadHealth = React.useCallback(async () => {
    try {
      const result = await api.systemHealth();
      setHealth(result.health);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入系統健康狀態。');
    }
  }, []);

  const loadSettings = React.useCallback(async () => {
    try {
      const result = await api.listSettings();
      setSettings(result.settings);
      setGroups(result.groups);
    } catch {
      // Settings may be unreadable for some roles; health still renders.
    }
  }, []);

  React.useEffect(() => {
    void Promise.all([loadHealth(), loadSettings()]).finally(() => setLoading(false));
  }, [loadHealth, loadSettings]);

  // Health is a live concern; refresh it on a timer.
  React.useEffect(() => {
    const timer = setInterval(() => void loadHealth(), 10_000);
    return () => clearInterval(timer);
  }, [loadHealth]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadHealth(), loadSettings()]);
    setRefreshing(false);
  };

  const saveSetting = async (setting: SystemSetting, value: string) => {
    setSavingKey(setting.key);
    try {
      await api.updateSetting(setting.key, value);
      toast.success(
        `已更新「${setting.labelZh}」`,
        setting.key === 'simulation.tickMs' ? '新的更新間隔已立即生效。' : undefined,
      );
      setEdits((current) => {
        const next = { ...current };
        delete next[setting.key];
        return next;
      });
      await loadSettings();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        // A refused privacy change is the platform working as designed.
        toast.warning('此設定受到保護', err.displayMessage);
      } else {
        toast.error('設定未變更', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
      }
      await loadSettings();
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="系統健康" description="載入中…" />
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="space-y-6">
        <PageHeader title="系統健康" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入系統健康狀態"
          description={error}
          action={<Button onClick={refresh}>重試</Button>}
        />
      </div>
    );
  }

  const degraded = health?.services.filter((s) => s.status !== 'ONLINE').length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="系統健康"
        description="各項服務的即時狀態與平台設定。這些是真實的檢查結果，而非固定顯示的裝飾。"
        actions={
          <>
            <LiveIndicator connection={connection} updates={updates} />
            <Button variant="outline" onClick={refresh} loading={refreshing}>
              <RefreshCw />
              重新檢查
            </Button>
          </>
        }
      />

      {/* ------------------------- Platform vitals ------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="服務狀態"
          value={degraded === 0 ? '全部正常' : `${degraded} 項異常`}
          icon={ShieldCheck}
          tone={degraded === 0 ? 'low' : 'medium'}
          sublabel={`共 ${health?.services.length ?? 0} 項服務`}
        />
        <StatCard
          label="運行時間"
          value={formatUptime(health?.uptimeSec ?? 0)}
          icon={Timer}
          tone="primary"
          sublabel={`版本 ${health?.version ?? '--'}`}
        />
        <StatCard
          label="風險評估次數"
          value={formatNumber(health?.tickCount ?? 0)}
          icon={Activity}
          tone="primary"
          sublabel="自服務啟動以來"
        />
        <StatCard
          label="設定版本"
          value={`v${configVersion}`}
          icon={Gauge}
          tone="neutral"
          sublabel="每次變更風險規則即遞增"
        />
      </div>

      {/* ---------------------------- Services ----------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {health?.services.map((service) => {
          const Icon = SERVICE_ICONS[service.key] ?? Server;
          return (
            <Card
              key={service.key}
              className={cn(
                service.status === 'OFFLINE' && 'border-risk-high-border',
                service.status === 'DEGRADED' && 'border-risk-medium-border',
              )}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span
                    className={cn(
                      'flex size-9 items-center justify-center rounded-lg',
                      service.status === 'ONLINE'
                        ? 'bg-risk-low-bg text-risk-low'
                        : service.status === 'DEGRADED'
                          ? 'bg-risk-medium-bg text-risk-medium'
                          : 'bg-risk-high-bg text-risk-high',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="tabular text-xs text-muted-foreground">
                    {service.latencyMs} ms
                  </span>
                </div>

                <p className="mt-3 text-sm font-semibold">{service.nameZh}</p>
                <StatusIndicator status={service.status} className="mt-1" />
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {service.detail}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        最後檢查：{health ? formatDateTime(health.checkedAt) : '--'}，每 10 秒自動更新。
      </p>

      {/* ---------------------------- Settings ----------------------------- */}
      {settings.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">平台設定</h2>

          {groups.map((group) => {
            const groupSettings = settings.filter((s) => s.group === group);
            if (groupSettings.length === 0) return null;

            return (
              <Card key={group}>
                <CardHeader>
                  <CardTitle className="text-base">{groupLabel(group)}</CardTitle>
                </CardHeader>

                <CardContent className="space-y-4">
                  {groupSettings.map((setting, index) => {
                    const locked = LOCKED_SETTINGS[setting.key];
                    const busy = savingKey === setting.key;
                    const current = edits[setting.key] ?? setting.value;

                    return (
                      <React.Fragment key={setting.key}>
                        {index > 0 && <Separator />}

                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <Label
                              htmlFor={`setting-${setting.key}`}
                              className="flex items-center gap-1.5"
                            >
                              {setting.labelZh}
                              {locked && <Lock className="size-3 text-muted-foreground" />}
                            </Label>
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              {setting.description}
                            </p>
                            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                              {setting.key}
                            </p>

                            {locked && (
                              <p className="mt-2 flex gap-2 rounded-lg bg-risk-low-bg p-2.5 text-xs leading-relaxed text-risk-low">
                                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                                {locked}
                              </p>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            {setting.type === 'boolean' ? (
                              <Switch
                                id={`setting-${setting.key}`}
                                checked={setting.value === 'true'}
                                disabled={!editable || busy || Boolean(locked)}
                                onCheckedChange={(value) =>
                                  void saveSetting(setting, String(value))
                                }
                              />
                            ) : (
                              <>
                                <Input
                                  id={`setting-${setting.key}`}
                                  type={setting.type === 'number' ? 'number' : 'text'}
                                  className="h-9 w-40"
                                  value={current}
                                  disabled={!editable || busy || Boolean(locked)}
                                  onChange={(e) =>
                                    setEdits({ ...edits, [setting.key]: e.target.value })
                                  }
                                />
                                {edits[setting.key] !== undefined &&
                                  edits[setting.key] !== setting.value && (
                                    <Button
                                      size="sm"
                                      loading={busy}
                                      onClick={() => void saveSetting(setting, current)}
                                    >
                                      儲存
                                    </Button>
                                  )}
                              </>
                            )}
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小時`;
}

function groupLabel(group: string): string {
  const labels: Record<string, string> = {
    General: '一般設定',
    Simulation: '模擬設定',
    Alerts: '警示設定',
    Privacy: '隱私設定',
  };
  return labels[group] ?? group;
}
