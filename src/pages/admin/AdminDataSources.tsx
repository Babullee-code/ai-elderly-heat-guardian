/**
 * 資料來源 - external and internal data feeds.
 *
 * The record counts reported by a sync are the number of rows the platform
 * actually holds for that source, not an invented figure. The prototype has
 * no outbound network dependency, and saying so is better than implying a
 * live integration that is not there.
 */

import * as React from 'react';
import {
  AlertTriangle,
  Building2,
  Cloud,
  Database,
  Heart,
  KeyRound,
  MapPin,
  RefreshCw,
  Radio,
  Settings2,
} from 'lucide-react';

import type { DataSource, DataSourceStatus } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/store/session';
import { cn, formatNumber, timeAgo } from '@/lib/utils';
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
  Skeleton,
  Switch,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, StatusIndicator } from '@/components/domain/RiskIndicators';

const KIND_META: Record<
  DataSource['kind'],
  { zh: string; icon: React.ComponentType<{ className?: string }> }
> = {
  WEATHER: { zh: '氣象資料', icon: Cloud },
  SENSOR: { zh: '感測器資料', icon: Radio },
  WEARABLE: { zh: '穿戴裝置資料', icon: Heart },
  CITY: { zh: '城市開放資料', icon: Building2 },
  COOLING_LOCATION: { zh: '涼適空間名錄', icon: MapPin },
};

const STATUS_OPTIONS: DataSourceStatus[] = ['ONLINE', 'DEGRADED', 'OFFLINE'];

interface Draft {
  id: string;
  enabled: boolean;
  status: DataSourceStatus;
  endpoint: string;
  intervalSec: number;
  retries: number;
}

