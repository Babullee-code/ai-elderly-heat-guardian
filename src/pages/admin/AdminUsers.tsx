/**
 * 長者管理 - the resident roster.
 *
 * The roster itself is fetched once; every risk number in the table is read
 * from the live socket store, so the table re-ranks itself as a scenario
 * plays without any polling. Sorting defaults to highest risk first because
 * that is the only ordering that matters when someone opens this screen
 * during an incident.
 */

import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Inbox,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Smartphone,
  UserPlus,
  Users,
} from 'lucide-react';

import type { RiskAssessment, RiskLevel, UserStatus } from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';
import { elderlyUserCreateSchema } from '@shared/schemas';
import { api, ApiError, type UserRow } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { useToast } from '@/components/Toast';
import { cn, formatTemp, initials, RELATIONSHIP_ZH, timeAgo } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
import { PageHeader } from '@/components/domain/Cards';
import { EmptyState, RiskBadge, StatusIndicator } from '@/components/domain/RiskIndicators';
import { DataTable, type Column, type FilterOption } from '@/components/domain/DataTable';

interface LiveUserRow extends UserRow {
  live: RiskAssessment | null;
}

const STATUS_ZH: Record<UserStatus, string> = {
  ACTIVE: '監測中',
  SUSPENDED: '已暫停',
  INACTIVE: '未啟用',
};

const STATUS_VARIANT: Record<UserStatus, 'success' | 'warning' | 'muted'> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  INACTIVE: 'muted',
};

const RISK_FILTER_LABEL: Record<RiskLevel, string> = {
  HIGH: '高風險',
  MEDIUM: '需要注意',
  LOW: '低風險',
};

