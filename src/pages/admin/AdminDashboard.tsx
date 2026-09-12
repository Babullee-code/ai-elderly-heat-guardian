/**
 * 系統總覽 - the CMS landing screen.
 *
 * This is the first thing a judge sees, so it has one job: state the condition
 * of the whole platform in about ten seconds, and keep moving while a demo
 * scenario runs. Every number here comes from the live socket snapshot, so the
 * page updates without a single refetch; the only API calls are for data the
 * socket does not carry (the resident roster, service health, scenario names).
 */

import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Building2,
  ChevronRight,
  Clock,
  Gauge,
  HeartPulse,
  Inbox,
  Map,
  RotateCcw,
  Server,
  ShieldCheck,
  Sparkles,
  Sun,
  Thermometer,
  Users,
} from 'lucide-react';

import type { RiskAssessment, RiskLevel, SystemHealth } from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';
import { api, ApiError, type ScenarioInfo, type UserRow } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { cn, formatNumber, formatPct, formatTemp, initials, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Progress,
  Skeleton,
} from '@/components/ui';
import { AlertCard, PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, RiskBadge, StatusIndicator } from '@/components/domain/RiskIndicators';
import { ChartCard, RiskDistributionChart } from '@/components/domain/Charts';
import { DataTable, type Column } from '@/components/domain/DataTable';

/** A roster row joined to the assessment currently on the wire. */
interface AttentionRow extends UserRow {
  live: RiskAssessment | null;
}

const TONE_BY_LEVEL: Record<RiskLevel, 'low' | 'medium' | 'high'> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

