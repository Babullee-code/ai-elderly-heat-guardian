/**
 * 風險規則 - the centralised configuration the risk engine reads.
 *
 * This is the page that proves the CMS is a real control layer rather than a
 * decorative dashboard. Every control here writes to the single RiskRuleConfig
 * the server's risk engine consults on every tick, so a change made here
 * re-levels every resident within one tick and propagates to every open
 * screen over the live socket.
 *
 * The impact preview is the important affordance: before committing, the
 * admin sees exactly which residents would move and to where, computed by the
 * real engine against the real current readings on the server. Nothing on
 * this page recomputes risk locally.
 */

import * as React from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  Gauge,
  Heart,
  Info,
  Lock,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Snowflake,
  Thermometer,
  Timer,
  TrendingUp,
  Undo2,
  Wind,
} from 'lucide-react';

import type { PlatformStats, RiskFactorKey, RiskLevel, RiskRuleConfig } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { cn, formatTemp, RISK_STYLES } from '@/lib/utils';
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
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Slider,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, RiskBadge } from '@/components/domain/RiskIndicators';

const FACTOR_LABELS: Record<RiskFactorKey, { zh: string; hint: string }> = {
  environmental: { zh: '環境熱負荷', hint: '室內熱指數相對於門檻區間的嚴重程度。' },
  physiological: { zh: '生理偏離', hint: '心率高於個人平常基準的幅度。' },
  heatwave: { zh: '熱浪持續', hint: '連續高溫天數與夜間未降溫造成的累積負荷。' },
  ventilation: { zh: '通風與濕度', hint: '濕度阻礙排汗，以及室內是否比室外涼爽。' },
  activity: { zh: '活動量', hint: '活動量低於個人平常水準（嗜睡是早期警訊）。' },
};

const LEVEL_OPTIONS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

/** Deep clone so edits never mutate the saved config held in state. */
function clone(config: RiskRuleConfig): RiskRuleConfig {
  return JSON.parse(JSON.stringify(config)) as RiskRuleConfig;
}

