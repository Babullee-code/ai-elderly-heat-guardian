/**
 * Domain cards shared by the resident, caregiver and admin interfaces.
 *
 * Each of these encodes a piece of the product's information hierarchy:
 * STATUS -> WHY -> ACTION. Keeping them here means the resident dashboard and
 * the CMS user-detail page tell the same story with the same wording.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AirVent,
  Armchair,
  BatteryLow,
  Bell,
  Brain,
  Building2,
  CheckCircle2,
  Clock,
  Droplet,
  Fan,
  Footprints,
  Gauge,
  Heart,
  Info,
  Library,
  MapPin,
  PhoneCall,
  Signal,
  Stethoscope,
  Sun,
  Thermometer,
  TrainFront,
  Trees,
  Users,
  Wind,
  XCircle,
} from 'lucide-react';

import type {
  Alert,
  BaselineEvaluation,
  CoolingSpaceRecommendation,
  Device,
  PersonalBaseline,
  RecommendedAction,
  RiskAssessment,
  SmartHomeState,
} from '@shared/types/domain';
import {
  ALERT_STATUS_ZH,
  DEVICE_LABELS_ZH,
  DEVICE_STATUS_ZH,
  cn,
  formatDistance,
  formatPct,
  formatTemp,
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
  Progress,
  Separator,
  Switch,
} from '@/components/ui';
import { RiskBadge, StatusIndicator, TrendIcon } from './RiskIndicators';

// ---------------------------------------------------------------------------
// AI explanation
// ---------------------------------------------------------------------------

/**
 * The WHY layer.
 *
 * Renders the engine's reasoning lines verbatim. The wording is deliberately
 * constrained upstream: the platform reports measurements and risk direction
 * and never asserts a diagnosis.
 */
