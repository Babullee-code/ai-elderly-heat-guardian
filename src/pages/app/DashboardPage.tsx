/**
 * Resident dashboard — the single most important screen in the product.
 *
 * It answers three questions in order, and nothing else competes with them:
 *
 *   1. 目前安全嗎  the current risk, stated in plain language
 *   2. 為什麼      the weighted factors and this person's own baseline
 *   3. 我該做什麼  what the platform did automatically, and what is left to do
 *
 * Every number on this page comes from the server's assessment. Nothing here
 * recomputes a level, a threshold or a policy decision - if the air
 * conditioner did not switch itself on, the reason shown is the one the
 * policy engine gave.
 */

import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  Droplet,
  Footprints,
  Heart,
  Info,
  LifeBuoy,
  MapPin,
  PhoneCall,
  Sun,
  Thermometer,
  UserRound,
  WifiOff,
} from 'lucide-react';

import type {
  CoolingSpaceRecommendation,
  Caregiver,
  Device,
  DeviceType,
  ElderlyUser,
  FieldProvenance,
  MeasurementField,
  PersonalBaseline,
  RiskRuleConfig,
} from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';

import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useSession } from '@/store/session';
import { selectAssessment, selectSmartHome, useLiveStore } from '@/store/live';
import {
  DEVICE_LABELS_ZH,
  RELATIONSHIP_ZH,
  RISK_STYLES,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Separator,
  Skeleton,
} from '@/components/ui';
import {
  EmptyState,
  LiveIndicator,
  MetricTile,
  DataQualitySummary,
  RiskBadge,
  RiskFactorList,
  RiskScoreDial,
} from '@/components/domain/RiskIndicators';
import {
  ActionList,
  AIExplanationCard,
  BaselineCard,
  CaregiverStatusCard,
  CoolingSpaceCard,
  PageHeader,
  SmartHomeCard,
} from '@/components/domain/Cards';
import { ChartCard, RiskTimeline } from '@/components/domain/Charts';
import { SimulateRiskButton } from '@/components/domain/DemoControls';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Which device supplies a reading.
 *
 * Only the label is derived here. Whether the value is current is the server's
 * decision, carried on the assessment's provenance - this page must not form
 * its own opinion, or the resident's screen could contradict the judgement the
 * risk engine actually acted on.
 */
function sourceFor(devices: Device[], type: DeviceType) {
  const device = devices.find((d) => d.type === type) ?? null;
  if (!device) {
    return { device: null, label: '無對應裝置' };
  }
  return {
    device,
    label: DEVICE_LABELS_ZH[device.type] ?? device.nameZh,
  };
}

