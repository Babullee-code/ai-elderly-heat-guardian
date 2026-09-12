/**
 * 監測 — detailed live instrumentation for one resident.
 *
 * The dashboard answers "am I safe"; this page answers "what exactly is being
 * measured, by which device, and how fresh is it". Provenance is the point:
 * every value states the device that supplied it, and a value fed by an
 * offline sensor is marked as held rather than presented as current.
 */

import * as React from 'react';
import {
  Activity,
  AirVent,
  AlertTriangle,
  Droplet,
  Footprints,
  Gauge,
  Heart,
  Sun,
  Thermometer,
  UserRound,
  WifiOff,
  Wind,
} from 'lucide-react';

import type { Device, DeviceType } from '@shared/types/domain';

import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useSession } from '@/store/session';
import { selectAssessment, selectSmartHome, useLiveStore } from '@/store/live';
import {
  DEVICE_LABELS_ZH,
  DEVICE_STATUS_ZH,
  cn,
  formatNumber,
  formatTemp,
  formatTime,
  timeAgo,
} from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@/components/ui';
import {
  EmptyState,
  LiveIndicator,
  MetricTile,
  RiskBadge,
  StatusIndicator,
} from '@/components/domain/RiskIndicators';
import { BaselineCard, DeviceCard, PageHeader, SmartHomeCard } from '@/components/domain/Cards';
import {
  ChartCard,
  EnvironmentChart,
  HeartRateChart,
  HumidityChart,
} from '@/components/domain/Charts';
import { DataTable, type Column } from '@/components/domain/DataTable';

// ---------------------------------------------------------------------------
// Reading provenance
// ---------------------------------------------------------------------------

interface ReadingRow {
  key: string;
  metricZh: string;
  value: string;
  unit: string;
  /** Where the number came from - a device, a city feed, or the engine. */
  sourceZh: string;
  device: Device | null;
  /** The feeding device is offline or disabled, so the value is held. */
  stale: boolean;
  at: string;
  simulated: boolean;
}

function deviceOfType(devices: Device[], type: DeviceType): Device | null {
  return devices.find((d) => d.type === type) ?? null;
}

