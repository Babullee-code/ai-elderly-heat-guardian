/**
 * 操作紀錄 - the administrative evidence trail.
 *
 * Every configuration change the platform accepts is recorded here with its
 * before and after values. Threshold changes are written field by field, so a
 * single save produces entries like "Changed MEDIUM threshold, 32C to 33C"
 * rather than one opaque blob.
 *
 * Read-only by design. An audit log an administrator can edit is not an audit
 * log.
 */

import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Building2,
  Cpu,
  FileClock,
  FileText,
  Database,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  User,
  Users,
  Workflow,
} from 'lucide-react';

import type { AuditLogEntry, Role } from '@shared/types/domain';
import { ROLE_LABELS } from '@shared/domain/permissions';
import { api, ApiError } from '@/lib/api';
import { cn, formatDateTime, formatTime, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';

const ENTITY_META: Record<
  string,
  { zh: string; icon: React.ComponentType<{ className?: string }> }
> = {
  RiskRuleConfig: { zh: '風險規則', icon: SlidersHorizontal },
  ActionRule: { zh: '行動政策', icon: Workflow },
  ElderlyUser: { zh: '長者', icon: User },
  Caregiver: { zh: '照護者', icon: Users },
  CaregiverAssignment: { zh: '照護指派', icon: Users },
  Device: { zh: '裝置', icon: Cpu },
  CoolingSpace: { zh: '涼適空間', icon: Building2 },
  NotificationTemplate: { zh: '通知範本', icon: Bell },
  Notification: { zh: '通知', icon: Bell },
  ContentArticle: { zh: '衛教內容', icon: FileText },
  DataSource: { zh: '資料來源', icon: Database },
  SystemSetting: { zh: '系統設定', icon: Settings2 },
  Alert: { zh: '警示', icon: AlertTriangle },
  CityRisk: { zh: '城市熱風險', icon: Building2 },
  SmartHome: { zh: '智慧家庭', icon: Cpu },
  Simulation: { zh: '模擬', icon: Workflow },
  System: { zh: '系統', icon: ShieldCheck },
};

const ROLE_TONE: Record<Role, string> = {
  SUPER_ADMIN: 'bg-primary-muted text-primary',
  ADMIN: 'bg-primary-muted text-primary',
  CAREGIVER: 'bg-risk-low-bg text-risk-low',
  ELDER: 'bg-muted text-muted-foreground',
  VIEWER: 'bg-muted text-muted-foreground',
};

export default function AdminAuditLog() {
  const [entries, setEntries] = React.useState<AuditLogEntry[]>([]);
  const [entities, setEntities] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [entityFilter, setEntityFilter] = React.useState('ALL');

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.auditLog();
      setEntries(result.entries);
      setEntities(result.entities);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入操作紀錄。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Poll gently: the log grows whenever anyone changes anything.
  React.useEffect(() => {
    const timer = setInterval(() => {
      api
        .auditLog()
        .then((result) => {
          setEntries(result.entries);
          setEntities(result.entities);
        })
        .catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  const filtered = React.useMemo(
    () => (entityFilter === 'ALL' ? entries : entries.filter((e) => e.entity === entityFilter)),
    [entries, entityFilter],
  );

  const todayCount = React.useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return entries.filter((e) => new Date(e.at) >= start).length;
  }, [entries]);

  const configChanges = entries.filter(
    (e) => e.entity === 'RiskRuleConfig' || e.entity === 'ActionRule',
  ).length;

  const columns: Column<AuditLogEntry>[] = [
    {
      key: 'time',
      header: '時間',
      primary: true,
      sortValue: (row) => new Date(row.at).getTime(),
      cell: (row) => (
        <div className="min-w-0">
          <p className="tabular text-sm font-medium">{formatTime(row.at)}</p>
          <p className="text-[11px] text-muted-foreground">{timeAgo(row.at)}</p>
        </div>
      ),
    },
    {
      key: 'actor',
      header: '操作者',
      sortValue: (row) => row.actorName,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
              ROLE_TONE[row.actorRole] ?? 'bg-muted text-muted-foreground',
            )}
          >
            {row.actorName.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm">{row.actorName}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {ROLE_LABELS[row.actorRole]?.labelZh ?? row.actorRole}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'action',
      header: '操作',
      sortValue: (row) => row.actionZh,
      cell: (row) => (
        <div className="min-w-0">
          <p className="text-sm font-medium">{row.actionZh}</p>
          <p className="truncate text-[11px] text-muted-foreground">{row.action}</p>
        </div>
      ),
    },
    {
      key: 'entity',
      header: '對象',
      sortValue: (row) => row.entity,
      cell: (row) => {
        const meta = ENTITY_META[row.entity];
        const Icon = meta?.icon ?? FileClock;
        return (
          <div className="min-w-0">
            <Badge variant="secondary" className="text-[10px]">
              <Icon className="size-3" />
              {meta?.zh ?? row.entity}
            </Badge>
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
              {row.entityId}
            </p>
          </div>
        );
      },
    },
    {
      key: 'change',
      header: '變更內容',
      cell: (row) => {
        // A before/after pair is the whole point of the log; render it as one.
        if (row.oldValue && row.newValue) {
          return (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <span className="max-w-[16rem] truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground line-through decoration-1">
                {row.oldValue}
              </span>
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
              <span className="max-w-[16rem] truncate rounded bg-primary-muted px-1.5 py-0.5 font-medium text-primary">
                {row.newValue}
              </span>
            </div>
          );
        }

        if (row.newValue) {
          return (
            <span className="block max-w-[20rem] truncate rounded bg-primary-muted px-1.5 py-0.5 text-xs text-primary">
              {row.newValue}
            </span>
          );
        }

        return <span className="text-xs text-muted-foreground">—</span>;
      },
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="操作紀錄" description="載入中…" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="操作紀錄" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入操作紀錄"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="操作紀錄"
        description="所有管理操作的完整紀錄，包含操作者、時間、對象與變更前後的數值。此頁面為唯讀。"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="紀錄總數" value={entries.length} icon={FileClock} tone="primary" />
        <StatCard label="今日操作" value={todayCount} icon={ShieldCheck} tone="neutral" />
        <StatCard
          label="設定與政策變更"
          value={configChanges}
          icon={SlidersHorizontal}
          tone={configChanges > 0 ? 'medium' : 'neutral'}
          sublabel="影響風險判讀的變更"
        />
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={FileClock}
          title="尚無操作紀錄"
          description="當管理者變更設定、裝置或內容時，紀錄會出現在這裡。"
        />
      ) : (
        <DataTable
          rows={filtered}
          columns={columns}
          getRowKey={(row) => row.id}
          searchPlaceholder="搜尋操作、操作者或對象…"
          searchFields={(row) =>
            `${row.actionZh} ${row.action} ${row.actorName} ${row.entity} ${row.entityId} ${row.oldValue ?? ''} ${row.newValue ?? ''}`
          }
          initialSort={{ key: 'time', direction: 'desc' }}
          filters={[
            {
              key: 'entity',
              label: '對象類型',
              value: entityFilter,
              onChange: setEntityFilter,
              options: [
                { value: 'ALL', label: '全部類型' },
                ...entities.map((entity) => ({
                  value: entity,
                  label: ENTITY_META[entity]?.zh ?? entity,
                })),
              ],
            },
          ]}
          emptyState={
            <EmptyState
              icon={FileClock}
              title="沒有符合條件的紀錄"
              description="請調整搜尋或篩選條件。"
            />
          }
        />
      )}

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            風險門檻的變更會逐欄位記錄，因此一次儲存可能產生多筆紀錄，例如「變更 MEDIUM 門檻：32C → 33C」。這讓事後可以精確追溯是哪一項設定、在什麼時候、由誰調整。此紀錄無法從介面編輯或刪除。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