export default function AdminUsers() {
  const navigate = useNavigate();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const assessments = useLiveStore((s) => s.assessments);

  const [users, setUsers] = React.useState<UserRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const [levelFilter, setLevelFilter] = React.useState('ALL');
  const [statusFilter, setStatusFilter] = React.useState('ALL');
  const [districtFilter, setDistrictFilter] = React.useState('ALL');

  const load = React.useCallback(async () => {
    try {
      const result = await api.listUsers();
      setUsers(result.users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入長者名冊，請稍後再試。');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // --- merge roster with the live wire ------------------------------------

  const rows = React.useMemo<LiveUserRow[]>(
    () => (users ?? []).map((user) => ({ ...user, live: assessments[user.id] ?? user.assessment })),
    [users, assessments],
  );

  const districts = React.useMemo(
    () => Array.from(new Set(rows.map((r) => r.district))).sort((a, b) => a.localeCompare(b, 'zh-TW')),
    [rows],
  );

  const visible = React.useMemo(
    () =>
      rows.filter((row) => {
        if (levelFilter !== 'ALL' && (row.live?.level ?? 'LOW') !== levelFilter) return false;
        if (statusFilter !== 'ALL' && row.status !== statusFilter) return false;
        if (districtFilter !== 'ALL' && row.district !== districtFilter) return false;
        return true;
      }),
    [rows, levelFilter, statusFilter, districtFilter],
  );

  const counts = React.useMemo(() => {
    const summary = {
      total: rows.length,
      active: 0,
      suspended: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    for (const row of rows) {
      if (row.status === 'ACTIVE') summary.active += 1;
      if (row.status === 'SUSPENDED') summary.suspended += 1;
      summary[row.live?.level ?? 'LOW'] += 1;
    }
    return summary;
  }, [rows]);

  // --- mutations ----------------------------------------------------------

  const toggleSuspend = async (row: LiveUserRow) => {
    setBusyId(row.id);
    try {
      const result = await api.suspendUser(row.id);
      await load();
      toast.success(
        result.user.status === 'SUSPENDED' ? '已暫停監測' : '已恢復監測',
        result.user.status === 'SUSPENDED'
          ? `${row.name} 的風險評估與通知已停止，資料仍會保留。`
          : `${row.name} 已重新納入即時監測。`,
      );
    } catch (err) {
      toast.error(
        '無法變更狀態',
        err instanceof ApiError ? err.displayMessage : '請稍後再試。',
      );
    } finally {
      setBusyId(null);
    }
  };

  // --- table --------------------------------------------------------------

  const filters: FilterOption[] = [
    {
      key: 'level',
      label: '風險等級',
      value: levelFilter,
      onChange: setLevelFilter,
      options: [
        { value: 'ALL', label: '所有風險等級' },
        { value: 'HIGH', label: RISK_FILTER_LABEL.HIGH },
        { value: 'MEDIUM', label: RISK_FILTER_LABEL.MEDIUM },
        { value: 'LOW', label: RISK_FILTER_LABEL.LOW },
      ],
    },
    {
      key: 'status',
      label: '帳號狀態',
      value: statusFilter,
      onChange: setStatusFilter,
      options: [
        { value: 'ALL', label: '所有狀態' },
        { value: 'ACTIVE', label: STATUS_ZH.ACTIVE },
        { value: 'SUSPENDED', label: STATUS_ZH.SUSPENDED },
        { value: 'INACTIVE', label: STATUS_ZH.INACTIVE },
      ],
    },
    {
      key: 'district',
      label: '行政區',
      value: districtFilter,
      onChange: setDistrictFilter,
      options: [
        { value: 'ALL', label: '所有行政區' },
        ...districts.map((d) => ({ value: d, label: d })),
      ],
    },
  ];

  const columns: Column<LiveUserRow>[] = [
    {
      key: 'name',
      header: '長者',
      primary: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-muted text-sm font-semibold text-primary">
            {initials(row.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{row.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {row.age} 歲 · {genderZh(row.gender)} · {row.nameEn}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'district',
      header: '行政區',
      sortValue: (row) => row.district,
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm">{row.district}</p>
          <p className="truncate text-xs text-muted-foreground">{row.city}</p>
        </div>
      ),
    },
    {
      key: 'risk',
      header: '風險等級',
      sortValue: (row) => RISK_ORDER[row.live?.level ?? 'LOW'] * 1000 + (row.live?.score ?? 0),
      cell: (row) =>
        row.live ? (
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge level={row.live.level} size="sm" />
            <span className="tabular text-xs text-muted-foreground">{row.live.score} 分</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">尚無評估</span>
        ),
    },
    {
      key: 'heatIndex',
      header: '熱指數',
      align: 'right',
      sortValue: (row) => row.live?.heatIndex ?? -1,
      cell: (row) => (
        <span className="tabular text-sm">{row.live ? formatTemp(row.live.heatIndex) : '--'}</span>
      ),
    },
    {
      key: 'heartRate',
      header: '心率 / 基準偏離',
      hideOnMobile: true,
      sortValue: (row) => row.live?.baseline.deviationPct ?? -1,
      cell: (row) =>
        row.live ? (
          <div className="min-w-0">
            <p className="tabular text-sm">{row.live.baseline.heartRateBpm} BPM</p>
            <p
              className={cn(
                'tabular text-xs',
                row.live.baseline.aboveBaseline
                  ? 'font-medium text-risk-medium'
                  : 'text-muted-foreground',
              )}
            >
              {row.live.baseline.aboveBaseline
                ? `高於平常 ${row.live.baseline.deviationPct}%`
                : `平常 ${row.live.baseline.range.min}–${row.live.baseline.range.max}`}
            </p>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">--</span>
        ),
    },
    {
      key: 'devices',
      header: '裝置',
      hideOnMobile: true,
      sortValue: (row) => (row.deviceCount === 0 ? -1 : row.devicesOnline / row.deviceCount),
      cell: (row) =>
        row.deviceCount === 0 ? (
          <span className="text-xs text-muted-foreground">未安裝裝置</span>
        ) : (
          <div className="min-w-0">
            <StatusIndicator
              status={
                row.deviceStatus === 'ALL_ONLINE'
                  ? 'ONLINE'
                  : row.deviceStatus === 'ALL_OFFLINE'
                    ? 'OFFLINE'
                    : 'DEGRADED'
              }
              label={`${row.devicesOnline} / ${row.deviceCount} 台連線`}
            />
          </div>
        ),
    },
    {
      key: 'caregivers',
      header: '照護者',
      hideOnMobile: true,
      sortValue: (row) => row.caregivers.length,
      cell: (row) =>
        row.caregivers.length === 0 ? (
          <span className="text-xs text-muted-foreground">尚未指派</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.caregivers.map((caregiver) => (
              <Badge
                key={caregiver.id}
                variant={caregiver.status === 'ACTIVE' ? 'secondary' : 'muted'}
                className="text-[10px]"
              >
                {caregiver.name}
                <span className="opacity-70">
                  · {RELATIONSHIP_ZH[caregiver.relationship] ?? caregiver.relationship}
                </span>
              </Badge>
            ))}
          </div>
        ),
    },
    {
      key: 'lastUpdate',
      header: '最後更新',
      hideOnMobile: true,
      sortValue: (row) => new Date(row.live?.timestamp ?? row.lastUpdate ?? 0).getTime(),
      cell: (row) => (
        <span className="text-xs text-muted-foreground">
          {timeAgo(row.live?.timestamp ?? row.lastUpdate)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '狀態',
      sortValue: (row) => row.status,
      cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_ZH[row.status]}</Badge>,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (row) => (
        <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${row.name} 的操作選單`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>{row.name}</DropdownMenuLabel>
              <DropdownMenuSeparator />

              <DropdownMenuItem onSelect={() => navigate(`/admin/users/${row.id}`)}>
                <ChevronRight />
                檢視詳細資料
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => navigate(`/admin/users/${row.id}?tab=devices`)}
              >
                <Smartphone />
                裝置與感測器
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => navigate(`/admin/users/${row.id}?tab=events`)}
              >
                <Activity />
                風險事件歷程
              </DropdownMenuItem>

              {can('user:suspend') && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    destructive={row.status !== 'SUSPENDED'}
                    disabled={busyId === row.id}
                    onSelect={() => void toggleSuspend(row)}
                  >
                    {row.status === 'SUSPENDED' ? <PlayCircle /> : <PauseCircle />}
                    {row.status === 'SUSPENDED' ? '恢復監測' : '暫停監測'}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  // --- render -------------------------------------------------------------

  return (
    <div className="space-y-6">
      <PageHeader
        title="長者管理"
        description="平台上所有受監測的長者。風險等級、熱指數與心率偏離皆為伺服器推送的即時值，預設由風險最高者排序。"
        actions={
          <>
            <Button variant="outline" onClick={() => void refresh()} loading={refreshing}>
              <RotateCcw />
              重新載入
            </Button>
            {can('user:write') && (
              <Button onClick={() => setCreateOpen(true)}>
                <UserPlus />
                新增長者
              </Button>
            )}
          </>
        }
      />

      {/* --------------------------- Stat chips ---------------------------- */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
          <Chip icon={Users} label="總人數" value={counts.total} />
          <Separator orientation="vertical" className="hidden h-8 sm:block" />
          <Chip label="高風險" value={counts.HIGH} tone="high" />
          <Chip label="需要注意" value={counts.MEDIUM} tone="medium" />
          <Chip label="低風險" value={counts.LOW} tone="low" />
          <Separator orientation="vertical" className="hidden h-8 sm:block" />
          <Chip label="監測中" value={counts.active} />
          <Chip label="已暫停" value={counts.suspended} tone={counts.suspended > 0 ? 'medium' : undefined} />
        </CardContent>
      </Card>

      {/* ----------------------------- Table ------------------------------- */}
      {error ? (
        <EmptyState
          icon={AlertTriangle}
          title="無法載入長者名冊"
          description={error}
          action={
            <Button variant="outline" onClick={() => void load()}>
              重試
            </Button>
          }
        />
      ) : !users ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : (
        <DataTable
          rows={visible}
          columns={columns}
          getRowKey={(row) => row.id}
          searchPlaceholder="搜尋姓名、行政區或編號…"
          searchFields={(row) => `${row.name} ${row.nameEn} ${row.district} ${row.city} ${row.id}`}
          filters={filters}
          initialSort={{ key: 'risk', direction: 'desc' }}
          onRowClick={(row) => navigate(`/admin/users/${row.id}`)}
          emptyState={
            <EmptyState
              icon={Inbox}
              title="沒有符合條件的長者"
              description="調整篩選條件，或新增一位長者開始監測。"
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setLevelFilter('ALL');
                    setStatusFilter('ALL');
                    setDistrictFilter('ALL');
                  }}
                >
                  清除篩選
                </Button>
              }
            />
          }
        />
      )}

      {can('user:write') && (
        <CreateUserDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={async (name) => {
            await load();
            toast.success('已新增長者', `${name} 已加入監測名冊，系統會開始學習其個人生理基準。`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header chip
// ---------------------------------------------------------------------------

function Chip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  tone?: 'low' | 'medium' | 'high';
}) {
  const toneClass = tone
    ? { low: 'text-risk-low', medium: 'text-risk-medium', high: 'text-risk-high' }[tone]
    : 'text-foreground';

  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className="size-4 text-muted-foreground" />}
      <span className={cn('tabular text-xl font-bold leading-none', toneClass)}>{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function genderZh(gender: 'M' | 'F' | 'OTHER'): string {
  return gender === 'M' ? '男性' : gender === 'F' ? '女性' : '其他';
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

interface CreateFormState {
  name: string;
  nameEn: string;
  age: string;
  gender: 'M' | 'F' | 'OTHER';
  city: string;
  district: string;
  lat: string;
  lng: string;
  phone: string;
  address: string;
  conditions: string;
  medications: string;
  status: UserStatus;
  elderlyModeDefault: boolean;
  permissions: {
    automaticCooling: boolean;
    caregiverNotifications: boolean;
    locationSharing: boolean;
    physiologicalDataStorage: boolean;
    cityDataContribution: boolean;
  };
  emergencyContact: { name: string; relationship: string; phone: string };
}

/** Taipei defaults, so a demo record can be created in a few keystrokes. */
const BLANK_FORM: CreateFormState = {
  name: '',
  nameEn: '',
  age: '76',
  gender: 'F',
  city: '台北市',
  district: '大安區',
  lat: '25.0264',
  lng: '121.5435',
  phone: '02-2700-1234',
  address: '台北市大安區信義路四段 1 號',
  conditions: '高血壓',
  medications: '利尿劑',
  status: 'ACTIVE',
  elderlyModeDefault: true,
  permissions: {
    automaticCooling: true,
    caregiverNotifications: true,
    locationSharing: true,
    physiologicalDataStorage: true,
    cityDataContribution: true,
  },
  emergencyContact: { name: '', relationship: '女兒', phone: '0912-345-678' },
};

const PERMISSION_FIELDS: {
  key: keyof CreateFormState['permissions'];
  label: string;
  hint: string;
}[] = [
  {
    key: 'automaticCooling',
    label: '自動降溫',
    hint: '授權平台在風險升高時自動開啟冷氣或電風扇。',
  },
  {
    key: 'caregiverNotifications',
    label: '通知照護者',
    hint: '授權在風險達到門檻時通知指派的照護者。',
  },
  {
    key: 'locationSharing',
    label: '分享概略位置',
    hint: '用於推薦附近的涼適空間。',
  },
  {
    key: 'physiologicalDataStorage',
    label: '儲存生理資料',
    hint: '未授權時無法學習個人心率基準。',
  },
  {
    key: 'cityDataContribution',
    label: '貢獻城市統計',
    hint: '以匿名方式納入城市熱風險統計。',
  },
];

function CreateUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState<CreateFormState>(BLANK_FORM);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(BLANK_FORM);
      setErrors({});
    }
  }, [open]);

  const set = <K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const splitList = (value: string) =>
      value
        .split(/[,，、]/)
        .map((item) => item.trim())
        .filter(Boolean);

    const payload = {
      name: form.name,
      nameEn: form.nameEn,
      age: Number(form.age),
      gender: form.gender,
      city: form.city,
      district: form.district,
      lat: Number(form.lat),
      lng: Number(form.lng),
      phone: form.phone,
      address: form.address,
      conditions: splitList(form.conditions),
      medications: splitList(form.medications),
      status: form.status,
      elderlyModeDefault: form.elderlyModeDefault,
      permissions: form.permissions,
      emergencyContact: form.emergencyContact,
    };

    // The same schema the server validates against, so the inline errors a
    // user sees here are exactly the ones the API would return.
    const parsed = elderlyUserCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      toast.warning('部分欄位需要修正', '請檢查標示紅字的欄位後再送出。');
      return;
    }

    setSubmitting(true);
    try {
      const result = await api.createUser(parsed.data);
      onOpenChange(false);
      await onCreated(result.user.name);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        toast.error('新增失敗', err.displayMessage);
      } else {
        toast.error('新增失敗', '請稍後再試。');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>新增長者</DialogTitle>
          <DialogDescription>
            建立後，系統會以預設的生理基準開始學習，並在累積足夠樣本後自動收斂為個人化基準。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5">
          {errors._root && (
            <p role="alert" className="rounded-lg bg-risk-high-bg p-3 text-sm text-risk-high">
              {errors._root}
            </p>
          )}

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">基本資料</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="姓名" required error={errors.name}>
                <Input
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="陳美玉"
                  autoFocus
                />
              </Field>
              <Field label="英文姓名" required error={errors.nameEn}>
                <Input
                  value={form.nameEn}
                  onChange={(e) => set('nameEn', e.target.value)}
                  placeholder="Chen Mei-Yu"
                />
              </Field>
              <Field label="年齡" required error={errors.age} hint="50 至 120 歲">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={form.age}
                  onChange={(e) => set('age', e.target.value)}
                />
              </Field>

              <div className="space-y-1.5">
                <Label htmlFor="create-gender">性別</Label>
                <Select
                  value={form.gender}
                  onValueChange={(value) => set('gender', value as CreateFormState['gender'])}
                >
                  <SelectTrigger id="create-gender" aria-label="性別">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="F">女性</SelectItem>
                    <SelectItem value="M">男性</SelectItem>
                    <SelectItem value="OTHER">其他</SelectItem>
                  </SelectContent>
                </Select>
                {errors.gender && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {errors.gender}
                  </p>
                )}
              </div>

              <Field label="聯絡電話" required error={errors.phone}>
                <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>

              <div className="space-y-1.5">
                <Label htmlFor="create-status">帳號狀態</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) => set('status', value as UserStatus)}
                >
                  <SelectTrigger id="create-status" aria-label="帳號狀態">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">{STATUS_ZH.ACTIVE}</SelectItem>
                    <SelectItem value="INACTIVE">{STATUS_ZH.INACTIVE}</SelectItem>
                    <SelectItem value="SUSPENDED">{STATUS_ZH.SUSPENDED}</SelectItem>
                  </SelectContent>
                </Select>
                {errors.status && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {errors.status}
                  </p>
                )}
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">居住地與座標</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="縣市" required error={errors.city}>
                <Input value={form.city} onChange={(e) => set('city', e.target.value)} />
              </Field>
              <Field label="行政區" required error={errors.district}>
                <Input value={form.district} onChange={(e) => set('district', e.target.value)} />
              </Field>
              <Field label="地址" required error={errors.address} className="sm:col-span-2">
                <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
              </Field>
              <Field label="緯度" required error={errors.lat} hint="用於熱風險地圖定位">
                <Input value={form.lat} onChange={(e) => set('lat', e.target.value)} />
              </Field>
              <Field label="經度" required error={errors.lng} hint="用於推薦附近涼適空間">
                <Input value={form.lng} onChange={(e) => set('lng', e.target.value)} />
              </Field>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">健康背景</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="慢性病"
                error={errors.conditions ?? errors['conditions.0']}
                hint="以逗號分隔，例如：高血壓, 糖尿病"
              >
                <Input
                  value={form.conditions}
                  onChange={(e) => set('conditions', e.target.value)}
                  placeholder="高血壓, 糖尿病"
                />
              </Field>
              <Field
                label="用藥"
                error={errors.medications ?? errors['medications.0']}
                hint="影響體溫調節的藥物，以逗號分隔"
              >
                <Input
                  value={form.medications}
                  onChange={(e) => set('medications', e.target.value)}
                  placeholder="利尿劑, 乙型阻斷劑"
                />
              </Field>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">緊急聯絡人</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="姓名" required error={errors['emergencyContact.name']}>
                <Input
                  value={form.emergencyContact.name}
                  onChange={(e) =>
                    set('emergencyContact', { ...form.emergencyContact, name: e.target.value })
                  }
                  placeholder="陳怡君"
                />
              </Field>
              <Field label="關係" required error={errors['emergencyContact.relationship']}>
                <Input
                  value={form.emergencyContact.relationship}
                  onChange={(e) =>
                    set('emergencyContact', {
                      ...form.emergencyContact,
                      relationship: e.target.value,
                    })
                  }
                />
              </Field>
              <Field label="電話" required error={errors['emergencyContact.phone']}>
                <Input
                  value={form.emergencyContact.phone}
                  onChange={(e) =>
                    set('emergencyContact', { ...form.emergencyContact, phone: e.target.value })
                  }
                />
              </Field>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">授權設定</h3>
            <p className="text-xs text-muted-foreground">
              未取得授權的項目，平台會在風險升高時明確說明「因未授權而未執行」，而不是靜默略過。
            </p>

            <ul className="space-y-1">
              {PERMISSION_FIELDS.map((permission) => (
                <li key={permission.key} className="flex items-start gap-3 py-1.5">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor={`perm-${permission.key}`} className="text-sm">
                      {permission.label}
                    </Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">{permission.hint}</p>
                  </div>
                  <Switch
                    id={`perm-${permission.key}`}
                    checked={form.permissions[permission.key]}
                    onCheckedChange={(checked) =>
                      set('permissions', { ...form.permissions, [permission.key]: checked })
                    }
                  />
                </li>
              ))}

              <li className="flex items-start gap-3 border-t border-border pt-3">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="perm-elder-mode" className="text-sm">
                    預設使用長者友善介面
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    以較大的字級與簡化的操作呈現使用者端畫面。
                  </p>
                </div>
                <Switch
                  id="perm-elder-mode"
                  checked={form.elderlyModeDefault}
                  onCheckedChange={(checked) => set('elderlyModeDefault', checked)}
                />
              </li>
            </ul>
          </section>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={submitting}>
              新增長者
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
