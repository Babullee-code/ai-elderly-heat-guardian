/**
 * 我的裝置 - the resident's own devices.
 *
 * A resident may switch their own appliances, but sensor administration
 * (disable, reconnect, reconfigure) is deliberately not offered here: those
 * are operator actions with platform-wide consequences and belong in the CMS.
 *
 * When a sensor is offline the page says what that costs — which reading has
 * stopped updating — rather than showing a stale number as though it were
 * current.
 */

import * as React from 'react';
import {
  Activity,
  AirVent,
  AlertTriangle,
  BatteryLow,
  CheckCircle2,
  Droplet,
  Fan,
  Heart,
  Info,
  Signal,
  Smartphone,
  Thermometer,
  Wind,
} from 'lucide-react';

import type { Device, DeviceType } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useLiveStore, selectSmartHome, selectUserDevices } from '@/store/live';
import { useSession } from '@/store/session';
import { cn, DEVICE_LABELS_ZH, DEVICE_STATUS_ZH, timeAgo } from '@/lib/utils';
import { useToast } from '@/components/Toast';
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
import { PageHeader, SmartHomeCard } from '@/components/domain/Cards';
import { EmptyState, StatusIndicator } from '@/components/domain/RiskIndicators';

const DEVICE_ICONS: Record<DeviceType, React.ComponentType<{ className?: string }>> = {
  SMART_WATCH: Heart,
  TEMPERATURE_SENSOR: Thermometer,
  HUMIDITY_SENSOR: Droplet,
  AIR_QUALITY_SENSOR: Wind,
  SMART_AC: AirVent,
  DEHUMIDIFIER: Wind,
  FAN: Fan,
};

/** What a resident loses when a given sensor stops reporting. */
const OFFLINE_IMPACT: Partial<Record<DeviceType, string>> = {
  TEMPERATURE_SENSOR: '室內溫度已停止更新，系統會沿用最後一次的讀值。',
  HUMIDITY_SENSOR: '室內濕度已停止更新，熱指數的判讀準確度會下降。',
  AIR_QUALITY_SENSOR: '空氣品質已停止更新。',
  SMART_WATCH: '心率與活動量已停止更新，系統暫時無法比對您的個人基準。',
  SMART_AC: '冷氣無法由系統自動啟動。',
  DEHUMIDIFIER: '除濕機無法由系統自動啟動。',
  FAN: '電風扇無法由系統自動啟動。',
};

