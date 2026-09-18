/**
 * 感測器監控 - live readings across the platform.
 *
 * The important honesty property on this page: when a sensor is offline the
 * platform holds its last value rather than fabricating a new one, and every
 * such row is marked as stale. A monitoring console that presents a held
 * value as a current one is worse than useless in a safety product.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Droplet,
  Heart,
  Info,
  Radio,
  Thermometer,
  Wind,
} from 'lucide-react';

import type { RiskAssessment, RiskHistoryPoint, SensorMetric } from '@shared/types/domain';
import { api, ApiError, type SensorRow } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { cn, DEVICE_LABELS_ZH, DEVICE_STATUS_ZH, formatNumber, timeAgo } from '@/lib/utils';
import { originLabelZh } from '@shared/domain/provenance';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import {
  DataQualityBadge,
  EmptyState,
  RiskBadge,
  StatusIndicator,
} from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';
import {
  ChartCard,
  EnvironmentChart,
  HeartRateChart,
  HumidityChart,
} from '@/components/domain/Charts';

const METRIC_META: Record<SensorMetric, { zh: string; icon: React.ComponentType<{ className?: string }> }> = {
  temperature: { zh: '溫度', icon: Thermometer },
  humidity: { zh: '濕度', icon: Droplet },
  heartRate: { zh: '心率', icon: Heart },
  activity: { zh: '活動量', icon: Activity },
  heatIndex: { zh: '熱指數', icon: Thermometer },
  airQuality: { zh: '空氣品質', icon: Wind },
};

interface Series {
  userId: string;
  userName: string;
  district: string;
  history: RiskHistoryPoint[];
  assessment: RiskAssessment | null;
}

export default function AdminSensors() {
  const liveHistory = useLiveStore((s) => s.history);
  const assessments = useLiveStore((s) => s.assessments);

  const [sensors, setSensors] = React.useState<SensorRow[]>([]);
  const [metrics, setMetrics] = React.useState<Record<string, number>>({});
  const [series, setSeries] = React.useState<Series[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [metricFilter, setMetricFilter] = React.useState('ALL');
  const [freshnessFilter, setFreshnessFilter] = React.useState('ALL');
  const [selectedUserId, setSelectedUserId] = React.useState<string>('');

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const [sensorResult, liveResult] = await Promise.all([api.listSensors(), api.liveSensors()]);
      setSensors(sensorResult.sensors);
      setMetrics(sensorResult.metrics);
      setSeries(liveResult.series);
      setSelectedUserId((current) => current || (liveResult.series[0]?.userId ?? ''));
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入感測器資料。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Current readings come from the REST snapshot; refresh them periodically so
  // the table's values track the live charts.
  React.useEffect(() => {
    const timer = setInterval(() => {
      api
        .listSensors()
        .then((result) => {
          setSensors(result.sensors);
          setMetrics(result.metrics);
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const filtered = React.useMemo(
    () =>
      sensors.filter((row) => {
        if (metricFilter !== 'ALL' && row.metric !== metricFilter) return false;
        if (freshnessFilter === 'STALE' && !row.stale) return false;
        if (freshnessFilter === 'LIVE' && row.stale) return false;
        return true;
      }),
    [sensors, metricFilter, freshnessFilter],
  );

  const staleCount = sensors.filter((s) => s.stale).length;

  // Prefer the socket history for the selected resident; fall back to the
  // REST series before the first tick lands.
  const selectedHistory = React.useMemo(() => {
    if (!selectedUserId) return [];
    const live = liveHistory[selectedUserId];
    if (live && live.length > 0) return live;
    return series.find((s) => s.userId === selectedUserId)?.history ?? [];
  }, [selectedUserId, liveHistory, series]);

  const selectedName = series.find((s) => s.userId === selectedUserId)?.userName ?? '';
  const selectedAssessment = selectedUserId ? assessments[selectedUserId] : undefined;

  const columns: Column<SensorRow>[] = [
    {
      key: 'device',
      header: '感測器',
      primary: true,
      sortValue: (row) => row.device.deviceId,
      cell: (row) => {
        const meta = METRIC_META[row.metric as SensorMetric] ?? METRIC_META.temperature;
        const Icon = meta.icon;
        return (
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg',
                row.stale ? 'bg-muted text-muted-foreground' : 'bg-primary-muted text-primary',
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {DEVICE_LABELS_ZH[row.device.type] ?? row.device.name}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {row.device.deviceId}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'user',
      header: '長者',
      sortValue: (row) => row.userName,
      cell: (row) => (
        <Link
          to={`/admin/users/${row.device.userId}`}
          className="text-sm hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {row.userName}
        </Link>
      ),
    },
    {
      key: 'value',
      header: '目前讀值',
      align: 'right',
      sortValue: (row) => row.value ?? -Infinity,
      cell: (row) => (
        <div className="text-right">
          <span
            className={cn(
              'tabular text-base font-semibold',
              row.stale && 'text-muted-foreground line-through decoration-1',
            )}
          >
            {row.value === null ? '--' : formatNumber(row.value, row.metric === 'heartRate' ? 0 : 1)}
          </span>
          <span className="ml-1 text-xs text-muted-foreground">{row.unit}</span>
        </div>
      ),
    },
    {
      key: 'freshness',
      header: '資料狀態',
      sortValue: (row) => row.ageSec ?? 0,
      cell: (row) => (
        <div className="flex flex-col items-start gap-1">
          <DataQualityBadge quality={row.quality} ageSec={row.ageSec ?? undefined} />
          {row.origin && (
            <span className="text-[10px] text-muted-foreground">{originLabelZh(row.origin)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: '裝置狀態',
      hideOnMobile: true,
      sortValue: (row) => row.device.status,
      cell: (row) => (
        <StatusIndicator status={row.device.status} label={DEVICE_STATUS_ZH[row.device.status]} />
      ),
    },
    {
      key: 'lastSeen',
      header: '最後回報',
      sortValue: (row) => new Date(row.lastSeen).getTime(),
      cell: (row) => <span className="text-xs text-muted-foreground">{timeAgo(row.lastSeen)}</span>,
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="感測器監控" description="載入中…" />
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="感測器監控" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入感測器資料"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="感測器監控"
        description="全平台感測器的即時讀值與新鮮度。離線的感測器會沿用最後一次的讀值，並標示為離線與其取得時間。"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="溫度感測器" value={metrics.temperature ?? 0} icon={Thermometer} tone="primary" />
        <StatCard label="濕度感測器" value={metrics.humidity ?? 0} icon={Droplet} tone="primary" />
        <StatCard label="穿戴裝置" value={metrics.heartRate ?? 0} icon={Heart} tone="primary" />
        <StatCard
          label="資料未更新"
          value={staleCount}
          icon={AlertTriangle}
          tone={staleCount > 0 ? 'medium' : 'low'}
          sublabel={staleCount > 0 ? '感測器離線，讀值已凍結' : '所有感測器正常回報'}
        />
      </div>

      {staleCount > 0 && (
        <Card className="border-risk-medium-border bg-risk-medium-bg/40">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk-medium" />
            <p className="text-sm text-risk-medium">
              目前有 {staleCount} 個感測器已停止回報。系統不會推測這些數值，而是保留最後一次讀值並標示為未更新，以免以過時資料做出風險判讀。
            </p>
          </CardContent>
        </Card>
      )}

      <DataTable
        rows={filtered}
        columns={columns}
        getRowKey={(row) => row.device.id}
        searchPlaceholder="搜尋感測器或長者…"
        searchFields={(row) => `${row.device.deviceId} ${row.userName} ${row.device.name} ${row.metric}`}
        initialSort={{ key: 'freshness', direction: 'desc' }}
        filters={[
          {
            key: 'metric',
            label: '量測項目',
            value: metricFilter,
            onChange: setMetricFilter,
            options: [
              { value: 'ALL', label: '全部項目' },
              ...(Object.keys(METRIC_META) as SensorMetric[]).map((metric) => ({
                value: metric,
                label: METRIC_META[metric].zh,
              })),
            ],
          },
          {
            key: 'freshness',
            label: '資料狀態',
            value: freshnessFilter,
            onChange: setFreshnessFilter,
            options: [
              { value: 'ALL', label: '全部' },
              { value: 'LIVE', label: '即時更新中' },
              { value: 'STALE', label: '未更新' },
            ],
          },
        ]}
        emptyState={
          <EmptyState icon={Radio} title="沒有符合條件的感測器" description="請調整篩選條件。" />
        }
      />

      {/* --------------------------- Drill-down ---------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">個別長者的即時趨勢</CardTitle>
              <CardDescription>
                選擇一位長者以檢視其環境與生理數值的變化。
              </CardDescription>
            </div>

            <div className="flex items-center gap-2">
              {selectedAssessment && <RiskBadge level={selectedAssessment.level} size="sm" />}
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="w-auto min-w-[160px]" aria-label="選擇長者">
                  <SelectValue placeholder="選擇長者" />
                </SelectTrigger>
                <SelectContent>
                  {series.map((item) => (
                    <SelectItem key={item.userId} value={item.userId}>
                      {item.userName}（{item.district}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {selectedHistory.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              這位長者目前沒有可顯示的趨勢資料。
            </p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard
                title={`${selectedName} · 溫度與熱指數`}
                description="室內、室外與熱指數"
                className="border-0 shadow-none"
              >
                <EnvironmentChart history={selectedHistory} />
              </ChartCard>

              <ChartCard
                title={`${selectedName} · 室內濕度`}
                description="濕度越高，散熱效率越差"
                className="border-0 shadow-none"
              >
                <HumidityChart history={selectedHistory} />
              </ChartCard>

              <ChartCard
                title={`${selectedName} · 心率與個人基準`}
                description="綠色區帶為此長者平常的休息範圍"
                className="border-0 shadow-none lg:col-span-2"
              >
                <HeartRateChart history={selectedHistory} />
              </ChartCard>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            本原型的所有感測數值皆由模擬引擎產生，並非真實硬體讀值。模擬的物理關係是真實的：開啟冷氣會實際拉低室內溫度與濕度，心率也會隨熱負荷變化，因此降溫成效在圖表上是可以驗證的。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
