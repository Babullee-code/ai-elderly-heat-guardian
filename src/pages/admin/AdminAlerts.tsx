/**
 * /admin/alerts — 警示中心
 *
 * The response surface of the platform. The list is fed by the live socket so
 * a new alert appears without a refetch; the detail dialog reconstructs the
 * whole incident from the server: why it fired, the readings it fired on, the
 * AI reasoning at that moment, what the platform did, who was told, and how
 * the situation looks right now.
 *
 * No risk value is computed here. Everything shown is what the server decided
 * at trigger time, plus the current assessment for comparison.
 */

import * as React from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Droplet,
  Footprints,
  Gauge,
  Heart,
  Info,
  Inbox,
  Lock,
  RefreshCw,
  ShieldCheck,
  Thermometer,
  UserCog,
  Wind,
  Zap,
} from 'lucide-react';

import type {
  Alert,
  AlertSeverity,
  AlertStatus,
  AlertTimelineEntry,
  RiskAssessment,
} from '@shared/types/domain';
import { ACTION_CATALOGUE } from '@shared/domain/actionEngine';

import { api, ApiError, type CaregiverRow } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { useToast } from '@/components/Toast';
import {
  ALERT_STATUS_ZH,
  cn,
  formatDateTime,
  formatNumber,
  formatPct,
  formatTemp,
  timeAgo,
} from '@/lib/utils';

import { AIExplanationCard, PageHeader } from '@/components/domain/Cards';
import { DataTable, type Column } from '@/components/domain/DataTable';
import {
  EmptyState,
  LiveIndicator,
  MetricTile,
  RiskBadge,
  RiskFactorList,
  RiskScoreDial,
  TrendIcon,
} from '@/components/domain/RiskIndicators';
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
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Textarea,
} from '@/components/ui';

// ---------------------------------------------------------------------------
// Presentation tables
// ---------------------------------------------------------------------------

const SEVERITY_META: Record<
  AlertSeverity,
  {
    zh: string;
    en: string;
    variant: 'muted' | 'warning' | 'danger';
    icon: React.ComponentType<{ className?: string }>;
    rank: number;
  }
> = {
  CRITICAL: { zh: '危急', en: 'CRITICAL', variant: 'danger', icon: AlertOctagon, rank: 3 },
  WARNING: { zh: '警告', en: 'WARNING', variant: 'warning', icon: AlertTriangle, rank: 2 },
  INFO: { zh: '一般', en: 'INFO', variant: 'muted', icon: Info, rank: 1 },
};

const STATUS_VARIANT: Record<AlertStatus, 'danger' | 'warning' | 'success'> = {
  NEW: 'danger',
  ESCALATED: 'danger',
  ACKNOWLEDGED: 'warning',
  RESOLVED: 'success',
};

const TIMELINE_META: Record<
  AlertTimelineEntry['kind'],
  { zh: string; icon: React.ComponentType<{ className?: string }>; dot: string; text: string }
> = {
  TRIGGER: { zh: '觸發', icon: Zap, dot: 'bg-risk-high-bg border-risk-high-border', text: 'text-risk-high' },
  ACTION: { zh: '系統行動', icon: Activity, dot: 'bg-primary-muted border-primary/30', text: 'text-primary' },
  NOTIFICATION: { zh: '通知', icon: Bell, dot: 'bg-risk-medium-bg border-risk-medium-border', text: 'text-risk-medium' },
  STATUS: { zh: '狀態變更', icon: ClipboardCheck, dot: 'bg-muted border-border', text: 'text-muted-foreground' },
  RECOVERY: { zh: '恢復', icon: ShieldCheck, dot: 'bg-risk-low-bg border-risk-low-border', text: 'text-risk-low' },
};

const STATUS_TABS: { value: 'ALL' | AlertStatus; label: string }[] = [
  { value: 'ALL', label: '全部' },
  { value: 'NEW', label: ALERT_STATUS_ZH.NEW },
  { value: 'ACKNOWLEDGED', label: ALERT_STATUS_ZH.ACKNOWLEDGED },
  { value: 'ESCALATED', label: ALERT_STATUS_ZH.ESCALATED },
  { value: 'RESOLVED', label: ALERT_STATUS_ZH.RESOLVED },
];

type AlertDetail = Awaited<ReturnType<typeof api.getAlert>>;

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="whitespace-nowrap">
      <Icon className="size-3" />
      {meta.zh}
      <span className="opacity-60">· {meta.en}</span>
    </Badge>
  );
}