function isDown(device: Device | null): boolean {
  return Boolean(device && (device.status === 'OFFLINE' || device.status === 'DISABLED'));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MonitorPage() {
  const toast = useToast();

  const focusUserId = useSession((s) => s.focusUserId());
  const account = useSession((s) => s.account);
  const canWriteDevices = useSession((s) => s.can('device:write'));
  const elderMode = useSession((s) => s.elderMode);

  const assessment = useLiveStore(selectAssessment(focusUserId));
  const smartHome = useLiveStore(selectSmartHome(focusUserId));
  const historyMap = useLiveStore((s) => s.history);
  const allDevices = useLiveStore((s) => s.devices);
  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);
  const reconnect = useLiveStore((s) => s.connect);

  const history = React.useMemo(
    () => (focusUserId ? (historyMap[focusUserId] ?? []) : []),
    [historyMap, focusUserId],
  );
  const devices = React.useMemo(
    () => (focusUserId ? allDevices.filter((d) => d.userId === focusUserId) : []),
    [allDevices, focusUserId],
  );

  const [busyDeviceId, setBusyDeviceId] = React.useState<string | null>(null);
  const [homeBusy, setHomeBusy] = React.useState(false);

  const canControlHome = account?.role !== 'VIEWER';

  const runDeviceAction = async (device: Device, action: string) => {
    setBusyDeviceId(device.id);
    try {
      await api.deviceAction(device.id, action);
      const label = DEVICE_LABELS_ZH[device.type] ?? device.nameZh;
      toast.success(
        action === 'reconnect'
          ? `已重新連線 ${label}`
          : action === 'disable'
            ? `已停用 ${label}`
            : `已切換 ${label} 電源`,
        `裝置 ${device.deviceId} 的狀態會在下一次同步後更新。`,
      );
    } catch (error) {
      const message =
        error instanceof ApiError ? error.displayMessage : '無法變更裝置狀態，請稍後再試。';
      toast.error('裝置操作失敗', message);
    } finally {
      setBusyDeviceId(null);
    }
  };

  const runHomeCommand = async (work: () => Promise<unknown>, successTitle: string) => {
    setHomeBusy(true);
    try {
      await work();
      toast.success(successTitle);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.displayMessage : '無法控制設備，請稍後再試。';
      toast.error('操作未完成', message);
    } finally {
      setHomeBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Guard states
  // -------------------------------------------------------------------------

  if (!focusUserId) {
    return (
      <>
        <PageHeader title="監測" description="即時感測數值與裝置狀態。" />
        <EmptyState
          icon={UserRound}
          title="尚未指定要檢視的長者"
          description="這個帳號沒有綁定長者資料。請以長者或照護者帳號登入，或由管理後台指派。"
        />
      </>
    );
  }

  if (!assessment) {
    return (
      <>
        <PageHeader
          title="監測"
          description="即時感測數值與裝置狀態。"
          actions={<LiveIndicator connection={connection} updates={updates} />}
        />
        {connection === 'error' || connection === 'closed' ? (
          <EmptyState
            icon={WifiOff}
            title="目前無法取得即時資料"
            description="與伺服器的即時連線中斷了。重新連線後畫面會自動更新。"
            action={<Button onClick={() => reconnect()}>重新連線</Button>}
          />
        ) : (
          <div className="space-y-4" aria-busy>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-80 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        )}
      </>
    );
  }

  const readings = assessment.readings;

  const tempDevice = deviceOfType(devices, 'TEMPERATURE_SENSOR');
  const humidityDevice = deviceOfType(devices, 'HUMIDITY_SENSOR');
  const airDevice = deviceOfType(devices, 'AIR_QUALITY_SENSOR');
  const watchDevice = deviceOfType(devices, 'SMART_WATCH');

  const label = (device: Device | null, fallback: string) =>
    device ? `${DEVICE_LABELS_ZH[device.type] ?? device.nameZh} · ${device.deviceId}` : fallback;

  const rows: ReadingRow[] = [
    {
      key: 'indoorTemp',
      metricZh: '室內溫度',
      value: readings.indoorTempC.toFixed(1),
      unit: '°C',
      sourceZh: label(tempDevice, '無對應裝置'),
      device: tempDevice,
      stale: isDown(tempDevice),
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'indoorHumidity',
      metricZh: '室內濕度',
      value: readings.indoorHumidityPct.toFixed(0),
      unit: '%',
      sourceZh: label(humidityDevice, '無對應裝置'),
      device: humidityDevice,
      stale: isDown(humidityDevice),
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'outdoorTemp',
      metricZh: '室外溫度',
      value: readings.outdoorTempC.toFixed(1),
      unit: '°C',
      sourceZh: '城市氣象資料源',
      device: null,
      stale: false,
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'outdoorHumidity',
      metricZh: '室外濕度',
      value: readings.outdoorHumidityPct.toFixed(0),
      unit: '%',
      sourceZh: '城市氣象資料源',
      device: null,
      stale: false,
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'heatIndex',
      metricZh: '熱指數',
      value: assessment.heatIndex.toFixed(1),
      unit: '°C',
      sourceZh: '風險引擎計算（溫度 × 濕度）',
      device: null,
      stale: false,
      at: assessment.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'airQuality',
      metricZh: '空氣品質 AQI',
      value: formatNumber(readings.airQualityIndex),
      unit: '',
      sourceZh: label(airDevice, '城市空品資料源'),
      device: airDevice,
      stale: isDown(airDevice),
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'heartRate',
      metricZh: '心率',
      value: String(readings.heartRateBpm),
      unit: 'BPM',
      sourceZh: label(watchDevice, '無對應裝置'),
      device: watchDevice,
      stale: isDown(watchDevice),
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'skinTemp',
      metricZh: '皮膚溫度',
      value: readings.skinTempC.toFixed(1),
      unit: '°C',
      sourceZh: label(watchDevice, '無對應裝置'),
      device: watchDevice,
      stale: isDown(watchDevice),
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'activity',
      metricZh: '活動量',
      value: formatNumber(readings.activityStepsPerHour),
      unit: '步/時',
      sourceZh: label(watchDevice, '無對應裝置'),
      device: watchDevice,
      stale: isDown(watchDevice),
      at: readings.timestamp,
      simulated: readings.simulated,
    },
    {
      key: 'heatwaveDays',
      metricZh: '連續熱浪天數',
      value: String(readings.heatwaveDays),
      unit: '天',
      sourceZh: '城市氣象資料源',
      device: null,
      stale: false,
      at: readings.timestamp,
      simulated: readings.simulated,
    },
  ];

  const columns: Column<ReadingRow>[] = [
    {
      key: 'metric',
      header: '量測項目',
      primary: true,
      sortValue: (row) => row.metricZh,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.metricZh}</span>
          {row.stale && (
            <Badge variant="warning" className="text-[10px]">
              數值已保留
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'value',
      header: '目前數值',
      align: 'right',
      sortValue: (row) => Number(row.value.replace(/,/g, '')) || 0,
      cell: (row) => (
        <span className={cn('tabular font-semibold', row.stale && 'text-muted-foreground')}>
          {row.value}
          {row.unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{row.unit}</span>}
        </span>
      ),
    },
    {
      key: 'source',
      header: '來源裝置',
      sortValue: (row) => row.sourceZh,
      cell: (row) => (
        <span className="text-xs text-muted-foreground">
          {row.device ? (
            <span className="font-mono">{row.sourceZh}</span>
          ) : (
            row.sourceZh
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: '裝置狀態',
      cell: (row) =>
        row.device ? (
          <StatusIndicator
            status={row.device.status}
            label={DEVICE_STATUS_ZH[row.device.status]}
          />
        ) : (
          <span className="text-xs text-muted-foreground">非裝置來源</span>
        ),
    },
    {
      key: 'at',
      header: '更新時間',
      hideOnMobile: true,
      sortValue: (row) => row.at,
      cell: (row) => (
        <span className="tabular text-xs text-muted-foreground">
          {formatTime(row.at)}
          <span className="ml-1">（{timeAgo(row.at)}）</span>
        </span>
      ),
    },
    {
      key: 'provenance',
      header: '資料性質',
      cell: (row) => (
        <Badge variant={row.simulated ? 'muted' : 'success'} className="font-mono text-[10px]">
          {row.simulated ? 'SIMULATED' : 'LIVE'}
        </Badge>
      ),
    },
  ];

  const downDevices = devices.filter((d) => isDown(d));

  return (
    <div className="space-y-8">
      <PageHeader
        title="監測"
        description="這個頁面顯示每一項感測數值、供應它的裝置，以及數值的新鮮度。"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <RiskBadge level={assessment.level} size="sm" />
            <LiveIndicator connection={connection} updates={updates} />
          </div>
        }
      />

      {/* Honest provenance, stated once and prominently. */}
      {readings.simulated && (
        <div className="flex gap-3 rounded-lg border border-dashed border-border bg-muted/50 p-4">
          <Activity className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            <strong className="font-semibold text-foreground">資料性質：SIMULATED。</strong>
            本原型的感測數值由伺服器端的模擬引擎產生，並未連接真實硬體。裝置狀態、數值保留邏輯與風險判讀則依照真實流程運作。
          </p>
        </div>
      )}

      {downDevices.length > 0 && (
        <div className="flex gap-3 rounded-lg border border-risk-medium-border bg-risk-medium-bg p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk-medium" />
          <div className="text-xs leading-relaxed text-risk-medium">
            <p className="font-semibold">有 {downDevices.length} 個裝置目前無法回報</p>
            <p className="mt-1">
              {downDevices
                .map((d) => `${DEVICE_LABELS_ZH[d.type] ?? d.nameZh}（${DEVICE_STATUS_ZH[d.status]}）`)
                .join('、')}
              。這些裝置所供應的數值為最後一次成功回報的值，並非目前數值。
            </p>
          </div>
        </div>
      )}

      {/* ---------------------------- Current values ---------------------- */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">目前讀數</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="室內溫度"
            value={readings.indoorTempC.toFixed(1)}
            unit="°C"
            icon={Thermometer}
            sublabel={label(tempDevice, '無對應裝置')}
            stale={isDown(tempDevice)}
          />
          <MetricTile
            label="室內濕度"
            value={readings.indoorHumidityPct.toFixed(0)}
            unit="%"
            icon={Droplet}
            sublabel={label(humidityDevice, '無對應裝置')}
            stale={isDown(humidityDevice)}
          />
          <MetricTile
            label="室外溫度"
            value={readings.outdoorTempC.toFixed(1)}
            unit="°C"
            icon={Sun}
            sublabel="城市氣象資料源"
          />
          <MetricTile
            label="熱指數"
            value={assessment.heatIndex.toFixed(1)}
            unit="°C"
            icon={Gauge}
            sublabel="由溫度與濕度計算"
            tone={
              assessment.level === 'HIGH'
                ? 'high'
                : assessment.level === 'MEDIUM'
                  ? 'medium'
                  : 'low'
            }
          />
          <MetricTile
            label="心率"
            value={readings.heartRateBpm}
            unit="BPM"
            icon={Heart}
            sublabel={`平常 ${assessment.baseline.range.min}–${assessment.baseline.range.max} BPM`}
            stale={isDown(watchDevice)}
            tone={assessment.baseline.aboveBaseline ? 'high' : 'low'}
          />
          <MetricTile
            label="皮膚溫度"
            value={readings.skinTempC.toFixed(1)}
            unit="°C"
            icon={Thermometer}
            sublabel={label(watchDevice, '無對應裝置')}
            stale={isDown(watchDevice)}
          />
          <MetricTile
            label="活動量"
            value={formatNumber(readings.activityStepsPerHour)}
            unit="步/時"
            icon={Footprints}
            sublabel={label(watchDevice, '無對應裝置')}
            stale={isDown(watchDevice)}
          />
          <MetricTile
            label="空氣品質 AQI"
            value={formatNumber(readings.airQualityIndex)}
            icon={Wind}
            sublabel={label(airDevice, '城市空品資料源')}
            stale={isDown(airDevice)}
          />
        </div>
      </section>

      {/* ------------------------------ Environment ----------------------- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">環境</h2>
          <p className="text-sm text-muted-foreground">
            室內外溫度、熱指數與冷氣目標溫度的變化。
          </p>
        </div>

        <ChartCard
          title="溫度與熱指數"
          description="熱指數是判讀風險等級的主要依據。"
          height={280}
          action={
            <Badge variant="muted" className="text-[10px]">
              最近 {history.length} 筆
            </Badge>
          }
        >
          <EnvironmentChart history={history} height={280} />
        </ChartCard>

        <ChartCard title="室內濕度" description="濕度越高，身體越不容易靠排汗散熱。" height={200}>
          <HumidityChart history={history} height={200} />
        </ChartCard>
      </section>

      {/* ------------------------------ Physiology ------------------------ */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">生理</h2>
          <p className="text-sm text-muted-foreground">
            心率以本人平常的範圍判讀，而不是固定的門檻。
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-5">
          <ChartCard
            title="心率與個人基準"
            description="淺色區塊為系統學習到的個人平常範圍。"
            height={260}
            className="lg:col-span-3"
          >
            <HeartRateChart history={history} height={260} />
          </ChartCard>

          <BaselineCard evaluation={assessment.baseline} className="lg:col-span-2" />
        </div>
      </section>

      {/* --------------------------- Devices & sensors -------------------- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">裝置與感測器</h2>
          <p className="text-sm text-muted-foreground">
            {canWriteDevices
              ? '可在此重新連線或停用裝置；長者介面僅供檢視。'
              : '裝置狀態僅供檢視，降溫設備可由下方的智慧家庭控制。'}
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {smartHome && (
            <SmartHomeCard
              className="lg:col-span-1"
              smartHome={smartHome}
              busy={homeBusy}
              readOnly={!canControlHome}
              onToggle={(appliance, on) =>
                runHomeCommand(
                  () => api.setAppliance(focusUserId, appliance, on),
                  `已${on ? '開啟' : '關閉'}${appliance === 'ac' ? '冷氣' : appliance === 'fan' ? '電風扇' : '除濕機'}`,
                )
              }
              onCancelAutomation={() =>
                runHomeCommand(() => api.cancelAutomation(focusUserId), '已取消自動降溫')
              }
              onRestoreAutomation={() =>
                runHomeCommand(() => api.restoreAutomation(focusUserId), '已恢復自動降溫')
              }
            />
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
            {devices.length === 0 ? (
              <EmptyState
                className="sm:col-span-2"
                icon={AirVent}
                title="尚未安裝任何裝置"
                description="這位長者目前沒有綁定的感測裝置，數值改由城市資料源推估。"
              />
            ) : (
              devices.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  busy={busyDeviceId === device.id}
                  onAction={
                    canWriteDevices ? (action) => void runDeviceAction(device, action) : undefined
                  }
                />
              ))
            )}
          </div>
        </div>
      </section>

      {/* ---------------------------- Readings table ---------------------- */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">讀數明細</h2>
          <p className="text-sm text-muted-foreground">
            每一項數值、供應它的裝置，以及該數值是即時或已保留。
          </p>
        </div>

        <DataTable
          rows={rows}
          columns={columns}
          getRowKey={(row) => row.key}
          searchFields={(row) => `${row.metricZh} ${row.sourceZh}`}
          searchPlaceholder="搜尋量測項目或裝置…"
          initialSort={{ key: 'metric', direction: 'asc' }}
        />

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">如何判讀這張表</CardTitle>
            <CardDescription className="text-xs">
              感測器離線時，平台不會編造數值，也不會直接沿用而不說明。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p>
              <strong className="text-foreground">即時：</strong>
              供應裝置處於連線狀態，數值取自最近一次回報，時間如「更新時間」欄所示。
            </p>
            <p>
              <strong className="text-foreground">數值已保留：</strong>
              供應裝置離線或已停用，畫面顯示的是最後一次成功回報的值，並非目前狀況。
            </p>
            <p>
              <strong className="text-foreground">非裝置來源：</strong>
              室外環境取自城市氣象資料源；熱指數由風險引擎依溫度與濕度計算，並非直接量測。
            </p>
            <Separator className="my-3" />
            <p>
              目前的評估頻率為每 {assessment.monitoringIntervalSec} 秒一次，風險越高頻率越密集。
            </p>
          </CardContent>
        </Card>
      </section>

      {elderMode && (
        <p className="text-sm text-muted-foreground">
          若只想看重點，請回到「總覽」，該頁面會用最簡單的方式說明目前狀況與該做的事。
        </p>
      )}
    </div>
  );
}
