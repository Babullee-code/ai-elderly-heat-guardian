/**
 * 熱風險地圖 - the resident and caregiver view of the city.
 *
 * District aggregates only. The resident layer exists on the map component
 * but is deliberately never offered here: showing where individual monitored
 * residents live is a staff function, and this page is not a staff surface.
 *
 * District values come from the live socket, so during a demo scenario the
 * circles grow and change colour without the page refetching anything.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Crosshair,
  Droplet,
  Info,
  Map as MapIcon,
  MapPin,
  Snowflake,
  Thermometer,
  Trees,
} from 'lucide-react';

import type { CityRisk, CoolingSpace, CoolingSpaceRecommendation } from '@shared/types/domain';
import { ApiError, api } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { CoolingSpaceCard, PageHeader } from '@/components/domain/Cards';
import { DataTable, type Column } from '@/components/domain/DataTable';
import { EmptyState, RiskBadge } from '@/components/domain/RiskIndicators';
import {
  DEFAULT_LAYERS,
  HeatMap,
  LayerControls,
  MapLegend,
  type MapLayers,
} from '@/components/domain/HeatMap';
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
import { cn, formatPct, formatTemp } from '@/lib/utils';

/** A phone gets a shorter map so the district list is reachable by scrolling. */
function useMapHeight(): number {
  const [narrow, setNarrow] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  );

  React.useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const handler = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, []);

  return narrow ? 340 : 520;
}