/** A numbered section heading, so the STATUS -> WHY -> ACTION order is legible. */
function SectionHeading({
  step,
  title,
  description,
}: {
  step: number;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="tabular mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-sm font-bold text-primary">
        {step}
      </span>
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const toast = useToast();

  const focusUserId = useSession((s) => s.focusUserId());
  const sessionUser = useSession((s) => s.elderlyUser);
  const account = useSession((s) => s.account);
  const elderMode = useSession((s) => s.elderMode);
  const canReadUsers = useSession((s) => s.can('user:read'));

  const assessment = useLiveStore(selectAssessment(focusUserId));
  const smartHome = useLiveStore(selectSmartHome(focusUserId));
  const historyMap = useLiveStore((s) => s.history);
  const allDevices = useLiveStore((s) => s.devices);
  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);
  const configVersion = useLiveStore((s) => s.configVersion);
  const reconnect = useLiveStore((s) => s.connect);

  const history = React.useMemo(
    () => (focusUserId ? (historyMap[focusUserId] ?? []) : []),
    [historyMap, focusUserId],
  );
  const devices = React.useMemo(
    () => (focusUserId ? allDevices.filter((d) => d.userId === focusUserId) : []),
    [allDevices, focusUserId],
  );

  // --- resident detail (name, emergency contact, caregivers, baseline) -----
  // An ELDER account has no `user:read` permission and does not need it: the
  // session already carries their own record.
  const [detail, setDetail] = React.useState<{
    user: ElderlyUser;
    caregivers: Caregiver[];
    baseline: PersonalBaseline | null;
  } | null>(null);

  React.useEffect(() => {
    if (!focusUserId || !canReadUsers) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .getUser(focusUserId)
      .then((res) => {
        if (!cancelled) {
          setDetail({ user: res.user, caregivers: res.caregivers, baseline: res.baseline });
        }
      })
      .catch(() => {
        // The dashboard still works from live data alone; only the contact
        // details are missing, which is not worth interrupting the user for.
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [focusUserId, canReadUsers]);

  const resident = detail?.user ?? sessionUser ?? null;

  // --- live rule configuration (thresholds for the timeline bands) ---------
  const [config, setConfig] = React.useState<RiskRuleConfig | null>(null);

  React.useEffect(() => {
    if (!focusUserId) return;
    let cancelled = false;
    api
      .userRisk(focusUserId)
      .then((res) => {
        if (!cancelled) setConfig(res.config);
      })
      .catch(() => {
        if (!cancelled) setConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [focusUserId, configVersion]);

  // --- cooling spaces, only once the level warrants leaving the house ------
  const level = assessment?.level ?? 'LOW';
  const atLeastMedium = RISK_ORDER[level] >= RISK_ORDER.MEDIUM;

  const [spaces, setSpaces] = React.useState<{
    recommendations: CoolingSpaceRecommendation[];
    blocked: boolean;
    reasonZh?: string;
  } | null>(null);
  const [spacesError, setSpacesError] = React.useState<string | null>(null);
  const [spacesLoading, setSpacesLoading] = React.useState(false);

  React.useEffect(() => {
    if (!focusUserId || !atLeastMedium) {
      setSpaces(null);
      setSpacesError(null);
      return;
    }
    let cancelled = false;
    setSpacesLoading(true);
    api
      .recommendCoolingSpaces(focusUserId)
      .then((res) => {
        if (cancelled) return;
        setSpaces({
          recommendations: res.recommendations,
          blocked: res.blocked,
          reasonZh: res.reasonZh,
        });
        setSpacesError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setSpaces(null);
        setSpacesError(
          error instanceof ApiError ? error.displayMessage : '無法取得附近的涼適空間。',
        );
      })
      .finally(() => {
        if (!cancelled) setSpacesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [focusUserId, atLeastMedium]);

  // --- smart-home control --------------------------------------------------
  const [busy, setBusy] = React.useState(false);
  const canControlHome = account?.role !== 'VIEWER';

  const runHomeCommand = async (
    work: () => Promise<unknown>,
    successTitle: string,
    successBody?: string,
  ) => {
    setBusy(true);
    try {
      await work();
      toast.success(successTitle, successBody);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.displayMessage : '無法控制設備，請稍後再試。';
      toast.error('操作未完成', message);
    } finally {
      setBusy(false);
    }
  };

  const applianceZh = { ac: '冷氣', fan: '電風扇', dehumidifier: '除濕機' } as const;

  // -------------------------------------------------------------------------
  // Guard states
  // -------------------------------------------------------------------------

  if (!focusUserId) {
    return (
      <>
        <PageHeader title="總覽" description="即時掌握目前的熱風險狀況。" />
        <EmptyState
          icon={UserRound}
          title="尚未指定要檢視的長者"
          description="這個帳號沒有綁定長者資料。請以長者或照護者帳號登入，或由管理後台指派。"
        />
      </>
    );
  }

  if (!assessment || !smartHome) {
    return (
      <>
        <PageHeader
          title="總覽"
          description="即時掌握目前的熱風險狀況。"
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
            <Skeleton className="h-56 w-full rounded-xl" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-lg" />
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-5">
              <Skeleton className="h-72 rounded-xl lg:col-span-3" />
              <Skeleton className="h-72 rounded-xl lg:col-span-2" />
            </div>
          </div>
        )}
      </>
    );
  }

  const style = RISK_STYLES[assessment.level];
  const readings = assessment.readings;
  const notifyAction = assessment.actions.find((a) => a.type === 'NOTIFY_CAREGIVER');
  const caregiverNotified = Boolean(notifyAction && !notifyAction.blockedReason);

  const caregiverRows = (detail?.caregivers ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    relationship: RELATIONSHIP_ZH[c.relationship] ?? c.relationship,
    status: c.status,
  }));

  // Without `user:read` the session still knows the resident's own emergency
  // contact, which is the person the resident actually thinks of as family.
  const contactRows =
    caregiverRows.length > 0
      ? caregiverRows
      : resident
        ? [
            {
              id: 'emergency-contact',
              name: resident.emergencyContact.name,
              relationship: resident.emergencyContact.relationship,
              status: 'ACTIVE',
            },
          ]
        : [];

  const indoorTemp = sourceFor(devices, 'TEMPERATURE_SENSOR');
  const indoorHumidity = sourceFor(devices, 'HUMIDITY_SENSOR');
  const wearable = sourceFor(devices, 'SMART_WATCH');

  /** The server's freshness verdict for one field, if it sent one. */
  const prov = (field: MeasurementField): FieldProvenance | undefined =>
    assessment.provenance?.fields?.[field];

  const updatedLine = `最後更新 ${formatTime(assessment.timestamp)}（${timeAgo(assessment.timestamp)}）· 每 ${assessment.monitoringIntervalSec} 秒重新評估`;

  const helpDialog = (
    <HelpDialog
      resident={resident}
      caregivers={detail?.caregivers ?? []}
      elderMode={elderMode}
    />
  );

  // -------------------------------------------------------------------------
  // Elderly mode: the same data, composed for a 78-year-old on a phone
  // -------------------------------------------------------------------------

  if (elderMode) {
    const topActions = [...assessment.actions]
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3);

    return (
      <div className="space-y-6">
        <PageHeader
          title={resident ? `${resident.name}，您好` : '您好'}
          description={updatedLine}
          actions={<SimulateRiskButton userId={focusUserId} />}
        />

        {/* ---------------------------- 目前狀態 --------------------------- */}
        <Card
          className={cn(
            'border-2',
            style.border,
            assessment.level === 'HIGH' ? 'bg-risk-high-bg' : style.bg,
          )}
        >
          <CardContent className="space-y-5 p-6 text-center sm:p-8">
            <RiskBadge level={assessment.level} size="lg" className="mx-auto" />

            <p className={cn('text-elder-2xl font-bold', style.text)} aria-live="polite">
              {style.plainZh}
            </p>

            <p className="mx-auto max-w-xl text-elder-base leading-relaxed">
              {assessment.explanation.headline}
            </p>

            <div className="mx-auto grid max-w-lg grid-cols-2 gap-4">
              <div className="rounded-xl bg-card p-4">
                <p className="text-base text-muted-foreground">室內溫度</p>
                <p className="tabular mt-1 text-elder-xl font-bold">
                  {formatTemp(readings.indoorTempC)}
                </p>
              </div>
              <div className="rounded-xl bg-card p-4">
                <p className="text-base text-muted-foreground">目前心率</p>
                <p className="tabular mt-1 text-elder-xl font-bold">
                  {readings.heartRateBpm} <span className="text-base font-normal">BPM</span>
                </p>
              </div>
            </div>

            <p className="text-base text-muted-foreground">
              {assessment.baseline.descriptionZh}
            </p>
          </CardContent>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* --------------------------- 現在做什麼 -------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-elder-lg">現在做什麼</CardTitle>
              <CardDescription className="text-base">
                系統已經替您做的事，以及建議您做的事。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActionList actions={topActions} large />
            </CardContent>
          </Card>

          {/* -------------------------- 家人是否知道 ------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="text-elder-lg">家人是否知道</CardTitle>
              <CardDescription className="text-base">
                {caregiverNotified ? '系統已經通知您的家人。' : '目前尚未發送通知給家人。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {contactRows.length === 0 ? (
                <p className="text-elder-base text-muted-foreground">目前沒有聯絡人資料。</p>
              ) : (
                <ul className="space-y-3">
                  {contactRows.map((contact) => (
                    <li key={contact.id} className="flex items-center gap-3">
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-muted text-elder-base font-semibold text-primary">
                        {contact.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-elder-base font-medium">{contact.name}</p>
                        <p className="text-base text-muted-foreground">{contact.relationship}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {notifyAction?.blockedReasonZh && (
                <p className="rounded-lg bg-muted p-4 text-base leading-relaxed text-muted-foreground">
                  {notifyAction.blockedReasonZh}
                </p>
              )}
            </CardContent>
          </Card>

          {/* ----------------------------- 家中設備 -------------------------- */}
          <SmartHomeCard
            smartHome={smartHome}
            busy={busy}
            readOnly={!canControlHome}
            onToggle={(appliance, on) =>
              runHomeCommand(
                () => api.setAppliance(focusUserId, appliance, on),
                `已${on ? '開啟' : '關閉'}${applianceZh[appliance]}`,
              )
            }
            onCancelAutomation={() =>
              runHomeCommand(
                () => api.cancelAutomation(focusUserId),
                '已取消自動降溫',
                '系統不會再自動開啟冷氣，您仍可以自己控制。',
              )
            }
            onRestoreAutomation={() =>
              runHomeCommand(() => api.restoreAutomation(focusUserId), '已恢復自動降溫')
            }
          />

          {/* ------------------------------ 求助 ---------------------------- */}
          <Card className="border-2 border-risk-high-border bg-risk-high-bg/50">
            <CardHeader>
              <CardTitle className="text-elder-lg">需要幫忙嗎</CardTitle>
              <CardDescription className="text-base">
                按下按鈕會顯示家人與緊急聯絡電話，可以直接撥打。
              </CardDescription>
            </CardHeader>
            <CardContent>{helpDialog}</CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Standard layout
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      <PageHeader
        title="總覽"
        description={
          resident
            ? `${resident.name} · ${resident.age} 歲 · ${resident.location}`
            : '即時掌握目前的熱風險狀況。'
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {helpDialog}
            <SimulateRiskButton userId={focusUserId} />
          </div>
        }
      />

      {/* ====================== 1. 目前安全嗎 ====================== */}
      <section className="space-y-4" aria-labelledby="section-status">
        <SectionHeading step={1} title="目前安全嗎" description="現在的熱風險判讀。" />

        <Card
          className={cn(
            'overflow-hidden',
            assessment.level === 'HIGH' && cn('border-2', style.border, 'bg-risk-high-bg/40'),
            assessment.level === 'MEDIUM' && cn('border', style.border),
          )}
        >
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col-reverse items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
              <div className="min-w-0 flex-1 space-y-3 text-center sm:text-left">
                <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
                  <RiskBadge level={assessment.level} size="lg" showEnglish />
                  <LiveIndicator connection={connection} updates={updates} />
                </div>

                <h3
                  id="section-status"
                  className={cn('text-3xl font-bold tracking-tight sm:text-4xl', style.text)}
                  aria-live="polite"
                >
                  {style.plainZh}
                </h3>

                <p className="text-base leading-relaxed text-muted-foreground text-pretty">
                  {assessment.explanation.headline}
                </p>

                <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pt-1 text-sm sm:justify-start">
                  <span className="flex items-center gap-1.5">
                    <Thermometer className="size-4 text-muted-foreground" />
                    熱指數
                    <strong className="tabular font-semibold">
                      {formatTemp(assessment.heatIndex)}
                    </strong>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Heart className="size-4 text-muted-foreground" />
                    心率
                    <strong className="tabular font-semibold">
                      {readings.heartRateBpm} BPM
                    </strong>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Brain className="size-4 text-muted-foreground" />
                    判讀信心度
                    <strong className="tabular font-semibold">
                      {Math.round(assessment.explanation.confidence * 100)}%
                    </strong>
                  </span>
                </div>

                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {updatedLine}
                </p>
              </div>

              <RiskScoreDial score={assessment.score} level={assessment.level} size={168} />
            </div>
          </CardContent>
        </Card>

        {/*
          Stated before the numbers, not after: a resident reading a held value
          should know it is held before they decide it means they are fine.
        */}
        {assessment.provenance && <DataQualitySummary provenance={assessment.provenance} />}

        {/* --------------------------- Environment --------------------------- */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MetricTile
            label="室內溫度"
            value={readings.indoorTempC.toFixed(1)}
            unit="°C"
            icon={Thermometer}
            sublabel={indoorTemp.label}
            provenance={prov('indoorTempC')}
            tone={readings.indoorTempC >= smartHome.targetTempC ? 'medium' : 'neutral'}
          />
          <MetricTile
            label="室內濕度"
            value={readings.indoorHumidityPct.toFixed(0)}
            unit="%"
            icon={Droplet}
            sublabel={indoorHumidity.label}
            provenance={prov('indoorHumidityPct')}
          />
          <MetricTile
            label="室外溫度"
            value={readings.outdoorTempC.toFixed(1)}
            unit="°C"
            icon={Sun}
            sublabel="城市氣象資料"
            provenance={prov('outdoorTempC')}
          />
          <MetricTile
            label="心率"
            value={readings.heartRateBpm}
            unit="BPM"
            icon={Heart}
            sublabel={`平常 ${assessment.baseline.range.min}–${assessment.baseline.range.max}`}
            provenance={prov('heartRateBpm')}
            tone={assessment.baseline.aboveBaseline ? 'high' : 'low'}
          />
          <MetricTile
            label="活動量"
            value={formatNumber(readings.activityStepsPerHour)}
            unit="步/時"
            icon={Footprints}
            sublabel={wearable.label}
            provenance={prov('activityStepsPerHour')}
          />
        </div>
      </section>

      {/* ========================= 2. 為什麼 ========================= */}
      <section className="space-y-4" aria-labelledby="section-why">
        <SectionHeading
          step={2}
          title="為什麼"
          description="AI 依據加權因素與您個人的生理基準做出這個判讀。"
        />
        <span id="section-why" className="sr-only">
          風險判讀原因
        </span>

        <div className="grid gap-4 lg:grid-cols-5">
          <AIExplanationCard assessment={assessment} className="lg:col-span-3" />

          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">風險因素組成</CardTitle>
                <CardDescription className="text-xs">
                  每項因素的嚴重度與其在總分中的權重。
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RiskFactorList factors={assessment.factors} />
              </CardContent>
            </Card>

            <BaselineCard
              evaluation={assessment.baseline}
              baselineRecord={detail?.baseline ?? null}
            />
          </div>
        </div>
      </section>

      {/* ======================= 3. 我該做什麼 ======================= */}
      <section className="space-y-4" aria-labelledby="section-action">
        <SectionHeading
          step={3}
          title="我該做什麼"
          description="系統已自動執行的動作會標示出來；未執行的也會說明原因。"
        />
        <span id="section-action" className="sr-only">
          建議行動
        </span>

        <Card>
          <CardContent className="p-5">
            <ActionList actions={assessment.actions} />
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <SmartHomeCard
            smartHome={smartHome}
            busy={busy}
            readOnly={!canControlHome}
            onToggle={(appliance, on) =>
              runHomeCommand(
                () => api.setAppliance(focusUserId, appliance, on),
                `已${on ? '開啟' : '關閉'}${applianceZh[appliance]}`,
                on ? undefined : '系統仍會持續監測室內溫度。',
              )
            }
            onCancelAutomation={() =>
              runHomeCommand(
                () => api.cancelAutomation(focusUserId),
                '已取消自動降溫',
                '系統不會再自動開啟冷氣，您仍可以自己控制設備。',
              )
            }
            onRestoreAutomation={() =>
              runHomeCommand(
                () => api.restoreAutomation(focusUserId),
                '已恢復自動降溫',
                '風險升高時系統會再次自動介入。',
              )
            }
          />

          <CaregiverStatusCard
            caregivers={contactRows}
            notified={caregiverNotified}
            blockedReason={
              notifyAction?.blockedReasonZh ??
              (caregiverNotified
                ? undefined
                : '目前風險尚未達到通知門檻，因此系統沒有打擾您的家人。')
            }
          />
        </div>
      </section>

      {/* ============================ 趨勢 ============================ */}
      <section className="space-y-4">
        <ChartCard
          title="風險趨勢"
          description="AI 風險分數的變化，虛線為目前設定的注意門檻。"
          height={260}
          action={
            <Badge variant="muted" className="text-[10px]">
              最近 {history.length} 筆
            </Badge>
          }
        >
          <RiskTimeline history={history} config={config} height={260} />
        </ChartCard>
      </section>

      {/* ========================= 附近涼適空間 ========================= */}
      {atLeastMedium && (
        <section className="space-y-4" aria-labelledby="section-cooling">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
              <MapPin className="size-4" />
            </span>
            <div>
              <h2 id="section-cooling" className="text-lg font-semibold tracking-tight">
                附近可以避暑的地方
              </h2>
              <p className="text-sm text-muted-foreground">
                風險已達「{style.labelZh}」，以下是離您最近、目前開放的涼適空間。
              </p>
            </div>
          </div>

          {spacesLoading && (
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          )}

          {!spacesLoading && spacesError && (
            <EmptyState
              icon={AlertTriangle}
              title="無法載入附近的涼適空間"
              description={spacesError}
            />
          )}

          {!spacesLoading && !spacesError && spaces?.blocked && (
            <Card className="border-dashed">
              <CardContent className="flex gap-3 p-5">
                <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">系統沒有提供附近地點</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {spaces.reasonZh ?? '目前無法提供附近的涼適空間建議。'}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {!spacesLoading &&
            !spacesError &&
            spaces &&
            !spaces.blocked &&
            (spaces.recommendations.length === 0 ? (
              <EmptyState
                icon={MapPin}
                title="附近沒有可建議的涼適空間"
                description={spaces.reasonZh ?? '目前範圍內沒有啟用中的涼適空間。'}
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {spaces.recommendations.slice(0, 4).map((space) => (
                  <CoolingSpaceCard key={space.id} space={space} />
                ))}
              </div>
            ))}
        </section>
      )}

      {/* Provenance: a judge should never wonder whether this is real hardware. */}
      {readings.simulated && (
        <p className="flex items-center gap-2 rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          <Activity className="size-3.5 shrink-0" />
          本原型的感測數值為模擬產生（SIMULATED），風險判讀、政策執行與通知流程則為實際運作的程式邏輯。
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Help dialog
// ---------------------------------------------------------------------------

/**
 * The 求助 control.
 *
 * Shows the people this resident can actually reach, with tap-to-call links.
 * The emergency contact comes from the resident's own record; caregiver
 * numbers are added when the account is permitted to see them.
 */
function HelpDialog({
  resident,
  caregivers,
  elderMode,
}: {
  resident: ElderlyUser | null;
  caregivers: Caregiver[];
  elderMode: boolean;
}) {
  const contacts: { key: string; name: string; role: string; phone: string }[] = [];

  if (resident) {
    contacts.push({
      key: 'emergency',
      name: resident.emergencyContact.name,
      role: `緊急聯絡人 · ${resident.emergencyContact.relationship}`,
      phone: resident.emergencyContact.phone,
    });
  }

  caregivers
    .filter((c) => c.status === 'ACTIVE')
    .forEach((c) =>
      contacts.push({
        key: c.id,
        name: c.name,
        role: `照護者 · ${RELATIONSHIP_ZH[c.relationship] ?? c.relationship}`,
        phone: c.phone,
      }),
    );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="danger"
          size={elderMode ? 'elder' : 'default'}
          className={elderMode ? 'w-full' : undefined}
        >
          <LifeBuoy />
          我需要幫忙
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle className={elderMode ? 'text-elder-lg' : undefined}>聯絡與求助</DialogTitle>
          <DialogDescription className={elderMode ? 'text-base' : undefined}>
            點選電話即可直接撥號。若感到頭暈、噁心或無法自行降溫，請立即撥打 119。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              目前沒有可顯示的聯絡人，請洽平台管理者協助設定。
            </p>
          ) : (
            <ul className="space-y-2">
              {contacts.map((contact) => (
                <li
                  key={contact.key}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-muted font-semibold text-primary">
                    {contact.name.slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{contact.name}</p>
                    <p className="text-xs text-muted-foreground">{contact.role}</p>
                  </div>
                  <Button asChild variant="outline" size={elderMode ? 'lg' : 'sm'}>
                    <a href={`tel:${contact.phone}`} aria-label={`撥打給 ${contact.name}`}>
                      <PhoneCall />
                      <span className="tabular">{contact.phone}</span>
                    </a>
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Separator />

          <Button asChild variant="danger" size={elderMode ? 'elder' : 'lg'} className="w-full">
            <a href="tel:119" aria-label="撥打 119 緊急救護">
              <PhoneCall />
              撥打 119 緊急救護
            </a>
          </Button>

          <p className="text-xs leading-relaxed text-muted-foreground">
            平台會記錄您的風險狀況並通知已授權的照護者，但不會代替您撥打電話。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
