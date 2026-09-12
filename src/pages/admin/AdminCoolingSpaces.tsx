/**
 * 涼適空間 - the municipal register of places a resident can be sent to cool down.
 *
 * The important thing about this screen is that it is not a catalogue: the
 * 啟用/停用 switch is wired straight to the recommendation engine. A location
 * disabled here stops being offered to residents on the very next evaluation,
 * which is why the toggle states that consequence in plain language and
 * reports the resulting active count the server sends back.
 *
 * Create, edit and import all validate against the same Zod schema the server
 * uses, so a malformed import is explained field by field before anything is
 * sent rather than coming back as one opaque 400.
 */

import * as React from 'react';
import {
  AirVent,
  AlertTriangle,
  Accessibility,
  Building2,
  Clock,
  Download,
  Inbox,
  MapPin,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';

import type { CoolingSpace, CoolingSpaceType, RiskLevel } from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';
import { coolingSpaceCreateSchema } from '@shared/schemas/index';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/store/session';
import { cn, formatNumber, RISK_STYLES } from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
  Textarea,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, RiskBadge, StatusIndicator } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';
import { HeatMap, type MapLayers } from '@/components/domain/HeatMap';

type SpaceRow = CoolingSpace & { openNow: boolean };
type TypeLabels = Record<string, { label: string; labelZh: string; icon: string }>;

/** Only the cooling-space pins are drawn on the placement preview. */
const PLACEMENT_LAYERS: MapLayers = {
  heatRisk: false,
  urbanHeat: false,
  greenSpace: false,
  coolingSpaces: true,
  residents: false,
};

/** Taipei city hall — a sane default so a new pin lands inside the city. */
const DEFAULT_LAT = 25.045;
const DEFAULT_LNG = 121.545;

const RISK_LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

interface FormState {
  name: string;
  nameEn: string;
  type: CoolingSpaceType;
  address: string;
  district: string;
  lat: string;
  lng: string;
  riskLevel: RiskLevel;
  airConditioned: boolean;
  accessible: boolean;
  accessibilityNotes: string;
  openingHours: string;
  opensAt: string;
  closesAt: string;
  contact: string;
  capacity: string;
  status: 'ACTIVE' | 'DISABLED';
}

const EMPTY_FORM: FormState = {
  name: '',
  nameEn: '',
  type: 'LIBRARY',
  address: '',
  district: '',
  lat: String(DEFAULT_LAT),
  lng: String(DEFAULT_LNG),
  riskLevel: 'LOW',
  airConditioned: true,
  accessible: true,
  accessibilityNotes: '',
  openingHours: '09:00–17:00',
  opensAt: '09:00',
  closesAt: '17:00',
  contact: '',
  capacity: '50',
  status: 'ACTIVE',
};

function toForm(space: CoolingSpace): FormState {
  return {
    name: space.name,
    nameEn: space.nameEn,
    type: space.type,
    address: space.address,
    district: space.district,
    lat: String(space.lat),
    lng: String(space.lng),
    riskLevel: space.riskLevel,
    airConditioned: space.airConditioned,
    accessible: space.accessible,
    accessibilityNotes: space.accessibilityNotes,
    openingHours: space.openingHours,
    opensAt: space.opensAt,
    closesAt: space.closesAt,
    contact: space.contact,
    capacity: String(space.capacity),
    status: space.status,
  };
}

function toPayload(form: FormState) {
  return {
    name: form.name.trim(),
    nameEn: form.nameEn.trim(),
    type: form.type,
    address: form.address.trim(),
    district: form.district.trim(),
    lat: Number(form.lat),
    lng: Number(form.lng),
    riskLevel: form.riskLevel,
    airConditioned: form.airConditioned,
    accessible: form.accessible,
    accessibilityNotes: form.accessibilityNotes.trim(),
    openingHours: form.openingHours.trim(),
    opensAt: form.opensAt.trim(),
    closesAt: form.closesAt.trim(),
    contact: form.contact.trim(),
    capacity: Number(form.capacity),
    status: form.status,
  };
}

/** Flattens Zod issues into the `{ 'field.path': message }` shape `<Field>` reads. */
function issuesToFieldErrors(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form';
    if (!result[key]) result[key] = issue.message;
  }
  return result;
}

