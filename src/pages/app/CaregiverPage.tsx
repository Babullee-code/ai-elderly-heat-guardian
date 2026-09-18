/**
 * Caregiver dashboard.
 *
 * The family member or professional carer looking after several residents at
 * once. Two rules shape the whole page:
 *
 *   1. Highest risk first, always. The roster is ordered by the server-computed
 *      risk level and score, never alphabetically, and the ordering is not
 *      user-sortable - a carer opening this page on a phone must see the person
 *      who needs them at the top without doing anything.
 *   2. The fetched roster is a starting point, not the truth. `caregiverDashboard`
 *      gives us who this carer is responsible for; every number rendered comes
 *      from the live store, which is a couple of seconds old at most.
 *
 * No risk logic lives here. Levels, scores, explanations and actions all arrive
 * ready-made from the risk engine.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Footprints,
  Heart,
  Inbox,
  Phone,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Thermometer,
  UserRound,
  Users,
} from 'lucide-react';

import type {
  Alert,
  ElderlyUser,
  RiskAssessment,
  RiskHistoryPoint,
  RiskLevel,
  RiskRuleConfig,
} from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';

import { api, ApiError, type CaregiverDashboard, type CaregiverRow } from '@/lib/api';
import { useSession } from '@/store/session';
import { useLiveStore, selectAssessment, selectHistory, selectSmartHome } from '@/store/live';
import { useToast } from '@/components/Toast';

import {
  AIExplanationCard,
  ActionList,
  AlertCard,
  PageHeader,
  SmartHomeCard,
  StatCard,
} from '@/components/domain/Cards';
import {
  EmptyState,
  MetricTile,
  DataQualitySummary,
  RiskBadge,
  RiskSummaryStrip,
} from '@/components/domain/RiskIndicators';
import {
  ChartCard,
  EnvironmentChart,
  HeartRateChart,
  RiskDistributionChart,
  RiskTimeline,
  Sparkline,
} from '@/components/domain/Charts';
import { DataTable, type Column } from '@/components/domain/DataTable';
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
} from '@/components/ui';
import {
  cn,
  formatNumber,
  formatTemp,
  RELATIONSHIP_ZH,
  RISK_STYLES,
  timeAgo,
} from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A roster entry after the fetched snapshot has been merged with live data. */
interface RosterRow {
  user: ElderlyUser;
  assessment: RiskAssessment | null;
  history: RiskHistoryPoint[];
  deviceCount: number;
  devicesOnline: number;
  lastUpdate: string | null;
}

