/**
 * 行動政策 - the policy engine and its rule builder.
 *
 * Rules are evaluated on the server by `evaluateActionRules`. This page shows
 * which rules are firing right now and for whom, so the policy list reads as
 * live behaviour rather than a declaration.
 *
 * The "would fire for N residents" figure in the builder is computed with the
 * SAME functions the server uses (`evaluateRule` / `buildRuleContext`),
 * imported from the shared domain rather than reimplemented. Reimplementing
 * the semantics here would let the preview disagree with reality.
 */

import * as React from 'react';
import {
  Activity,
  AirVent,
  AlertTriangle,
  Armchair,
  Bell,
  Droplet,
  Info,
  Layers,
  Lock,
  MapPin,
  PhoneCall,
  Plus,
  Shield,
  Sun,
  Thermometer,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';

import type {
  ActionRule,
  ActionType,
  RiskLevel,
  RuleCondition,
  RuleField,
  RuleOperator,
} from '@shared/types/domain';
import { ACTION_CATALOGUE, buildRuleContext, evaluateRule } from '@shared/domain/actionEngine';
import { api, ApiError } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { cn, RISK_STYLES } from '@/lib/utils';
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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Skeleton,
  Switch,
  Textarea,
} from '@/components/ui';
import { PageHeader } from '@/components/domain/Cards';
import { EmptyState, RiskBadge } from '@/components/domain/RiskIndicators';

// ---------------------------------------------------------------------------
// Display maps
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<RuleField, { zh: string; unit: string; numeric: boolean }> = {
  riskLevel: { zh: '風險等級', unit: '', numeric: false },
  riskScore: { zh: '綜合風險分數', unit: '分', numeric: true },
  heatIndex: { zh: '熱指數', unit: '°C', numeric: true },
  indoorTemp: { zh: '室內溫度', unit: '°C', numeric: true },
  humidity: { zh: '室內濕度', unit: '%', numeric: true },
  heartRateDeviation: { zh: '心率偏離基準', unit: '%', numeric: true },
  activityLevel: { zh: '活動量', unit: '步/小時', numeric: true },
};

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  is: '等於',
  isNot: '不等於',
  gte: '大於或等於',
  lte: '小於或等於',
  gt: '大於',
  lt: '小於',
};

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

const ALL_ACTIONS = Object.keys(ACTION_CATALOGUE) as ActionType[];
const ALL_FIELDS = Object.keys(FIELD_LABELS) as RuleField[];
const LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

interface DraftRule {
  id?: string;
  name: string;
  nameZh: string;
  description: string;
  enabled: boolean;
  priority: number;
  conditions: RuleCondition[];
  actions: ActionType[];
  builtIn: boolean;
}

const EMPTY_DRAFT: DraftRule = {
  name: '',
  nameZh: '',
  description: '',
  enabled: true,
  priority: 50,
  conditions: [{ field: 'riskLevel', operator: 'gte', value: 'MEDIUM' }],
  actions: ['NOTIFY_CAREGIVER'],
  builtIn: false,
};

// ---------------------------------------------------------------------------

