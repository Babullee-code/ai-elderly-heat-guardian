/**
 * 裝置管理 - the device fleet.
 *
 * Every action here is consequential rather than cosmetic, and the confirm
 * dialogs say what the consequence is. Disabling a temperature sensor stops
 * that reading updating for its resident; disabling an air conditioner makes
 * the policy engine report cooling as blocked. That is the clearest available
 * demonstration that the CMS controls the running platform.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AirVent,
  AlertTriangle,
  BatteryLow,
  Cpu,
  Droplet,
  Fan,
  Heart,
  KeyRound,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Settings2,
  Signal,
  Thermometer,
  Wind,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { Device, DeviceType, SensorReading } from '@shared/types/domain';
import { deviceCreateSchema } from '@shared/schemas/index';
import { api, ApiError } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import {
  cn,
  DEVICE_LABELS_ZH,
  DEVICE_STATUS_ZH,
  formatDateTime,
  formatTime,
  timeAgo,
} from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { DevicePairingWizard } from '@/components/domain/DevicePairingWizard';
import { EmptyState, StatusIndicator } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';

type DeviceRow = Device & { userName: string; userDistrict: string };

const DEVICE_ICONS: Record<DeviceType, React.ComponentType<{ className?: string }>> = {
  SMART_WATCH: Heart,
  TEMPERATURE_SENSOR: Thermometer,
  HUMIDITY_SENSOR: Droplet,
  AIR_QUALITY_SENSOR: Wind,
  SMART_AC: AirVent,
  DEHUMIDIFIER: Wind,
  FAN: Fan,
};

const ALL_TYPES = Object.keys(DEVICE_ICONS) as DeviceType[];

/** What disabling each device type actually costs, shown before confirming. */
const DISABLE_IMPACT: Record<DeviceType, string> = {
  SMART_WATCH: '心率、體表溫度與活動量將停止更新，系統無法比對此長者的個人基準。',
  TEMPERATURE_SENSOR: '室內溫度將停止更新，熱指數會沿用最後一次的讀值。',
  HUMIDITY_SENSOR: '室內濕度將停止更新，熱指數的準確度會下降。',
  AIR_QUALITY_SENSOR: '空氣品質將停止更新，通風風險的判讀會少一項依據。',
  SMART_AC: '自動降溫將無法使用，長者端會顯示降溫動作「未執行：沒有可用設備」。',
  DEHUMIDIFIER: '除濕功能將無法由系統自動啟動。',
  FAN: '電風扇將無法由系統自動啟動。',
};

const NEW_DEVICE = {
  deviceId: '',
  name: '',
  nameZh: '',
  type: 'TEMPERATURE_SENSOR' as DeviceType,
  userId: '',
  location: '客廳',
  firmware: '2.1.0',
};