export default function AdminRiskRules() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const liveStats = useLiveStore((s) => s.stats);
  const configVersion = useLiveStore((s) => s.configVersion);

  const editable = can('risk-rule:write');

  const [saved, setSaved] = React.useState<RiskRuleConfig | null>(null);
  const [draft, setDraft] = React.useState<RiskRuleConfig | null>(null);
  const [version, setVersion] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = React.useState(false);

  const [preview, setPreview] = React.useState<{
    projected: Record<RiskLevel, number>;
    moved: { userId: string; name: string; from: string; to: string }[];
  } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.getRiskRules();
      setSaved(result.config);
      setDraft(clone(result.config));
      setVersion(result.version);
    } catch (error) {
      setLoadError(
        error instanceof ApiError ? error.displayMessage : '無法載入風險規則設定。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = React.useMemo(
    () => Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft)),
    [saved, draft],
  );

  /**
   * Ask the server what this draft WOULD do, without saving it.
   * Debounced, because the admin is dragging sliders.
   */
  React.useEffect(() => {
    if (!draft || !dirty) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setPreviewing(true);

    const timer = setTimeout(() => {
      api
        .previewRiskRules(toPayload(draft))
        .then((result) => {
          if (cancelled) return;
          setPreview({ projected: result.projected, moved: result.moved });
        })
        .catch(() => {
          // A preview failure is not worth interrupting editing for; the save
          // path reports validation problems properly.
          if (!cancelled) setPreview(null);
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 450);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, dirty]);

  const update = React.useCallback(
    (mutate: (next: RiskRuleConfig) => void) => {
      setDraft((current) => {
        if (!current) return current;
        const next = clone(current);
        mutate(next);
        return next;
      });
      setFieldErrors({});
    },
    [],
  );

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setFieldErrors({});

    try {
      const result = await api.updateRiskRules(toPayload(draft));
      setSaved(result.config);
      setDraft(clone(result.config));
      setVersion(result.version);
      setPreview(null);

      toast.success(
        `設定已套用（版本 v${result.version}）`,
        `目前：高風險 ${result.effect.highRiskUsers} 位、需注意 ${result.effect.mediumRiskUsers} 位、低風險 ${result.effect.lowRiskUsers} 位。所有畫面已同步更新。`,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        toast.error('設定未儲存', error.displayMessage);
      } else {
        toast.error('設定未儲存', '請稍後再試。');
      }
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!saved) return;
    setDraft(clone(saved));
    setPreview(null);
    setFieldErrors({});
  };

  const reset = async () => {
    setSaving(true);
    try {
      const result = await api.resetRiskRules();
      setSaved(result.config);
      setDraft(clone(result.config));
      setVersion(result.version);
      setPreview(null);
      setResetOpen(false);
      toast.success('已還原為預設值', '風險門檻與權重已回到提案的建議設定。');
    } catch (error) {
      toast.error(
        '無法還原',
        error instanceof ApiError ? error.displayMessage : '請稍後再試。',
      );
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="風險規則" description="載入中…" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (loadError || !draft || !saved) {
    return (
      <div className="space-y-6">
        <PageHeader title="風險規則" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入風險規則"
          description={loadError ?? '設定資料不可用。'}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  const weightTotal = Object.values(draft.weights).reduce((sum, w) => sum + w, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="風險規則"
        description="這是整個平台唯一的風險設定來源。儲存後，風險引擎會在下一個更新週期立即套用，所有使用者與照護端畫面同步變更。"
        actions={
          <>
            <Badge variant="secondary">設定版本 v{Math.max(version, configVersion)}</Badge>
            {editable && (
              <>
                <Button variant="outline" onClick={() => setResetOpen(true)} disabled={saving}>
                  <RotateCcw />
                  還原預設值
                </Button>
                {dirty && (
                  <Button variant="ghost" onClick={discard} disabled={saving}>
                    <Undo2 />
                    捨棄變更
                  </Button>
                )}
                <Button onClick={save} loading={saving} disabled={!dirty}>
                  <Save />
                  {dirty ? '儲存並套用' : '沒有變更'}
                </Button>
              </>
            )}
          </>
        }
      />

      {!editable && (
        <Card className="border-border bg-muted/50">
          <CardContent className="flex items-start gap-3 p-4">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              您目前的角色為唯讀，可以檢視所有設定值，但無法變更。變更風險規則需要管理者權限。
            </p>
          </CardContent>
        </Card>
      )}

      {/* ------------------------ Live effect strip ------------------------ */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="目前高風險"
          value={liveStats?.highRiskUsers ?? '--'}
          sublabel="依現行設定計算"
          icon={AlertTriangle}
          tone="high"
        />
        <StatCard
          label="目前需注意"
          value={liveStats?.mediumRiskUsers ?? '--'}
          sublabel="依現行設定計算"
          icon={TrendingUp}
          tone="medium"
        />
        <StatCard
          label="目前低風險"
          value={liveStats?.lowRiskUsers ?? '--'}
          sublabel="依現行設定計算"
          icon={Check}
          tone="low"
        />
        <StatCard
          label="監測中長者"
          value={liveStats?.activeUsers ?? '--'}
          sublabel="狀態為啟用"
          icon={Gauge}
          tone="primary"
        />
      </div>

      {/* -------------------------- Impact preview ------------------------- */}
      {dirty && (
        <Card className="border-primary/30 bg-primary-muted/40">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="size-4 text-primary" />
                  變更影響預覽
                </CardTitle>
                <CardDescription>
                  尚未儲存。以下為伺服器以實際感測資料試算的結果。
                </CardDescription>
              </div>
              {previewing && <Badge variant="muted">試算中…</Badge>}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {preview ? (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {LEVEL_OPTIONS.map((level) => {
                    const before =
                      level === 'HIGH'
                        ? (liveStats?.highRiskUsers ?? 0)
                        : level === 'MEDIUM'
                          ? (liveStats?.mediumRiskUsers ?? 0)
                          : (liveStats?.lowRiskUsers ?? 0);
                    const after = preview.projected[level] ?? 0;
                    const delta = after - before;

                    return (
                      <div key={level} className="rounded-lg border border-border bg-card p-3">
                        <div className="flex items-center justify-between gap-2">
                          <RiskBadge level={level} size="sm" />
                          {delta !== 0 && (
                            <Badge variant={delta > 0 ? 'danger' : 'success'} className="text-[10px]">
                              {delta > 0 ? '+' : ''}
                              {delta}
                            </Badge>
                          )}
                        </div>
                        <p className="tabular mt-2 text-2xl font-bold">
                          {before}
                          <span className="mx-1.5 text-base font-normal text-muted-foreground">→</span>
                          <span className={cn(delta !== 0 && 'text-primary')}>{after}</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">位長者</p>
                      </div>
                    );
                  })}
                </div>

                {preview.moved.length > 0 ? (
                  <div>
                    <p className="mb-2 text-sm font-medium">
                      將有 {preview.moved.length} 位長者的風險等級改變：
                    </p>
                    <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                      {preview.moved.map((item) => (
                        <li
                          key={item.userId}
                          className="flex items-center gap-2 rounded-md bg-card px-3 py-2 text-sm"
                        >
                          <span className="font-medium">{item.name}</span>
                          <span className="ml-auto flex items-center gap-2">
                            <RiskBadge level={item.from as RiskLevel} size="sm" />
                            <span className="text-muted-foreground">→</span>
                            <RiskBadge level={item.to as RiskLevel} size="sm" />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    以目前的感測數值來看，這項變更不會改變任何長者的風險等級。
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">正在試算變更的影響…</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ----------------------------- Editor ------------------------------ */}
      <Tabs defaultValue="thresholds">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="thresholds">
            <Thermometer className="size-3.5" />
            熱指數門檻
          </TabsTrigger>
          <TabsTrigger value="weights">
            <SlidersHorizontal className="size-3.5" />
            風險權重
          </TabsTrigger>
          <TabsTrigger value="physiology">
            <Heart className="size-3.5" />
            生理與環境
          </TabsTrigger>
          <TabsTrigger value="monitoring">
            <Timer className="size-3.5" />
            監測頻率
          </TabsTrigger>
          <TabsTrigger value="policy">
            <Snowflake className="size-3.5" />
            降溫與通知政策
          </TabsTrigger>
        </TabsList>

        {/* ------------------------- Thresholds --------------------------- */}
        <TabsContent value="thresholds" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">熱指數門檻</CardTitle>
              <CardDescription>
                風險等級主要由室內熱指數決定。提案的建議值為 LOW 27°C、MEDIUM 32°C、HIGH 39°C。
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <ThresholdBands config={draft} />

              <div className="grid gap-5 md:grid-cols-3">
                <ThresholdControl
                  label="LOW 起始門檻"
                  description="低於此值視為舒適，不產生熱風險提醒。"
                  value={draft.thresholds.low}
                  min={15}
                  max={35}
                  step={0.5}
                  error={fieldErrors['thresholds.low']}
                  disabled={!editable}
                  onChange={(v) => update((next) => (next.thresholds.low = v))}
                />
                <ThresholdControl
                  label="MEDIUM 門檻"
                  description="達到此熱指數即進入「需要注意」。"
                  value={draft.thresholds.medium}
                  min={20}
                  max={45}
                  step={0.5}
                  error={fieldErrors['thresholds.medium']}
                  disabled={!editable}
                  onChange={(v) => update((next) => (next.thresholds.medium = v))}
                  highlight
                />
                <ThresholdControl
                  label="HIGH 門檻"
                  description="達到此熱指數即進入「高風險」，並啟動完整應變。"
                  value={draft.thresholds.high}
                  min={25}
                  max={55}
                  step={0.5}
                  error={fieldErrors['thresholds.high']}
                  disabled={!editable}
                  onChange={(v) => update((next) => (next.thresholds.high = v))}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">綜合分數升級</CardTitle>
              <CardDescription>
                綜合風險分數可以「提高」等級，但永遠不會降低它。這確保了明顯的生理異常不會因為室溫只是偏暖就被忽略。
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4 rounded-lg bg-muted p-3">
                <div>
                  <Label htmlFor="escalation-enabled">啟用分數升級機制</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    關閉後，風險等級將只由熱指數決定。
                  </p>
                </div>
                <Switch
                  id="escalation-enabled"
                  checked={draft.scoreEscalation.enabled}
                  disabled={!editable}
                  onCheckedChange={(v) => update((next) => (next.scoreEscalation.enabled = v))}
                />
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <ThresholdControl
                  label="升至 MEDIUM 的分數"
                  description="綜合分數達到此值時，至少視為「需要注意」。"
                  value={draft.scoreEscalation.mediumScore}
                  min={0}
                  max={100}
                  step={1}
                  unit=" 分"
                  error={fieldErrors['scoreEscalation.mediumScore']}
                  disabled={!editable || !draft.scoreEscalation.enabled}
                  onChange={(v) => update((next) => (next.scoreEscalation.mediumScore = v))}
                />
                <ThresholdControl
                  label="升至 HIGH 的分數"
                  description="綜合分數達到此值時，直接視為「高風險」。"
                  value={draft.scoreEscalation.highScore}
                  min={0}
                  max={100}
                  step={1}
                  unit=" 分"
                  error={fieldErrors['scoreEscalation.highScore']}
                  disabled={!editable || !draft.scoreEscalation.enabled}
                  onChange={(v) => update((next) => (next.scoreEscalation.highScore = v))}
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* --------------------------- Weights ---------------------------- */}
        <TabsContent value="weights">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">風險因子權重</CardTitle>
              <CardDescription>
                綜合分數由五項因子加權組成。權重不必剛好加總為 1，引擎會自動正規化——重要的是彼此之間的比例。
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {(Object.keys(FACTOR_LABELS) as RiskFactorKey[]).map((key) => {
                const weight = draft.weights[key];
                const share = weightTotal > 0 ? (weight / weightTotal) * 100 : 0;

                return (
                  <div key={key} className="space-y-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <Label htmlFor={`weight-${key}`} className="text-sm">
                        {FACTOR_LABELS[key].zh}
                      </Label>
                      <span className="tabular text-xs text-muted-foreground">
                        權重 {weight.toFixed(2)} · 實際占比{' '}
                        <strong className="font-semibold text-foreground">
                          {share.toFixed(0)}%
                        </strong>
                      </span>
                    </div>

                    <Slider
                      id={`weight-${key}`}
                      min={0}
                      max={1}
                      step={0.01}
                      value={[weight]}
                      disabled={!editable}
                      onValueChange={([v]) => update((next) => (next.weights[key] = v))}
                    />

                    <p className="text-xs text-muted-foreground">{FACTOR_LABELS[key].hint}</p>
                  </div>
                );
              })}

              <Separator />

              <div className="flex items-center justify-between rounded-lg bg-muted p-3 text-sm">
                <span className="text-muted-foreground">權重總和</span>
                <span className="tabular font-semibold">{weightTotal.toFixed(2)}</span>
              </div>

              {weightTotal === 0 && (
                <p className="flex items-start gap-2 rounded-lg bg-risk-high-bg p-3 text-xs text-risk-high">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  所有權重皆為 0 時，綜合分數將永遠是 0，風險等級會完全由熱指數決定。
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------ Physiology & env ---------------------- */}
        <TabsContent value="physiology" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">生理偏離範圍</CardTitle>
              <CardDescription>
                以「高於個人平常基準的百分比」計算生理風險，而非固定的心率門檻。
              </CardDescription>
            </CardHeader>

            <CardContent className="grid gap-5 md:grid-cols-2">
              <ThresholdControl
                label="視為雜訊的下限"
                description="偏離低於此百分比時，生理風險計為 0。"
                value={draft.physiology.minDeviationPct}
                min={0}
                max={50}
                step={1}
                unit="%"
                error={fieldErrors['physiology.minDeviationPct']}
                disabled={!editable}
                onChange={(v) => update((next) => (next.physiology.minDeviationPct = v))}
              />
              <ThresholdControl
                label="達到滿分的上限"
                description="偏離達到此百分比時，生理風險計為 100。"
                value={draft.physiology.maxDeviationPct}
                min={5}
                max={100}
                step={1}
                unit="%"
                error={fieldErrors['physiology.maxDeviationPct']}
                disabled={!editable}
                onChange={(v) => update((next) => (next.physiology.maxDeviationPct = v))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">環境參數</CardTitle>
              <CardDescription>影響通風與熱浪兩項因子的判讀方式。</CardDescription>
            </CardHeader>

            <CardContent className="grid gap-5 md:grid-cols-3">
              <ThresholdControl
                label="濕度關注門檻"
                description="超過此濕度後，排汗散熱效率明顯下降。"
                value={draft.environment.humidityConcernPct}
                min={30}
                max={95}
                step={1}
                unit="%"
                icon={Wind}
                disabled={!editable}
                onChange={(v) => update((next) => (next.environment.humidityConcernPct = v))}
              />
              <ThresholdControl
                label="通風溫差門檻"
                description="室內比室外低於此溫差時，視為未提供有效降溫。"
                value={draft.environment.ventilationDeltaC}
                min={0}
                max={10}
                step={0.5}
                disabled={!editable}
                onChange={(v) => update((next) => (next.environment.ventilationDeltaC = v))}
              />
              <ThresholdControl
                label="熱浪天數門檻"
                description="連續高溫達到此天數時，熱浪風險計為滿分。"
                value={draft.environment.heatwaveDayThreshold}
                min={1}
                max={14}
                step={1}
                unit=" 天"
                disabled={!editable}
                onChange={(v) => update((next) => (next.environment.heatwaveDayThreshold = v))}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* -------------------------- Monitoring -------------------------- */}
        <TabsContent value="monitoring">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">監測頻率</CardTitle>
              <CardDescription>
                風險越高，感測讀取間隔越短，以更快察覺變化。此設定會直接顯示在長者端的「提高監測頻率」說明中。
              </CardDescription>
            </CardHeader>

            <CardContent className="grid gap-5 md:grid-cols-3">
              {LEVEL_OPTIONS.map((level) => (
                <div key={level} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <RiskBadge level={level} size="sm" />
                    <span className="tabular text-xs text-muted-foreground">
                      每 {draft.monitoringIntervalSec[level]} 秒
                    </span>
                  </div>
                  <Slider
                    min={5}
                    max={600}
                    step={5}
                    value={[draft.monitoringIntervalSec[level]]}
                    disabled={!editable}
                    onValueChange={([v]) =>
                      update((next) => (next.monitoringIntervalSec[level] = v))
                    }
                    aria-label={`${RISK_STYLES[level].labelZh}監測間隔`}
                  />
                  {fieldErrors[`monitoringIntervalSec.${level}`] && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      {fieldErrors[`monitoringIntervalSec.${level}`]}
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- Policy ---------------------------- */}
        <TabsContent value="policy" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">智慧家庭政策</CardTitle>
              <CardDescription>
                平台層級的自動降溫政策。長者本人的授權是另一道獨立條件，兩者都必須成立才會自動啟動設備。
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="flex items-start justify-between gap-4 rounded-lg bg-muted p-3">
                <div>
                  <Label htmlFor="auto-cooling">允許自動降溫</Label>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    關閉後，平台將不再為任何長者自動啟動冷氣或除濕機。長者端會顯示降溫動作「未執行」，並說明原因為平台政策停用。
                  </p>
                </div>
                <Switch
                  id="auto-cooling"
                  checked={draft.smartHomePolicy.allowAutomaticCooling}
                  disabled={!editable}
                  onCheckedChange={(v) =>
                    update((next) => (next.smartHomePolicy.allowAutomaticCooling = v))
                  }
                />
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="min-cooling-level">自動降溫的最低風險等級</Label>
                  <Select
                    value={draft.smartHomePolicy.minLevelForCooling}
                    disabled={!editable || !draft.smartHomePolicy.allowAutomaticCooling}
                    onValueChange={(v) =>
                      update((next) => (next.smartHomePolicy.minLevelForCooling = v as RiskLevel))
                    }
                  >
                    <SelectTrigger id="min-cooling-level">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVEL_OPTIONS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {RISK_STYLES[level].labelZh}（{level}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    風險未達此等級時，系統不會主動開啟降溫設備。
                  </p>
                </div>

                <ThresholdControl
                  label="冷氣目標溫度"
                  description="自動降溫時設定的室內目標溫度。"
                  value={draft.smartHomePolicy.targetIndoorTempC}
                  min={16}
                  max={30}
                  step={0.5}
                  disabled={!editable || !draft.smartHomePolicy.allowAutomaticCooling}
                  error={fieldErrors['smartHomePolicy.targetIndoorTempC']}
                  onChange={(v) => update((next) => (next.smartHomePolicy.targetIndoorTempC = v))}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bell className="size-4" />
                通知政策
              </CardTitle>
              <CardDescription>
                決定何時通知照護者。照護者個人的通知偏好與勿擾時段會在此之上再套用一次。
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="min-notify-level">通知照護者的最低風險等級</Label>
                <Select
                  value={draft.notificationPolicy.minLevelForCaregiver}
                  disabled={!editable}
                  onValueChange={(v) =>
                    update((next) => (next.notificationPolicy.minLevelForCaregiver = v as RiskLevel))
                  }
                >
                  <SelectTrigger id="min-notify-level" className="max-w-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVEL_OPTIONS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {RISK_STYLES[level].labelZh}（{level}）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <ThresholdControl
                  label="重複通知冷卻時間"
                  description="同一風險等級在此時間內不會重複發送通知。"
                  value={draft.notificationPolicy.cooldownMinutes}
                  min={0}
                  max={120}
                  step={1}
                  unit=" 分鐘"
                  disabled={!editable}
                  onChange={(v) => update((next) => (next.notificationPolicy.cooldownMinutes = v))}
                />
                <ThresholdControl
                  label="未回應升級時間"
                  description="高風險警示超過此時間未被確認時升級處理。"
                  value={draft.notificationPolicy.escalateAfterMinutes}
                  min={1}
                  max={120}
                  step={1}
                  unit=" 分鐘"
                  disabled={!editable}
                  onChange={(v) =>
                    update((next) => (next.notificationPolicy.escalateAfterMinutes = v))
                  }
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            這些設定是平台中唯一的風險門檻來源。使用者介面不會自行內建任何門檻值，一律讀取此處的設定，因此在這裡的每一項變更都會真實改變系統行為。所有變更都會記錄在
            <strong className="font-medium text-foreground"> 操作紀錄 </strong>
            中，包含變更前後的數值。
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------- Reset dialog -------------------------- */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>還原為預設值？</DialogTitle>
            <DialogDescription>
              所有風險門檻、權重與政策將回到提案的建議設定（LOW 27°C、MEDIUM 32°C、HIGH
              39°C）。此操作會立即套用到所有長者，並記錄於操作紀錄。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={reset} loading={saving}>
              確認還原
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A slider plus a numeric input, kept in sync, with inline error. */
function ThresholdControl({
  label,
  description,
  value,
  min,
  max,
  step,
  unit = '°C',
  error,
  disabled,
  highlight,
  icon: Icon,
  onChange,
}: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  error?: string;
  disabled?: boolean;
  highlight?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  onChange: (value: number) => void;
}) {
  const id = React.useId();

  return (
    <div className={cn('space-y-2 rounded-lg p-3', highlight && 'bg-primary-muted/50')}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="flex items-center gap-1.5">
          {Icon && <Icon className="size-3.5 text-muted-foreground" />}
          {label}
        </Label>
        <div className="flex items-baseline gap-1">
          <Input
            id={id}
            type="number"
            className="h-8 w-20 text-right"
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next)) onChange(next);
            }}
          />
          <span className="text-xs text-muted-foreground">{unit}</span>
        </div>
      </div>

      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        onValueChange={([v]) => onChange(v)}
        aria-label={label}
      />

      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : (
        description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

/**
 * Visual representation of the three bands.
 *
 * Widths are derived from the draft values, so dragging a threshold visibly
 * resizes the band it controls.
 */
function ThresholdBands({ config }: { config: RiskRuleConfig }) {
  const { low, medium, high } = config.thresholds;

  // Plot across a window with a little headroom either side.
  const windowMin = Math.max(0, low - 6);
  const windowMax = high + 8;
  const span = Math.max(1, windowMax - windowMin);
  const pct = (value: number) => ((value - windowMin) / span) * 100;

  const bands: { level: RiskLevel; from: number; to: number }[] = [
    { level: 'LOW', from: windowMin, to: medium },
    { level: 'MEDIUM', from: medium, to: high },
    { level: 'HIGH', from: high, to: windowMax },
  ];

  return (
    <div>
      <div className="flex h-10 w-full overflow-hidden rounded-lg border border-border">
        {bands.map((band) => {
          const width = Math.max(0, pct(band.to) - pct(band.from));
          return (
            <div
              key={band.level}
              className={cn(
                'flex items-center justify-center text-xs font-semibold transition-[width] duration-300',
                RISK_STYLES[band.level].bg,
                RISK_STYLES[band.level].text,
              )}
              style={{ width: `${width}%` }}
            >
              {width > 12 && RISK_STYLES[band.level].labelZh}
            </div>
          );
        })}
      </div>

      <div className="relative mt-1 h-5 text-[11px] text-muted-foreground">
        <span className="absolute left-0">{windowMin.toFixed(0)}°C</span>
        <span
          className="tabular absolute -translate-x-1/2 font-medium text-risk-medium"
          style={{ left: `${pct(medium)}%` }}
        >
          {medium}°C
        </span>
        <span
          className="tabular absolute -translate-x-1/2 font-medium text-risk-high"
          style={{ left: `${pct(high)}%` }}
        >
          {high}°C
        </span>
        <span className="absolute right-0">{windowMax.toFixed(0)}°C</span>
      </div>
    </div>
  );
}

/** Strip fields the update schema does not accept. */
function toPayload(config: RiskRuleConfig) {
  return {
    thresholds: config.thresholds,
    weights: config.weights,
    scoreEscalation: config.scoreEscalation,
    monitoringIntervalSec: config.monitoringIntervalSec,
    physiology: config.physiology,
    environment: config.environment,
    smartHomePolicy: config.smartHomePolicy,
    notificationPolicy: config.notificationPolicy,
  };
}