const RISK_TONE: Record<RiskLevel, 'low' | 'medium' | 'high'> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CaregiverPage() {
  const account = useSession((s) => s.account);
  const sessionCaregiverId = useSession((s) => s.caregiver?.id ?? null);
  const can = useSession((s) => s.can);
  const toast = useToast();

  const [caregiverOptions, setCaregiverOptions] = React.useState<CaregiverRow[]>([]);
  const [caregiverId, setCaregiverId] = React.useState<string | null>(sessionCaregiverId);
  const [dashboard, setDashboard] = React.useState<CaregiverDashboard | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyAlertId, setBusyAlertId] = React.useState<string | null>(null);
  const [openResidentId, setOpenResidentId] = React.useState<string | null>(null);

  const isElder = account?.role === 'ELDER';
  const mayPick = !sessionCaregiverId && !isElder;

  // Live slices. The roster needs every assigned resident's current state at
  // once, so it reads the maps directly; the detail dialog uses the per-user
  // selectors from the contract.
  const assessments = useLiveStore((s) => s.assessments);
  const histories = useLiveStore((s) => s.history);
  const liveDevices = useLiveStore((s) => s.devices);
  const liveAlerts = useLiveStore((s) => s.alerts);

  // --- which caregiver -----------------------------------------------------

  React.useEffect(() => {
    if (!mayPick) return;
    let cancelled = false;

    api
      .listCaregivers()
      .then((result) => {
        if (cancelled) return;
        setCaregiverOptions(result.caregivers);
        setCaregiverId((current) => current ?? result.caregivers[0]?.id ?? null);
        if (result.caregivers.length === 0) setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.displayMessage : '無法載入照護者名單。');
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [mayPick]);

  React.useEffect(() => {
    if (sessionCaregiverId) setCaregiverId(sessionCaregiverId);
  }, [sessionCaregiverId]);

  // --- roster --------------------------------------------------------------

  const load = React.useCallback(
    async (id: string, mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const result = await api.caregiverDashboard(id);
        setDashboard(result);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.displayMessage : '無法載入照護儀表板。');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (isElder || !caregiverId) return;
    void load(caregiverId);
  }, [caregiverId, isElder, load]);

  // --- merge fetched roster with live values -------------------------------

  const rows = React.useMemo<RosterRow[]>(() => {
    if (!dashboard) return [];

    return dashboard.residents
      .map((entry) => {
        const live = assessments[entry.user.id] ?? entry.assessment;
        const liveHistory = histories[entry.user.id];
        const own = liveDevices.filter((d) => d.userId === entry.user.id);

        return {
          user: entry.user,
          assessment: live,
          history: liveHistory && liveHistory.length > 0 ? liveHistory : entry.history,
          deviceCount: own.length > 0 ? own.length : entry.deviceCount,
          devicesOnline:
            own.length > 0
              ? own.filter((d) => d.status === 'ONLINE' || d.status === 'LOW_BATTERY').length
              : entry.devicesOnline,
          lastUpdate: live?.timestamp ?? entry.lastUpdate,
        };
      })
      .sort((a, b) => {
        const byLevel =
          RISK_ORDER[b.assessment?.level ?? 'LOW'] - RISK_ORDER[a.assessment?.level ?? 'LOW'];
        if (byLevel !== 0) return byLevel;
        return (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0);
      });
  }, [dashboard, assessments, histories, liveDevices]);

  const counts = React.useMemo(() => {
    const tally: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    rows.forEach((row) => {
      tally[row.assessment?.level ?? 'LOW'] += 1;
    });
    return tally;
  }, [rows]);

  const highRisk = rows.filter((row) => row.assessment?.level === 'HIGH');

  const openAlerts = React.useMemo(() => {
    const rosterIds = new Set(rows.map((row) => row.user.id));
    return liveAlerts.filter((a) => rosterIds.has(a.userId) && a.status !== 'RESOLVED');
  }, [liveAlerts, rows]);

  const openResident = rows.find((row) => row.user.id === openResidentId) ?? null;

  // --- alert actions -------------------------------------------------------

  const setAlertStatus = async (alert: Alert, status: 'ACKNOWLEDGED' | 'RESOLVED') => {
    setBusyAlertId(alert.id);
    try {
      await api.updateAlert(alert.id, { status });
      toast.success(
        status === 'ACKNOWLEDGED' ? '已確認收到警示' : '警示已標記為解除',
        status === 'ACKNOWLEDGED'
          ? `${alert.userName} 的警示已記錄由您確認，升級通知不會再送出。`
          : `${alert.userName} 的警示已結案，並寫入處理紀錄。`,
      );
      if (caregiverId) await load(caregiverId, 'refresh');
    } catch (err) {
      toast.error(
        '更新警示失敗',
        err instanceof ApiError ? err.displayMessage : '請稍後再試。',
      );
    } finally {
      setBusyAlertId(null);
    }
  };

  // --- guards --------------------------------------------------------------

  if (isElder) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="照護儀表板"
          description="這個畫面是給家人或專業照護者使用的。"
        />
        <EmptyState
          icon={Users}
          title="這個畫面不是為您設計的"
          description="照護儀表板讓您的家人或照護者一次看顧多位長者。您自己的健康狀況、目前風險與建議行動，都在「總覽」畫面上。"
          action={
            <Button asChild>
              <a href="/app">回到我的總覽</a>
            </Button>
          }
        />
      </div>
    );
  }

  if (!can('caregiver:read')) {
    return (
      <div className="space-y-6">
        <PageHeader title="照護儀表板" description="需要照護者讀取權限才能檢視。" />
        <EmptyState
          icon={ShieldCheck}
          title="沒有檢視權限"
          description="目前的帳號角色無法讀取照護者與其負責的長者名單。請聯絡平台管理者調整角色。"
        />
      </div>
    );
  }

  const picker = mayPick ? (
    <div className="flex items-center gap-2">
      <Label htmlFor="caregiver-picker" className="whitespace-nowrap text-xs text-muted-foreground">
        檢視照護者
      </Label>
      <Select
        value={caregiverId ?? ''}
        onValueChange={(value) => setCaregiverId(value)}
      >
        <SelectTrigger id="caregiver-picker" className="w-[220px]" aria-label="選擇要檢視的照護者">
          <SelectValue placeholder="選擇照護者" />
        </SelectTrigger>
        <SelectContent>
          {caregiverOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}（{RELATIONSHIP_ZH[option.relationship] ?? option.relationship}．
              {option.assignedUserIds.length} 位）
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ) : null;

  const refreshButton = (
    <Button
      variant="outline"
      onClick={() => caregiverId && load(caregiverId, 'refresh')}
      loading={refreshing}
      disabled={!caregiverId}
    >
      <RefreshCw />
      重新整理
    </Button>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="照護儀表板" description="正在載入您負責的長者名單…" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="照護儀表板" description="無法取得目前的照護名單。" actions={picker} />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入資料"
          description={error}
          action={
            <Button onClick={() => caregiverId && load(caregiverId)}>重試</Button>
          }
        />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="space-y-6">
        <PageHeader title="照護儀表板" description="尚未選擇要檢視的照護者。" actions={picker} />
        <EmptyState
          icon={Users}
          title="平台上還沒有照護者資料"
          description="請先在管理後台建立照護者，並指派負責的長者。"
        />
      </div>
    );
  }

  const caregiver = dashboard.caregiver;

  return (
    <div className="space-y-6">
      <PageHeader
        title="照護儀表板"
        description={`${caregiver.name}（${RELATIONSHIP_ZH[caregiver.relationship] ?? caregiver.relationship}）負責 ${rows.length} 位長者。名單依風險由高至低排列，數值每數秒自動更新。`}
        actions={
          <>
            {picker}
            {refreshButton}
          </>
        }
      />

      {/* ------------------------- Summary header ------------------------- */}
      <section aria-labelledby="roster-summary">
        <h2 id="roster-summary" className="sr-only">
          照護名單摘要
        </h2>

        <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
          <div className="grid gap-4 sm:grid-cols-2" aria-live="polite">
            <StatCard
              label="高風險"
              value={counts.HIGH}
              sublabel={counts.HIGH > 0 ? '請優先聯繫' : '目前沒有高風險長者'}
              icon={AlertOctagon}
              tone={counts.HIGH > 0 ? 'high' : 'neutral'}
            />
            <StatCard
              label="需要注意"
              value={counts.MEDIUM}
              sublabel="建議留意環境與補水"
              icon={AlertTriangle}
              tone={counts.MEDIUM > 0 ? 'medium' : 'neutral'}
            />
            <StatCard
              label="低風險"
              value={counts.LOW}
              sublabel="目前狀況穩定"
              icon={ShieldCheck}
              tone="low"
            />
            <StatCard
              label="未結案警示"
              value={openAlerts.length}
              sublabel={
                openAlerts.filter((a) => a.status === 'NEW').length > 0
                  ? `其中 ${openAlerts.filter((a) => a.status === 'NEW').length} 則尚未確認`
                  : '皆已確認'
              }
              icon={BellRing}
              tone={openAlerts.some((a) => a.status === 'NEW') ? 'high' : 'neutral'}
            />
          </div>

          <ChartCard
            title="風險分布"
            description="您負責的長者目前落在各風險等級的人數。"
            height={200}
          >
            <RiskDistributionChart
              counts={[
                { level: 'HIGH', count: counts.HIGH },
                { level: 'MEDIUM', count: counts.MEDIUM },
                { level: 'LOW', count: counts.LOW },
              ]}
              height={200}
            />
          </ChartCard>
        </div>
      </section>

      {/* ------------------------- Urgent cases --------------------------- */}
      {highRisk.length > 0 && (
        <section aria-labelledby="urgent-heading" className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertOctagon className="size-5 text-risk-high" aria-hidden />
            <h2 id="urgent-heading" className="text-lg font-semibold">
              需要立即關注
            </h2>
            <Badge variant="danger">{highRisk.length} 位</Badge>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {highRisk.map((row) => (
              <UrgentCard
                key={row.user.id}
                row={row}
                onOpen={() => setOpenResidentId(row.user.id)}
              />
            ))}
          </div>
        </section>
      )}

      {/* ---------------------------- Roster ------------------------------ */}
      <section aria-labelledby="roster-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="roster-heading" className="text-lg font-semibold">
            我負責的長者
          </h2>
          <p className="text-xs text-muted-foreground">
            固定依風險等級與分數由高至低排序，點選任一列可展開詳細判讀。
          </p>
        </div>

        <DataTable<RosterRow>
          rows={rows}
          getRowKey={(row) => row.user.id}
          onRowClick={(row) => setOpenResidentId(row.user.id)}
          searchPlaceholder="搜尋姓名或地區…"
          searchFields={(row) => `${row.user.name} ${row.user.nameEn} ${row.user.district} ${row.user.city}`}
          emptyState={
            <EmptyState
              icon={Users}
              title="目前沒有指派的長者"
              description="這位照護者尚未被指派任何長者。請在管理後台的「照護者」頁面完成指派。"
            />
          }
          columns={rosterColumns}
        />
      </section>

      {/* ---------------------------- Alerts ------------------------------ */}
      <section aria-labelledby="alerts-heading" className="space-y-3">
        <div className="flex items-center gap-2">
          <BellRing className="size-5 text-muted-foreground" aria-hidden />
          <h2 id="alerts-heading" className="text-lg font-semibold">
            未結案警示
          </h2>
          {openAlerts.length > 0 && <Badge variant="muted">{openAlerts.length}</Badge>}
        </div>

        {openAlerts.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="目前沒有未處理的警示"
            description="當任何一位長者的風險升高到需要通知的程度，警示會立刻出現在這裡。"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {openAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                busy={busyAlertId === alert.id}
                onAcknowledge={
                  can('alert:write') ? () => void setAlertStatus(alert, 'ACKNOWLEDGED') : undefined
                }
                onResolve={
                  can('alert:write') ? () => void setAlertStatus(alert, 'RESOLVED') : undefined
                }
              />
            ))}
          </div>
        )}

        {!can('alert:write') && openAlerts.length > 0 && (
          <p className="text-xs text-muted-foreground">
            目前的角色為唯讀，可以檢視警示但無法變更狀態。
          </p>
        )}
      </section>

      {/* ------------------------- Contact card --------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">通知設定</CardTitle>
          <CardDescription className="text-xs">
            這些設定決定哪些狀況會主動聯絡 {caregiver.name}，由平台管理者維護。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <Phone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">聯絡電話</span>
            <span className="ml-auto font-medium">{caregiver.phone}</span>
          </div>
          <div className="flex items-center gap-2">
            <BellRing className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">通知門檻</span>
            <span className="ml-auto">
              <RiskBadge level={caregiver.notificationPreferences.minLevel} size="sm" />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Inbox className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">通知管道</span>
            <span className="ml-auto font-medium">
              {caregiver.notificationPreferences.channels.join('．')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">緊急升級權限</span>
            <span className="ml-auto font-medium">
              {caregiver.emergencyPermission ? '已授權' : '未授權'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------- Detail dialog -------------------------- */}
      <Dialog
        open={openResident !== null}
        onOpenChange={(next) => {
          if (!next) setOpenResidentId(null);
        }}
      >
        <DialogContent wide>
          {openResident && <ResidentDetail row={openResident} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster columns
// ---------------------------------------------------------------------------

/**
 * Deliberately no `sortValue` on any column.
 *
 * The order of this table is a safety property, not a preference: the person
 * at greatest risk is first. Letting a carer sort by name would bury them.
 */
const rosterColumns: Column<RosterRow>[] = [
  {
    key: 'user',
    header: '長者',
    primary: true,
    cell: (row) => (
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
            row.assessment
              ? cn(RISK_STYLES[row.assessment.level].bg, RISK_STYLES[row.assessment.level].text)
              : 'bg-muted text-muted-foreground',
          )}
          aria-hidden
        >
          {row.user.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-semibold">{row.user.name}</p>
          <p className="text-xs text-muted-foreground">
            {row.user.age} 歲 · {row.user.district}
          </p>
        </div>
      </div>
    ),
  },
  {
    key: 'level',
    header: '風險',
    cell: (row) =>
      row.assessment ? (
        <div className="flex flex-col items-start gap-1">
          <RiskBadge level={row.assessment.level} size="sm" />
          <span className="tabular text-[11px] text-muted-foreground">
            AI 分數 {Math.round(row.assessment.score)}
          </span>
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">尚無評估</span>
      ),
  },
  {
    key: 'heatIndex',
    header: '熱指數',
    cell: (row) => (
      <span className="tabular text-sm">
        {row.assessment ? formatTemp(row.assessment.heatIndex) : '--'}
      </span>
    ),
  },
  {
    key: 'heartRate',
    header: '心率',
    cell: (row) => {
      if (!row.assessment) return <span className="text-xs text-muted-foreground">--</span>;
      const { baseline } = row.assessment;
      return (
        <div className="flex flex-col items-start gap-0.5">
          <span className="tabular text-sm">{baseline.heartRateBpm} BPM</span>
          <span
            className={cn(
              'tabular text-[11px]',
              baseline.aboveBaseline ? 'font-medium text-risk-medium' : 'text-muted-foreground',
            )}
          >
            {baseline.aboveBaseline
              ? `高於平常 ${baseline.deviationPct}%`
              : baseline.belowBaseline
                ? '低於平常'
                : '在平常範圍'}
          </span>
        </div>
      );
    },
  },
  {
    key: 'indoor',
    header: '室內溫度',
    hideOnMobile: true,
    cell: (row) => (
      <span className="tabular text-sm">
        {row.assessment ? formatTemp(row.assessment.readings.indoorTempC) : '--'}
      </span>
    ),
  },
  {
    key: 'activity',
    header: '活動量',
    hideOnMobile: true,
    cell: (row) => (
      <span className="tabular text-sm">
        {row.assessment
          ? `${formatNumber(row.assessment.readings.activityStepsPerHour)} 步/時`
          : '--'}
      </span>
    ),
  },
  {
    key: 'devices',
    header: '裝置',
    hideOnMobile: true,
    cell: (row) => (
      <span
        className={cn(
          'tabular inline-flex items-center gap-1.5 text-sm',
          row.devicesOnline < row.deviceCount && 'text-risk-medium',
        )}
      >
        <Smartphone className="size-3.5" aria-hidden />
        {row.devicesOnline}/{row.deviceCount}
      </span>
    ),
  },
  {
    key: 'trend',
    header: '近期趨勢',
    hideOnMobile: true,
    cell: (row) => (
      <Sparkline data={row.history} level={row.assessment?.level ?? 'LOW'} width={88} height={30} />
    ),
  },
  {
    key: 'updated',
    header: '最後更新',
    align: 'right',
    cell: (row) => (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {timeAgo(row.lastUpdate)}
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Urgent case card
// ---------------------------------------------------------------------------

/**
 * The high-risk treatment.
 *
 * Urgency is carried by a solid accent edge, an icon and the words 「高風險」 -
 * not by a saturated red card. A carer glancing at this on a phone in a
 * supermarket needs to find the name quickly; a screaming panel makes the
 * text harder to read, not easier.
 */
function UrgentCard({ row, onOpen }: { row: RosterRow; onOpen: () => void }) {
  const assessment = row.assessment;

  return (
    <Card className="overflow-hidden border-risk-high-border">
      <div className="flex">
        <div className="w-1.5 shrink-0 bg-risk-high" aria-hidden />

        <CardContent className="min-w-0 flex-1 space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-lg font-semibold">{row.user.name}</p>
              <p className="text-xs text-muted-foreground">
                {row.user.age} 歲 · {row.user.location} · 更新於 {timeAgo(row.lastUpdate)}
              </p>
            </div>
            <RiskBadge level="HIGH" />
          </div>

          {assessment && (
            <>
              <p className="text-sm font-medium leading-snug">
                {assessment.explanation.headline}
              </p>

              <div className="grid grid-cols-3 gap-2">
                <MetricTile
                  label="熱指數"
                  value={assessment.heatIndex.toFixed(1)}
                  unit="°C"
                  icon={Thermometer}
                  tone="high"
                />
                <MetricTile
                  label="心率"
                  value={assessment.baseline.heartRateBpm}
                  unit="BPM"
                  sublabel={
                    assessment.baseline.aboveBaseline
                      ? `高於平常 ${assessment.baseline.deviationPct}%`
                      : '在平常範圍'
                  }
                  icon={Heart}
                  tone={assessment.baseline.aboveBaseline ? 'high' : 'neutral'}
                  provenance={assessment.provenance?.fields?.heartRateBpm}
                />
                <MetricTile
                  label="活動量"
                  value={formatNumber(assessment.readings.activityStepsPerHour)}
                  unit="步/時"
                  icon={Footprints}
                  provenance={assessment.provenance?.fields?.activityStepsPerHour}
                />
              </div>

              <RiskSummaryStrip assessment={assessment} />
            </>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={onOpen}>
              <UserRound />
              查看完整判讀
            </Button>
            <Button variant="outline" asChild>
              <a href={`tel:${row.user.phone}`}>
                <Phone />
                撥打 {row.user.phone}
              </a>
            </Button>
          </div>
        </CardContent>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Resident detail
// ---------------------------------------------------------------------------

/**
 * One resident, in full.
 *
 * Everything here is live except the threshold config, which is fetched once
 * per open so the risk timeline can draw the bands the administrator actually
 * configured rather than bands this page invented.
 *
 * The smart-home panel is read-only: a caregiver can see that the air
 * conditioner is running and why, but switching a resident's appliances from
 * a remote screen is the resident's own decision to make.
 */
function ResidentDetail({ row }: { row: RosterRow }) {
  const userId = row.user.id;
  const assessment = useLiveStore(selectAssessment(userId));
  const smartHome = useLiveStore(selectSmartHome(userId));
  const liveHistory = useLiveStore(selectHistory(userId));

  const [config, setConfig] = React.useState<RiskRuleConfig | null>(null);
  const [configError, setConfigError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    api
      .userRisk(userId)
      .then((result) => {
        if (!cancelled) setConfig(result.config);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setConfigError(
            err instanceof ApiError ? err.displayMessage : '無法載入風險門檻設定。',
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const current = assessment ?? row.assessment;
  const history = liveHistory.length > 0 ? liveHistory : row.history;

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle>{row.user.name}</DialogTitle>
          {current && <RiskBadge level={current.level} size="sm" />}
        </div>
        <DialogDescription>
          {row.user.age} 歲 · {row.user.location} · 資料更新於 {timeAgo(row.lastUpdate)}
        </DialogDescription>
      </DialogHeader>

      {!current ? (
        <EmptyState
          icon={AlertTriangle}
          title="目前沒有可用的評估結果"
          description="這位長者尚未收到任何感測資料，或監測已暫停。"
        />
      ) : (
        <div className="space-y-4">
          {current.provenance && <DataQualitySummary provenance={current.provenance} />}

          {/* STATUS */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricTile
              label="AI 風險分數"
              value={Math.round(current.score)}
              unit="/ 100"
              icon={AlertOctagon}
              tone={RISK_TONE[current.level]}
            />
            <MetricTile
              label="熱指數"
              value={current.heatIndex.toFixed(1)}
              unit="°C"
              icon={Thermometer}
              tone={RISK_TONE[current.level]}
            />
            <MetricTile
              label="心率"
              value={current.baseline.heartRateBpm}
              unit="BPM"
              sublabel={current.baseline.descriptionZh}
              icon={Heart}
              tone={current.baseline.aboveBaseline ? 'high' : 'neutral'}
              provenance={current.provenance?.fields?.heartRateBpm}
            />
            <MetricTile
              label="裝置連線"
              value={`${row.devicesOnline}/${row.deviceCount}`}
              sublabel={
                row.devicesOnline < row.deviceCount ? '有裝置離線，部分數值可能未更新' : '全部正常'
              }
              icon={Smartphone}
              tone={row.devicesOnline < row.deviceCount ? 'medium' : 'neutral'}
            />
          </div>

          {/* WHY */}
          <AIExplanationCard assessment={current} />

          {/* ACTION */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">系統建議與已執行的行動</CardTitle>
              <CardDescription className="text-xs">
                由風險引擎依目前判讀產生。未執行的自動化行動會標示原因。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActionList actions={current.actions} />
            </CardContent>
          </Card>

          {smartHome && (
            <>
              <SmartHomeCard smartHome={smartHome} readOnly />
              <p className="text-xs leading-relaxed text-muted-foreground">
                照護者僅能檢視家電狀態。實際開關由長者本人或平台自動化控制，避免遠端替他人改變居家環境。
              </p>
            </>
          )}

          <Separator />

          <ChartCard
            title="風險分數變化"
            description={
              config
                ? `虛線為管理者設定的「需要注意」門檻（熱指數 ${config.thresholds.medium}°C）。`
                : configError ?? '正在載入門檻設定…'
            }
            height={220}
          >
            <RiskTimeline history={history} config={config} height={220} />
          </ChartCard>

          <ChartCard title="溫度與熱指數" description="室內、室外與熱指數的近期走勢。" height={220}>
            <EnvironmentChart history={history} height={220} />
          </ChartCard>

          <ChartCard
            title="心率與個人基準"
            description="陰影區間為此人平常的心率範圍，用來判讀「對這個人而言」是否異常。"
            height={220}
          >
            <HeartRateChart history={history} height={220} />
          </ChartCard>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">緊急聯絡</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Phone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-muted-foreground">本人</span>
                <a className="ml-auto font-medium text-primary hover:underline" href={`tel:${row.user.phone}`}>
                  {row.user.phone}
                </a>
              </div>
              <div className="flex items-center gap-2">
                <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-muted-foreground">
                  {row.user.emergencyContact.name}（
                  {RELATIONSHIP_ZH[row.user.emergencyContact.relationship] ??
                    row.user.emergencyContact.relationship}
                  ）
                </span>
                <a
                  className="ml-auto font-medium text-primary hover:underline"
                  href={`tel:${row.user.emergencyContact.phone}`}
                >
                  {row.user.emergencyContact.phone}
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
