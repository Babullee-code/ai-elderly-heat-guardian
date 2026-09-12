/**
 * 預判 - the AI reasoning surface.
 *
 * Explains how the current risk number was reached: which factors contributed
 * and by how much, what the engine observed, what it expects next, and the
 * history of level transitions. Everything shown is computed on the server;
 * this page presents the assessment, it does not re-derive it.
 */

import * as React from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Brain,
  Clock,
  Gauge,
  Info,
  Timer,
  TrendingUp,
} from 'lucide-react';

import type { RiskEvent, RiskLevel, RiskRuleConfig } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useLiveStore, selectAssessment, selectHistory } from '@/store/live';
import { useSession } from '@/store/session';
import { cn, formatDateTime, formatTemp, RISK_STYLES, timeAgo } from '@/lib/utils';
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
  Skeleton,
} from '@/components/ui';
import { PageHeader } from '@/components/domain/Cards';
import { AIExplanationCard } from '@/components/domain/Cards';
import {
  EmptyState,
  RiskBadge,
  RiskFactorList,
  RiskScoreDial,
  TrendIcon,
} from '@/components/domain/RiskIndicators';
import { ChartCard, RiskTimeline } from '@/components/domain/Charts';

export default function PredictPage() {
  const focusUserId = useSession((s) => s.focusUserId());
  const elderMode = useSession((s) => s.elderMode);

  const assessment = useLiveStore(selectAssessment(focusUserId));
  const history = useLiveStore(selectHistory(focusUserId));

  const [events, setEvents] = React.useState<RiskEvent[]>([]);
  const [config, setConfig] = React.useState<RiskRuleConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!focusUserId) return;
    setError(null);
    try {
      const [eventsResult, riskResult] = await Promise.all([
        api.riskEvents(focusUserId),
        api.userRisk(focusUserId),
      ]);
      setEvents(eventsResult.events);
      setConfig(riskResult.config);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入風險判讀資料。');
    } finally {
      setLoading(false);
    }
  }, [focusUserId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!focusUserId) {
    return (
      <div className="space-y-6">
        <PageHeader title="預判" />
        <EmptyState
          icon={Brain}
          title="尚未選擇長者"
          description="目前的帳號沒有對應的長者資料，因此無法顯示風險判讀。"
        />
      </div>
    );
  }

  if (loading && !assessment) {
    return (
      <div className="space-y-6">
        <PageHeader title="預判" description="載入中…" />
        <Skeleton className="h-64" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!assessment) {
    return (
      <div className="space-y-6">
        <PageHeader title="預判" />
        <EmptyState
          icon={AlertTriangle}
          title="目前沒有即時判讀資料"
          description={error ?? '這位長者目前未在監測中，可能是帳號已暫停或尚未連線。'}
          action={<Button onClick={() => void load()}>重新載入</Button>}
        />
      </div>
    );
  }

  const style = RISK_STYLES[assessment.level];
  const ordered = [...assessment.factors].sort((a, b) => b.contribution - a.contribution);
  const top = ordered[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title="預判"
        description="說明系統如何得出目前的風險判讀，以及接下來可能的變化。"
      />

      {/* ----------------------- Score composition ------------------------ */}
      <Card className={cn('border-2', style.border, style.bg)}>
        <CardContent className="flex flex-col items-center gap-6 p-6 sm:flex-row sm:items-start">
          <div className="flex shrink-0 flex-col items-center gap-3">
            <RiskScoreDial score={assessment.score} level={assessment.level} size={elderMode ? 180 : 150} />
            <RiskBadge level={assessment.level} size={elderMode ? 'lg' : 'default'} showEnglish />
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div>
              <h2 className={cn('font-bold', elderMode ? 'text-2xl' : 'text-xl')}>
                {assessment.explanation.headline}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                判讀信心度 {Math.round(assessment.explanation.confidence * 100)}% ·
                更新於 {timeAgo(assessment.timestamp)}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-card p-3">
                <p className="text-xs text-muted-foreground">熱指數</p>
                <p className="tabular mt-1 text-xl font-semibold">
                  {formatTemp(assessment.heatIndex)}
                </p>
              </div>
              <div className="rounded-lg bg-card p-3">
                <p className="text-xs text-muted-foreground">主要風險來源</p>
                <p className="mt-1 text-base font-semibold">{top?.labelZh ?? '—'}</p>
              </div>
              <div className="rounded-lg bg-card p-3">
                <p className="text-xs text-muted-foreground">監測頻率</p>
                <p className="tabular mt-1 text-xl font-semibold">
                  每 {assessment.monitoringIntervalSec} 秒
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* --------------------- Explanation ---------------------------- */}
        <AIExplanationCard assessment={assessment} />

        {/* --------------------- Factor breakdown ----------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="size-4 text-primary" />
              風險分數的組成
            </CardTitle>
            <CardDescription>
              每項因子的嚴重程度乘上其權重，加總後得到 0–100 的綜合分數。
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <ul className="space-y-3">
              {ordered.map((factor) => (
                <li key={factor.key} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium">{factor.labelZh}</span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {factor.score} 分 × {Math.round(factor.weight * 100)}% ={' '}
                      <strong className="font-semibold text-foreground">
                        {factor.contribution.toFixed(1)}
                      </strong>
                    </span>
                  </div>
                  <Progress
                    value={factor.score}
                    className="h-1.5"
                    indicatorClassName={
                      factor.score >= 66
                        ? 'bg-risk-high'
                        : factor.score >= 33
                          ? 'bg-risk-medium'
                          : 'bg-risk-low'
                    }
                    aria-label={`${factor.labelZh} ${factor.score} 分`}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {factor.detailZh}
                  </p>
                </li>
              ))}
            </ul>

            <Separator />

            <div className="flex items-center justify-between rounded-lg bg-muted p-3">
              <span className="text-sm text-muted-foreground">綜合風險分數</span>
              <span className="tabular text-2xl font-bold">{assessment.score}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ---------------------------- Timeline ---------------------------- */}
      <ChartCard
        title="風險時間軸"
        description="綜合風險分數隨時間的變化。虛線為目前設定的中度風險門檻。"
        height={280}
      >
        <RiskTimeline history={history} config={config} height={280} />
      </ChartCard>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* ------------------------ Event history ----------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="size-4 text-primary" />
              風險等級變化紀錄
            </CardTitle>
            <CardDescription>
              每一次等級升高或下降都會被記錄，包含當時的判讀依據。
            </CardDescription>
          </CardHeader>

          <CardContent>
            {events.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                目前尚無風險等級變化紀錄。風險維持穩定時不會產生事件。
              </p>
            ) : (
              <ol className="relative space-y-4 border-l border-border pl-6">
                {events.map((event) => {
                  const escalation = event.reason === 'ESCALATION';
                  return (
                    <li key={event.id} className="relative">
                      <span
                        className={cn(
                          'absolute -left-[31px] flex size-5 items-center justify-center rounded-full border-2 border-card',
                          escalation ? 'bg-risk-high' : 'bg-risk-low',
                        )}
                        aria-hidden
                      >
                        {escalation ? (
                          <ArrowUp className="size-3 text-white" />
                        ) : (
                          <ArrowDown className="size-3 text-white" />
                        )}
                      </span>

                      <div className="flex flex-wrap items-center gap-2">
                        {event.previousLevel && (
                          <>
                            <RiskBadge level={event.previousLevel} size="sm" />
                            <ArrowRight className="size-3 text-muted-foreground" />
                          </>
                        )}
                        <RiskBadge level={event.level} size="sm" />
                        <span className="ml-auto text-xs text-muted-foreground">
                          {formatDateTime(event.recordedAt)}
                        </span>
                      </div>

                      <p className="mt-1.5 text-sm">{event.explanation.headline}</p>

                      <p className="tabular mt-1 text-xs text-muted-foreground">
                        分數 {event.score} · 熱指數 {formatTemp(event.heatIndex)}
                        {event.actionsTaken.length > 0 &&
                          ` · 已執行 ${event.actionsTaken.length} 項自動動作`}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* ------------------------ How it works ------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Info className="size-4 text-primary" />
              判讀方式說明
            </CardTitle>
            <CardDescription>系統如何計算風險，以及為什麼這樣設計。</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4 text-sm leading-relaxed">
            <div>
              <p className="font-medium">1. 以個人基準判讀生理數值</p>
              <p className="mt-1 text-muted-foreground">
                同樣是每分鐘 98 下的心率，對某些長者是正常的，對另一些人則是明顯偏離。系統會學習每位長者休息時的心率範圍，再以「高於平常多少」來判讀，而不是套用固定門檻。
              </p>
            </div>

            <div>
              <p className="font-medium">2. 五項因子加權計算</p>
              <p className="mt-1 text-muted-foreground">
                環境熱負荷、生理偏離、熱浪持續、通風與濕度、活動量，各自評分後依權重加總，得到 0–100 的綜合分數。
              </p>
            </div>

            <div>
              <p className="font-medium">3. 熱指數決定基本等級</p>
              {config ? (
                <p className="mt-1 text-muted-foreground">
                  目前設定：熱指數低於 {config.thresholds.medium}°C 為低風險，
                  {config.thresholds.medium}–{config.thresholds.high}°C 為需要注意，
                  達到 {config.thresholds.high}°C 以上為高風險。這些門檻由平台管理者設定，可依季節或地區調整。
                </p>
              ) : (
                <p className="mt-1 text-muted-foreground">正在讀取目前的門檻設定…</p>
              )}
            </div>

            <div>
              <p className="font-medium">4. 綜合分數只會提高等級</p>
              <p className="mt-1 text-muted-foreground">
                若綜合分數偏高，等級會被提升；但分數低不會讓等級下降。這是為了避免明顯的生理異常，因為室溫只是「有點熱」就被忽略。
              </p>
            </div>

            <Separator />

            <div className="flex gap-2.5 rounded-lg bg-muted p-3">
              <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                目前每 {assessment.monitoringIntervalSec} 秒重新評估一次。風險越高，評估越頻繁，以更早察覺變化。
              </p>
            </div>

            <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              系統提供的是風險判讀與建議，不構成醫療診斷。若身體出現不適，請直接聯繫家人或醫療專業人員。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ---------------------------- Forecast ---------------------------- */}
      <Card className="border-primary/25 bg-primary-muted/40">
        <CardContent className="flex items-start gap-3 p-4">
          <TrendingUp className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <p className="font-medium">接下來的預期</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {assessment.explanation.forecast}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
