/**
 * Risk presentation components.
 *
 * Every risk indicator in the product renders through one of these, so the
 * accessibility contract is enforced in one place: colour is ALWAYS paired
 * with an icon and a text label, never used alone to carry meaning.
 */

import * as React from 'react';
import { AlertOctagon, AlertTriangle, ShieldCheck, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import type {
  DataQuality,
  FieldProvenance,
  ReadingProvenance,
  RiskAssessment,
  RiskFactor,
  RiskLevel,
} from '@shared/types/domain';
import {
  estimatedSummaryZh,
  provenanceSummaryZh,
  qualityLabelZh,
} from '@shared/domain/provenance';
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
// Data quality
// ---------------------------------------------------------------------------

const QUALITY_STYLES: Record<DataQuality, { badge: string; dot: string }> = {
  LIVE: { badge: 'bg-risk-low-bg text-risk-low border-risk-low-border', dot: 'bg-risk-low' },
  RECENT: { badge: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground' },
  STALE: {
    badge: 'bg-risk-medium-bg text-risk-medium border-risk-medium-border',
    dot: 'bg-risk-medium',
  },
  OFFLINE: {
    badge: 'bg-risk-high-bg text-risk-high border-risk-high-border',
    dot: 'bg-risk-high',
  },
};

/** How old a value is, in the plainest Chinese that is still accurate. */
export function formatAgeZh(ageSec: number): string {
  if (ageSec < 60) return `${Math.max(0, Math.round(ageSec))} 秒前`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)} 分鐘前`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)} 小時前`;
  return `${Math.round(ageSec / 86400)} 天前`;
}

/**
 * Freshness of one measured value.
 *
 * The server decides the quality band; this component only renders it. That
 * matters because a caregiver screen and the resident's own screen must never
 * disagree about whether a number can be trusted.
 */
export function DataQualityBadge({
  quality,
  ageSec,
  className,
}: {
  quality: DataQuality;
  ageSec?: number;
  className?: string;
}) {
  const style = QUALITY_STYLES[quality];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        style.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden />
      {qualityLabelZh(quality)}
      {ageSec !== undefined && quality !== 'LIVE' && (
        <span className="tabular font-normal opacity-80">{formatAgeZh(ageSec)}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Metric tile
// ---------------------------------------------------------------------------

/**
 * A single live reading.
 *
 * Pass `provenance` wherever it is available: it carries the server's own
 * verdict on where the number came from and how old it is. When the feeding
 * sensor is down the platform holds the last value rather than inventing one,
 * and the tile then says so instead of presenting an old number as current.
 *
 * `stale` remains for the few call sites that show a value with no per-field
 * provenance behind it, such as derived aggregates.
 */
export function MetricTile({
  label,
  value,
  unit,
  sublabel,
  icon: Icon,
  tone = 'neutral',
  stale = false,
  provenance,
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sublabel?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'low' | 'medium' | 'high';
  stale?: boolean;
  provenance?: FieldProvenance;
  className?: string;
}) {
  const tones = {
    neutral: 'text-foreground',
    low: 'text-risk-low',
    medium: 'text-risk-medium',
    high: 'text-risk-high',
  };

  const quality = provenance?.quality;
  const degraded = quality ? quality !== 'LIVE' && quality !== 'RECENT' : stale;
  const estimated = provenance?.origin === 'DEFAULT';

  // Prefer the server's own note over anything the page could infer.
  const note =
    provenance?.noteZh ??
    (stale && !provenance ? '感測器離線，數值未更新' : undefined);

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-4 transition-shadow hover:shadow-card-hover',
        degraded && 'opacity-70',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {Icon && <Icon className="size-4 shrink-0" />}
        <span className="truncate text-xs font-medium">{label}</span>
        {quality && quality !== 'LIVE' ? (
          <DataQualityBadge quality={quality} ageSec={provenance?.ageSec} className="ml-auto" />
        ) : (
          estimated && (
            <span className="ml-auto rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              推估
            </span>
          )
        )}
      </div>

      <div className="mt-2 flex items-baseline gap-1">
        <span className={cn('tabular text-2xl font-semibold leading-none', tones[tone])}>
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>

      {note ? (
        <p className={cn('mt-1.5 text-xs', degraded ? 'font-medium text-risk-medium' : 'text-muted-foreground')}>
          {note}
        </p>
      ) : (
        sublabel && <p className="mt-1.5 truncate text-xs text-muted-foreground">{sublabel}</p>
      )}
    </div>
  );
}

/**
 * One line telling the reader whether the assessment rests on current data.
 *
 * Renders nothing when everything is live - a banner that is always present
 * stops being read, and there is nothing to warn about.
 */
export function DataQualitySummary({
  provenance,
  className,
}: {
  provenance: ReadingProvenance;
  className?: string;
}) {
  const summary = provenanceSummaryZh(provenance);
  const estimated = estimatedSummaryZh(provenance);
  if (!summary && !estimated) return null;

  const severe = provenance.worstQuality === 'OFFLINE' || provenance.worstQuality === 'STALE';

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3',
        severe && summary
          ? 'border-risk-medium-border bg-risk-medium-bg text-risk-medium'
          : 'border-border bg-muted/50 text-muted-foreground',
        className,
      )}
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1 text-xs leading-relaxed">
        {summary && <p>{summary}</p>}
        {estimated && <p className={cn(summary && 'opacity-80')}>{estimated}</p>}
      </div>
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