export default function AdminDataSources() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const editable = can('data-source:write');

  const [sources, setSources] = React.useState<DataSource[]>([]);
  const [summary, setSummary] = React.useState({ online: 0, degraded: 0, offline: 0 });
  const [note, setNote] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.listDataSources();
      setSources(result.sources);
      setSummary(result.summary);
      setNote(result.noteZh);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入資料來源。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  /** The most recent failure reported for each source, shown on its card. */
  const [lastErrors, setLastErrors] = React.useState<Record<string, string | null>>({});

  const sync = async (source: DataSource) => {
    setBusyId(source.id);
    try {
      const result = await api.syncDataSource(source.id);

      // The weather provider answers with what actually happened, including a
      // partial fetch. Reporting that as an unqualified success would be the
      // false-success pattern this project keeps removing.
      if (result.synced === false) {
        toast.error(`${source.nameZh} 同步未完成`, result.messageZh);
        setLastErrors((prev) => ({ ...prev, [source.id]: result.health?.lastError ?? null }));
      } else {
        toast.success(`${source.nameZh} 已同步`, result.messageZh);
        setLastErrors((prev) => ({ ...prev, [source.id]: null }));
      }

      await load();
    } catch (err) {
      // 409 for a disabled source, 502 when a provider could not be reached,
      // 501 in the static build, which has no server to call from.
      const message = err instanceof ApiError ? err.displayMessage : '請稍後再試。';
      toast.error('同步未執行', message);
      setLastErrors((prev) => ({ ...prev, [source.id]: message }));
    } finally {
      setBusyId(null);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusyId(draft.id);
    setFieldErrors({});
    try {
      await api.updateDataSource(draft.id, {
        enabled: draft.enabled,
        status: draft.status,
        config: {
          endpoint: draft.endpoint,
          intervalSec: draft.intervalSec,
          retries: draft.retries,
        },
      });
      toast.success('資料來源設定已更新');
      setDraft(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('設定未儲存', err.displayMessage);
      } else {
        toast.error('設定未儲存', '請稍後再試。');
      }
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = async (source: DataSource) => {
    setBusyId(source.id);
    try {
      await api.updateDataSource(source.id, { enabled: !source.enabled });
      toast.success(
        source.enabled ? `已停用 ${source.nameZh}` : `已啟用 ${source.nameZh}`,
        source.enabled ? '停用後無法執行同步。' : undefined,
      );
      await load();
    } catch (err) {
      toast.error('操作失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="資料來源" description="載入中…" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="資料來源" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入資料來源"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="資料來源"
        description="平台使用的各項資料饋送與其同步狀態。"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="正常" value={summary.online} icon={Database} tone="low" />
        <StatCard
          label="降級"
          value={summary.degraded}
          icon={AlertTriangle}
          tone={summary.degraded > 0 ? 'medium' : 'neutral'}
          sublabel="仍在運作但錯誤率偏高"
        />
        <StatCard
          label="離線"
          value={summary.offline}
          icon={AlertTriangle}
          tone={summary.offline > 0 ? 'high' : 'neutral'}
        />
      </div>

      {/* A real security property of the design, worth surfacing. */}
      <Card className="border-primary/25 bg-primary-muted/40">
        <CardContent className="flex items-start gap-3 p-4">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {note || '此設定不會儲存任何憑證，密鑰均由環境變數提供。'}
            {' '}因此即使管理後台的資料外洩，也不會連帶洩漏任何對外服務的存取權限。
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {sources.map((source) => {
          const meta = KIND_META[source.kind];
          const Icon = meta.icon;
          const busy = busyId === source.id;

          return (
            <Card key={source.id} className={cn(!source.enabled && 'opacity-70')}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-lg',
                        source.status === 'ONLINE'
                          ? 'bg-primary-muted text-primary'
                          : source.status === 'DEGRADED'
                            ? 'bg-risk-medium-bg text-risk-medium'
                            : 'bg-risk-high-bg text-risk-high',
                      )}
                    >
                      <Icon className="size-5" />
                    </span>

                    <div className="min-w-0">
                      <CardTitle className="text-base">{source.nameZh}</CardTitle>
                      <CardDescription className="mt-0.5">
                        {meta.zh} · {source.provider}
                      </CardDescription>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <StatusIndicator status={source.status} />
                        {!source.enabled && (
                          <Badge variant="muted" className="text-[10px]">
                            已停用
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  {editable && (
                    <Switch
                      checked={source.enabled}
                      disabled={busy}
                      onCheckedChange={() => void toggleEnabled(source)}
                      aria-label={`${source.enabled ? '停用' : '啟用'} ${source.nameZh}`}
                    />
                  )}
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">最後同步</dt>
                    <dd className="mt-0.5">{timeAgo(source.lastSyncAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">資料筆數</dt>
                    <dd className="tabular mt-0.5">{formatNumber(source.recordCount)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">錯誤率</dt>
                    <dd
                      className={cn(
                        'tabular mt-0.5',
                        source.errorRatePct > 5 && 'font-medium text-risk-medium',
                      )}
                    >
                      {source.errorRatePct}%
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">同步間隔</dt>
                    <dd className="tabular mt-0.5">{source.config.intervalSec} 秒</dd>
                  </div>
                </dl>

                <p className="truncate rounded bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {source.config.endpoint}
                </p>

                {/*
                  The last error, verbatim. An operator deciding whether to act
                  needs the cause, not a category - "ECONNREFUSED" and "429 Too
                  Many Requests" call for completely different responses.
                */}
                {lastErrors[source.id] && (
                  <p className="rounded border border-risk-medium-border bg-risk-medium-bg/40 px-2 py-1.5 text-[11px] text-risk-medium">
                    最後一次錯誤：{lastErrors[source.id]}
                  </p>
                )}

                {editable && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void sync(source)}
                      loading={busy}
                      disabled={!source.enabled}
                    >
                      <RefreshCw />
                      立即同步
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDraft({
                          id: source.id,
                          enabled: source.enabled,
                          status: source.status,
                          endpoint: source.config.endpoint,
                          intervalSec: source.config.intervalSec,
                          retries: source.config.retries,
                        });
                        setFieldErrors({});
                      }}
                    >
                      <Settings2 />
                      設定
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            本原型沒有對外網路連線，因此「立即同步」回報的筆數是平台本機實際持有的資料量，而不是虛構的數字。正式部署時，這些設定會指向真實的中央氣象署、資料大平台與裝置閘道端點。
          </p>
        </CardContent>
      </Card>

      {/* ----------------------------- Config ------------------------------ */}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>資料來源設定</DialogTitle>
            <DialogDescription>
              調整同步端點與頻率。此處不會儲存任何憑證。
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <Field
                label="同步端點"
                required
                hint="必須是 http 或 https 開頭的網址"
                error={fieldErrors['config.endpoint']}
              >
                <Input
                  value={draft.endpoint}
                  onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
                  placeholder="https://opendata.cwa.gov.tw/api"
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="同步間隔（秒）"
                  required
                  error={fieldErrors['config.intervalSec']}
                >
                  <Input
                    type="number"
                    min={5}
                    max={86400}
                    value={draft.intervalSec}
                    onChange={(e) => setDraft({ ...draft, intervalSec: Number(e.target.value) })}
                  />
                </Field>

                <Field label="重試次數" required error={fieldErrors['config.retries']}>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={draft.retries}
                    onChange={(e) => setDraft({ ...draft, retries: Number(e.target.value) })}
                  />
                </Field>
              </div>

              <Field label="狀態">
                <Select
                  value={draft.status}
                  onValueChange={(v) => setDraft({ ...draft, status: v as DataSourceStatus })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status === 'ONLINE' ? '正常' : status === 'DEGRADED' ? '降級' : '離線'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
                <Label htmlFor="source-enabled">啟用此資料來源</Label>
                <Switch
                  id="source-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button onClick={save} loading={Boolean(busyId)}>
              儲存設定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