export default function AdminActionRules() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const assessments = useLiveStore((s) => s.assessments);

  const editable = can('action-rule:write');

  const [rules, setRules] = React.useState<ActionRule[]>([]);
  const [firing, setFiring] = React.useState<Record<string, string[]>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const [draft, setDraft] = React.useState<DraftRule | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<ActionRule | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.listActionRules();
      setRules(result.rules);
      setFiring(result.firing);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入行動政策。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Refresh the firing map as live assessments change, so the list stays
  // honest without the admin needing to reload.
  React.useEffect(() => {
    const timer = setInterval(() => {
      api
        .listActionRules()
        .then((result) => setFiring(result.firing))
        .catch(() => undefined);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

  const toggleEnabled = async (rule: ActionRule) => {
    setBusyId(rule.id);
    try {
      await api.updateActionRule(rule.id, { enabled: !rule.enabled });
      toast.success(
        rule.enabled ? `已停用「${rule.nameZh}」` : `已啟用「${rule.nameZh}」`,
        rule.enabled
          ? '此規則產生的動作將不再套用於任何長者。'
          : '此規則會在下一個更新週期開始生效。',
      );
      await load();
    } catch (err) {
      toast.error('無法更新規則', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusyId(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setFieldErrors({});

    const payload = {
      name: draft.name,
      nameZh: draft.nameZh,
      description: draft.description,
      enabled: draft.enabled,
      priority: draft.priority,
      conditions: draft.conditions,
      actions: draft.actions,
    };

    try {
      if (draft.id) {
        await api.updateActionRule(draft.id, payload);
        toast.success('規則已更新', '新的條件會在下一個更新週期套用。');
      } else {
        await api.createActionRule(payload);
        toast.success('規則已建立', '新的政策已加入，並會與內建規則一起評估。');
      }
      setDraft(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('規則未儲存', err.displayMessage);
      } else {
        toast.error('規則未儲存', '請稍後再試。');
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await api.deleteActionRule(deleteTarget.id);
      toast.success('規則已刪除');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      // Built-in rules are protected server-side; report that clearly.
      toast.error(
        '無法刪除規則',
        err instanceof ApiError ? err.displayMessage : '請稍後再試。',
      );
      setDeleteTarget(null);
    } finally {
      setSaving(false);
    }
  };

  /**
   * How many monitored residents the draft would currently fire for.
   * Uses the shared evaluator, so it cannot drift from server behaviour.
   */
  const draftMatches = React.useMemo(() => {
    if (!draft || draft.conditions.length === 0) return [];

    const candidate: ActionRule = {
      id: draft.id ?? 'draft',
      name: draft.name,
      nameZh: draft.nameZh,
      description: draft.description,
      enabled: true,
      builtIn: false,
      priority: draft.priority,
      conditions: draft.conditions,
      actions: draft.actions,
      updatedAt: new Date().toISOString(),
    };

    return Object.values(assessments)
      .filter((assessment) => evaluateRule(candidate, buildRuleContext(assessment)))
      .map((assessment) => assessment.userId);
  }, [draft, assessments]);

  // ---------------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="行動政策" description="載入中…" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="行動政策" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入行動政策"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  return (
    <div className="space-y-6">
      <PageHeader
        title="行動政策"
        description="決定在什麼情況下要採取什麼行動。政策引擎會在每次風險評估後執行，並與提案的累進式動作模型合併。"
        actions={
          editable && (
            <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>
              <Plus />
              新增規則
            </Button>
          )
        }
      />

      {/* -------------------------- Cumulative model ------------------------ */}
      <Card className="border-primary/25 bg-primary-muted/40">
        <CardContent className="flex items-start gap-3 p-4">
          <Layers className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">動作是累進的</p>
            <p className="leading-relaxed text-muted-foreground">
              低風險的動作在中度與高風險時同樣適用；中度風險的動作在高風險時同樣適用。下方的規則會在這個基礎之上再加入額外動作，兩者取聯集。
            </p>
            <p className="leading-relaxed text-muted-foreground">
              動作產生後仍會經過可行性檢查：例如自動降溫需要平台政策允許、長者已授權、且設備在線，任何一項不成立時，該動作會標示為「未執行」並說明原因，而不是默默略過。
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------ Rules ------------------------------- */}
      <div className="space-y-3">
        {sorted.map((rule) => {
          const firingFor = firing[rule.id] ?? [];

          return (
            <Card key={rule.id} className={cn(!rule.enabled && 'opacity-60')}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{rule.nameZh}</CardTitle>

                      {rule.builtIn && (
                        <Badge variant="secondary" className="text-[10px]">
                          <Shield className="size-3" />
                          內建
                        </Badge>
                      )}

                      <Badge variant="muted" className="text-[10px]">
                        優先序 {rule.priority}
                      </Badge>

                      {rule.enabled ? (
                        firingFor.length > 0 ? (
                          <Badge variant="warning" className="text-[10px]">
                            <Activity className="size-3" />
                            正在套用於 {firingFor.length} 位長者
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            目前未觸發
                          </Badge>
                        )
                      ) : (
                        <Badge variant="muted" className="text-[10px]">
                          已停用
                        </Badge>
                      )}
                    </div>

                    <CardDescription className="mt-1">{rule.description}</CardDescription>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {editable && (
                      <>
                        <Switch
                          checked={rule.enabled}
                          disabled={busyId === rule.id}
                          onCheckedChange={() => void toggleEnabled(rule)}
                          aria-label={`${rule.enabled ? '停用' : '啟用'}規則 ${rule.nameZh}`}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setDraft({
                              id: rule.id,
                              name: rule.name,
                              nameZh: rule.nameZh,
                              description: rule.description,
                              enabled: rule.enabled,
                              priority: rule.priority,
                              conditions: rule.conditions.map((c) => ({ ...c })),
                              actions: [...rule.actions],
                              builtIn: rule.builtIn,
                            })
                          }
                        >
                          編輯
                        </Button>
                        {rule.builtIn ? (
                          <Button size="sm" variant="ghost" disabled title="內建規則無法刪除">
                            <Lock />
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleteTarget(rule)}
                            aria-label={`刪除規則 ${rule.nameZh}`}
                          >
                            <Trash2 />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <RuleLogic conditions={rule.conditions} actions={rule.actions} />

                {firingFor.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                    <span className="text-xs text-muted-foreground">目前符合條件：</span>
                    {firingFor.slice(0, 8).map((name) => (
                      <Badge key={name} variant="outline" className="text-[10px]">
                        {name}
                      </Badge>
                    ))}
                    {firingFor.length > 8 && (
                      <span className="text-xs text-muted-foreground">
                        等 {firingFor.length} 位
                      </span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* --------------------------- Rule builder --------------------------- */}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Workflow className="size-5 text-primary" />
              {draft?.id ? '編輯規則' : '新增規則'}
            </DialogTitle>
            <DialogDescription>
              以「如果…就…」的方式定義政策。所有條件都必須成立，規則才會觸發。
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="規則名稱（中文）" required error={fieldErrors.nameZh}>
                  <Input
                    value={draft.nameZh}
                    onChange={(e) => setDraft({ ...draft, nameZh: e.target.value })}
                    placeholder="例如：高濕度除濕輔助"
                  />
                </Field>
                <Field label="規則名稱（英文）" required error={fieldErrors.name}>
                  <Input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="e.g. High humidity cooling assist"
                  />
                </Field>
              </div>

              <Field label="說明" error={fieldErrors.description}>
                <Textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="說明這條規則的用意，讓其他管理者理解為什麼需要它。"
                  rows={2}
                />
              </Field>

              <Separator />

              {/* --------------------------- IF --------------------------- */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm font-semibold">如果（IF）</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        conditions: [
                          ...draft.conditions,
                          { field: 'heatIndex', operator: 'gte', value: 32 },
                        ],
                      })
                    }
                    disabled={draft.conditions.length >= 6}
                  >
                    <Plus />
                    新增條件
                  </Button>
                </div>

                {fieldErrors.conditions && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {fieldErrors.conditions}
                  </p>
                )}

                <div className="space-y-2">
                  {draft.conditions.map((condition, index) => (
                    <div
                      key={index}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-3"
                    >
                      {index > 0 && (
                        <Badge variant="secondary" className="shrink-0 text-[10px]">
                          並且
                        </Badge>
                      )}

                      <Select
                        value={condition.field}
                        onValueChange={(value) => {
                          const field = value as RuleField;
                          const next = [...draft.conditions];
                          // Switching between a level field and a numeric one
                          // must also reset the value, or the rule becomes
                          // uncomparable and silently never fires.
                          next[index] = {
                            field,
                            operator: condition.operator,
                            value: FIELD_LABELS[field].numeric ? 30 : 'MEDIUM',
                          };
                          setDraft({ ...draft, conditions: next });
                        }}
                      >
                        <SelectTrigger className="w-auto min-w-[130px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ALL_FIELDS.map((field) => (
                            <SelectItem key={field} value={field}>
                              {FIELD_LABELS[field].zh}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select
                        value={condition.operator}
                        onValueChange={(value) => {
                          const next = [...draft.conditions];
                          next[index] = { ...condition, operator: value as RuleOperator };
                          setDraft({ ...draft, conditions: next });
                        }}
                      >
                        <SelectTrigger className="w-auto min-w-[110px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(OPERATOR_LABELS) as RuleOperator[]).map((op) => (
                            <SelectItem key={op} value={op}>
                              {OPERATOR_LABELS[op]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {FIELD_LABELS[condition.field].numeric ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            className="h-10 w-24"
                            value={Number(condition.value)}
                            onChange={(e) => {
                              const next = [...draft.conditions];
                              next[index] = { ...condition, value: Number(e.target.value) };
                              setDraft({ ...draft, conditions: next });
                            }}
                            aria-label={`${FIELD_LABELS[condition.field].zh} 數值`}
                          />
                          <span className="text-xs text-muted-foreground">
                            {FIELD_LABELS[condition.field].unit}
                          </span>
                        </div>
                      ) : (
                        <Select
                          value={String(condition.value)}
                          onValueChange={(value) => {
                            const next = [...draft.conditions];
                            next[index] = { ...condition, value };
                            setDraft({ ...draft, conditions: next });
                          }}
                        >
                          <SelectTrigger className="w-auto min-w-[120px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {LEVELS.map((level) => (
                              <SelectItem key={level} value={level}>
                                {RISK_STYLES[level].labelZh}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}

                      {draft.conditions.length > 1 && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="ml-auto"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              conditions: draft.conditions.filter((_, i) => i !== index),
                            })
                          }
                          aria-label="移除這個條件"
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Live match count, computed with the shared evaluator. */}
                <p
                  className={cn(
                    'rounded-lg p-2.5 text-xs',
                    draftMatches.length > 0
                      ? 'bg-risk-medium-bg text-risk-medium'
                      : 'bg-muted text-muted-foreground',
                  )}
                >
                  以目前所有長者的即時數據評估，這組條件會套用於{' '}
                  <strong className="font-semibold">{draftMatches.length}</strong> 位長者。
                </p>
              </div>

              <Separator />

              {/* -------------------------- THEN -------------------------- */}
              <div className="space-y-3">
                <Label className="text-sm font-semibold">就執行（THEN）</Label>

                {fieldErrors.actions && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {fieldErrors.actions}
                  </p>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  {ALL_ACTIONS.map((action) => {
                    const def = ACTION_CATALOGUE[action];
                    const Icon = ACTION_ICONS[def.icon] ?? Info;
                    const selected = draft.actions.includes(action);

                    return (
                      <button
                        key={action}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            actions: selected
                              ? draft.actions.filter((a) => a !== action)
                              : [...draft.actions, action],
                          })
                        }
                        className={cn(
                          'flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          selected
                            ? 'border-primary bg-primary-muted'
                            : 'border-border hover:bg-accent',
                        )}
                        aria-pressed={selected}
                      >
                        <span
                          className={cn(
                            'flex size-8 shrink-0 items-center justify-center rounded-lg',
                            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                          )}
                        >
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{def.titleZh}</span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {def.automatic ? '系統自動執行' : '提供給長者的建議'}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Separator />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="優先序"
                  hint="數字越小越先評估。內建規則使用 10–30。"
                  error={fieldErrors.priority}
                >
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={draft.priority}
                    onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                  />
                </Field>

                <div className="flex items-end">
                  <div className="flex w-full items-center justify-between gap-3 rounded-lg bg-muted p-3">
                    <Label htmlFor="draft-enabled">立即啟用</Label>
                    <Switch
                      id="draft-enabled"
                      checked={draft.enabled}
                      onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">規則預覽</p>
                <RuleLogic conditions={draft.conditions} actions={draft.actions} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button onClick={save} loading={saving}>
              {draft?.id ? '儲存變更' : '建立規則'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --------------------------- Delete dialog -------------------------- */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>刪除規則？</DialogTitle>
            <DialogDescription>
              「{deleteTarget?.nameZh}」將被永久移除，其產生的動作會立即停止套用。此操作會記錄於操作紀錄。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={remove} loading={saving}>
              確認刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Renders a rule as readable IF / THEN logic using human labels. */
function RuleLogic({
  conditions,
  actions,
}: {
  conditions: RuleCondition[];
  actions: ActionType[];
}) {
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
          IF
        </Badge>
        {conditions.length === 0 ? (
          <span className="text-xs text-muted-foreground">（尚未設定條件）</span>
        ) : (
          conditions.map((condition, index) => (
            <React.Fragment key={index}>
              {index > 0 && <span className="text-xs text-muted-foreground">並且</span>}
              <span className="rounded-md bg-muted px-2 py-1 text-xs">
                <span className="font-medium">{FIELD_LABELS[condition.field].zh}</span>{' '}
                {OPERATOR_LABELS[condition.operator]}{' '}
                <span className="font-semibold">
                  {FIELD_LABELS[condition.field].numeric
                    ? `${condition.value}${FIELD_LABELS[condition.field].unit}`
                    : (RISK_STYLES[condition.value as RiskLevel]?.labelZh ?? condition.value)}
                </span>
              </span>
            </React.Fragment>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="default" className="shrink-0 font-mono text-[10px]">
          THEN
        </Badge>
        {actions.length === 0 ? (
          <span className="text-xs text-muted-foreground">（尚未選擇動作）</span>
        ) : (
          actions.map((action) => {
            const def = ACTION_CATALOGUE[action];
            const Icon = ACTION_ICONS[def.icon] ?? Info;
            return (
              <span
                key={action}
                className="flex items-center gap-1 rounded-md bg-primary-muted px-2 py-1 text-xs text-primary"
              >
                <Icon className="size-3" />
                {def.titleZh}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}