export default function AdminCoolingSpaces() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const canWrite = can('cooling-space:write');

  const [spaces, setSpaces] = React.useState<SpaceRow[] | null>(null);
  const [types, setTypes] = React.useState<TypeLabels>({});
  const [summary, setSummary] = React.useState<{
    active: number;
    disabled: number;
    airConditioned: number;
    accessible: number;
    openNow: number;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  // --- filters ------------------------------------------------------------
  const [typeFilter, setTypeFilter] = React.useState('ALL');
  const [districtFilter, setDistrictFilter] = React.useState('ALL');
  const [statusFilter, setStatusFilter] = React.useState('ALL');
  const [acOnly, setAcOnly] = React.useState(false);
  const [accessibleOnly, setAccessibleOnly] = React.useState(false);

  // --- dialogs ------------------------------------------------------------
  const [editing, setEditing] = React.useState<CoolingSpace | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const [deleting, setDeleting] = React.useState<CoolingSpace | null>(null);
  const [deletingBusy, setDeletingBusy] = React.useState(false);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [importErrors, setImportErrors] = React.useState<string[]>([]);
  const [importBusy, setImportBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const result = await api.listCoolingSpaces();
      setSpaces(result.spaces);
      setTypes(result.types);
      setSummary(result.summary);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入涼適空間資料。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const typeLabel = React.useCallback(
    (type: string) => types[type]?.labelZh ?? type,
    [types],
  );

  const districts = React.useMemo(
    () => [...new Set((spaces ?? []).map((s) => s.district))].sort((a, b) => a.localeCompare(b, 'zh-TW')),
    [spaces],
  );

  const rows = React.useMemo(() => {
    let result = spaces ?? [];
    if (typeFilter !== 'ALL') result = result.filter((s) => s.type === typeFilter);
    if (districtFilter !== 'ALL') result = result.filter((s) => s.district === districtFilter);
    if (statusFilter !== 'ALL') result = result.filter((s) => s.status === statusFilter);
    if (acOnly) result = result.filter((s) => s.airConditioned);
    if (accessibleOnly) result = result.filter((s) => s.accessible);
    return result;
  }, [spaces, typeFilter, districtFilter, statusFilter, acOnly, accessibleOnly]);

  // --- mutations ----------------------------------------------------------

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormOpen(true);
  };

  const openEdit = (space: CoolingSpace) => {
    setEditing(space);
    setForm(toForm(space));
    setFieldErrors({});
    setFormOpen(true);
  };

  const submitForm = async () => {
    const payload = toPayload(form);
    const parsed = coolingSpaceCreateSchema.safeParse(payload);

    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error));
      toast.error('請修正表單', '有欄位未通過驗證，已在欄位下方標示原因。');
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        await api.updateCoolingSpace(editing.id, parsed.data);
        toast.success('已更新涼適空間', `${parsed.data.name} 的資料已儲存。`);
      } else {
        await api.createCoolingSpace(parsed.data);
        toast.success(
          '已新增涼適空間',
          `${parsed.data.name} 已加入名冊，${parsed.data.status === 'ACTIVE' ? '並立即納入長者推薦。' : '目前為停用狀態，不會出現在長者推薦中。'}`,
        );
      }
      setFormOpen(false);
      setFieldErrors({});
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('儲存失敗', err.displayMessage);
      } else {
        toast.error('儲存失敗', '請稍後再試。');
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleSpace = async (space: SpaceRow) => {
    setTogglingId(space.id);
    try {
      const result = await api.toggleCoolingSpace(space.id);
      if (result.space.status === 'ACTIVE') {
        toast.success(
          `已啟用「${result.space.name}」`,
          `下一次評估起會重新出現在長者的涼適空間建議中。目前全市啟用中共 ${result.activeCount} 處。`,
        );
      } else {
        toast.warning(
          `已停用「${result.space.name}」`,
          `此地點已立即從長者的涼適空間建議中移除。目前全市啟用中剩 ${result.activeCount} 處。`,
        );
      }
      await load();
    } catch (err) {
      toast.error(
        '切換狀態失敗',
        err instanceof ApiError ? err.displayMessage : '請稍後再試。',
      );
    } finally {
      setTogglingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      await api.deleteCoolingSpace(deleting.id);
      toast.success('已刪除涼適空間', `${deleting.name} 已從名冊移除。`);
      setDeleting(null);
      await load();
    } catch (err) {
      toast.error('刪除失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setDeletingBusy(false);
    }
  };

  const runImport = async () => {
    setImportErrors([]);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(importText);
    } catch (err) {
      setImportErrors([
        `JSON 格式錯誤：${err instanceof Error ? err.message : '無法解析內容'}`,
      ]);
      return;
    }

    if (!Array.isArray(parsedJson)) {
      setImportErrors(['最外層必須是陣列，例如 [ { … }, { … } ]。']);
      return;
    }

    if (parsedJson.length === 0) {
      setImportErrors(['陣列是空的，沒有可匯入的地點。']);
      return;
    }

    if (parsedJson.length > 200) {
      setImportErrors([`一次最多匯入 200 筆，目前有 ${parsedJson.length} 筆。`]);
      return;
    }

    // Validate every entry against the same schema the server enforces, so
    // the admin sees which row and which field is wrong rather than one 400.
    const validated: unknown[] = [];
    const problems: string[] = [];

    parsedJson.forEach((entry, index) => {
      const result = coolingSpaceCreateSchema.safeParse(entry);
      if (result.success) {
        validated.push(result.data);
      } else {
        for (const [path, message] of Object.entries(issuesToFieldErrors(result.error))) {
          problems.push(`第 ${index + 1} 筆 · ${path}：${message}`);
        }
      }
    });

    if (problems.length > 0) {
      setImportErrors(problems);
      return;
    }

    setImportBusy(true);
    try {
      const result = await api.importCoolingSpaces(validated);
      const skippedNote =
        result.skipped.length > 0
          ? `略過 ${result.skipped.length} 筆同名重複：${result.skipped.slice(0, 5).join('、')}${result.skipped.length > 5 ? ' 等' : ''}。`
          : '沒有重複的地點。';
      toast.success('匯入完成', `新增 ${result.created} 筆，${skippedNote}`);
      setImportOpen(false);
      setImportText('');
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setImportErrors([err.displayMessage]);
      } else {
        setImportErrors(['匯入失敗，請稍後再試。']);
      }
    } finally {
      setImportBusy(false);
    }
  };

  // --- table --------------------------------------------------------------

  const columns: Column<SpaceRow>[] = [
    {
      key: 'name',
      header: '名稱',
      primary: true,
      sortValue: (row) => row.name,
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">{row.nameEn}</p>
        </div>
      ),
    },
    {
      key: 'type',
      header: '類型',
      sortValue: (row) => typeLabel(row.type),
      cell: (row) => <Badge variant="outline">{typeLabel(row.type)}</Badge>,
    },
    {
      key: 'district',
      header: '行政區',
      sortValue: (row) => row.district,
      cell: (row) => <span>{row.district}</span>,
    },
    {
      key: 'address',
      header: '地址',
      hideOnMobile: true,
      sortValue: (row) => row.address,
      cell: (row) => (
        <span className="block max-w-[220px] truncate text-xs text-muted-foreground">
          {row.address}
        </span>
      ),
    },
    {
      key: 'ac',
      header: '冷氣',
      sortValue: (row) => (row.airConditioned ? 1 : 0),
      cell: (row) =>
        row.airConditioned ? (
          <Badge variant="success" className="gap-1">
            <AirVent className="size-3" />有冷氣
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">無</span>
        ),
    },
    {
      key: 'accessible',
      header: '無障礙',
      sortValue: (row) => (row.accessible ? 1 : 0),
      cell: (row) =>
        row.accessible ? (
          <Badge variant="secondary" className="gap-1">
            <Accessibility className="size-3" />無障礙
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">無</span>
        ),
    },
    {
      key: 'hours',
      header: '開放時間',
      hideOnMobile: true,
      sortValue: (row) => row.opensAt,
      cell: (row) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">{row.openingHours}</span>
      ),
    },
    {
      key: 'openNow',
      header: '目前開放',
      sortValue: (row) => (row.openNow ? 1 : 0),
      cell: (row) =>
        row.openNow ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-risk-low">
            <Clock className="size-3.5" aria-hidden />
            開放中
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" aria-hidden />
            未開放
          </span>
        ),
    },
    {
      key: 'capacity',
      header: '容納人數',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => row.capacity,
      cell: (row) => <span className="tabular">{formatNumber(row.capacity)}</span>,
    },
    {
      key: 'contact',
      header: '聯絡方式',
      hideOnMobile: true,
      sortValue: (row) => row.contact,
      cell: (row) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {row.contact || '未提供'}
        </span>
      ),
    },
    {
      key: 'risk',
      header: '在地風險',
      sortValue: (row) => RISK_ORDER[row.riskLevel],
      cell: (row) => <RiskBadge level={row.riskLevel} size="sm" />,
    },
    {
      key: 'status',
      header: '狀態',
      sortValue: (row) => (row.status === 'ACTIVE' ? 1 : 0),
      cell: (row) => (
        <StatusIndicator
          status={row.status === 'ACTIVE' ? 'ONLINE' : 'DISABLED'}
          label={row.status === 'ACTIVE' ? '啟用中' : '已停用'}
        />
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (row) =>
        canWrite ? (
          <div className="flex justify-end gap-1">
            <Button
              variant={row.status === 'ACTIVE' ? 'outline' : 'default'}
              size="sm"
              loading={togglingId === row.id}
              onClick={() => void toggleSpace(row)}
            >
              <Power />
              {row.status === 'ACTIVE' ? '停用' : '啟用'}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`編輯 ${row.name}`}
              onClick={() => openEdit(row)}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`刪除 ${row.name}`}
              onClick={() => setDeleting(row)}
            >
              <Trash2 className="text-destructive" />
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">僅可檢視</span>
        ),
    },
  ];

  // --- render -------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="涼適空間" description="正在載入涼適空間名冊…" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-[116px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="涼適空間" description="全市可供長者避暑的公共空間名冊。" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入資料"
          description={error}
          action={
            <Button
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              重試
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="涼適空間"
        description="管理全市可供長者避暑的公共空間。停用任何地點，都會立即從長者端的推薦名單中移除。"
        actions={
          <>
            <Button variant="outline" onClick={() => { setLoading(true); void load(); }}>
              <RefreshCw />
              重新整理
            </Button>
            {canWrite && (
              <>
                <Button variant="outline" onClick={() => setImportOpen(true)}>
                  <Upload />
                  匯入
                </Button>
                <Button onClick={openCreate}>
                  <Plus />
                  新增地點
                </Button>
              </>
            )}
          </>
        }
      />

      {/* --------------------------- Summary ---------------------------- */}
      {summary && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard
            label="啟用中"
            value={summary.active}
            sublabel="會出現在長者推薦中"
            icon={Building2}
            tone="low"
          />
          <StatCard
            label="已停用"
            value={summary.disabled}
            sublabel="不會被推薦給任何長者"
            icon={Power}
            tone={summary.disabled > 0 ? 'medium' : 'neutral'}
          />
          <StatCard
            label="有冷氣"
            value={summary.airConditioned}
            sublabel="啟用中且具空調"
            icon={AirVent}
            tone="primary"
          />
          <StatCard
            label="無障礙"
            value={summary.accessible}
            sublabel="啟用中且具無障礙設施"
            icon={Accessibility}
            tone="primary"
          />
          <StatCard
            label="目前開放"
            value={summary.openNow}
            sublabel="依開放時間即時判定"
            icon={Clock}
            tone="neutral"
          />
        </div>
      )}

      <Card className="border-primary/30 bg-primary-muted/40">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <Power className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-muted-foreground text-pretty">
            <span className="font-medium text-foreground">啟用／停用是即時生效的控制項。</span>{' '}
            推薦引擎只會挑選「啟用中」的地點，因此停用後，該地點會在下一次風險評估時立即從長者的建議名單消失，不需要重新部署或等待同步。
          </p>
        </CardContent>
      </Card>

      {/* ---------------------------- Table ----------------------------- */}
      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        searchPlaceholder="搜尋名稱或地址…"
        searchFields={(row) => `${row.name} ${row.nameEn} ${row.address} ${row.district}`}
        initialSort={{ key: 'district', direction: 'asc' }}
        filters={[
          {
            key: 'type',
            label: '類型',
            value: typeFilter,
            onChange: setTypeFilter,
            options: [
              { value: 'ALL', label: '全部類型' },
              ...Object.entries(types).map(([value, meta]) => ({
                value,
                label: meta.labelZh,
              })),
            ],
          },
          {
            key: 'district',
            label: '行政區',
            value: districtFilter,
            onChange: setDistrictFilter,
            options: [
              { value: 'ALL', label: '全部行政區' },
              ...districts.map((district) => ({ value: district, label: district })),
            ],
          },
          {
            key: 'status',
            label: '狀態',
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: 'ALL', label: '全部狀態' },
              { value: 'ACTIVE', label: '啟用中' },
              { value: 'DISABLED', label: '已停用' },
            ],
          },
        ]}
        toolbar={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="filter-ac"
                checked={acOnly}
                onCheckedChange={(checked) => setAcOnly(Boolean(checked))}
              />
              <Label htmlFor="filter-ac" className="cursor-pointer text-sm font-normal">
                只看有冷氣
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="filter-accessible"
                checked={accessibleOnly}
                onCheckedChange={(checked) => setAccessibleOnly(Boolean(checked))}
              />
              <Label htmlFor="filter-accessible" className="cursor-pointer text-sm font-normal">
                只看無障礙
              </Label>
            </div>
          </div>
        }
        emptyState={
          <EmptyState
            icon={Inbox}
            title="沒有符合條件的涼適空間"
            description="調整上方的篩選條件，或新增一個地點到名冊中。"
            action={canWrite ? <Button onClick={openCreate}><Plus />新增地點</Button> : undefined}
          />
        }
      />

      {/* ------------------------- Map preview -------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <span className="inline-flex items-center gap-2">
              <MapPin className="size-4 text-muted-foreground" aria-hidden />
              地點分布預覽
            </span>
          </CardTitle>
          <CardDescription>
            只顯示啟用中的涼適空間，用來確認布點是否覆蓋各行政區。點選地圖上的圖釘可直接編輯該地點。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(spaces ?? []).filter((s) => s.status === 'ACTIVE').length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="地圖上沒有可顯示的地點"
              description="目前沒有啟用中的涼適空間，請先啟用或新增地點。"
            />
          ) : (
            <HeatMap
              districts={[]}
              coolingSpaces={spaces ?? []}
              layers={PLACEMENT_LAYERS}
              height={380}
              onSpaceClick={canWrite ? openEdit : undefined}
            />
          )}
        </CardContent>
      </Card>

      {/* --------------------------- Form dialog ------------------------ */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>{editing ? `編輯「${editing.name}」` : '新增涼適空間'}</DialogTitle>
            <DialogDescription>
              欄位會以與伺服器相同的規則驗證。狀態設為「啟用中」的地點，會立即納入長者的推薦名單。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="名稱" required error={fieldErrors.name}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="大安區圖書館"
              />
            </Field>

            <Field label="英文名稱" required error={fieldErrors.nameEn}>
              <Input
                value={form.nameEn}
                onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
                placeholder="Da'an District Library"
              />
            </Field>

            <div className="space-y-1.5">
              <Label htmlFor="space-type">類型</Label>
              <Select
                value={form.type}
                onValueChange={(value) => setForm({ ...form, type: value as CoolingSpaceType })}
              >
                <SelectTrigger id="space-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(types).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>
                      {meta.labelZh}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors.type && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {fieldErrors.type}
                </p>
              )}
            </div>

            <Field label="行政區" required error={fieldErrors.district}>
              <Input
                value={form.district}
                onChange={(e) => setForm({ ...form, district: e.target.value })}
                placeholder="大安區"
              />
            </Field>

            <Field label="地址" required error={fieldErrors.address} className="sm:col-span-2">
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                placeholder="台北市大安區辛亥路二段 1 號"
              />
            </Field>

            <Field
              label="緯度"
              required
              error={fieldErrors.lat}
              hint={`預設為台北市中心 ${DEFAULT_LAT}`}
            >
              <Input
                type="number"
                step="0.0001"
                value={form.lat}
                onChange={(e) => setForm({ ...form, lat: e.target.value })}
              />
            </Field>

            <Field
              label="經度"
              required
              error={fieldErrors.lng}
              hint={`預設為台北市中心 ${DEFAULT_LNG}`}
            >
              <Input
                type="number"
                step="0.0001"
                value={form.lng}
                onChange={(e) => setForm({ ...form, lng: e.target.value })}
              />
            </Field>

            <Field
              label="開放時間（顯示文字）"
              required
              error={fieldErrors.openingHours}
              className="sm:col-span-2"
            >
              <Input
                value={form.openingHours}
                onChange={(e) => setForm({ ...form, openingHours: e.target.value })}
                placeholder="每日 09:00–21:00"
              />
            </Field>

            <Field label="開始開放" required error={fieldErrors.opensAt} hint="24 小時制 HH:MM">
              <Input
                type="time"
                value={form.opensAt}
                onChange={(e) => setForm({ ...form, opensAt: e.target.value })}
              />
            </Field>

            <Field label="結束開放" required error={fieldErrors.closesAt} hint="24 小時制 HH:MM">
              <Input
                type="time"
                value={form.closesAt}
                onChange={(e) => setForm({ ...form, closesAt: e.target.value })}
              />
            </Field>

            <Field label="容納人數" required error={fieldErrors.capacity}>
              <Input
                type="number"
                min={0}
                max={10000}
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
              />
            </Field>

            <Field label="聯絡方式" error={fieldErrors.contact}>
              <Input
                value={form.contact}
                onChange={(e) => setForm({ ...form, contact: e.target.value })}
                placeholder="02-2732-8422"
              />
            </Field>

            <div className="space-y-1.5">
              <Label htmlFor="space-risk">在地熱風險</Label>
              <Select
                value={form.riskLevel}
                onValueChange={(value) => setForm({ ...form, riskLevel: value as RiskLevel })}
              >
                <SelectTrigger id="space-risk">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {RISK_STYLES[level].labelZh}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="space-status">狀態</Label>
              <Select
                value={form.status}
                onValueChange={(value) =>
                  setForm({ ...form, status: value as 'ACTIVE' | 'DISABLED' })
                }
              >
                <SelectTrigger id="space-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">啟用中（會被推薦給長者）</SelectItem>
                  <SelectItem value="DISABLED">已停用（不會被推薦）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <Label htmlFor="space-ac" className="font-normal">
                具備冷氣空調
              </Label>
              <Switch
                id="space-ac"
                checked={form.airConditioned}
                onCheckedChange={(checked) => setForm({ ...form, airConditioned: checked })}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <Label htmlFor="space-accessible" className="font-normal">
                具備無障礙設施
              </Label>
              <Switch
                id="space-accessible"
                checked={form.accessible}
                onCheckedChange={(checked) => setForm({ ...form, accessible: checked })}
              />
            </div>

            <Field
              label="無障礙說明"
              error={fieldErrors.accessibilityNotes}
              hint="例如：電梯直達、備有無障礙廁所"
              className="sm:col-span-2"
            >
              <Textarea
                value={form.accessibilityNotes}
                onChange={(e) => setForm({ ...form, accessibilityNotes: e.target.value })}
                rows={2}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button onClick={submitForm} loading={saving}>
              {editing ? '儲存變更' : '新增地點'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------- Import dialog ----------------------- */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>匯入涼適空間</DialogTitle>
            <DialogDescription>
              貼上一個 JSON 陣列，每個項目的欄位與新增表單相同。內容會先在瀏覽器端以與伺服器相同的規則驗證，通過後才送出；名稱重複的地點會被略過而不會建立第二筆。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="import-json">JSON 內容</Label>
              <Textarea
                id="import-json"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={12}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={`[\n  {\n    "name": "信義區運動中心",\n    "nameEn": "Xinyi Sports Center",\n    "type": "PUBLIC_BUILDING",\n    "address": "台北市信義區松勤街 100 號",\n    "district": "信義區",\n    "lat": 25.033,\n    "lng": 121.565,\n    "riskLevel": "LOW",\n    "airConditioned": true,\n    "accessible": true,\n    "accessibilityNotes": "電梯直達，備有無障礙廁所",\n    "openingHours": "每日 06:00–22:00",\n    "opensAt": "06:00",\n    "closesAt": "22:00",\n    "contact": "02-2723-9909",\n    "capacity": 300,\n    "status": "ACTIVE"\n  }\n]`}
              />
            </div>

            {importErrors.length > 0 && (
              <div
                role="alert"
                className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-risk-high-border bg-risk-high-bg p-3"
              >
                <p className="text-sm font-medium text-risk-high">
                  驗證未通過，共 {importErrors.length} 個問題，尚未送出任何資料
                </p>
                <ul className="list-inside list-disc space-y-0.5 text-xs text-risk-high">
                  {importErrors.map((problem, index) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button onClick={runImport} loading={importBusy} disabled={!importText.trim()}>
              <Download />
              驗證並匯入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------------------------- Delete confirm ---------------------- */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>刪除「{deleting?.name}」？</DialogTitle>
            <DialogDescription>
              這會將此地點從名冊中永久移除，長者端也不會再收到相關建議。若只是暫時不開放，建議改用「停用」，之後可以直接啟用回來。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deletingBusy}>
              <Trash2 />
              確認刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
