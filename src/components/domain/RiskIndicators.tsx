/**
 * Risk presentation components.
 *
 * Every risk indicator in the product renders through one of these, so the
 * accessibility contract is enforced in one place: colour is ALWAYS paired
 * with an icon and a text label, never used alone to carry meaning.
 */

import * as React from 'react';
import { AlertOctagon, AlertTriangle, ShieldCheck, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import type { RiskAssessment, RiskFactor, RiskLevel } from '@shared/types/domain';
import { cn, RISK_STYLES, formatTemp } from '@/lib/utils';
import { Card, CardContent, Progress } from '@/components/ui';

const RISK_ICONS = {
  'shield-check': ShieldCheck,
  'alert-triangle': AlertTriangle,
  'alert-octagon': AlertOctagon,
} as const;

export function RiskIcon({ level, className }: { level: RiskLevel; className?: string }) {
  const Icon = RISK_ICONS[RISK_STYLES[level].icon];
  return <Icon className={className} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export function RiskBadge({
  level,
  size = 'default',
  showEnglish = false,
  className,
}: {
  level: RiskLevel;
  size?: 'sm' | 'default' | 'lg';
  showEnglish?: boolean;
  className?: string;
}) {
  const style = RISK_STYLES[level];

  const sizes = {
    sm: 'px-2 py-0.5 text-xs gap-1 [&_svg]:size-3',
    default: 'px-2.5 py-1 text-sm gap-1.5 [&_svg]:size-4',
    lg: 'px-4 py-2 text-base gap-2 [&_svg]:size-5',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-semibold',
        style.bg,
        style.text,
        style.border,
        sizes[size],
        className,
      )}
    >
      <RiskIcon level={level} />
      <span>{style.labelZh}</span>
      {showEnglish && <span className="opacity-70">· {style.labelEn}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Score dial
// ---------------------------------------------------------------------------

/**
 * Circular AI risk score.
 *
 * The arc is an SVG rather than a chart library because it animates smoothly
 * between ticks and needs to stay legible at 64px on a phone.
 */
export function RiskScoreDial({
  score,
  level,
  size = 160,
  label = 'AI 風險分數',
}: {
  score: number;
  level: RiskLevel;
  size?: number;
  label?: string;
}) {
  const stroke = size >= 120 ? 12 : 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);

  const colour = {
    LOW: 'hsl(var(--risk-low))',
    MEDIUM: 'hsl(var(--risk-medium))',
    HIGH: 'hsl(var(--risk-high))',
  }[level];

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label}：${score} 分，共 100 分，等級 ${RISK_STYLES[level].labelZh}`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colour}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(0.16,1,0.3,1), stroke 400ms' }}
        />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="tabular font-bold leading-none"
          style={{ fontSize: size * 0.28, color: colour }}
        >
          {Math.round(score)}
        </span>
        {size >= 120 && (
          <span className="mt-1 text-xs font-medium text-muted-foreground">/ 100</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Factor breakdown
// ---------------------------------------------------------------------------

/**
 * The WHY layer of the dashboard hierarchy.
 *
 * Shows each weighted contributor with its measured value, so the score is
 * explainable rather than an opaque number. Factors are ordered by how much
 * they actually contributed.
 */
export function RiskFactorList({
  factors,
  compact = false,
  className,
}: {
  factors: RiskFactor[];
  compact?: boolean;
  className?: string;
}) {
  const ordered = React.useMemo(
    () => [...factors].sort((a, b) => b.contribution - a.contribution),
    [factors],
  );

  const tone = (score: number) =>
    score >= 66 ? 'bg-risk-high' : score >= 33 ? 'bg-risk-medium' : 'bg-risk-low';

  return (
    <ul className={cn('space-y-3', className)}>
      {ordered.map((factor) => (
        <li key={factor.key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{factor.labelZh}</span>
            <span className="tabular shrink-0 text-xs text-muted-foreground">
              {factor.score} 分 · 權重 {Math.round(factor.weight * 100)}%
            </span>
          </div>

          <Progress
            value={factor.score}
            className="mt-1.5 h-1.5"
            indicatorClassName={tone(factor.score)}
            aria-label={`${factor.labelZh} 風險 ${factor.score} 分`}
          />

          {!compact && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {factor.detailZh}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export function TrendIcon({
  direction,
  className,
}: {
  direction: 'up' | 'down' | 'flat';
  className?: string;
}) {
  if (direction === 'up') {
    return <TrendingUp className={cn('text-risk-high', className)} aria-label="上升" />;
  }
  if (direction === 'down') {
    return <TrendingDown className={cn('text-risk-low', className)} aria-label="下降" />;
  }
  return <Minus className={cn('text-muted-foreground', className)} aria-label="持平" />;
}

// ---------------------------------------------------------------------------
// Metric tile
// ---------------------------------------------------------------------------

/**
 * A single live reading.
 *
 * `stale` matters: when the responsible sensor is offline the platform holds
 * the last value rather than inventing one, and the tile must say so rather
 * than presenting an old number as current.
 */
export function MetricTile({
  label,
  value,
  unit,
  sublabel,
  icon: Icon,
  tone = 'neutral',
  stale = false,
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sublabel?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'low' | 'medium' | 'high';
  stale?: boolean;
  className?: string;
}) {
  const tones = {
    neutral: 'text-foreground',
    low: 'text-risk-low',
    medium: 'text-risk-medium',
    high: 'text-risk-high',
  };

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-card-hover',
        stale && 'opacity-70',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {Icon && <Icon className="size-4 shrink-0" />}
        <span className="truncate text-xs font-medium">{label}</span>
      </div>

      <div className="mt-2 flex items-baseline gap-1">
        <span className={cn('tabular text-2xl font-semibold leading-none', tones[tone])}>
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>

      {stale ? (
        <p className="mt-1.5 text-xs font-medium text-risk-medium">感測器離線，數值未更新</p>
      ) : (
        sublabel && <p className="mt-1.5 truncate text-xs text-muted-foreground">{sublabel}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

export function StatusIndicator({
  status,
  label,
  className,
}: {
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'DISABLED' | 'LOW_BATTERY';
  label?: string;
  className?: string;
}) {
  const config = {
    ONLINE: { dot: 'bg-risk-low', text: 'text-risk-low', zh: '正常' },
    DEGRADED: { dot: 'bg-risk-medium', text: 'text-risk-medium', zh: '降級' },
    OFFLINE: { dot: 'bg-risk-high', text: 'text-risk-high', zh: '離線' },
    DISABLED: { dot: 'bg-muted-foreground', text: 'text-muted-foreground', zh: '已停用' },
    LOW_BATTERY: { dot: 'bg-risk-medium', text: 'text-risk-medium', zh: '電量偏低' },
  }[status];

  return (
    <span className={cn('inline-flex items-center gap-2 text-xs font-medium', config.text, className)}>
      <span className="relative flex size-2">
        {status === 'ONLINE' && (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', config.dot)} />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', config.dot)} />
      </span>
      {label ?? config.zh}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Live connection pill
// ---------------------------------------------------------------------------

export function LiveIndicator({
  connection,
  updates,
  className,
}: {
  connection: 'connecting' | 'open' | 'closed' | 'error';
  updates: number;
  className?: string;
}) {
  const config = {
    open: { zh: '即時連線中', dot: 'bg-risk-low', text: 'text-risk-low' },
    connecting: { zh: '連線中…', dot: 'bg-risk-medium', text: 'text-risk-medium' },
    closed: { zh: '連線中斷，重新連線中', dot: 'bg-risk-medium', text: 'text-risk-medium' },
    error: { zh: '無法連線', dot: 'bg-risk-high', text: 'text-risk-high' },
  }[connection];

  return (
    <span
      className={cn('inline-flex items-center gap-2 text-xs font-medium', config.text, className)}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex size-2">
        {connection === 'open' && (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', config.dot)} />
        )}
        <span className={cn('relative inline-flex size-2 rounded-full', config.dot)} />
      </span>
      {config.zh}
      {connection === 'open' && <span className="tabular opacity-60">· {updates}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------------------

/** Compact STATUS -> WHY -> ACTION summary used in list rows and cards. */
export function RiskSummaryStrip({ assessment }: { assessment: RiskAssessment }) {
  const top = [...assessment.factors].sort((a, b) => b.contribution - a.contribution)[0];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular">熱指數 {formatTemp(assessment.heatIndex)}</span>
      <span className="tabular">心率 {assessment.baseline.heartRateBpm} BPM</span>
      {assessment.baseline.aboveBaseline && (
        <span className="tabular font-medium text-risk-medium">
          高於基準 {assessment.baseline.deviationPct}%
        </span>
      )}
      {top && <span>主要因素：{top.labelZh}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('border-dashed shadow-none', className)}>
      <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        {Icon && (
          <div className="rounded-full bg-muted p-3">
            <Icon className="size-6 text-muted-foreground" />
          </div>
        )}
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          {description && (
            <p className="mx-auto max-w-sm text-sm text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
        {action}
      </CardContent>
    </Card>
  );
}
