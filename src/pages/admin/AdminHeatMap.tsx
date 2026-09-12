/**
 * 熱風險地圖 - the staff-facing city view.
 *
 * This is the only surface in the product that may plot individual residents,
 * and it does so under a hard constraint: the marker carries a name and a risk
 * level and nothing else. No heart rate, no skin temperature, no address. The
 * HeatMap component enforces that shape; this page simply supplies name, level
 * and coordinates and never widens it.
 *
 * District values come from the live socket rather than the REST snapshot, so
 * the map actually moves while a demo scenario plays. The REST call is used
 * only for the things the socket does not carry: the privacy notice, and a
 * cold-start fallback before the first tick arrives.
 */

import * as React from 'react';
import {
  AlertTriangle,
  Building2,
  CloudSun,
  Crosshair,
  DatabaseBackup,
  Droplets,
  Info,
  Map as MapIcon,
  RefreshCw,
  ShieldCheck,
  Thermometer,
  Users,
} from 'lucide-react';

import type { CityRisk, CoolingSpace, RiskLevel } from '@shared/types/domain';
import { RISK_ORDER } from '@shared/types/domain';
import { api, ApiError, type UserRow } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { cn, formatNumber, formatPct, formatTemp, RISK_STYLES, timeAgo } from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, LiveIndicator, RiskBadge } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';
import {
  DEFAULT_LAYERS,
  HeatMap,
  LayerControls,
  MapLegend,
  type MapLayers,
} from '@/components/domain/HeatMap';

/** A resident reduced to exactly what a map surface is allowed to show. */
interface MapResident {
  id: string;
  name: string;
  lat: number;
  lng: number;
  level: RiskLevel;
  district: string;
}

const TONE_BY_LEVEL: Record<RiskLevel, 'low' | 'medium' | 'high'> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