export function AIExplanationCard({
  assessment,
  className,
  compact = false,
}: {
  assessment: RiskAssessment;
  className?: string;
  compact?: boolean;
}) {
  const { explanation } = assessment;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <Brain className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className="text-base">AI 風險分析</CardTitle>
              <CardDescription className="text-xs">
                判讀信心度 {Math.round(explanation.confidence * 100)}%
              </CardDescription>
            </div>
          </div>
          <RiskBadge level={assessment.level} size="sm" />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-lg font-semibold leading-snug">{explanation.headline}</p>

        <ul className="space-y-2.5">
          {explanation.lines.map((line, index) => (
            <li key={index} className="flex gap-2.5">
              <TrendIcon direction={line.direction} className="mt-0.5 size-4 shrink-0" />
              <span
                className={cn(
                  'text-sm leading-relaxed',
                  line.factor === 'summary' ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {line.zh}
              </span>
            </li>
          ))}
        </ul>

        {!compact && (
          <div className="flex gap-2.5 rounded-lg bg-muted p-3">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-xs leading-relaxed text-muted-foreground">{explanation.forecast}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Personal baseline
// ---------------------------------------------------------------------------

/**
 * The clinical heart of the proposal: this reading, relative to THIS person.
 *
 * The bar positions the current heart rate against the learned personal
 * range, so "98 BPM" is legible as normal or abnormal without the viewer
 * needing to know anything about the individual.
 */
export function BaselineCard({
  baseline,
  evaluation,
  baselineRecord,
  className,
}: {
  baseline?: PersonalBaseline | null;
  evaluation: BaselineEvaluation;
  baselineRecord?: PersonalBaseline | null;
  className?: string;
}) {
  const record = baselineRecord ?? baseline ?? null;
  const { range, heartRateBpm, aboveBaseline, deviationPct } = evaluation;

  // Plot across a window that always contains the band plus headroom.
  const windowMin = Math.min(range.min - 12, heartRateBpm - 6);
  const windowMax = Math.max(range.max + 30, heartRateBpm + 6);
  const span = Math.max(1, windowMax - windowMin);

  const pos = (value: number) => ((value - windowMin) / span) * 100;

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-risk-high-bg">
            <Heart className="size-4 text-risk-high" />
          </span>
          <div>
            <CardTitle className="text-base">個人生理基準</CardTitle>
            <CardDescription className="text-xs">
              以本人平常數值判讀，而非固定門檻
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              'tabular text-4xl font-bold leading-none',
              aboveBaseline ? 'text-risk-high' : 'text-foreground',
            )}
          >
            {heartRateBpm}
          </span>
          <span className="text-sm text-muted-foreground">BPM</span>

          {aboveBaseline && (
            <Badge variant="danger" className="ml-auto">
              +{deviationPct}%
            </Badge>
          )}
          {!aboveBaseline && !evaluation.belowBaseline && (
            <Badge variant="success" className="ml-auto">
              正常範圍
            </Badge>
          )}
          {evaluation.belowBaseline && (
            <Badge variant="muted" className="ml-auto">
              低於平常
            </Badge>
          )}
        </div>

        {/* Baseline band visualisation */}
        <div className="space-y-2">
          <div className="relative h-8">
            <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-muted" />
            <div
              className="absolute top-3 h-2 rounded-full bg-risk-low/30"
              style={{ left: `${pos(range.min)}%`, width: `${pos(range.max) - pos(range.min)}%` }}
            />
            <div
              className={cn(
                'absolute top-1 size-6 -translate-x-1/2 rounded-full border-[3px] border-card shadow',
                aboveBaseline ? 'bg-risk-high' : 'bg-risk-low',
              )}
              style={{ left: `${Math.min(98, Math.max(2, pos(heartRateBpm)))}%` }}
              role="img"
              aria-label={`目前心率 ${heartRateBpm} BPM，個人平常範圍 ${range.min} 到 ${range.max} BPM`}
            />
          </div>

          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="tabular">{Math.round(windowMin)}</span>
            <span className="tabular font-medium text-risk-low">
              平常 {range.min}–{range.max}
            </span>
            <span className="tabular">{Math.round(windowMax)}</span>
          </div>
        </div>

        <p
          className={cn(
            'rounded-lg p-3 text-sm font-medium',
            aboveBaseline ? 'bg-risk-high-bg text-risk-high' : 'bg-risk-low-bg text-risk-low',
          )}
        >
          {evaluation.descriptionZh}
        </p>

        {record && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            此基準由 {record.sampleCount} 筆休息時段的量測學習而得，信心度{' '}
            {Math.round(record.confidence * 100)}%。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recommended actions
// ---------------------------------------------------------------------------

const ACTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  droplet: Droplet,
  armchair: Armchair,
  sun: Sun,
  bell: Bell,
  'air-vent': AirVent,
  thermometer: Thermometer,
  activity: Activity,
  'map-pin': MapPin,
  'phone-call': PhoneCall,
};

/**
 * The ACTION layer.
 *
 * A blocked automatic action is shown, not hidden. If the air conditioner did
 * not switch itself on, the resident is told why - that honesty is the whole
 * value of an automation the user is trusting with their safety.
 */
export function ActionList({
  actions,
  className,
  large = false,
}: {
  actions: RecommendedAction[];
  className?: string;
  large?: boolean;
}) {
  if (actions.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        目前沒有需要特別採取的行動。
      </p>
    );
  }

  return (
    <ul className={cn('space-y-2.5', className)}>
      {actions.map((action) => {
        const Icon = ACTION_ICONS[action.icon] ?? Info;
        const blocked = Boolean(action.blockedReason);

        return (
          <li
            key={action.type}
            className={cn(
              'flex gap-3 rounded-lg border p-3.5',
              blocked
                ? 'border-dashed border-border bg-muted/40'
                : action.automatic
                  ? 'border-risk-low-border bg-risk-low-bg/50'
                  : 'border-border bg-card',
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-lg',
                large && 'size-12',
                blocked
                  ? 'bg-muted text-muted-foreground'
                  : action.automatic
                    ? 'bg-risk-low text-white'
                    : 'bg-primary-muted text-primary',
              )}
            >
              <Icon className={cn('size-4.5', large && 'size-6')} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className={cn('font-semibold', large ? 'text-lg' : 'text-sm')}>
                  {action.titleZh}
                </p>

                {action.automatic && !blocked && (
                  <Badge variant="success" className="text-[10px]">
                    <CheckCircle2 className="size-3" />
                    系統已自動執行
                  </Badge>
                )}
                {blocked && (
                  <Badge variant="muted" className="text-[10px]">
                    <XCircle className="size-3" />
                    未執行
                  </Badge>
                )}
              </div>

              <p
                className={cn(
                  'mt-1 leading-relaxed text-muted-foreground',
                  large ? 'text-base' : 'text-xs',
                )}
              >
                {action.bodyZh}
              </p>

              {blocked && (
                <p
                  className={cn(
                    'mt-1.5 font-medium text-risk-medium',
                    large ? 'text-sm' : 'text-xs',
                  )}
                >
                  原因：{action.blockedReasonZh}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Smart home
// ---------------------------------------------------------------------------

export function SmartHomeCard({
  smartHome,
  onToggle,
  onCancelAutomation,
  onRestoreAutomation,
  busy,
  readOnly = false,
  className,
}: {
  smartHome: SmartHomeState;
  onToggle?: (appliance: 'ac' | 'fan' | 'dehumidifier', on: boolean) => void;
  onCancelAutomation?: () => void;
  onRestoreAutomation?: () => void;
  busy?: boolean;
  readOnly?: boolean;
  className?: string;
}) {
  const appliances = [
    { key: 'ac' as const, label: '冷氣', icon: AirVent, state: smartHome.ac },
    { key: 'fan' as const, label: '電風扇', icon: Fan, state: smartHome.fan },
    { key: 'dehumidifier' as const, label: '除濕機', icon: Wind, state: smartHome.dehumidifier },
  ];

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">智慧家庭</CardTitle>
            <CardDescription className="text-xs">室內環境與降溫設備</CardDescription>
          </div>
          {smartHome.automaticallyEngaged && (
            <Badge variant="success">
              <CheckCircle2 className="size-3" />
              自動降溫中
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-muted p-3 text-center">
            <Thermometer className="mx-auto size-4 text-muted-foreground" />
            <p className="tabular mt-1.5 text-lg font-semibold">
              {formatTemp(smartHome.indoorTempC)}
            </p>
            <p className="text-[11px] text-muted-foreground">室內溫度</p>
          </div>
          <div className="rounded-lg bg-muted p-3 text-center">
            <Droplet className="mx-auto size-4 text-muted-foreground" />
            <p className="tabular mt-1.5 text-lg font-semibold">
              {formatPct(smartHome.indoorHumidityPct)}
            </p>
            <p className="text-[11px] text-muted-foreground">室內濕度</p>
          </div>
          <div className="rounded-lg bg-muted p-3 text-center">
            <Gauge className="mx-auto size-4 text-muted-foreground" />
            <p className="tabular mt-1.5 text-lg font-semibold">
              {formatTemp(smartHome.targetTempC, 0)}
            </p>
            <p className="text-[11px] text-muted-foreground">目標溫度</p>
          </div>
        </div>

        <Separator />

        <ul className="space-y-1">
          {appliances.map(({ key, label, icon: Icon, state }) => (
            <li key={key} className="flex items-center gap-3 py-1.5">
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  state.on ? 'bg-risk-low text-white' : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="size-4" />
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {!state.present
                    ? '未安裝'
                    : state.disabled
                      ? '離線或已停用'
                      : state.on
                        ? '運轉中'
                        : '待機'}
                </p>
              </div>

              {state.present && !readOnly && onToggle ? (
                <Switch
                  checked={state.on}
                  disabled={state.disabled || busy}
                  onCheckedChange={(on) => onToggle(key, on)}
                  aria-label={`${state.on ? '關閉' : '開啟'}${label}`}
                />
              ) : (
                <Badge variant={state.on ? 'success' : 'muted'} className="text-[10px]">
                  {state.on ? 'ON' : state.present ? 'OFF' : '—'}
                </Badge>
              )}
            </li>
          ))}
        </ul>

        {/* The automation note always states what the platform did or did not
            do, and why - never leaving the user to guess. */}
        {smartHome.automationNoteZh && (
          <div
            className={cn(
              'flex gap-2.5 rounded-lg p-3 text-xs leading-relaxed',
              smartHome.automaticallyEngaged
                ? 'bg-risk-low-bg text-risk-low'
                : 'bg-muted text-muted-foreground',
            )}
          >
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{smartHome.automationNoteZh}</span>
          </div>
        )}

        {!readOnly && (
          <>
            {smartHome.automaticallyEngaged && onCancelAutomation && (
              <Button variant="outline" className="w-full" onClick={onCancelAutomation} loading={busy}>
                取消自動降溫
              </Button>
            )}
            {smartHome.userOverride && onRestoreAutomation && (
              <Button variant="outline" className="w-full" onClick={onRestoreAutomation} loading={busy}>
                恢復自動降溫
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

const DEVICE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  SMART_WATCH: Heart,
  TEMPERATURE_SENSOR: Thermometer,
  HUMIDITY_SENSOR: Droplet,
  AIR_QUALITY_SENSOR: Wind,
  SMART_AC: AirVent,
  DEHUMIDIFIER: Wind,
  FAN: Fan,
};

export function DeviceCard({
  device,
  onAction,
  busy,
  className,
}: {
  device: Device;
  onAction?: (action: string) => void;
  busy?: boolean;
  className?: string;
}) {
  const Icon = DEVICE_ICONS[device.type] ?? Activity;
  const down = device.status === 'OFFLINE' || device.status === 'DISABLED';

  return (
    <Card className={cn(down && 'border-dashed', className)}>
      <CardContent className="flex items-start gap-3 p-4">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            down ? 'bg-muted text-muted-foreground' : 'bg-primary-muted text-primary',
          )}
        >
          <Icon className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{DEVICE_LABELS_ZH[device.type] ?? device.name}</p>
            <StatusIndicator status={device.status} label={DEVICE_STATUS_ZH[device.status]} />
          </div>

          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{device.deviceId}</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <MapPin className="size-3" />
              {device.location}
            </span>

            {device.batteryPct !== null && (
              <span
                className={cn(
                  'flex items-center gap-1',
                  device.batteryPct < 20 && 'font-medium text-risk-medium',
                )}
              >
                <BatteryLow className="size-3" />
                {device.batteryPct}%
              </span>
            )}

            <span className="flex items-center gap-1">
              <Signal className="size-3" />
              {device.signalPct}%
            </span>

            <span className="flex items-center gap-1">
              <Clock className="size-3" />
              {timeAgo(device.lastSeen)}
            </span>
          </div>

          {onAction && (
            <div className="mt-3 flex flex-wrap gap-2">
              {down ? (
                <Button size="sm" variant="outline" onClick={() => onAction('reconnect')} loading={busy}>
                  重新連線
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onAction('disable')} loading={busy}>
                  停用
                </Button>
              )}
              {device.isActuator && !down && (
                <Button
                  size="sm"
                  variant={device.power ? 'secondary' : 'outline'}
                  onClick={() => onAction('toggle-power')}
                  loading={busy}
                >
                  {device.power ? '關閉電源' : '開啟電源'}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Cooling spaces
// ---------------------------------------------------------------------------

const SPACE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  LIBRARY: Library,
  COMMUNITY_CENTER: Users,
  PUBLIC_BUILDING: Building2,
  AIR_CONDITIONED_PUBLIC_SPACE: AirVent,
  PARK: Trees,
  MRT_STATION: TrainFront,
  HEALTH_CENTER: Stethoscope,
};

export function CoolingSpaceCard({
  space,
  className,
  large = false,
}: {
  space: CoolingSpaceRecommendation;
  className?: string;
  large?: boolean;
}) {
  const Icon = SPACE_ICONS[space.type] ?? Building2;

  return (
    <Card className={cn('transition-shadow hover:shadow-card-hover', className)}>
      <CardContent className={cn('flex items-start gap-3 p-4', large && 'gap-4 p-5')}>
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary',
            large && 'size-12',
          )}
        >
          <Icon className={cn('size-5', large && 'size-6')} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className={cn('font-semibold', large && 'text-lg')}>{space.name}</p>
            <span className={cn('tabular shrink-0 text-sm font-semibold text-primary', large && 'text-base')}>
              {formatDistance(space.distanceKm)}
            </span>
          </div>

          <p className={cn('mt-0.5 text-xs text-muted-foreground', large && 'text-sm')}>
            {space.address} · 步行約 {space.walkingMinutes} 分鐘
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {space.airConditioned && (
              <Badge variant="success" className="text-[10px]">
                <AirVent className="size-3" />
                有冷氣
              </Badge>
            )}
            {space.accessible && (
              <Badge variant="secondary" className="text-[10px]">
                無障礙
              </Badge>
            )}
            <Badge variant={space.openNow ? 'outline' : 'muted'} className="text-[10px]">
              <Clock className="size-3" />
              {space.openNow ? '現在開放' : '目前休息'}
            </Badge>
          </div>

          <p className={cn('mt-2 text-xs text-muted-foreground', large && 'text-sm')}>
            {space.openingHours}
            {space.contact && ` · ${space.contact}`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export function AlertCard({
  alert,
  href,
  onAcknowledge,
  onResolve,
  busy,
  className,
}: {
  alert: Alert;
  href?: string;
  onAcknowledge?: () => void;
  onResolve?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const statusVariant = {
    NEW: 'danger',
    ESCALATED: 'danger',
    ACKNOWLEDGED: 'warning',
    RESOLVED: 'success',
  }[alert.status] as 'danger' | 'warning' | 'success';

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <RiskBadge level={alert.level} size="sm" />
        <Badge variant={statusVariant} className="text-[10px]">
          {ALERT_STATUS_ZH[alert.status]}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(alert.createdAt)}</span>
      </div>

      <p className="mt-2 font-semibold">{alert.userName}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{alert.triggerZh}</p>

      {alert.assignedCaregiverName && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          負責照護者：{alert.assignedCaregiverName}
        </p>
      )}
    </>
  );

  return (
    <Card
      className={cn(
        'transition-shadow',
        alert.status !== 'RESOLVED' && alert.level === 'HIGH' && 'border-risk-high-border',
        href && 'hover:shadow-card-hover',
        className,
      )}
    >
      <CardContent className="p-4">
        {href ? (
          <Link to={href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {body}
          </Link>
        ) : (
          body
        )}

        {(onAcknowledge || onResolve) && alert.status !== 'RESOLVED' && (
          <div className="mt-3 flex gap-2">
            {onAcknowledge && alert.status === 'NEW' && (
              <Button size="sm" variant="outline" onClick={onAcknowledge} loading={busy}>
                確認收到
              </Button>
            )}
            {onResolve && (
              <Button size="sm" variant="outline" onClick={onResolve} loading={busy}>
                標記為已解除
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Caregiver status (resident-facing)
// ---------------------------------------------------------------------------

/** Answers the resident's question: does my family know? */
export function CaregiverStatusCard({
  caregivers,
  notified,
  blockedReason,
  className,
}: {
  caregivers: { id: string; name: string; relationship: string; status?: string }[];
  notified: boolean;
  blockedReason?: string;
  className?: string;
}) {
  const active = caregivers.filter((c) => c.status !== 'INACTIVE');

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-8 items-center justify-center rounded-lg',
              notified ? 'bg-risk-low-bg' : 'bg-muted',
            )}
          >
            <Users className={cn('size-4', notified ? 'text-risk-low' : 'text-muted-foreground')} />
          </span>
          <div>
            <CardTitle className="text-base">家人是否知道</CardTitle>
            <CardDescription className="text-xs">
              {notified ? '已通知家人' : '目前尚未發送通知'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">目前沒有指派的照護者。</p>
        ) : (
          <ul className="space-y-2">
            {active.map((caregiver) => (
              <li key={caregiver.id} className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-muted text-xs font-semibold text-primary">
                  {caregiver.name.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{caregiver.name}</p>
                  <p className="text-xs text-muted-foreground">{caregiver.relationship}</p>
                </div>
                {notified && <CheckCircle2 className="size-4 shrink-0 text-risk-low" />}
              </li>
            ))}
          </ul>
        )}

        {blockedReason && (
          <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            {blockedReason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Admin stat card
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = 'neutral',
  href,
  trend,
  className,
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'primary' | 'low' | 'medium' | 'high';
  href?: string;
  trend?: { direction: 'up' | 'down' | 'flat'; label: string };
  className?: string;
}) {
  const tones = {
    neutral: { accent: 'bg-muted text-muted-foreground', value: 'text-foreground' },
    primary: { accent: 'bg-primary-muted text-primary', value: 'text-foreground' },
    low: { accent: 'bg-risk-low-bg text-risk-low', value: 'text-risk-low' },
    medium: { accent: 'bg-risk-medium-bg text-risk-medium', value: 'text-risk-medium' },
    high: { accent: 'bg-risk-high-bg text-risk-high', value: 'text-risk-high' },
  }[tone];

  const inner = (
    <CardContent className="p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && (
          <span className={cn('flex size-8 items-center justify-center rounded-lg', tones.accent)}>
            <Icon className="size-4" />
          </span>
        )}
      </div>

      <p className={cn('tabular mt-3 text-3xl font-bold leading-none', tones.value)}>{value}</p>

      <div className="mt-2 flex items-center gap-2">
        {trend && <TrendIcon direction={trend.direction} className="size-3.5" />}
        {(sublabel || trend) && (
          <p className="truncate text-xs text-muted-foreground">{trend?.label ?? sublabel}</p>
        )}
      </div>
    </CardContent>
  );

  if (href) {
    return (
      <Card className={cn('transition-shadow hover:shadow-card-hover', className)}>
        <Link to={href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl">
          {inner}
        </Link>
      </Card>
    );
  }

  return <Card className={className}>{inner}</Card>;
}

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-6', className)}>
      {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground text-pretty">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}