function StatusBadge({ status }: { status: AlertStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="whitespace-nowrap">
      {ALERT_STATUS_ZH[status]}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminAlerts() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const writable = can('alert:write');

  const liveAlerts = useLiveStore((s) => s.alerts);
  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);

  const [status, setStatus] = React.useState<'ALL' | AlertStatus>('ALL');
  // Two fetch buckets: the unfiltered load underwrites the tab counts, the
  // filtered load is the authoritative answer for the selected tab. Both are
  // merged with the live socket, which always wins on a given alert id.
  const [allFetched, setAllFetched] = React.useState<Alert[]>([]);
  const [statusFetched, setStatusFetched] = React.useState<Alert[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [openId, setOpenId] = React.useState<string | null>(null);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listAlerts();
      setAllFetched(result.alerts);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Filtering goes back to the server so the tab reflects what the API says,
  // not only what the socket happens to be carrying.
  React.useEffect(() => {
    let cancelled = false;
    if (status === 'ALL') {
      setStatusFetched([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const result = await api.listAlerts(status);
        if (!cancelled) setStatusFetched(result.alerts);
      } catch {
        // The unfiltered list plus the live socket still cover this tab; the
        // page-level error state is reserved for a total failure to load.
        if (!cancelled) setStatusFetched([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  /** Every alert we know about, with the live copy taking precedence. */
  const merged = React.useMemo(() => {
    const byId = new Map<string, Alert>();
    for (const alert of allFetched) byId.set(alert.id, alert);
    for (const alert of statusFetched) byId.set(alert.id, alert);
    for (const alert of liveAlerts) byId.set(alert.id, alert);
    return [...byId.values()];
  }, [allFetched, statusFetched, liveAlerts]);

  const counts = React.useMemo(() => {
    const base: Record<'ALL' | AlertStatus, number> = {
      ALL: merged.length,
      NEW: 0,
      ACKNOWLEDGED: 0,
      ESCALATED: 0,
      RESOLVED: 0,
    };
    for (const alert of merged) base[alert.status] += 1;
    return base;
  }, [merged]);

  /** Most severe first, then newest — the order a responder wants. */
  const rows = React.useMemo(() => {
    const filtered = status === 'ALL' ? merged : merged.filter((a) => a.status === status);
    return [...filtered].sort((a, b) => {
      const severity = SEVERITY_META[b.severity].rank - SEVERITY_META[a.severity].rank;
      if (severity !== 0) return severity;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [merged, status]);

  const columns = React.useMemo<Column<Alert>[]>(
    () => [
      {
        key: 'severity',
        header: '嚴重度',
        cell: (row) => <SeverityBadge severity={row.severity} />,
        sortValue: (row) => SEVERITY_META[row.severity].rank,
      },
      {
        key: 'resident',
        header: '長者',
        primary: true,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.userName}</p>
            <p className="truncate text-xs text-muted-foreground md:hidden">{row.triggerZh}</p>
          </div>
        ),
        sortValue: (row) => row.userName,
      },
      {
        key: 'level',
        header: '風險等級',
        cell: (row) => <RiskBadge level={row.level} size="sm" />,
        sortValue: (row) => row.level,
      },
      {
        key: 'trigger',
        header: '觸發原因',
        hideOnMobile: true,
        className: 'max-w-[22rem]',
        cell: (row) => <p className="truncate text-xs text-muted-foreground">{row.triggerZh}</p>,
      },
      {
        key: 'createdAt',
        header: '發生時間',
        cell: (row) => (
          <span className="tabular whitespace-nowrap text-xs text-muted-foreground">
            {timeAgo(row.createdAt)}
          </span>
        ),
        sortValue: (row) => new Date(row.createdAt).getTime(),
      },
      {
        key: 'status',
        header: '狀態',
        cell: (row) => <StatusBadge status={row.status} />,
        sortValue: (row) => row.status,
      },
      {
        key: 'caregiver',
        header: '負責照護者',
        hideOnMobile: true,
        cell: (row) =>
          row.assignedCaregiverName ? (
            <span className="whitespace-nowrap text-sm">{row.assignedCaregiverName}</span>
          ) : (
            <span className="text-xs text-muted-foreground">尚未指派</span>
          ),
        sortValue: (row) => row.assignedCaregiverName ?? '',
      },
      {
        key: 'actions',
        header: '操作',
        align: 'right',
        cell: (row) => (
          <Button size="sm" variant="outline" onClick={() => setOpenId(row.id)}>
            查看詳情
          </Button>
        ),
      },
    ],
    [],
  );

  if (loading && merged.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="警示中心" description="正在載入警示資料…" />
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((tab) => (
            <Skeleton key={tab.value} className="h-9 w-28" />
          ))}
        </div>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (error && merged.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="警示中心" description="監看所有觸發中的熱風險警示並記錄處理過程。" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入警示資料"
          description={error}
          action={
            <Button onClick={() => void loadAll()}>
              <RefreshCw />
              重試
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="警示中心"
        description="每一則警示都保留觸發當下的感測數值與 AI 判讀，並完整記錄後續處理過程。"
        actions={
          <>
            <LiveIndicator connection={connection} updates={updates} className="self-center" />
            <Button variant="outline" onClick={() => void loadAll()} loading={loading}>
              <RefreshCw />
              重新整理
            </Button>
          </>
        }
      />

      {!writable && (
        <Card className="border-dashed">
          <CardContent className="flex items-start gap-3 p-4">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              您目前的帳號為唯讀權限，可以檢視警示內容與處理紀錄，但無法變更狀態或指派照護者。
            </p>
          </CardContent>
        </Card>
      )}

      {/* Status filter tabs with live counts. */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="依狀態篩選警示"
      >
        {STATUS_TABS.map((tab) => {
          const active = status === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setStatus(tab.value)}
              aria-pressed={active}
              className={cn(
                'inline-flex min-h-[44px] items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {tab.label}
              <span
                className={cn(
                  'tabular rounded-full px-2 py-0.5 text-xs',
                  active ? 'bg-primary-foreground/20' : 'bg-muted',
                )}
              >
                {counts[tab.value]}
              </span>
            </button>
          );
        })}
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        searchPlaceholder="搜尋長者、觸發原因或照護者…"
        searchFields={(row) =>
          `${row.userName} ${row.triggerZh} ${row.trigger} ${row.assignedCaregiverName ?? ''}`
        }
        onRowClick={(row) => setOpenId(row.id)}
        emptyState={
          <EmptyState
            icon={Inbox}
            title={status === 'ALL' ? '目前沒有任何警示' : `目前沒有${
              STATUS_TABS.find((t) => t.value === status)?.label ?? ''
            }的警示`}
            description="當風險等級升高或裝置異常時，系統會自動在這裡建立警示。"
          />
        }
      />

      <AlertDetailDialog
        alertId={openId}
        writable={writable}
        onClose={() => setOpenId(null)}
        onMutated={(updated) => {
          // Keep the table in step immediately; the socket confirms shortly after.
          setAllFetched((current) =>
            current.some((a) => a.id === updated.id)
              ? current.map((a) => (a.id === updated.id ? updated : a))
              : [updated, ...current],
          );
          setStatusFetched((current) => current.map((a) => (a.id === updated.id ? updated : a)));
        }}
        toast={toast}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------

function AlertDetailDialog({
  alertId,
  writable,
  onClose,
  onMutated,
  toast,
}: {
  alertId: string | null;
  writable: boolean;
  onClose: () => void;
  onMutated: (alert: Alert) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [detail, setDetail] = React.useState<AlertDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [caregivers, setCaregivers] = React.useState<CaregiverRow[]>([]);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAlert(id);
      setDetail(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!alertId) {
      setDetail(null);
      setError(null);
      setNote('');
      return;
    }
    void load(alertId);
  }, [alertId, load]);

  // The reassignment list is the full caregiver roster, fetched once the
  // dialog is first opened rather than on every page load.
  React.useEffect(() => {
    if (!alertId || caregivers.length > 0) return;
    void (async () => {
      try {
        const result = await api.listCaregivers();
        setCaregivers(result.caregivers);
      } catch {
        // Reassignment simply stays unavailable; the rest of the dialog works.
      }
    })();
  }, [alertId, caregivers.length]);

  const alert = detail?.alert ?? null;

  async function mutate(
    label: string,
    body: { status: AlertStatus; assignedCaregiverId?: string | null },
  ) {
    if (!alert) return;
    setBusy(label);
    try {
      const trimmed = note.trim();
      const result = await api.updateAlert(alert.id, {
        ...body,
        ...(trimmed ? { note: trimmed } : {}),
      });
      setDetail((current) => (current ? { ...current, alert: result.alert } : current));
      onMutated(result.alert);
      setNote('');
      toast.success(`${label}已完成`, `處理紀錄已寫入這則警示的時間軸${trimmed ? '，並附上您的備註。' : '。'}`);
    } catch (err) {
      const message = err instanceof ApiError ? err.displayMessage : '請稍後再試。';
      toast.error(`${label}失敗`, message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={Boolean(alertId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide className="max-w-5xl">
        {loading && (
          <div className="space-y-4">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}

        {!loading && error && (
          <>
            <DialogHeader>
              <DialogTitle>無法載入警示詳情</DialogTitle>
              <DialogDescription>{error}</DialogDescription>
            </DialogHeader>
            <div>
              <Button onClick={() => alertId && void load(alertId)}>
                <RefreshCw />
                重試
              </Button>
            </div>
          </>
        )}

        {!loading && !error && alert && (
          <AlertDetailBody
            detail={detail!}
            alert={alert}
            writable={writable}
            caregivers={caregivers}
            note={note}
            setNote={setNote}
            busy={busy}
            mutate={mutate}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AlertDetailBody({
  detail,
  alert,
  writable,
  caregivers,
  note,
  setNote,
  busy,
  mutate,
}: {
  detail: AlertDetail;
  alert: Alert;
  writable: boolean;
  caregivers: CaregiverRow[];
  note: string;
  setNote: (value: string) => void;
  busy: string | null;
  mutate: (
    label: string,
    body: { status: AlertStatus; assignedCaregiverId?: string | null },
  ) => Promise<void>;
}) {
  const snapshot = alert.assessment;
  const current = detail.currentAssessment;
  const readings = snapshot?.readings ?? null;

  const timeline = React.useMemo(
    () => [...alert.timeline].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
    [alert.timeline],
  );

  const assignedIds = React.useMemo(
    () => new Set(detail.caregivers.map((c) => c.id)),
    [detail.caregivers],
  );

  return (
    <div className="space-y-5">
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={alert.severity} />
          <RiskBadge level={alert.level} size="sm" showEnglish />
          <StatusBadge status={alert.status} />
        </div>
        <DialogTitle className="text-xl">{alert.userName}</DialogTitle>
        <DialogDescription>
          {formatDateTime(alert.createdAt)} 觸發 · {timeAgo(alert.createdAt)}
          {alert.acknowledgedAt && ` · ${formatDateTime(alert.acknowledgedAt)} 確認`}
          {alert.resolvedAt && ` · ${formatDateTime(alert.resolvedAt)} 解除`}
        </DialogDescription>
      </DialogHeader>

      {/* -------------------- WHY it triggered -------------------- */}
      <Card className="border-risk-medium-border bg-risk-medium-bg/40">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-risk-medium" />
            <CardTitle className="text-base">為什麼觸發這則警示</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm leading-relaxed">{alert.triggerZh}</p>
          <p className="text-xs text-muted-foreground">
            觸發當下風險等級為 {alert.level}
            {snapshot && ` · AI 風險分數 ${Math.round(snapshot.score)} 分 · 熱指數 ${formatTemp(snapshot.heatIndex)}`}
            {snapshot?.previousLevel && ` · 前一次評估為 ${snapshot.previousLevel}`}
          </p>
        </CardContent>
      </Card>

      {/* -------------------- Readings at trigger time -------------------- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">觸發當下的感測數值</h2>
          {readings && (
            <span className="text-xs text-muted-foreground">
              {formatDateTime(readings.timestamp)}
              {readings.simulated && ' · 模擬資料'}
            </span>
          )}
        </div>

        {readings ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricTile
              label="室內溫度"
              value={formatTemp(readings.indoorTempC)}
              icon={Thermometer}
              sublabel={`室外 ${formatTemp(readings.outdoorTempC)}`}
            />
            <MetricTile
              label="室內濕度"
              value={formatPct(readings.indoorHumidityPct)}
              icon={Droplet}
              sublabel={`室外 ${formatPct(readings.outdoorHumidityPct)}`}
            />
            <MetricTile
              label="空氣品質 AQI"
              value={formatNumber(readings.airQualityIndex)}
              icon={Wind}
              sublabel={`連續高溫 ${readings.heatwaveDays} 天`}
            />
            <MetricTile
              label="心率"
              value={formatNumber(readings.heartRateBpm)}
              unit="BPM"
              icon={Heart}
              tone={snapshot?.baseline.aboveBaseline ? 'high' : 'neutral'}
              sublabel={snapshot?.baseline.descriptionZh}
            />
            <MetricTile
              label="活動量"
              value={formatNumber(readings.activityStepsPerHour)}
              unit="步/小時"
              icon={Footprints}
              sublabel={`皮膚溫度 ${formatTemp(readings.skinTempC)}`}
            />
            <MetricTile
              label="熱指數"
              value={snapshot ? formatTemp(snapshot.heatIndex) : '--'}
              icon={Gauge}
              sublabel="體感溫度，綜合溫度與濕度"
            />
          </div>
        ) : (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            這則警示沒有保留感測數值快照。
          </p>
        )}
      </section>

      {/* -------------------- AI reasoning + current state -------------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-sm font-semibold">觸發當下的 AI 判讀</h2>
          {snapshot ? (
            <>
              <AIExplanationCard assessment={snapshot} />
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">風險因子組成</CardTitle>
                  <CardDescription className="text-xs">
                    各因子的分數與權重皆由伺服器的風險引擎計算
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <RiskFactorList factors={snapshot.factors} />
                </CardContent>
              </Card>
            </>
          ) : (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
              這則警示沒有保留 AI 判讀快照。
            </p>
          )}
        </div>

        <div className="space-y-4">
          <h2 className="text-sm font-semibold">目前狀況</h2>
          <CurrentStateCard snapshot={snapshot} current={current} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">系統採取的行動</CardTitle>
              <CardDescription className="text-xs">
                警示建立時由行動政策引擎產生
              </CardDescription>
            </CardHeader>
            <CardContent>
              {alert.actionsTaken.length === 0 ? (
                <p className="text-sm text-muted-foreground">此警示未觸發任何自動行動。</p>
              ) : (
                <ul className="space-y-2">
                  {alert.actionsTaken.map((action) => {
                    const def = ACTION_CATALOGUE[action];
                    return (
                      <li key={action} className="flex gap-2.5">
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-risk-low" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{def?.titleZh ?? action}</p>
                          <p className="text-xs text-muted-foreground">{def?.title ?? ''}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* -------------------- Timeline -------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">處理時間軸</h2>
        {timeline.length === 0 ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">尚無處理紀錄。</p>
        ) : (
          <ol className="relative space-y-4 border-l border-border pl-6">
            {timeline.map((entry, index) => {
              const meta = TIMELINE_META[entry.kind];
              const Icon = meta.icon;
              return (
                <li key={`${entry.at}-${index}`} className="relative">
                  <span
                    className={cn(
                      'absolute -left-[2.05rem] flex size-7 items-center justify-center rounded-full border',
                      meta.dot,
                    )}
                  >
                    <Icon className={cn('size-3.5', meta.text)} />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Badge variant="outline" className="text-[10px]">
                      {meta.zh}
                    </Badge>
                    <span className="tabular text-xs text-muted-foreground">
                      {formatDateTime(entry.at)}
                    </span>
                    <span className="text-xs text-muted-foreground">· {entry.actor}</span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed">{entry.labelZh}</p>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* -------------------- Response actions -------------------- */}
      <Separator />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">處理這則警示</h2>
          <span className="text-xs text-muted-foreground">
            {alert.assignedCaregiverName
              ? `目前負責：${alert.assignedCaregiverName}`
              : '目前尚未指派照護者'}
          </span>
        </div>

        {!writable ? (
          <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              您的帳號沒有 <code className="font-mono text-xs">alert:write</code> 權限，因此無法變更狀態或重新指派。伺服器端也會獨立拒絕這類請求。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="alert-note">處理備註（選填）</Label>
              <Textarea
                id="alert-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={300}
                placeholder="例如：已致電長者，確認已開冷氣並補充水分。"
                className="min-h-[72px]"
              />
              <p className="text-xs text-muted-foreground">
                備註會與狀態變更一起寫入上方時間軸，最多 300 字。
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={alert.status === 'ACKNOWLEDGED' || Boolean(busy)}
                loading={busy === '確認收到'}
                onClick={() => void mutate('確認收到', { status: 'ACKNOWLEDGED' })}
              >
                <CheckCircle2 />
                確認收到
              </Button>

              <Button
                variant="outline"
                disabled={alert.status === 'ESCALATED' || Boolean(busy)}
                loading={busy === '升級處理'}
                onClick={() => void mutate('升級處理', { status: 'ESCALATED' })}
              >
                <AlertOctagon />
                升級處理
              </Button>

              <Button
                variant="default"
                disabled={alert.status === 'RESOLVED' || Boolean(busy)}
                loading={busy === '解除警示'}
                onClick={() => void mutate('解除警示', { status: 'RESOLVED' })}
              >
                <ShieldCheck />
                標記為已解除
              </Button>

              {alert.status !== 'NEW' && (
                <Button
                  variant="ghost"
                  disabled={Boolean(busy)}
                  loading={busy === '重新開啟'}
                  onClick={() => void mutate('重新開啟', { status: 'NEW' })}
                >
                  <RefreshCw />
                  重新開啟
                </Button>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="alert-assign">重新指派照護者</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={alert.assignedCaregiverId ?? 'UNASSIGNED'}
                  onValueChange={(value) =>
                    void mutate('重新指派', {
                      status: alert.status,
                      assignedCaregiverId: value === 'UNASSIGNED' ? null : value,
                    })
                  }
                  disabled={Boolean(busy) || caregivers.length === 0}
                >
                  <SelectTrigger id="alert-assign" className="w-full sm:w-80">
                    <UserCog className="size-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue placeholder="選擇照護者" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UNASSIGNED">不指派</SelectItem>
                    {caregivers.map((caregiver) => (
                      <SelectItem key={caregiver.id} value={caregiver.id}>
                        {caregiver.name}
                        {assignedIds.has(caregiver.id) ? '（負責此長者）' : ''}
                        {caregiver.status === 'INACTIVE' ? '（停用中）' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {busy === '重新指派' && (
                  <span className="text-xs text-muted-foreground">指派中…</span>
                )}
              </div>
              {caregivers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  目前無法載入照護者名單，請稍後再試。
                </p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The alert is a snapshot; this card answers the responder's real question —
 * has anything changed since it fired?
 */
function CurrentStateCard({
  snapshot,
  current,
}: {
  snapshot: RiskAssessment | null;
  current: RiskAssessment | null;
}) {
  if (!current) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">目前評估</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            目前沒有這位長者的即時評估資料，可能是監測已停用或裝置離線。
          </p>
        </CardContent>
      </Card>
    );
  }

  const delta = snapshot ? current.score - snapshot.score : 0;
  const direction: 'up' | 'down' | 'flat' = delta > 1 ? 'up' : delta < -1 ? 'down' : 'flat';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">目前評估</CardTitle>
            <CardDescription className="text-xs">
              {formatDateTime(current.timestamp)} · {timeAgo(current.timestamp)}
            </CardDescription>
          </div>
          <RiskBadge level={current.level} size="sm" />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <RiskScoreDial score={current.score} level={current.level} size={110} label="目前 AI 風險分數" />
          <div className="min-w-0 space-y-1.5 text-sm">
            <p className="flex items-center gap-1.5">
              <Thermometer className="size-3.5 text-muted-foreground" />
              <span className="tabular">熱指數 {formatTemp(current.heatIndex)}</span>
            </p>
            <p className="flex items-center gap-1.5">
              <Heart className="size-3.5 text-muted-foreground" />
              <span className="tabular">心率 {current.baseline.heartRateBpm} BPM</span>
            </p>
            <p className="flex items-center gap-1.5">
              <Clock className="size-3.5 text-muted-foreground" />
              <span className="tabular">每 {current.monitoringIntervalSec} 秒評估一次</span>
            </p>
          </div>
        </div>

        {snapshot && (
          <div className="flex items-start gap-2.5 rounded-lg bg-muted p-3">
            <TrendIcon direction={direction} className="mt-0.5 size-4 shrink-0" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              觸發當時 {Math.round(snapshot.score)} 分（{snapshot.level}），目前{' '}
              {Math.round(current.score)} 分（{current.level}）。
              {direction === 'up'
                ? ' 情況比警示發生時更嚴重，建議優先處理。'
                : direction === 'down'
                  ? ' 情況已較警示發生時緩解，仍建議確認長者狀況。'
                  : ' 與警示發生時大致相同。'}
            </p>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          {current.explanation.headline}
        </p>
      </CardContent>
    </Card>
  );
}