export default function DevicesPage() {
  const toast = useToast();
  const focusUserId = useSession((s) => s.focusUserId());
  const elderMode = useSession((s) => s.elderMode);

  const devices = useLiveStore(selectUserDevices(focusUserId));
  const smartHome = useLiveStore(selectSmartHome(focusUserId));

  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // The live socket carries device state, so this only covers the brief
    // window before the first tick arrives.
    const timer = setTimeout(() => setLoading(false), 1200);
    if (devices.length > 0) setLoading(false);
    return () => clearTimeout(timer);
  }, [devices.length]);

  const setAppliance = async (appliance: 'ac' | 'fan' | 'dehumidifier', on: boolean) => {
    if (!focusUserId) return;
    setBusy(true);
    try {
      await api.setAppliance(focusUserId, appliance, on);
      const label = appliance === 'ac' ? '冷氣' : appliance === 'fan' ? '電風扇' : '除濕機';
      toast.success(on ? `已開啟${label}` : `已關閉${label}`);
    } catch (error) {
      toast.error(
        '無法操作設備',
        error instanceof ApiError ? error.displayMessage : '請稍後再試。',
      );
    } finally {
      setBusy(false);
    }
  };

  const cancelAutomation = async () => {
    if (!focusUserId) return;
    setBusy(true);
    try {
      await api.cancelAutomation(focusUserId);
      toast.info('已取消本次自動降溫', '在風險回到低風險之前，系統不會再自動開啟降溫設備。');
    } catch (error) {
      toast.error('操作失敗', error instanceof ApiError ? error.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const restoreAutomation = async () => {
    if (!focusUserId) return;
    setBusy(true);
    try {
      await api.restoreAutomation(focusUserId);
      toast.success('已恢復自動降溫');
    } catch (error) {
      toast.error('操作失敗', error instanceof ApiError ? error.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  if (!focusUserId) {
    return (
      <div className="space-y-6">
        <PageHeader title="我的裝置" />
        <EmptyState icon={Smartphone} title="尚未選擇長者" description="目前的帳號沒有對應的長者資料。" />
      </div>
    );
  }

  if (loading && devices.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="我的裝置" description="載入中…" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="我的裝置" />
        <EmptyState
          icon={Smartphone}
          title="尚未登記任何裝置"
          description="這位長者目前沒有連接的感測器或家電。請聯繫平台管理者協助安裝。"
        />
      </div>
    );
  }

  const online = devices.filter((d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY');
  const down = devices.filter((d) => d.status === 'OFFLINE' || d.status === 'DISABLED');
  const lowBattery = devices.filter((d) => d.batteryPct !== null && d.batteryPct < 20);

  const sensors = devices.filter((d) => !d.isActuator);
  const appliances = devices.filter((d) => d.isActuator);

  return (
    <div className="space-y-6">
      <PageHeader
        title="我的裝置"
        description="您家中的感測器與降溫設備。感測器負責提供數據，降溫設備可以由您或系統開關。"
      />

      {/* --------------------------- Summary ----------------------------- */}
      <Card className={cn(down.length > 0 ? 'border-risk-medium-border bg-risk-medium-bg/40' : '')}>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
          <div className="flex items-center gap-2">
            {down.length === 0 ? (
              <CheckCircle2 className="size-5 text-risk-low" />
            ) : (
              <AlertTriangle className="size-5 text-risk-medium" />
            )}
            <span className={cn('font-semibold', elderMode && 'text-lg')}>
              {online.length} / {devices.length} 台裝置連線中
            </span>
          </div>

          {lowBattery.length > 0 && (
            <Badge variant="warning">
              <BatteryLow className="size-3" />
              {lowBattery.length} 台電量偏低
            </Badge>
          )}

          {down.length > 0 && (
            <Badge variant="danger">
              {down.length} 台離線或已停用
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* ------------------- Offline impact, stated plainly ---------------- */}
      {down.length > 0 && (
        <Card className="border-risk-medium-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4 text-risk-medium" />
              目前受影響的功能
            </CardTitle>
            <CardDescription>
              裝置離線時，系統不會猜測數值，而是沿用最後一次的讀值並標示為未更新。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {down.map((device) => (
                <li key={device.id} className="flex gap-2.5 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk-medium" />
                  <span>
                    <strong className="font-medium">
                      {DEVICE_LABELS_ZH[device.type] ?? device.name}
                    </strong>
                    （{DEVICE_STATUS_ZH[device.status]}）：
                    <span className="text-muted-foreground">
                      {OFFLINE_IMPACT[device.type] ?? '此裝置的資料已停止更新。'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              需要重新連線或更換裝置時，請聯繫您的照護者或平台管理者協助處理。
            </p>
          </CardContent>
        </Card>
      )}

      {/* -------------------------- Smart home ---------------------------- */}
      {smartHome && (
        <SmartHomeCard
          smartHome={smartHome}
          onToggle={setAppliance}
          onCancelAutomation={cancelAutomation}
          onRestoreAutomation={restoreAutomation}
          busy={busy}
        />
      )}

      {/* -------------------------- Appliances ---------------------------- */}
      {appliances.length > 0 && (
        <section className="space-y-3">
          <h2 className={cn('font-semibold', elderMode ? 'text-xl' : 'text-lg')}>降溫設備</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {appliances.map((device) => (
              <ResidentDeviceCard key={device.id} device={device} elderMode={elderMode} />
            ))}
          </div>
        </section>
      )}

      {/* --------------------------- Sensors ------------------------------ */}
      <section className="space-y-3">
        <h2 className={cn('font-semibold', elderMode ? 'text-xl' : 'text-lg')}>感測器</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {sensors.map((device) => (
            <ResidentDeviceCard key={device.id} device={device} elderMode={elderMode} />
          ))}
        </div>
      </section>

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            本原型的所有感測數值皆為模擬產生，並未連接真實硬體。裝置的連線狀態、電量與訊號強度同樣為模擬資料，但風險判讀與設備控制的流程則是真實運作的程式邏輯。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Read-only device card for the resident.
 *
 * Deliberately omits the administrative actions (disable, reconnect,
 * configure) that the CMS version of this card offers.
 */
function ResidentDeviceCard({ device, elderMode }: { device: Device; elderMode: boolean }) {
  const Icon = DEVICE_ICONS[device.type] ?? Activity;
  const down = device.status === 'OFFLINE' || device.status === 'DISABLED';

  return (
    <Card className={cn(down && 'border-dashed opacity-80')}>
      <CardContent className="flex items-start gap-3 p-4">
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg',
            elderMode ? 'size-12' : 'size-10',
            down ? 'bg-muted text-muted-foreground' : 'bg-primary-muted text-primary',
          )}
        >
          <Icon className={elderMode ? 'size-6' : 'size-5'} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={cn('font-semibold', elderMode ? 'text-lg' : 'text-sm')}>
              {DEVICE_LABELS_ZH[device.type] ?? device.name}
            </p>
            <StatusIndicator status={device.status} label={DEVICE_STATUS_ZH[device.status]} />
          </div>

          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{device.deviceId}</p>

          <div
            className={cn(
              'mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground',
              elderMode ? 'text-sm' : 'text-xs',
            )}
          >
            <span>{device.location}</span>

            {device.batteryPct !== null && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  device.batteryPct < 20 && 'font-medium text-risk-medium',
                )}
              >
                <BatteryLow className="size-3" />
                電量 {device.batteryPct}%
              </span>
            )}

            {!down && (
              <span className="flex items-center gap-1">
                <Signal className="size-3" />
                訊號 {device.signalPct}%
              </span>
            )}
          </div>

          <p className="mt-1.5 text-xs text-muted-foreground">
            最後回報：{timeAgo(device.lastSeen)}
            {device.isActuator && (
              <>
                {' · '}
                <span className={cn('font-medium', device.power ? 'text-risk-low' : '')}>
                  {device.power ? '運轉中' : '待機'}
                </span>
              </>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
