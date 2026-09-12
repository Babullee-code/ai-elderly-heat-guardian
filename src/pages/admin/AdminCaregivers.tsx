/**
 * /admin/caregivers — 照護者管理
 *
 * The roster of people the platform escalates to. This page is a control
 * layer rather than a directory: deactivating a caregiver or removing an
 * assignment changes what the risk engine is able to do for a resident, and
 * the page says so before the admin commits to it.
 *
 * All risk levels shown here are computed on the server and arrive with the
 * caregiver row; nothing on this page re-derives a level or a threshold.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  BellOff,
  BellRing,
  Inbox,
  Link2,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  UserMinus,
  UserRoundPlus,
  Users,
  UserX,
} from 'lucide-react';

import type {
  CaregiverRelationship,
  NotificationChannel,
  RiskLevel,
} from '@shared/types/domain';
import { RISK_LABEL_ZH } from '@shared/types/domain';
import { api, ApiError, type CaregiverRow, type UserRow } from '@/lib/api';
import { CHANNEL_ZH, RELATIONSHIP_ZH, cn, formatDateTime } from '@/lib/utils';
import { useSession } from '@/store/session';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, RiskBadge, StatusIndicator } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const RELATIONSHIP_OPTIONS: CaregiverRelationship[] = [
  'SON',
  'DAUGHTER',
  'SPOUSE',
  'NURSE',
  'SOCIAL_WORKER',
  'NEIGHBOUR',
  'OTHER',
];

const CHANNEL_OPTIONS: NotificationChannel[] = ['PUSH', 'SMS', 'EMAIL', 'IN_APP', 'VOICE_CALL'];

const LEVEL_OPTIONS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

interface CaregiverFormState {
  name: string;
  nameEn: string;
  relationship: CaregiverRelationship;
  phone: string;
  email: string;
  assignedUserIds: string[];
  channels: NotificationChannel[];
  minLevel: RiskLevel;
  quietEnabled: boolean;
  quietFrom: string;
  quietTo: string;
  emergencyPermission: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

const BLANK_FORM: CaregiverFormState = {
  name: '',
  nameEn: '',
  relationship: 'DAUGHTER',
  phone: '',
  email: '',
  assignedUserIds: [],
  channels: ['PUSH', 'SMS'],
  minLevel: 'MEDIUM',
  quietEnabled: false,
  quietFrom: '22:00',
  quietTo: '07:00',
  emergencyPermission: false,
  status: 'ACTIVE',
};

function toForm(row: CaregiverRow): CaregiverFormState {
  return {
    name: row.name,
    nameEn: row.nameEn,
    relationship: row.relationship,
    phone: row.phone,
    email: row.email,
    assignedUserIds: [...row.assignedUserIds],
    channels: [...row.notificationPreferences.channels],
    minLevel: row.notificationPreferences.minLevel,
    quietEnabled: row.notificationPreferences.quietHours.enabled,
    quietFrom: row.notificationPreferences.quietHours.from,
    quietTo: row.notificationPreferences.quietHours.to,
    emergencyPermission: row.emergencyPermission,
    status: row.status,
  };
}

function toPayload(form: CaregiverFormState) {
  return {
    name: form.name.trim(),
    nameEn: form.nameEn.trim(),
    relationship: form.relationship,
    phone: form.phone.trim(),
    email: form.email.trim(),
    assignedUserIds: form.assignedUserIds,
    notificationPreferences: {
      channels: form.channels,
      minLevel: form.minLevel,
      quietHours: {
        enabled: form.quietEnabled,
        from: form.quietFrom,
        to: form.quietTo,
      },
    },
    emergencyPermission: form.emergencyPermission,
    status: form.status,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminCaregivers() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const writable = can('caregiver:write');

  const [rows, setRows] = React.useState<CaregiverRow[]>([]);
  const [residents, setResidents] = React.useState<UserRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const [statusFilter, setStatusFilter] = React.useState('ALL');
  const [relationshipFilter, setRelationshipFilter] = React.useState('ALL');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CaregiverRow | null>(null);
  const [assigning, setAssigning] = React.useState<CaregiverRow | null>(null);
  const [toggling, setToggling] = React.useState<CaregiverRow | null>(null);

  const [busy, setBusy] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const [caregiverResult, userResult] = await Promise.all([
        api.listCaregivers(),
        api.listUsers(),
      ]);
      setRows(caregiverResult.caregivers);
      setResidents(userResult.users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Keep the dialogs looking at the freshest server copy of their record.
  const editingRow = editing ? (rows.find((r) => r.id === editing.id) ?? editing) : null;
  const assigningRow = assigning ? (rows.find((r) => r.id === assigning.id) ?? assigning) : null;
  const togglingRow = toggling ? (rows.find((r) => r.id === toggling.id) ?? toggling) : null;

  /**
   * Residents with no ACTIVE caregiver.
   *
   * This is the figure that matters operationally: for these residents the
   * policy engine reports NOTIFY_CAREGIVER as blocked with
   * 「此使用者目前沒有指派的照護者。」 — the alert has nowhere to go.
   */
  const uncovered = React.useMemo(
    () => residents.filter((u) => !u.caregivers.some((c) => c.status === 'ACTIVE')),
    [residents],
  );

  const activeCount = rows.filter((r) => r.status === 'ACTIVE').length;
  const coveredResidentIds = React.useMemo(() => {
    const set = new Set<string>();
    rows.filter((r) => r.status === 'ACTIVE').forEach((r) => r.assignedUserIds.forEach((id) => set.add(id)));
    return set;
  }, [rows]);
  const highNow = rows.reduce((sum, r) => sum + r.riskCounts.HIGH, 0);

  const filtered = React.useMemo(
    () =>
      rows.filter((row) => {
        if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
        if (relationshipFilter !== 'ALL' && row.relationship !== relationshipFilter) return false;
        return true;
      }),
    [rows, statusFilter, relationshipFilter],
  );

  // -- mutations ------------------------------------------------------------

  const handleCreate = async (form: CaregiverFormState) => {
    setBusy(true);
    setFieldErrors({});
    try {
      const { caregiver } = await api.createCaregiver(toPayload(form));
      toast.success(
        '已新增照護者',
        `${caregiver.name} 已加入名單，負責 ${caregiver.assignedUserIds.length} 位長者。`,
      );
      setCreateOpen(false);
      await load(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('無法新增照護者', err.displayMessage);
      } else {
        toast.error('無法新增照護者', '請稍後再試。');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (form: CaregiverFormState) => {
    if (!editingRow) return;
    setBusy(true);
    setFieldErrors({});
    try {
      const { caregiver } = await api.updateCaregiver(editingRow.id, toPayload(form));
      toast.success('已更新照護者資料', `${caregiver.name} 的通知設定與指派已套用。`);
      setEditing(null);
      await load(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('無法更新照護者', err.displayMessage);
      } else {
        toast.error('無法更新照護者', '請稍後再試。');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleToggleStatus = async () => {
    if (!togglingRow) return;
    setBusy(true);
    try {
      const { caregiver } = await api.toggleCaregiverStatus(togglingRow.id);
      if (caregiver.status === 'INACTIVE') {
        toast.warning(
          `已停用 ${caregiver.name}`,
          '停用期間這位照護者不會收到任何通知；若長者已無其他啟用中的照護者，系統會將「通知照護者」標示為未執行。',
        );
      } else {
        toast.success(`已恢復 ${caregiver.name}`, '這位照護者將重新依通知設定接收警示。');
      }
      setToggling(null);
      await load(true);
    } catch (err) {
      toast.error('無法變更狀態', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const handleAssign = async (caregiverId: string, userId: string, userName: string) => {
    setBusy(true);
    try {
      await api.assignCaregiver(caregiverId, userId);
      toast.success('已指派長者', `${userName} 的警示將送達這位照護者。`);
      await load(true);
    } catch (err) {
      toast.error('無法指派', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const handleUnassign = async (
    caregiverId: string,
    userId: string,
    userName: string,
    wasLastActive: boolean,
  ) => {
    setBusy(true);
    try {
      await api.unassignCaregiver(caregiverId, userId);
      if (wasLastActive) {
        toast.warning(
          `已移除 ${userName} 的指派`,
          '這位長者目前沒有啟用中的照護者，平台會將「通知照護者」標示為未執行，並說明原因。',
        );
      } else {
        toast.success(`已移除 ${userName} 的指派`, '其他照護者仍會繼續收到這位長者的警示。');
      }
      await load(true);
    } catch (err) {
      toast.error('無法移除指派', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  // -- columns --------------------------------------------------------------

  const columns: Column<CaregiverRow>[] = [
    {
      key: 'name',
      header: '照護者',
      primary: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-muted text-xs font-semibold text-primary">
              {row.name.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{row.name}</p>
              <p className="truncate text-xs text-muted-foreground">{row.nameEn}</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'relationship',
      header: '關係',
      sortValue: (row) => RELATIONSHIP_ZH[row.relationship] ?? row.relationship,
      cell: (row) => <Badge variant="secondary">{RELATIONSHIP_ZH[row.relationship] ?? row.relationship}</Badge>,
    },
    {
      key: 'contact',
      header: '聯絡方式',
      hideOnMobile: true,
      cell: (row) => (
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p className="tabular flex items-center gap-1.5">
            <Phone className="size-3 shrink-0" aria-hidden />
            {row.phone}
          </p>
          <p className="flex items-center gap-1.5">
            <Mail className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{row.email}</span>
          </p>
        </div>
      ),
    },
    {
      key: 'residents',
      header: '負責長者',
      sortValue: (row) => row.assignedUsers.length,
      cell: (row) =>
        row.assignedUsers.length === 0 ? (
          <span className="text-xs text-muted-foreground">尚未指派</span>
        ) : (
          <div className="space-y-1">
            <p className="tabular text-xs text-muted-foreground">{row.assignedUsers.length} 位</p>
            <ul className="flex flex-wrap gap-1.5">
              {row.assignedUsers.map((user) => (
                <li key={user.id} className="flex items-center gap-1">
                  <Link
                    to={`/admin/users/${user.id}`}
                    className="rounded text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {user.name}
                  </Link>
                  <RiskBadge level={user.level} size="sm" />
                </li>
              ))}
            </ul>
          </div>
        ),
    },
    {
      key: 'riskCounts',
      header: '目前風險',
      align: 'right',
      sortValue: (row) => row.riskCounts.HIGH * 100 + row.riskCounts.MEDIUM,
      cell: (row) => (
        <div className="flex flex-wrap justify-end gap-1">
          {row.riskCounts.HIGH > 0 && (
            <Badge variant="high" className="text-[10px]">
              高風險 {row.riskCounts.HIGH}
            </Badge>
          )}
          {row.riskCounts.MEDIUM > 0 && (
            <Badge variant="medium" className="text-[10px]">
              需注意 {row.riskCounts.MEDIUM}
            </Badge>
          )}
          {row.riskCounts.HIGH === 0 && row.riskCounts.MEDIUM === 0 && (
            <Badge variant="low" className="text-[10px]">
              全部低風險
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'notifications',
      header: '通知設定',
      hideOnMobile: true,
      cell: (row) => {
        const prefs = row.notificationPreferences;
        return (
          <div className="space-y-1">
            <p className="text-xs">
              <span className="text-muted-foreground">最低等級</span>{' '}
              <span className="font-medium">{RISK_LABEL_ZH[prefs.minLevel]}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {prefs.channels.map((c) => CHANNEL_ZH[c] ?? c).join('、')}
            </p>
            <p className="tabular text-[11px] text-muted-foreground">
              {prefs.quietHours.enabled
                ? `勿擾 ${prefs.quietHours.from}–${prefs.quietHours.to}`
                : '未設定勿擾時段'}
            </p>
          </div>
        );
      },
    },
    {
      key: 'emergency',
      header: '緊急權限',
      cell: (row) =>
        row.emergencyPermission ? (
          <Badge variant="warning" className="text-[10px]">
            <ShieldAlert className="size-3" aria-hidden />
            可啟動緊急協助
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">否</span>
        ),
    },
    {
      key: 'status',
      header: '狀態',
      sortValue: (row) => row.status,
      cell: (row) => (
        <div className="space-y-1">
          <StatusIndicator
            status={row.status === 'ACTIVE' ? 'ONLINE' : 'DISABLED'}
            label={row.status === 'ACTIVE' ? '啟用中' : '已停用'}
          />
          {row.status === 'INACTIVE' && (
            <p className="text-[11px] leading-snug text-muted-foreground">停用期間不會收到通知</p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (row) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${row.name} 的操作選單`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{row.name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setAssigning(row)}>
              <Link2 />
              管理負責長者
            </DropdownMenuItem>
            {writable && (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    setFieldErrors({});
                    setEditing(row);
                  }}
                >
                  <Pencil />
                  編輯資料
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive={row.status === 'ACTIVE'} onSelect={() => setToggling(row)}>
                  {row.status === 'ACTIVE' ? <BellOff /> : <BellRing />}
                  {row.status === 'ACTIVE' ? '停用照護者' : '恢復照護者'}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  // -- render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="照護者管理" description="正在載入照護者名單…" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="照護者管理" description="指派照護者、設定通知條件，並掌握每位長者是否有人接收警示。" />
        <EmptyState
          icon={TriangleAlert}
          title="無法載入照護者資料"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="照護者管理"
        description="指派照護者、設定通知條件，並掌握每位長者是否有人接收警示。停用或移除指派會直接改變平台在高風險時的通知行為。"
        actions={
          <>
            <Button variant="outline" onClick={() => void load(true)} loading={refreshing}>
              <RefreshCw />
              重新整理
            </Button>
            {writable && (
              <Button
                onClick={() => {
                  setFieldErrors({});
                  setCreateOpen(true);
                }}
              >
                <Plus />
                新增照護者
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="照護者總數" value={rows.length} icon={Users} tone="primary" sublabel={`啟用中 ${activeCount} 位`} />
        <StatCard
          label="已覆蓋長者"
          value={coveredResidentIds.size}
          icon={UserRoundPlus}
          tone="low"
          sublabel={`共 ${residents.length} 位長者在監測中`}
        />
        <StatCard
          label="無照護者的長者"
          value={uncovered.length}
          icon={UserX}
          tone={uncovered.length > 0 ? 'medium' : 'neutral'}
          sublabel={uncovered.length > 0 ? '這些長者的「通知照護者」會被標示為未執行' : '每位長者都有人接收警示'}
        />
        <StatCard
          label="負責中的高風險長者"
          value={highNow}
          icon={ShieldAlert}
          tone={highNow > 0 ? 'high' : 'low'}
          sublabel="由伺服器即時評估，非本頁計算"
        />
      </div>

      {uncovered.length > 0 && (
        <Card className="border-risk-medium-border bg-risk-medium-bg/40">
          <CardContent className="flex flex-wrap items-start gap-3 p-4">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-risk-medium" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-risk-medium">
                有 {uncovered.length} 位長者沒有啟用中的照護者
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                當風險升高時，平台會如實把「通知照護者」標示為未執行，原因為「此使用者目前沒有指派的照護者。」。
                請於下方任一照護者的「管理負責長者」中補上指派。
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {uncovered.map((user) => (
                  <li key={user.id}>
                    <Link
                      to={`/admin/users/${user.id}`}
                      className="rounded text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {user.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      <DataTable
        rows={filtered}
        columns={columns}
        getRowKey={(row) => row.id}
        initialSort={{ key: 'riskCounts', direction: 'desc' }}
        searchPlaceholder="搜尋姓名、電話、電子郵件或負責長者…"
        searchFields={(row) =>
          [
            row.name,
            row.nameEn,
            row.phone,
            row.email,
            RELATIONSHIP_ZH[row.relationship] ?? '',
            ...row.assignedUsers.map((u) => u.name),
          ].join(' ')
        }
        filters={[
          {
            key: 'status',
            label: '狀態',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: 'ALL', label: '所有狀態' },
              { value: 'ACTIVE', label: '啟用中' },
              { value: 'INACTIVE', label: '已停用' },
            ],
          },
          {
            key: 'relationship',
            label: '關係',
            value: relationshipFilter,
            onChange: setRelationshipFilter,
            options: [
              { value: 'ALL', label: '所有關係' },
              ...RELATIONSHIP_OPTIONS.map((r) => ({ value: r, label: RELATIONSHIP_ZH[r] ?? r })),
            ],
          },
        ]}
        emptyState={
          <EmptyState
            icon={Inbox}
            title="沒有符合條件的照護者"
            description="調整篩選條件，或新增一位照護者。"
            action={
              writable ? (
                <Button
                  onClick={() => {
                    setFieldErrors({});
                    setCreateOpen(true);
                  }}
                >
                  <Plus />
                  新增照護者
                </Button>
              ) : undefined
            }
          />
        }
      />

      {createOpen && (
        <CaregiverFormDialog
          title="新增照護者"
          description="新增後，這位照護者會依下列設定接收指派長者的風險警示。"
          submitLabel="新增照護者"
          initial={BLANK_FORM}
          residents={residents}
          busy={busy}
          fieldErrors={fieldErrors}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      )}

      {editingRow && (
        <CaregiverFormDialog
          title={`編輯 ${editingRow.name}`}
          description="調整聯絡資料、通知條件與負責長者。變更會立即套用於後續的警示派送。"
          submitLabel="儲存變更"
          initial={toForm(editingRow)}
          residents={residents}
          busy={busy}
          fieldErrors={fieldErrors}
          onClose={() => setEditing(null)}
          onSubmit={handleUpdate}
        />
      )}

      {assigningRow && (
        <AssignmentDialog
          caregiver={assigningRow}
          residents={residents}
          writable={writable}
          busy={busy}
          onClose={() => setAssigning(null)}
          onAssign={handleAssign}
          onUnassign={handleUnassign}
        />
      )}

      {togglingRow && (
        <ToggleStatusDialog
          caregiver={togglingRow}
          residents={residents}
          busy={busy}
          onClose={() => setToggling(null)}
          onConfirm={handleToggleStatus}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Labelled select — Field clones its child, which a Radix Select root cannot
// receive, so selects get their label wired to the trigger explicitly.
// ---------------------------------------------------------------------------

function SelectField({
  id,
  label,
  value,
  onValueChange,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------

function CaregiverFormDialog({
  title,
  description,
  submitLabel,
  initial,
  residents,
  busy,
  fieldErrors,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  submitLabel: string;
  initial: CaregiverFormState;
  residents: UserRow[];
  busy: boolean;
  fieldErrors: Record<string, string>;
  onClose: () => void;
  onSubmit: (form: CaregiverFormState) => void | Promise<void>;
}) {
  const [form, setForm] = React.useState<CaregiverFormState>(initial);

  const set = <K extends keyof CaregiverFormState>(key: K, value: CaregiverFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleChannel = (channel: NotificationChannel) =>
    setForm((current) => ({
      ...current,
      channels: current.channels.includes(channel)
        ? current.channels.filter((c) => c !== channel)
        : [...current.channels, channel],
    }));

  const toggleResident = (userId: string) =>
    setForm((current) => ({
      ...current,
      assignedUserIds: current.assignedUserIds.includes(userId)
        ? current.assignedUserIds.filter((id) => id !== userId)
        : [...current.assignedUserIds, userId],
    }));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void onSubmit(form);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          {fieldErrors._root && (
            <p role="alert" className="rounded-lg bg-risk-high-bg p-3 text-xs font-medium text-risk-high">
              {fieldErrors._root}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="姓名" required error={fieldErrors.name}>
              <Input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="王小美"
                autoComplete="off"
              />
            </Field>

            <Field label="英文姓名" required error={fieldErrors.nameEn}>
              <Input
                value={form.nameEn}
                onChange={(e) => set('nameEn', e.target.value)}
                placeholder="Wang Hsiao-Mei"
                autoComplete="off"
              />
            </Field>

            <SelectField
              id="caregiver-relationship"
              label="與長者的關係"
              value={form.relationship}
              onValueChange={(value) => set('relationship', value as CaregiverRelationship)}
              error={fieldErrors.relationship}
            >
              {RELATIONSHIP_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {RELATIONSHIP_ZH[option] ?? option}
                </SelectItem>
              ))}
            </SelectField>

            <SelectField
              id="caregiver-status"
              label="帳號狀態"
              value={form.status}
              onValueChange={(value) => set('status', value as 'ACTIVE' | 'INACTIVE')}
              error={fieldErrors.status}
              hint="停用的照護者不會收到任何通知。"
            >
              <SelectItem value="ACTIVE">啟用中</SelectItem>
              <SelectItem value="INACTIVE">已停用</SelectItem>
            </SelectField>

            <Field label="聯絡電話" required error={fieldErrors.phone}>
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="0912-345-678"
                autoComplete="off"
              />
            </Field>

            <Field label="電子郵件" required error={fieldErrors.email}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                placeholder="name@example.com"
                autoComplete="off"
              />
            </Field>
          </div>

          <Separator />

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">通知設定</legend>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                id="caregiver-min-level"
                label="最低通知等級"
                value={form.minLevel}
                onValueChange={(value) => set('minLevel', value as RiskLevel)}
                error={fieldErrors['notificationPreferences.minLevel']}
                hint="低於此等級的風險不會打擾這位照護者。"
              >
                {LEVEL_OPTIONS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {RISK_LABEL_ZH[level]}
                  </SelectItem>
                ))}
              </SelectField>

              <div className="space-y-1.5">
                <Label>通知管道</Label>
                <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-input bg-card p-3">
                  {CHANNEL_OPTIONS.map((channel) => {
                    const id = `channel-${channel}`;
                    return (
                      <div key={channel} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={form.channels.includes(channel)}
                          onCheckedChange={() => toggleChannel(channel)}
                        />
                        <Label htmlFor={id} className="cursor-pointer text-sm font-normal">
                          {CHANNEL_ZH[channel] ?? channel}
                        </Label>
                      </div>
                    );
                  })}
                </div>
                {fieldErrors['notificationPreferences.channels'] && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {fieldErrors['notificationPreferences.channels']}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-input p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor="quiet-hours">勿擾時段</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    勿擾時段內仍會保留高風險的緊急升級路徑。
                  </p>
                </div>
                <Switch
                  id="quiet-hours"
                  checked={form.quietEnabled}
                  onCheckedChange={(on) => set('quietEnabled', on)}
                />
              </div>

              {form.quietEnabled && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="開始" error={fieldErrors['notificationPreferences.quietHours.from']}>
                    <Input
                      type="time"
                      value={form.quietFrom}
                      onChange={(e) => set('quietFrom', e.target.value)}
                    />
                  </Field>
                  <Field label="結束" error={fieldErrors['notificationPreferences.quietHours.to']}>
                    <Input
                      type="time"
                      value={form.quietTo}
                      onChange={(e) => set('quietTo', e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border border-input p-3">
              <div className="min-w-0">
                <Label htmlFor="emergency-permission">緊急協助權限</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  允許這位照護者代為啟動緊急協助流程。
                </p>
              </div>
              <Switch
                id="emergency-permission"
                checked={form.emergencyPermission}
                onCheckedChange={(on) => set('emergencyPermission', on)}
              />
            </div>
          </fieldset>

          <Separator />

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">負責長者</legend>
            <p className="text-xs text-muted-foreground">
              已選 {form.assignedUserIds.length} 位。長者若沒有任何啟用中的照護者，平台會將「通知照護者」標示為未執行。
            </p>

            {residents.length === 0 ? (
              <p className="text-xs text-muted-foreground">目前沒有可指派的長者。</p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-input p-2">
                {residents.map((user) => {
                  const id = `assign-${user.id}`;
                  const otherActive = user.caregivers.filter((c) => c.status === 'ACTIVE').length;
                  return (
                    <li key={user.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50">
                      <Checkbox
                        id={id}
                        checked={form.assignedUserIds.includes(user.id)}
                        onCheckedChange={() => toggleResident(user.id)}
                      />
                      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer font-normal">
                        <span className="font-medium">{user.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {user.district} · {user.age} 歲 · 現有照護者 {otherActive} 位
                        </span>
                      </Label>
                      {user.assessment && <RiskBadge level={user.assessment.level} size="sm" />}
                    </li>
                  );
                })}
              </ul>
            )}
            {fieldErrors.assignedUserIds && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {fieldErrors.assignedUserIds}
              </p>
            )}
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="submit" loading={busy}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Assignment management
// ---------------------------------------------------------------------------

function AssignmentDialog({
  caregiver,
  residents,
  writable,
  busy,
  onClose,
  onAssign,
  onUnassign,
}: {
  caregiver: CaregiverRow;
  residents: UserRow[];
  writable: boolean;
  busy: boolean;
  onClose: () => void;
  onAssign: (caregiverId: string, userId: string, userName: string) => void | Promise<void>;
  onUnassign: (
    caregiverId: string,
    userId: string,
    userName: string,
    wasLastActive: boolean,
  ) => void | Promise<void>;
}) {
  const assignedIds = new Set(caregiver.assignedUserIds);
  const assigned = residents.filter((u) => assignedIds.has(u.id));
  const available = residents.filter((u) => !assignedIds.has(u.id));

  /** True when this caregiver is the resident's only ACTIVE caregiver. */
  const isLastActiveFor = (user: UserRow) =>
    caregiver.status === 'ACTIVE' &&
    user.caregivers.filter((c) => c.status === 'ACTIVE' && c.id !== caregiver.id).length === 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>管理 {caregiver.name} 的負責長者</DialogTitle>
          <DialogDescription>
            指派與移除會立刻生效。若移除後某位長者已無任何啟用中的照護者，平台會把該長者的「通知照護者」動作標示為未執行，
            並顯示原因「此使用者目前沒有指派的照護者。」 — 這是平台真實的行為，不是提示文字。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              目前負責 <span className="tabular text-muted-foreground">（{assigned.length} 位）</span>
            </h3>

            {assigned.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                這位照護者目前沒有負責任何長者，因此不會收到任何警示。
              </p>
            ) : (
              <ul className="space-y-2">
                {assigned.map((user) => {
                  const last = isLastActiveFor(user);
                  return (
                    <li
                      key={user.id}
                      className={cn(
                        'flex flex-wrap items-center gap-3 rounded-lg border p-3',
                        last ? 'border-risk-medium-border bg-risk-medium-bg/30' : 'border-border',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            to={`/admin/users/${user.id}`}
                            className="rounded font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {user.name}
                          </Link>
                          {user.assessment && <RiskBadge level={user.assessment.level} size="sm" />}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {user.district} · {user.age} 歲 · 最後更新 {formatDateTime(user.lastUpdate)}
                        </p>
                        {last && (
                          <p className="mt-1 text-xs font-medium text-risk-medium">
                            移除後這位長者將沒有任何啟用中的照護者，警示會無人接收。
                          </p>
                        )}
                      </div>

                      {writable && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void onUnassign(caregiver.id, user.id, user.name, last)}
                        >
                          <UserMinus />
                          移除指派
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <Separator />

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">
              可加入的長者 <span className="tabular text-muted-foreground">（{available.length} 位）</span>
            </h3>

            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground">所有長者都已指派給這位照護者。</p>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {available.map((user) => {
                  const activeCovers = user.caregivers.filter((c) => c.status === 'ACTIVE').length;
                  return (
                    <li
                      key={user.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{user.name}</span>
                          {user.assessment && <RiskBadge level={user.assessment.level} size="sm" />}
                          {activeCovers === 0 && (
                            <Badge variant="warning" className="text-[10px]">
                              目前無照護者
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {user.district} · {user.age} 歲 · 啟用中的照護者 {activeCovers} 位
                        </p>
                      </div>

                      {writable && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void onAssign(caregiver.id, user.id, user.name)}
                        >
                          <UserRoundPlus />
                          指派
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {!writable && (
            <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              您的角色可以檢視指派關係，但沒有變更權限。
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            關閉
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Deactivate / reactivate
// ---------------------------------------------------------------------------

function ToggleStatusDialog({
  caregiver,
  residents,
  busy,
  onClose,
  onConfirm,
}: {
  caregiver: CaregiverRow;
  residents: UserRow[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const deactivating = caregiver.status === 'ACTIVE';

  // Residents who would be left with no active caregiver at all.
  const wouldBeUncovered = deactivating
    ? residents.filter(
        (user) =>
          caregiver.assignedUserIds.includes(user.id) &&
          user.caregivers.filter((c) => c.status === 'ACTIVE' && c.id !== caregiver.id).length === 0,
      )
    : [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deactivating ? `停用 ${caregiver.name}？` : `恢復 ${caregiver.name}？`}</DialogTitle>
          <DialogDescription>
            {deactivating
              ? '停用後，這位照護者不會再收到任何管道的通知。這是伺服器端實際執行的規則，不只是介面上的標記。'
              : '恢復後，這位照護者會依其通知設定重新接收指派長者的風險警示。'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            <p>
              目前負責 {caregiver.assignedUserIds.length} 位長者 · 最低通知等級{' '}
              {RISK_LABEL_ZH[caregiver.notificationPreferences.minLevel]} · 管道{' '}
              {caregiver.notificationPreferences.channels.map((c) => CHANNEL_ZH[c] ?? c).join('、')}
            </p>
          </div>

          {wouldBeUncovered.length > 0 && (
            <div className="rounded-lg border border-risk-medium-border bg-risk-medium-bg/40 p-3">
              <p className="flex items-center gap-2 text-xs font-semibold text-risk-medium">
                <TriangleAlert className="size-4 shrink-0" aria-hidden />
                以下 {wouldBeUncovered.length} 位長者將沒有任何啟用中的照護者
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {wouldBeUncovered.map((user) => (
                  <li key={user.id} className="rounded-full bg-card px-2 py-0.5 text-xs font-medium">
                    {user.name}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                他們的「通知照護者」動作會被標示為未執行，原因為「此使用者目前沒有指派的照護者。」。
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant={deactivating ? 'danger' : 'default'}
            loading={busy}
            onClick={() => void onConfirm()}
          >
            {deactivating ? <BellOff /> : <BellRing />}
            {deactivating ? '確認停用' : '確認恢復'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