export default function AdminDevices() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const liveDevices = useLiveStore((s) => s.devices);

  const editable = can('device:write');

  const [rows, setRows] = React.useState<DeviceRow[]>([]);
  const [summary, setSummary] = React.useState({ online: 0, lowBattery: 0, offline: 0, disabled: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [statusFilter, setStatusFilter] = React.useState('ALL');
  const [typeFilter, setTypeFilter] = React.useState('ALL');

  const [confirm, setConfirm] = React.useState<{ device: DeviceRow; action: string } | null>(null);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<{ device: Device; history: SensorReading[] } | null>(null);

  const [creating, setCreating] = React.useState(false);
  const [draft, setDraft] = React.useState({ ...NEW_DEVICE });
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [residents, setResidents] = React.useState<{ id: string; name: string }[]>([]);
  const [pairing, setPairing] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.listDevices();
      setRows(result.devices);
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入裝置清單。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Keep status live from the socket, so a device disabled elsewhere updates
  // here without a manual reload.
  const merged = React.useMemo(() => {
    if (liveDevices.length === 0) return rows;
    const liveById = new Map(liveDevices.map((d) => [d.id, d]));
    return rows.map((row) => {
      const live = liveById.get(row.id);
      return live ? { ...row, ...live } : row;
    });
  }, [rows, liveDevices]);

  const filtered = React.useMemo(
    () =>
      merged.filter((row) => {
        if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
        if (typeFilter !== 'ALL' && row.type !== typeFilter) return false;
        return true;
      }),
    [merged, statusFilter, typeFilter],
  );

  React.useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    api
      .getDevice(detailId)
      .then((result) => setDetail({ device: result.device, history: result.history }))
      .catch(() => setDetail(null));
  }, [detailId]);

  React.useEffect(() => {
    if ((!creating && !pairing) || residents.length > 0) return;
    api
      .listUsers()
      .then((result) => setResidents(result.users.map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => undefined);
  }, [creating, pairing, residents.length]);

  /**
   * The key-management dialog.
   *
   * `issuedKey` holds the one and only copy of a freshly minted key. It lives
   * in component state and nowhere else - not in the store, not in a URL, and
   * never fetched back from the server, which keeps only a hash. Closing the
   * dialog discards it, which is why the dialog says so plainly.
   */
  const [keyFor, setKeyFor] = React.useState<DeviceRow | null>(null);
  const [issuedKey, setIssuedKey] = React.useState<string | null>(null);

  const issueKey = async (device: DeviceRow) => {
    setBusy(true);
    try {
      const result = await api.issueIngestKey(device.id);
      setIssuedKey(result.key);
      toast.success(`已為 ${device.deviceId} 產生金鑰`, '請立即複製，離開後無法再次顯示。');
      await load();
    } catch (err) {
      toast.error('無法產生金鑰', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const revokeKey = async (device: DeviceRow) => {
    setBusy(true);
    try {
      await api.revokeIngestKey(device.id);
      setIssuedKey(null);
      toast.success(
        `已撤銷 ${device.deviceId} 的金鑰`,
        '此裝置將無法再回報資料，數值改由模擬引擎提供。',
      );
      await load();
    } catch (err) {
      toast.error('無法撤銷金鑰', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (device: DeviceRow, action: string) => {
    setBusy(true);
    try {
      await api.deviceAction(device.id, action);

      const messages: Record<string, string> = {
        disable: `已停用 ${device.deviceId}`,
        enable: `已啟用 ${device.deviceId}`,
        reconnect: `已重新連線 ${device.deviceId}`,
        configure: `已重新設定 ${device.deviceId}`,
        'toggle-power': `已${device.power ? '關閉' : '開啟'} ${device.deviceId} 的電源`,
      };

      toast.success(
        messages[action] ?? '指令已執行',
        action === 'disable' ? DISABLE_IMPACT[device.type] : undefined,
      );
      setConfirm(null);
      await load();
    } catch (err) {
      // 409 DEVICE_UNAVAILABLE and 400 NOT_AN_ACTUATOR carry real explanations.
      toast.error('指令未執行', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setFieldErrors({});

    const parsed = deviceCreateSchema.safeParse(draft);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        errors[issue.path.join('.')] = issue.message;
      }
      setFieldErrors(errors);
      setBusy(false);
      return;
    }

    try {
      await api.createDevice(parsed.data);
      toast.success('裝置已註冊', '新裝置已加入監測，並會在下一個更新週期開始回報。');
      setCreating(false);
      setDraft({ ...NEW_DEVICE });
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('註冊失敗', err.displayMessage);
      } else {
        toast.error('註冊失敗', '請稍後再試。');
      }
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------------

  const columns: Column<DeviceRow>[] = [
    {
      key: 'device',
      header: '裝置',
      primary: true,
      sortValue: (row) => row.deviceId,
      cell: (row) => {
        const Icon = DEVICE_ICONS[row.type] ?? Cpu;
        return (
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg',
                row.status === 'OFFLINE' || row.status === 'DISABLED'
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-primary-muted text-primary',
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {DEVICE_LABELS_ZH[row.type] ?? row.name}
              </p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{row.deviceId}</p>
            </div>
          </div>
        );
      },
    },
    {
      key: 'ingest',
      header: '資料來源',
      hideOnMobile: true,
      sortValue: (row) => (row.lastIngestAt ? 2 : row.ingestKeyPrefix ? 1 : 0),
      cell: (row) => {
        if (row.isActuator) {
          return <span className="text-xs text-muted-foreground">控制器</span>;
        }

        // Three genuinely different states, and the difference matters: only
        // the third means a number on screen was measured by real hardware.
        if (row.lastIngestAt) {
          return (
            <div className="flex flex-col items-start gap-0.5">
              <Badge variant="success" className="text-[10px]">實機回報</Badge>
              <span className="text-[10px] text-muted-foreground">
                最後回報 {timeAgo(row.lastIngestAt)}
              </span>
            </div>
          );
        }

        if (row.ingestKeyPrefix) {
          return (
            <div className="flex flex-col items-start gap-0.5">
              <Badge variant="warning" className="text-[10px]">已發金鑰</Badge>
              <span className="font-mono text-[10px] text-muted-foreground">
                {row.ingestKeyPrefix}…
              </span>
            </div>
          );
        }

        return <Badge variant="muted" className="text-[10px]">模擬資料</Badge>;
      },
    },
    {
      key: 'user',
      header: '長者',
      sortValue: (row) => row.userName,
      cell: (row) => (
        <Link
          to={`/admin/users/${row.userId}`}
          className="text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="font-medium">{row.userName}</span>
          <span className="block text-xs text-muted-foreground">{row.userDistrict}</span>
        </Link>
      ),
    },
    {
      key: 'status',
      header: '狀態',
      sortValue: (row) => row.status,
      cell: (row) => <StatusIndicator status={row.status} label={DEVICE_STATUS_ZH[row.status]} />,
    },
    {
      key: 'battery',
      header: '電量',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => row.batteryPct ?? 999,
      cell: (row) =>
        row.batteryPct === null ? (
          <span className="text-xs text-muted-foreground">市電</span>
        ) : (
          <span
            className={cn('tabular text-sm', row.batteryPct < 20 && 'font-medium text-risk-medium')}
          >
            {row.batteryPct}%
          </span>
        ),
    },
    {
      key: 'signal',
      header: '訊號',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => row.signalPct,
      cell: (row) => <span className="tabular text-sm">{row.signalPct}%</span>,
    },
    {
      key: 'lastSeen',
      header: '最後回報',
      sortValue: (row) => new Date(row.lastSeen).getTime(),
      cell: (row) => <span className="text-xs text-muted-foreground">{timeAgo(row.lastSeen)}</span>,
    },
    {
      key: 'firmware',
      header: '韌體',
      hideOnMobile: true,
      cell: (row) => <span className="font-mono text-xs text-muted-foreground">{row.firmware}</span>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (row) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => setDetailId(row.id)}>
            詳細
          </Button>

          {editable && !row.isActuator && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setIssuedKey(null);
                setKeyFor(row);
              }}
            >
              <KeyRound />
              金鑰
            </Button>
          )}

          {editable && (
            <>
              {row.isActuator && row.status !== 'DISABLED' && row.status !== 'OFFLINE' && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void runAction(row, 'toggle-power')}
                  aria-label={`${row.power ? '關閉' : '開啟'} ${row.deviceId} 電源`}
                  title={row.power ? '關閉電源' : '開啟電源'}
                >
                  <Power className={cn(row.power && 'text-risk-low')} />
                </Button>
              )}

              {row.status === 'OFFLINE' || row.status === 'DISABLED' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void runAction(row, 'reconnect')}
                  loading={busy}
                >
                  <RefreshCw />
                  重連
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirm({ device: row, action: 'disable' })}>
                  停用
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="裝置管理" description="載入中…" />
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
        <PageHeader title="裝置管理" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入裝置清單"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="裝置管理"
        description="平台上所有感測器與家電。停用或重新連線會立即影響對應長者的風險判讀與自動降溫能力。"
        actions={
          editable && (
            <div className="flex flex-wrap gap-2">
              {/*
                Pairing is the primary path because it ends with a device that
                has actually reported. Plain registration stays for the case
                where the hardware is not in hand yet.
              */}
              <Button onClick={() => setPairing(true)}>
                <Radio />
                連接新裝置
              </Button>
              <Button variant="outline" onClick={() => setCreating(true)}>
                <Plus />
                只註冊
              </Button>
            </div>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="連線中" value={summary.online} icon={Signal} tone="low" sublabel="正常回報資料" />
        <StatCard
          label="電量偏低"
          value={summary.lowBattery}
          icon={BatteryLow}
          tone="medium"
          sublabel="低於 20%，需更換電池"
        />
        <StatCard label="離線" value={summary.offline} icon={AlertTriangle} tone="high" sublabel="已停止回報" />
        <StatCard label="已停用" value={summary.disabled} icon={Cpu} tone="neutral" sublabel="由管理者停用" />
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowKey={(row) => row.id}
        searchPlaceholder="搜尋裝置編號、長者或位置…"
        searchFields={(row) =>
          `${row.deviceId} ${row.name} ${DEVICE_LABELS_ZH[row.type] ?? ''} ${row.userName} ${row.location} ${row.userDistrict}`
        }
        initialSort={{ key: 'status', direction: 'asc' }}
        filters={[
          {
            key: 'status',
            label: '狀態',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: 'ALL', label: '全部狀態' },
              { value: 'ONLINE', label: '連線中' },
              { value: 'LOW_BATTERY', label: '電量偏低' },
              { value: 'OFFLINE', label: '離線' },
              { value: 'DISABLED', label: '已停用' },
            ],
          },
          {
            key: 'type',
            label: '類型',
            value: typeFilter,
            onChange: setTypeFilter,
            options: [
              { value: 'ALL', label: '全部類型' },
              ...ALL_TYPES.map((type) => ({ value: type, label: DEVICE_LABELS_ZH[type] })),
            ],
          },
        ]}
        emptyState={
          <EmptyState icon={Cpu} title="沒有符合條件的裝置" description="請調整搜尋或篩選條件。" />
        }
      />

      {/* -------------------------- Confirm dialog ------------------------- */}
      <Dialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>停用這台裝置？</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  <span className="font-mono">{confirm?.device.deviceId}</span>（
                  {confirm && DEVICE_LABELS_ZH[confirm.device.type]}）屬於{' '}
                  <strong className="text-foreground">{confirm?.device.userName}</strong>。
                </p>
                <p className="rounded-lg bg-risk-medium-bg p-3 text-risk-medium">
                  <strong className="font-medium">停用後：</strong>
                  {confirm && DISABLE_IMPACT[confirm.device.type]}
                </p>
                <p>此操作會記錄於操作紀錄，並可隨時重新啟用。</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() => confirm && void runAction(confirm.device, confirm.action)}
            >
              確認停用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --------------------------- Detail dialog ------------------------- */}
      <Dialog open={Boolean(detailId)} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>裝置詳細資料</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.device.deviceId} · ${DEVICE_LABELS_ZH[detail.device.type]}` : '載入中…'}
            </DialogDescription>
          </DialogHeader>

          {detail ? (
            <div className="space-y-4">
              <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
                <DetailRow label="狀態" value={DEVICE_STATUS_ZH[detail.device.status]} />
                <DetailRow label="安裝位置" value={detail.device.location} />
                <DetailRow label="韌體版本" value={detail.device.firmware} />
                <DetailRow
                  label="電量"
                  value={detail.device.batteryPct === null ? '市電供電' : `${detail.device.batteryPct}%`}
                />
                <DetailRow label="訊號強度" value={`${detail.device.signalPct}%`} />
                <DetailRow label="最後回報" value={formatDateTime(detail.device.lastSeen)} />
              </dl>

              <div>
                <p className="mb-2 text-sm font-medium">近期讀值</p>
                {detail.history.length === 0 ? (
                  <p className="rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground">
                    此裝置尚無儲存的讀值紀錄。
                  </p>
                ) : (
                  <div className="h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={detail.history.map((sample) => ({
                          label: formatTime(sample.recordedAt),
                          value: sample.value,
                        }))}
                        margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis
                          dataKey="label"
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={32}
                        />
                        <YAxis
                          stroke="hsl(var(--muted-foreground))"
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                          width={40}
                          domain={['auto', 'auto']}
                        />
                        <Tooltip
                          contentStyle={{
                            borderRadius: 8,
                            border: '1px solid hsl(var(--border))',
                            fontSize: 12,
                          }}
                          formatter={(value) => [
                            `${Number(value).toFixed(1)} ${detail.history[0]?.unit ?? ''}`,
                            '讀值',
                          ]}
                        />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  共 {detail.history.length} 筆紀錄。所有數值皆為模擬產生。
                </p>
              </div>
            </div>
          ) : (
            <Skeleton className="h-64" />
          )}
        </DialogContent>
      </Dialog>

      {/* --------------------------- Create dialog ------------------------- */}
      <Dialog open={creating} onOpenChange={(open) => !open && setCreating(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>註冊新裝置</DialogTitle>
            <DialogDescription>
              新裝置註冊後會立即加入監測，並於下一個更新週期開始回報資料。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Field
              label="裝置編號"
              required
              hint="大寫英文、數字與連字號，例如 HG-TEMP-0123"
              error={fieldErrors.deviceId}
            >
              <Input
                value={draft.deviceId}
                onChange={(e) => setDraft({ ...draft, deviceId: e.target.value.toUpperCase() })}
                placeholder="HG-TEMP-0123"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="裝置類型" required error={fieldErrors.type}>
                <Select
                  value={draft.type}
                  onValueChange={(value) => {
                    const type = value as DeviceType;
                    setDraft({
                      ...draft,
                      type,
                      nameZh: DEVICE_LABELS_ZH[type],
                      name: type.split('_').map(titleCase).join(' '),
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {DEVICE_LABELS_ZH[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="指派長者" required error={fieldErrors.userId}>
                <Select value={draft.userId} onValueChange={(value) => setDraft({ ...draft, userId: value })}>
                  <SelectTrigger>
                    <SelectValue placeholder="選擇長者" />
                  </SelectTrigger>
                  <SelectContent>
                    {residents.map((resident) => (
                      <SelectItem key={resident.id} value={resident.id}>
                        {resident.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="顯示名稱（中文）" required error={fieldErrors.nameZh}>
                <Input
                  value={draft.nameZh || DEVICE_LABELS_ZH[draft.type]}
                  onChange={(e) => setDraft({ ...draft, nameZh: e.target.value })}
                />
              </Field>
              <Field label="顯示名稱（英文）" required error={fieldErrors.name}>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Temperature Sensor"
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="安裝位置" required error={fieldErrors.location}>
                <Input
                  value={draft.location}
                  onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                  placeholder="客廳"
                />
              </Field>
              <Field label="韌體版本" required hint="語意化版本，例如 2.4.1" error={fieldErrors.firmware}>
                <Input
                  value={draft.firmware}
                  onChange={(e) => setDraft({ ...draft, firmware: e.target.value })}
                  placeholder="2.1.0"
                />
              </Field>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>
              取消
            </Button>
            <Button onClick={create} loading={busy}>
              註冊裝置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DevicePairingWizard
        open={pairing}
        onOpenChange={setPairing}
        residents={residents}
        onPaired={() => void load()}
      />

      {/* ------------------------- Ingest key ------------------------------ */}
      <Dialog
        open={Boolean(keyFor)}
        onOpenChange={(open) => {
          if (open) return;
          // Discard the key with the dialog. It exists nowhere else.
          setKeyFor(null);
          setIssuedKey(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>資料回報金鑰</DialogTitle>
            <DialogDescription>
              {keyFor?.deviceId} · {keyFor ? (DEVICE_LABELS_ZH[keyFor.type] ?? keyFor.name) : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              有金鑰的裝置可以自行回報量測值。平台只會儲存金鑰的雜湊值，
              因此金鑰僅在產生的當下顯示一次，之後無法再查看；遺失時只能重新產生，
              舊金鑰同時失效。
            </p>

            {issuedKey ? (
              <div className="space-y-2 rounded-lg border border-risk-medium-border bg-risk-medium-bg/40 p-3">
                <p className="text-xs font-semibold text-risk-medium">
                  請立即複製，關閉後將無法再次顯示
                </p>
                <code className="block break-all rounded bg-card p-2 font-mono text-xs">
                  {issuedKey}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(issuedKey);
                    toast.success('已複製金鑰');
                  }}
                >
                  複製
                </Button>
              </div>
            ) : keyFor?.ingestKeyPrefix ? (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <p>
                  目前金鑰：
                  <span className="ml-1 font-mono">{keyFor.ingestKeyPrefix}…</span>
                </p>
                <p className="mt-1 text-muted-foreground">
                  {keyFor.lastIngestAt
                    ? `此裝置已開始回報實機資料，最後一次為 ${timeAgo(keyFor.lastIngestAt)}。`
                    : '此裝置尚未回報任何資料，畫面上的數值仍由模擬引擎提供。'}
                </p>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                此裝置尚未設定金鑰，其數值由模擬引擎提供。
              </p>
            )}

            {keyFor?.lastIngestAt && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                此裝置若<strong className="font-semibold">停止回報</strong>，畫面會顯示最後一次讀值並標示為離線，
                模擬引擎不會接手填補。若要讓此裝置退回模擬資料，請明確撤銷金鑰——
                那是管理者的決定，與裝置自己安靜下來是兩回事。
              </p>
            )}
          </div>

          <DialogFooter>
            {keyFor?.ingestKeyPrefix && (
              <Button
                variant="outline"
                onClick={() => keyFor && void revokeKey(keyFor)}
                loading={busy}
              >
                撤銷金鑰
              </Button>
            )}
            <Button onClick={() => keyFor && void issueKey(keyFor)} loading={busy}>
              {keyFor?.ingestKeyPrefix ? '重新產生' : '產生金鑰'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

function titleCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}