export default function AdminHeatMap() {
  const toast = useToast();
  const can = useSession((s) => s.can);

  // --- live slices --------------------------------------------------------
  const liveDistricts = useLiveStore((s) => s.cityRisk);
  const assessments = useLiveStore((s) => s.assessments);
  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);
  const configVersion = useLiveStore((s) => s.configVersion);

  // --- fetched slices -----------------------------------------------------
  const [fallbackDistricts, setFallbackDistricts] = React.useState<CityRisk[]>([]);
  const [privacyNoticeZh, setPrivacyNoticeZh] = React.useState<string | null>(null);
  const [spaces, setSpaces] = React.useState<CoolingSpace[] | null>(null);
  const [users, setUsers] = React.useState<UserRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [syncing, setSyncing] = React.useState(false);

  const [layers, setLayers] = React.useState<MapLayers>({ ...DEFAULT_LAYERS, residents: true });
  const [focus, setFocus] = React.useState<[number, number] | null>(null);
  const [focusedDistrict, setFocusedDistrict] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const [city, cooling, roster] = await Promise.all([
        api.cityRisk(),
        api.listCoolingSpaces(),
        api.listUsers(),
      ]);
      setFallbackDistricts(city.districts);
      setPrivacyNoticeZh(city.privacyNoticeZh);
      setSpaces(cooling.spaces);
      setUsers(roster.users);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入城市熱風險資料。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load, configVersion]);

  // The socket is the source of truth once it has delivered a tick; the REST
  // snapshot only covers the gap before that.
  const districts = liveDistricts.length > 0 ? liveDistricts : fallbackDistricts;

  /**
   * Residents on the map.
   *
   * Level is taken from the live assessment so a marker changes colour during
   * a scenario. Only name, level and coordinates cross into the map layer.
   */
  const residents = React.useMemo<MapResident[]>(() => {
    if (!users) return [];
    return users
      .filter((user) => Number.isFinite(user.lat) && Number.isFinite(user.lng))
      .map((user) => ({
        id: user.id,
        name: user.name,
        lat: user.lat,
        lng: user.lng,
        district: user.district,
        level: assessments[user.id]?.level ?? user.assessment?.level ?? 'LOW',
      }));
  }, [users, assessments]);

  // --- city summary -------------------------------------------------------

  const worst = React.useMemo(() => {
    if (districts.length === 0) return null;
    return [...districts].sort(
      (a, b) =>
        RISK_ORDER[b.riskLevel] - RISK_ORDER[a.riskLevel] || b.heatIndex - a.heatIndex,
    )[0];
  }, [districts]);

  const averageHeatIndex = React.useMemo(() => {
    if (districts.length === 0) return null;
    return districts.reduce((sum, d) => sum + d.heatIndex, 0) / districts.length;
  }, [districts]);

  const levelCounts = React.useMemo(() => {
    const counts: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
    for (const district of districts) counts[district.riskLevel] += 1;
    return counts;
  }, [districts]);

  const activeSpaces = React.useMemo(
    () => (spaces ?? []).filter((space) => space.status === 'ACTIVE'),
    [spaces],
  );

  const lastUpdatedAt = React.useMemo(() => {
    if (districts.length === 0) return null;
    return [...districts].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0].updatedAt;
  }, [districts]);

  // --- actions ------------------------------------------------------------

  const focusDistrict = (district: CityRisk) => {
    setFocus([district.lat, district.lng]);
    setFocusedDistrict(district.district);
  };

  const syncToDatabase = async () => {
    setSyncing(true);
    try {
      const result = await api.syncCityRisk();
      toast.success(
        '已同步至資料庫',
        `目前的即時數值已寫入 ${result.synced} 個行政區的紀錄。`,
      );
      await load();
    } catch (err) {
      toast.error(
        '同步失敗',
        err instanceof ApiError ? err.displayMessage : '請稍後再試。',
      );
    } finally {
      setSyncing(false);
    }
  };

  // --- table --------------------------------------------------------------

  const columns: Column<CityRisk>[] = [
    {
      key: 'district',
      header: '行政區',
      primary: true,
      sortValue: (row) => row.district,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.district}</span>
          {focusedDistrict === row.district && (
            <Badge variant="muted" className="gap-1">
              <Crosshair className="size-3" />
              已定位
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'level',
      header: '風險等級',
      sortValue: (row) => RISK_ORDER[row.riskLevel],
      cell: (row) => <RiskBadge level={row.riskLevel} size="sm" />,
    },
    {
      key: 'heatIndex',
      header: '熱指數',
      align: 'right',
      sortValue: (row) => row.heatIndex,
      cell: (row) => (
        <span className={cn('tabular font-semibold', RISK_STYLES[row.riskLevel].text)}>
          {formatTemp(row.heatIndex)}
        </span>
      ),
    },
    {
      key: 'temperature',
      header: '氣溫',
      align: 'right',
      sortValue: (row) => row.temperatureC,
      cell: (row) => <span className="tabular">{formatTemp(row.temperatureC)}</span>,
    },
    {
      key: 'humidity',
      header: '濕度',
      align: 'right',
      sortValue: (row) => row.humidityPct,
      cell: (row) => <span className="tabular">{formatPct(row.humidityPct)}</span>,
    },
    {
      key: 'urbanDensity',
      header: '都市密度',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => row.urbanDensity,
      cell: (row) => <span className="tabular">{row.urbanDensity} / 100</span>,
    },
    {
      key: 'green',
      header: '綠覆率',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => row.greenCoveragePct,
      cell: (row) => <span className="tabular">{formatPct(row.greenCoveragePct)}</span>,
    },
    {
      key: 'coolingSpaces',
      header: '涼適空間',
      align: 'right',
      sortValue: (row) => row.coolingSpaceCount,
      cell: (row) => <span className="tabular">{row.coolingSpaceCount} 處</span>,
    },
    {
      key: 'residents',
      header: '登記長者',
      align: 'right',
      sortValue: (row) => row.elderlyUserCount,
      cell: (row) => <span className="tabular">{row.elderlyUserCount} 位</span>,
    },
    {
      key: 'updatedAt',
      header: '更新時間',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => new Date(row.updatedAt).getTime(),
      cell: (row) => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {timeAgo(row.updatedAt)}
        </span>
      ),
    },
  ];

  // --- render -------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="熱風險地圖" description="正在載入城市熱風險資料…" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[116px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-[520px] rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="熱風險地圖" description="城市層級的熱風險分布與涼適空間布點。" />
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
        title="熱風險地圖"
        description="以行政區為單位呈現全市熱風險，並疊加涼適空間與登記長者分布，協助調度降溫資源。"
        actions={
          <>
            <LiveIndicator connection={connection} updates={updates} className="self-center" />
            <Button
              variant="outline"
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              <RefreshCw />
              重新整理
            </Button>
            {can('city-risk:write') && (
              <Button onClick={syncToDatabase} loading={syncing}>
                <DatabaseBackup />
                同步至資料庫
              </Button>
            )}
          </>
        }
      />

      {/* ------------------------- City summary ------------------------- */}
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
        aria-live="polite"
      >
        <StatCard
          label="最嚴重行政區"
          value={worst ? worst.district : '--'}
          sublabel={
            worst
              ? `${RISK_STYLES[worst.riskLevel].labelZh} · 熱指數 ${formatTemp(worst.heatIndex)}`
              : '尚無行政區資料'
          }
          icon={AlertTriangle}
          tone={worst ? TONE_BY_LEVEL[worst.riskLevel] : 'neutral'}
        />
        <StatCard
          label="全市平均熱指數"
          value={averageHeatIndex === null ? '--' : formatTemp(averageHeatIndex)}
          sublabel={`${districts.length} 個行政區平均`}
          icon={Thermometer}
          tone="primary"
        />
        <StatCard
          label="高風險行政區"
          value={levelCounts.HIGH}
          sublabel="需要立即調度資源"
          icon={AlertTriangle}
          tone="high"
        />
        <StatCard
          label="需要注意行政區"
          value={levelCounts.MEDIUM}
          sublabel="建議加強巡查與提醒"
          icon={CloudSun}
          tone="medium"
        />
        <StatCard
          label="低風險行政區"
          value={levelCounts.LOW}
          sublabel="維持例行監測"
          icon={ShieldCheck}
          tone="low"
        />
        <StatCard
          label="啟用中涼適空間"
          value={activeSpaces.length}
          sublabel={`共登錄 ${spaces?.length ?? 0} 處`}
          icon={Building2}
          tone="neutral"
        />
      </div>

      {/* --------------------------- Privacy ---------------------------- */}
      {privacyNoticeZh && (
        <Card className="border-primary/30 bg-primary-muted/40">
          <CardContent className="flex items-start gap-3 p-4">
            <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div className="space-y-1 text-sm">
              <p className="font-medium">隱私原則</p>
              <p className="text-muted-foreground text-pretty">{privacyNoticeZh}</p>
              <p className="text-xs text-muted-foreground text-pretty">
                「長者分布」圖層僅供機構人員使用，圖上只顯示姓名與風險等級，不會呈現心率、體溫等任何生理數值。
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ----------------------------- Map ------------------------------ */}
      <LayerControls layers={layers} onChange={setLayers} showResidents />

      <Card className="overflow-hidden">
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-2">
                <MapIcon className="size-4 text-muted-foreground" aria-hidden />
                台北市熱風險分布
              </span>
            </CardTitle>
            <CardDescription>
              圓圈大小與顏色代表該行政區的熱指數與風險等級；點選下方表格的任一列可將地圖移至該區。
            </CardDescription>
          </div>
          <span className="text-xs text-muted-foreground">
            資料更新：{lastUpdatedAt ? timeAgo(lastUpdatedAt) : '尚無資料'}
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          {districts.length === 0 ? (
            <EmptyState
              icon={MapIcon}
              title="尚未載入行政區資料"
              description="即時連線送達第一筆快照後，地圖就會顯示各行政區的熱風險。"
            />
          ) : (
            <>
              <HeatMap
                districts={districts}
                coolingSpaces={spaces ?? []}
                residents={residents}
                layers={layers}
                focus={focus}
                height={520}
                onDistrictClick={focusDistrict}
              />
              <MapLegend />
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="size-3.5" aria-hidden />
                長者圖層目前顯示 {residents.length} 位登記長者，僅標示姓名與風險等級。
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* --------------------------- District table --------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">行政區明細</h2>
          <p className="text-xs text-muted-foreground">
            點選任一列可將地圖定位到該行政區；欄位標題可排序。
          </p>
        </div>

        <DataTable
          rows={districts}
          columns={columns}
          getRowKey={(row) => row.id}
          searchPlaceholder="搜尋行政區…"
          searchFields={(row) => `${row.district} ${row.city} ${RISK_STYLES[row.riskLevel].labelZh}`}
          initialSort={{ key: 'heatIndex', direction: 'desc' }}
          onRowClick={focusDistrict}
          emptyState={
            <EmptyState
              icon={Droplets}
              title="目前沒有行政區資料"
              description="城市熱風險模型尚未產生任何行政區數值。"
            />
          }
        />
      </section>
    </div>
  );
}