export default function HeatMapPage() {
  const focusUserId = useSession((s) => s.focusUserId());

  const liveDistricts = useLiveStore((s) => s.cityRisk);
  const connection = useLiveStore((s) => s.connection);

  const mapHeight = useMapHeight();

  // Residents may never be switched on from this page.
  const [layers, setLayers] = React.useState<MapLayers>({ ...DEFAULT_LAYERS, residents: false });
  const [focus, setFocus] = React.useState<[number, number] | null>(null);
  const [selectedDistrict, setSelectedDistrict] = React.useState<string | null>(null);

  const [city, setCity] = React.useState<{
    loading: boolean;
    error: string | null;
    fallback: CityRisk[];
    privacyNoticeZh: string;
    cityName: string;
  }>({ loading: true, error: null, fallback: [], privacyNoticeZh: '', cityName: '台北市' });

  const [spaces, setSpaces] = React.useState<{
    loading: boolean;
    error: string | null;
    list: (CoolingSpace & { openNow: boolean })[];
  }>({ loading: true, error: null, list: [] });

  const [nearby, setNearby] = React.useState<{
    loading: boolean;
    error: string | null;
    blocked: boolean;
    reasonZh: string | null;
    recommendations: CoolingSpaceRecommendation[];
  }>({ loading: true, error: null, blocked: false, reasonZh: null, recommendations: [] });

  // --- city risk (privacy notice + a fallback before the first tick) --------
  const loadCity = React.useCallback(async () => {
    setCity((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await api.cityRisk();
      setCity({
        loading: false,
        error: null,
        fallback: result.districts,
        privacyNoticeZh: result.privacyNoticeZh,
        cityName: result.city,
      });
    } catch (error) {
      setCity({
        loading: false,
        error: error instanceof ApiError ? error.displayMessage : '請稍後再試。',
        fallback: [],
        privacyNoticeZh: '',
        cityName: '台北市',
      });
    }
  }, []);

  // --- cooling spaces on the map -------------------------------------------
  const loadSpaces = React.useCallback(async () => {
    setSpaces((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await api.listCoolingSpaces();
      setSpaces({ loading: false, error: null, list: result.spaces });
    } catch (error) {
      setSpaces({
        loading: false,
        error: error instanceof ApiError ? error.displayMessage : '請稍後再試。',
        list: [],
      });
    }
  }, []);

  // --- personalised recommendations ----------------------------------------
  const loadNearby = React.useCallback(async () => {
    if (!focusUserId) return;
    setNearby((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await api.recommendCoolingSpaces(focusUserId);
      setNearby({
        loading: false,
        error: null,
        blocked: result.blocked,
        reasonZh: result.reasonZh ?? null,
        recommendations: result.recommendations,
      });
    } catch (error) {
      setNearby({
        loading: false,
        error: error instanceof ApiError ? error.displayMessage : '請稍後再試。',
        blocked: false,
        reasonZh: null,
        recommendations: [],
      });
    }
  }, [focusUserId]);

  React.useEffect(() => {
    void loadCity();
    void loadSpaces();
  }, [loadCity, loadSpaces]);

  React.useEffect(() => {
    void loadNearby();
  }, [loadNearby]);

  // Live values win; the fetched list only covers the moment before the first
  // socket tick arrives.
  const districts = liveDistricts.length > 0 ? liveDistricts : city.fallback;

  const ordered = React.useMemo(
    () => [...districts].sort((a, b) => b.heatIndex - a.heatIndex),
    [districts],
  );

  const focusDistrict = React.useCallback((district: CityRisk) => {
    setFocus([district.lat, district.lng]);
    setSelectedDistrict(district.district);
  }, []);

  const hottest = ordered[0] ?? null;

  const columns: Column<CityRisk>[] = [
    {
      key: 'district',
      header: '行政區',
      primary: true,
      sortValue: (row) => row.district,
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('font-semibold', selectedDistrict === row.district && 'text-primary')}>
            {row.district}
          </span>
          <RiskBadge level={row.riskLevel} size="sm" />
        </div>
      ),
    },
    {
      key: 'heatIndex',
      header: '熱指數',
      align: 'right',
      sortValue: (row) => row.heatIndex,
      cell: (row) => <span className="tabular font-semibold">{formatTemp(row.heatIndex)}</span>,
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
      key: 'green',
      header: '綠覆率',
      align: 'right',
      hideOnMobile: true,
      sortValue: (row) => row.greenCoveragePct,
      cell: (row) => <span className="tabular">{row.greenCoveragePct}%</span>,
    },
    {
      key: 'spaces',
      header: '涼適空間',
      align: 'right',
      sortValue: (row) => row.coolingSpaceCount,
      cell: (row) => <span className="tabular">{row.coolingSpaceCount} 處</span>,
    },
    {
      key: 'action',
      header: '地圖',
      align: 'right',
      cell: (row) => (
        <Button
          size="sm"
          variant="outline"
          onClick={(event) => {
            event.stopPropagation();
            focusDistrict(row);
          }}
          aria-label={`在地圖上顯示${row.district}`}
        >
          <Crosshair />
          定位
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="熱風險地圖"
        description="以行政區為單位呈現全市熱風險，並標示可以避熱的涼適空間。"
        actions={
          hottest ? (
            <Button variant="outline" onClick={() => focusDistrict(hottest)}>
              <MapPin />
              前往最熱的 {hottest.district}
            </Button>
          ) : undefined
        }
      />

      {/* ------------------------------ Map -------------------------------- */}
      {districts.length === 0 ? (
        city.loading ? (
          <Skeleton className="h-[340px] w-full rounded-xl sm:h-[520px]" />
        ) : (
          <EmptyState
            icon={AlertTriangle}
            title="無法載入城市熱風險資料"
            description={city.error ?? '目前沒有可顯示的行政區資料。'}
            action={<Button onClick={() => void loadCity()}>重試</Button>}
          />
        )
      ) : (
        <div className="min-w-0 space-y-3">
          <HeatMap
            districts={districts}
            coolingSpaces={layers.coolingSpaces ? spaces.list : []}
            layers={layers}
            focus={focus}
            height={mapHeight}
            className="w-full"
            onDistrictClick={focusDistrict}
            onSpaceClick={(space) => {
              setFocus([space.lat, space.lng]);
              setSelectedDistrict(space.district);
            }}
          />

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <LayerControls layers={layers} onChange={setLayers} showResidents={false} />
            <Card>
              <CardContent className="p-4">
                <MapLegend />
              </CardContent>
            </Card>
          </div>

          {spaces.error && (
            <p className="flex gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>涼適空間圖層目前無法載入（{spaces.error}）。</span>
            </p>
          )}
        </div>
      )}

      {/* --------------------------- Privacy notice ------------------------ */}
      {city.privacyNoticeZh && (
        <p className="flex gap-2.5 rounded-lg border border-border bg-muted/50 p-3.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{city.privacyNoticeZh}</span>
        </p>
      )}

      {/* -------------------------- District list -------------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{city.cityName}各行政區熱風險</h2>
            <p className="text-sm text-muted-foreground">
              依熱指數由高到低排列，點選任一列即可在上方地圖定位。
            </p>
          </div>
          {connection === 'open' && (
            <Badge variant="muted" className="text-[10px]">
              即時更新中
            </Badge>
          )}
        </div>

        <DataTable
          rows={ordered}
          columns={columns}
          getRowKey={(row) => row.id}
          initialSort={{ key: 'heatIndex', direction: 'desc' }}
          onRowClick={focusDistrict}
          searchFields={(row) => `${row.district} ${row.city}`}
          searchPlaceholder="搜尋行政區…"
          emptyState={
            <EmptyState icon={MapIcon} title="沒有符合的行政區" description="請調整搜尋條件。" />
          }
        />
      </section>

      {/* -------------------------- Nearby spaces -------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
                <Snowflake className="size-4 text-primary" />
              </span>
              <div>
                <CardTitle className="text-base">我附近的涼適空間</CardTitle>
                <CardDescription className="text-xs">
                  依距離、是否有冷氣、無障礙進出與現在是否開放排序。
                </CardDescription>
              </div>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/app/guide">查看完整行動指引</Link>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {!focusUserId ? (
            <EmptyState
              icon={MapPin}
              title="尚未選擇要檢視的長者"
              description="此帳號沒有綁定長者資料，因此無法提供個人化的涼適空間建議。"
            />
          ) : nearby.loading ? (
            <>
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </>
          ) : nearby.error ? (
            <EmptyState
              icon={AlertTriangle}
              title="無法載入建議"
              description={nearby.error}
              action={<Button onClick={() => void loadNearby()}>重試</Button>}
            />
          ) : nearby.blocked ? (
            <EmptyState
              icon={MapPin}
              title="位置分享已關閉"
              description={
                nearby.reasonZh ??
                '位置分享已關閉，因此無法建議附近的涼適空間。地圖上仍會顯示全市的涼適空間。'
              }
              action={
                <Button asChild>
                  <Link to="/app/privacy">前往隱私設定</Link>
                </Button>
              }
            />
          ) : nearby.recommendations.length === 0 ? (
            <EmptyState
              icon={Snowflake}
              title="附近沒有可建議的涼適空間"
              description={nearby.reasonZh ?? '搜尋範圍內目前沒有啟用中的涼適空間。'}
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {nearby.recommendations.map((space) => (
                <li key={space.id}>
                  <CoolingSpaceCard space={space} className="h-full" />
                  <button
                    type="button"
                    onClick={() => {
                      setFocus([space.lat, space.lng]);
                      setSelectedDistrict(space.district);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="mt-1 inline-flex items-center gap-1 px-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Crosshair className="size-3" />
                    在地圖上顯示
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --------------------------- Selected detail ----------------------- */}
      {selectedDistrict && (
        <SelectedDistrictSummary
          district={ordered.find((d) => d.district === selectedDistrict) ?? null}
          onClear={() => {
            setSelectedDistrict(null);
            setFocus(null);
          }}
        />
      )}
    </div>
  );
}

function SelectedDistrictSummary({
  district,
  onClear,
}: {
  district: CityRisk | null;
  onClear: () => void;
}) {
  if (!district) return null;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div className="flex items-center gap-2">
          <MapPin className="size-4 text-primary" />
          <span className="font-semibold">{district.district}</span>
          <RiskBadge level={district.riskLevel} size="sm" />
        </div>

        <span className="tabular flex items-center gap-1.5 text-sm text-muted-foreground">
          <Thermometer className="size-4" />
          熱指數 {formatTemp(district.heatIndex)}
        </span>
        <span className="tabular flex items-center gap-1.5 text-sm text-muted-foreground">
          <Droplet className="size-4" />
          濕度 {formatPct(district.humidityPct)}
        </span>
        <span className="tabular flex items-center gap-1.5 text-sm text-muted-foreground">
          <Trees className="size-4" />
          綠覆率 {district.greenCoveragePct}%
        </span>
        <span className="tabular flex items-center gap-1.5 text-sm text-muted-foreground">
          <Snowflake className="size-4" />
          涼適空間 {district.coolingSpaceCount} 處
        </span>

        <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
          清除選取
        </Button>
      </CardContent>
    </Card>
  );
}