export default function AdminDashboard() {
  const navigate = useNavigate();

  // --- live slices --------------------------------------------------------
  const stats = useLiveStore((s) => s.stats);
  const cityRisk = useLiveStore((s) => s.cityRisk);
  const alerts = useLiveStore((s) => s.alerts);
  const assessments = useLiveStore((s) => s.assessments);
  const simulation = useLiveStore((s) => s.simulation);
  const configVersion = useLiveStore((s) => s.configVersion);

  // --- fetched slices -----------------------------------------------------
  const [users, setUsers] = React.useState<UserRow[] | null>(null);
  const [usersError, setUsersError] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<SystemHealth | null>(null);
  const [healthError, setHealthError] = React.useState<string | null>(null);
  const [scenarios, setScenarios] = React.useState<ScenarioInfo[]>([]);
  const [phaseLabels, setPhaseLabels] = React.useState<Record<string, { labelZh: string }>>({});
  const [refreshing, setRefreshing] = React.useState(false);

  const loadUsers = React.useCallback(async () => {
    try {
      const result = await api.listUsers();
      setUsers(result.users);
      setUsersError(null);
    } catch (error) {
      setUsersError(error instanceof ApiError ? error.displayMessage : '無法載入長者名冊。');
    }
  }, []);

  const loadHealth = React.useCallback(async () => {
    try {
      const result = await api.systemHealth();
      setHealth(result.health);
      setHealthError(null);
    } catch (error) {
      setHealthError(error instanceof ApiError ? error.displayMessage : '無法載入系統健康狀態。');
    }
  }, []);

  // The roster changes only when someone is added, suspended or the config is
  // republished - the socket carries the risk numbers, so this stays cheap.
  React.useEffect(() => {
    void loadUsers();
  }, [loadUsers, configVersion]);

  React.useEffect(() => {
    void loadHealth();
    const timer = setInterval(() => void loadHealth(), 20_000);
    return () => clearInterval(timer);
  }, [loadHealth]);

  // Scenario names come from the server catalogue rather than a local map, so
  // the banner cannot drift from what the simulation engine actually runs.
  React.useEffect(() => {
    api
      .getSimulation()
      .then((result) => {
        setScenarios(result.scenarios);
        setPhaseLabels(result.phaseLabels);
      })
      .catch(() => {
        // Without the catalogue the banner falls back to the raw scenario key,
        // which is still truthful - not worth interrupting the screen for.
      });
  }, []);

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([loadUsers(), loadHealth()]);
    setRefreshing(false);
  };

  // --- derived ------------------------------------------------------------

  /** Roster joined to live assessments, highest risk first. */
  const attention = React.useMemo<AttentionRow[]>(() => {
    if (!users) return [];
    return users
      .map((user) => ({ ...user, live: assessments[user.id] ?? user.assessment }))
      .sort((a, b) => {
        const levelDiff =
          RISK_ORDER[b.live?.level ?? 'LOW'] - RISK_ORDER[a.live?.level ?? 'LOW'];
        if (levelDiff !== 0) return levelDiff;
        return (b.live?.score ?? 0) - (a.live?.score ?? 0);
      })
      .slice(0, 8);
  }, [users, assessments]);

  const recentAlerts = React.useMemo(
    () =>
      [...alerts]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5),
    [alerts],
  );

  const hottestDistricts = React.useMemo(
    () => [...cityRisk].sort((a, b) => b.heatIndex - a.heatIndex).slice(0, 6),
    [cityRisk],
  );

  const runningScenario =
    simulation && simulation.scenario && simulation.scenario !== 'AMBIENT' ? simulation : null;

  const scenarioLabel =
    scenarios.find((s) => s.name === runningScenario?.scenario)?.labelZh ??
    runningScenario?.scenario ??
    '';
  const phaseLabel = runningScenario
    ? (phaseLabels[runningScenario.phase]?.labelZh ?? runningScenario.phase)
    : '';

  const columns: Column<AttentionRow>[] = [
    {
      key: 'name',
      header: '長者',
      primary: true,
      cell: (row) => (
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-muted text-xs font-semibold text-primary">
            {initials(row.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{row.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.age} 歲 · {row.district}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'level',
      header: '風險等級',
      cell: (row) =>
        row.live ? (
          <div className="flex items-center gap-2">
            <RiskBadge level={row.live.level} size="sm" />
            <span className="tabular text-xs text-muted-foreground">{row.live.score} 分</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">尚無評估</span>
        ),
    },
    {
      key: 'heatIndex',
      header: '熱指數',
      align: 'right',
      cell: (row) => (
        <span className="tabular text-sm">{row.live ? formatTemp(row.live.heatIndex) : '--'}</span>
      ),
    },
    {
      key: 'hr',
      header: '心率 / 基準偏離',
      hideOnMobile: true,
      cell: (row) =>
        row.live ? (
          <div className="flex items-baseline gap-2">
            <span className="tabular text-sm">{row.live.baseline.heartRateBpm} BPM</span>
            {row.live.baseline.aboveBaseline ? (
              <span className="tabular text-xs font-medium text-risk-medium">
                +{row.live.baseline.deviationPct}%
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">正常範圍</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">--</span>
        ),
    },
    {
      key: 'updated',
      header: '最後更新',
      hideOnMobile: true,
      cell: (row) => (
        <span className="text-xs text-muted-foreground">
          {timeAgo(row.live?.timestamp ?? row.lastUpdate)}
        </span>
      ),
    },
    {
      key: 'go',
      header: '',
      align: 'right',
      cell: (row) => (
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/admin/users/${row.id}`} aria-label={`檢視 ${row.name} 的詳細資料`}>
            檢視
            <ChevronRight />
          </Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="系統總覽"
        description="全平台的即時狀態：長者風險分布、警示動態、城市熱風險與系統健康。數值由伺服器每兩秒推送，不需重新整理。"
        actions={
          <>
            <Button variant="outline" onClick={() => void refreshAll()} loading={refreshing}>
              <RotateCcw />
              重新載入名冊
            </Button>
            <Button asChild>
              <Link to="/admin/alerts">
                <AlertTriangle />
                前往警示中心
              </Link>
            </Button>
          </>
        }
      />

      {/* ------------------------ Simulation banner ------------------------ */}
      {runningScenario && (
        <Card className="border-primary/40 bg-primary-muted/40">
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="size-5" />
            </span>

            <div className="min-w-[220px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">正在播放情境：{scenarioLabel}</p>
                <Badge variant="secondary">目前階段 · {phaseLabel}</Badge>
                <Badge variant="outline" className="tabular">
                  {runningScenario.speed}× 速度
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                所有畫面正依此腳本同步變化，感測數值皆為模擬資料。
              </p>

              <div className="mt-2 flex items-center gap-3" aria-live="polite">
                <Progress
                  value={Math.round(runningScenario.phaseProgress * 100)}
                  className="h-1.5 max-w-sm"
                  aria-label={`${phaseLabel} 進度`}
                />
                <span className="tabular shrink-0 text-xs text-muted-foreground">
                  {Math.round(runningScenario.phaseProgress * 100)}% · 已進行{' '}
                  {Math.round(runningScenario.elapsedSec)} 秒
                </span>
              </div>
            </div>

            <Button variant="outline" size="sm" asChild>
              <Link to={`/admin/users/${runningScenario.focusUserId}`}>
                檢視情境主角
                <ChevronRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ----------------------------- Stats ------------------------------- */}
      {!stats ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="監測中的長者"
            value={stats.activeUsers}
            sublabel={`低風險 ${stats.lowRiskUsers} 位`}
            icon={Users}
            tone="primary"
            href="/admin/users"
          />
          <StatCard
            label="高風險長者"
            value={stats.highRiskUsers}
            sublabel="需要立即介入"
            icon={AlertTriangle}
            tone="high"
            href="/admin/users"
          />
          <StatCard
            label="需要注意的長者"
            value={stats.mediumRiskUsers}
            sublabel="風險升高，持續追蹤"
            icon={Activity}
            tone="medium"
            href="/admin/users"
          />
          <StatCard
            label="裝置連線率"
            value={formatPct(stats.devicesOnlinePct)}
            sublabel={`${stats.onlineDevices} / ${stats.totalDevices} 台連線中`}
            icon={Gauge}
            tone={stats.offlineDevices > 0 ? 'medium' : 'low'}
            href="/admin/devices"
          />
          <StatCard
            label="處理中的警示"
            value={stats.activeAlerts}
            sublabel={`其中 ${stats.newAlerts} 則尚未確認`}
            icon={ShieldCheck}
            tone={stats.activeAlerts > 0 ? 'high' : 'low'}
            href="/admin/alerts"
          />
          <StatCard
            label="可用涼適空間"
            value={stats.activeCoolingSpaces}
            sublabel={`共登錄 ${stats.coolingSpaces} 處`}
            icon={Building2}
            tone="primary"
            href="/admin/cooling-spaces"
          />
          <StatCard
            label="照護者"
            value={stats.caregivers}
            sublabel={`今日已送出 ${formatNumber(stats.notificationsToday)} 則通知`}
            icon={HeartPulse}
            tone="neutral"
            href="/admin/caregivers"
          />
          <StatCard
            label="城市熱指數"
            value={formatTemp(stats.cityHeatIndex)}
            sublabel={`全市風險等級 · ${cityRisk.length} 個行政區監測中`}
            icon={Sun}
            tone={TONE_BY_LEVEL[stats.cityRiskLevel]}
            href="/admin/heat-map"
          />
        </div>
      )}

      {/* -------------------- Distribution + attention --------------------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          title="風險分布"
          description="目前每個風險等級的長者人數"
          height={220}
          className="lg:col-span-1"
        >
          {stats ? (
            <RiskDistributionChart
              counts={[
                { level: 'LOW', count: stats.lowRiskUsers },
                { level: 'MEDIUM', count: stats.mediumRiskUsers },
                { level: 'HIGH', count: stats.highRiskUsers },
              ]}
              height={220}
            />
          ) : (
            <Skeleton className="size-full" />
          )}
        </ChartCard>

        <section className="space-y-3 lg:col-span-2" aria-labelledby="attention-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="attention-heading" className="text-base font-semibold">
                需要關注的長者
              </h2>
              <p className="text-xs text-muted-foreground">
                依風險等級與 AI 分數排序，最需要處理的排在最前面。
              </p>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/admin/users">
                查看全部長者
                <ChevronRight />
              </Link>
            </Button>
          </div>

          {usersError ? (
            <EmptyState
              icon={AlertTriangle}
              title="無法載入長者名冊"
              description={usersError}
              action={
                <Button onClick={() => void loadUsers()} variant="outline">
                  重試
                </Button>
              }
            />
          ) : !users ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <DataTable
              rows={attention}
              columns={columns}
              getRowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/admin/users/${row.id}`)}
              emptyState={
                <EmptyState
                  icon={Inbox}
                  title="目前沒有登錄的長者"
                  description="新增長者後，這裡會顯示風險最高的幾位。"
                />
              }
            />
          )}
        </section>
      </div>

      {/* ----------------------- Alerts + city heat ------------------------ */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3" aria-labelledby="alerts-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="alerts-heading" className="text-base font-semibold">
                即時警示動態
              </h2>
              <p className="text-xs text-muted-foreground">最新的警示會即時出現在最上方。</p>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/admin/alerts">
                警示中心
                <ChevronRight />
              </Link>
            </Button>
          </div>

          {recentAlerts.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="目前沒有警示"
              description="所有監測中的長者風險都在可接受範圍內。"
            />
          ) : (
            <div className="space-y-2" aria-live="polite">
              {recentAlerts.map((alert) => (
                <AlertCard key={alert.id} alert={alert} href="/admin/alerts" />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3" aria-labelledby="city-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="city-heading" className="text-base font-semibold">
                城市熱風險
              </h2>
              <p className="text-xs text-muted-foreground">熱指數最高的行政區。</p>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/admin/heat-map">
                熱風險地圖
                <ChevronRight />
              </Link>
            </Button>
          </div>

          {hottestDistricts.length === 0 ? (
            <EmptyState
              icon={Map}
              title="尚未取得城市熱風險資料"
              description="等待資料來源同步後即會顯示各行政區的熱指數。"
            />
          ) : (
            <Card>
              <ul className="divide-y divide-border">
                {hottestDistricts.map((district) => (
                  <li key={district.id}>
                    <Link
                      to="/admin/heat-map"
                      className={cn(
                        'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">
                          {district.city} {district.district}
                        </p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                          <span className="tabular flex items-center gap-1">
                            <Thermometer className="size-3" />
                            氣溫 {formatTemp(district.temperatureC)}
                          </span>
                          <span className="tabular">濕度 {formatPct(district.humidityPct)}</span>
                          <span className="tabular">{district.elderlyUserCount} 位長者</span>
                          <span className="tabular">{district.coolingSpaceCount} 處涼適空間</span>
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="tabular text-sm font-semibold">
                          {formatTemp(district.heatIndex)}
                        </span>
                        <RiskBadge level={district.riskLevel} size="sm" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>

      {/* --------------------------- System health ------------------------- */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Server className="size-4 text-muted-foreground" />
              系統健康
            </CardTitle>
            <CardDescription>
              {health
                ? `版本 ${health.version} · 已運行 ${formatUptime(health.uptimeSec)} · 模擬時脈 ${formatNumber(
                    health.tickCount,
                  )} 次`
                : '正在檢查各項服務…'}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/admin/system">
              詳細狀態
              <ChevronRight />
            </Link>
          </Button>
        </CardHeader>

        <CardContent>
          {healthError ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              <AlertTriangle className="size-4 shrink-0 text-risk-medium" />
              <span>{healthError}</span>
              <Button variant="outline" size="sm" onClick={() => void loadHealth()}>
                重試
              </Button>
            </div>
          ) : !health ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-44 rounded-lg" />
              ))}
            </div>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {health.services.map((service) => (
                <li
                  key={service.key}
                  className="min-w-[180px] flex-1 rounded-lg border border-border bg-muted/40 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-semibold">{service.nameZh}</p>
                    <StatusIndicator status={service.status} />
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="size-3 shrink-0" />
                    <span className="tabular">{service.latencyMs} ms</span>
                    <span className="truncate">· {service.detail}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小時 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}
