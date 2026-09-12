/**
 * City heat-risk map.
 *
 * Leaflet with OpenStreetMap tiles. District risk is drawn as graduated
 * circles rather than a raster heat layer, because circles can carry a text
 * label and a keyboard-reachable popup - a raster cannot, and this map has to
 * be usable without colour vision or a mouse.
 *
 * PRIVACY: district aggregates only. Resident markers, when shown, are
 * available exclusively to staff roles and never expose physiological values
 * on the map surface itself.
 */

import * as React from 'react';
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { AirVent, Building2, Layers, MapPin, Trees, Users } from 'lucide-react';

import type { CityRisk, CoolingSpace, RiskLevel } from '@shared/types/domain';
import { cn, formatPct, formatTemp, RISK_STYLES } from '@/lib/utils';
import { Badge, Button, Card, CardContent, Checkbox, Label } from '@/components/ui';

const TAIPEI_CENTRE: [number, number] = [25.045, 121.545];

const RISK_FILL: Record<RiskLevel, string> = {
  LOW: '#0f7f5c',
  MEDIUM: '#b45309',
  HIGH: '#c0304a',
};

export interface MapLayers {
  heatRisk: boolean;
  urbanHeat: boolean;
  greenSpace: boolean;
  coolingSpaces: boolean;
  residents: boolean;
}

export const DEFAULT_LAYERS: MapLayers = {
  heatRisk: true,
  urbanHeat: false,
  greenSpace: false,
  coolingSpaces: true,
  residents: false,
};

/** Recentres the map when the focus coordinate changes. */
function Recentre({ centre, zoom }: { centre: [number, number] | null; zoom?: number }) {
  const map = useMap();
  React.useEffect(() => {
    if (centre) map.flyTo(centre, zoom ?? map.getZoom(), { duration: 0.8 });
  }, [centre, zoom, map]);
  return null;
}

/** A small pin for cooling spaces, built as a divIcon so it inherits theme colours. */
function coolingIcon(accessible: boolean, airConditioned: boolean): L.DivIcon {
  const colour = airConditioned ? '#0f5f57' : '#6b7280';
  return L.divIcon({
    className: '',
    html: `<div style="
        width:22px;height:22px;border-radius:50%;
        background:${colour};border:2.5px solid white;
        box-shadow:0 1px 4px rgba(0,0,0,.35);
        display:flex;align-items:center;justify-content:center;">
        <span style="color:white;font-size:11px;font-weight:700;line-height:1">
          ${accessible ? '♿' : '•'}
        </span>
      </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

export function HeatMap({
  districts,
  coolingSpaces = [],
  residents = [],
  layers = DEFAULT_LAYERS,
  focus,
  height = 480,
  className,
  onDistrictClick,
  onSpaceClick,
}: {
  districts: CityRisk[];
  coolingSpaces?: CoolingSpace[];
  /** Staff-only. Carries no physiological values. */
  residents?: { id: string; name: string; lat: number; lng: number; level: RiskLevel; district: string }[];
  layers?: MapLayers;
  focus?: [number, number] | null;
  height?: number;
  className?: string;
  onDistrictClick?: (district: CityRisk) => void;
  onSpaceClick?: (space: CoolingSpace) => void;
}) {
  return (
    <div
      className={cn('overflow-hidden rounded-xl border border-border', className)}
      style={{ height }}
    >
      <MapContainer
        center={TAIPEI_CENTRE}
        zoom={12}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
        // Keyboard users can pan with arrow keys once the map has focus.
        keyboard
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <Recentre centre={focus ?? null} />

        {/* ---------------------- District heat risk --------------------- */}
        {layers.heatRisk &&
          districts.map((district) => (
            <CircleMarker
              key={district.id}
              center={[district.lat, district.lng]}
              // Radius scales with heat index so severity reads spatially as
              // well as by colour.
              radius={12 + Math.max(0, district.heatIndex - 26) * 1.1}
              pathOptions={{
                color: RISK_FILL[district.riskLevel],
                fillColor: RISK_FILL[district.riskLevel],
                fillOpacity: 0.32,
                weight: 2,
              }}
              eventHandlers={onDistrictClick ? { click: () => onDistrictClick(district) } : undefined}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                <span className="text-xs font-semibold">
                  {district.district} · {RISK_STYLES[district.riskLevel].labelZh}
                </span>
              </Tooltip>

              <Popup>
                <div className="min-w-[200px] space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold">{district.district}</p>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                      style={{ backgroundColor: RISK_FILL[district.riskLevel] }}
                    >
                      {RISK_STYLES[district.riskLevel].labelZh}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-gray-500">熱指數</dt>
                    <dd className="text-right font-semibold">{formatTemp(district.heatIndex)}</dd>
                    <dt className="text-gray-500">氣溫</dt>
                    <dd className="text-right">{formatTemp(district.temperatureC)}</dd>
                    <dt className="text-gray-500">濕度</dt>
                    <dd className="text-right">{formatPct(district.humidityPct)}</dd>
                    <dt className="text-gray-500">都市密度</dt>
                    <dd className="text-right">{district.urbanDensity}/100</dd>
                    <dt className="text-gray-500">綠覆率</dt>
                    <dd className="text-right">{district.greenCoveragePct}%</dd>
                    <dt className="text-gray-500">涼適空間</dt>
                    <dd className="text-right">{district.coolingSpaceCount} 處</dd>
                    <dt className="text-gray-500">登記長者</dt>
                    <dd className="text-right">{district.elderlyUserCount} 位</dd>
                  </dl>
                </div>
              </Popup>
            </CircleMarker>
          ))}

        {/* ------------------------- Urban heat island ------------------- */}
        {layers.urbanHeat &&
          districts.map((district) => (
            <CircleMarker
              key={`urban-${district.id}`}
              center={[district.lat, district.lng]}
              radius={district.urbanDensity / 3.2}
              pathOptions={{
                color: '#7c2d12',
                fillColor: '#ea580c',
                fillOpacity: 0.14,
                weight: 1,
                dashArray: '4 4',
              }}
            >
              <Tooltip direction="top">
                <span className="text-xs">
                  {district.district} 都市密度 {district.urbanDensity}/100
                </span>
              </Tooltip>
            </CircleMarker>
          ))}

        {/* --------------------------- Green space ----------------------- */}
        {layers.greenSpace &&
          districts.map((district) => (
            <CircleMarker
              key={`green-${district.id}`}
              center={[district.lat, district.lng]}
              radius={district.greenCoveragePct / 2.2}
              pathOptions={{
                color: '#14532d',
                fillColor: '#22c55e',
                fillOpacity: 0.16,
                weight: 1,
              }}
            >
              <Tooltip direction="top">
                <span className="text-xs">
                  {district.district} 綠覆率 {district.greenCoveragePct}%
                </span>
              </Tooltip>
            </CircleMarker>
          ))}

        {/* ------------------------- Cooling spaces ---------------------- */}
        {layers.coolingSpaces &&
          coolingSpaces
            .filter((space) => space.status === 'ACTIVE')
            .map((space) => (
              <Marker
                key={space.id}
                position={[space.lat, space.lng]}
                icon={coolingIcon(space.accessible, space.airConditioned)}
                eventHandlers={onSpaceClick ? { click: () => onSpaceClick(space) } : undefined}
              >
                <Popup>
                  <div className="min-w-[200px] space-y-1.5">
                    <p className="font-semibold">{space.name}</p>
                    <p className="text-xs text-gray-500">{space.address}</p>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {space.airConditioned && (
                        <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-800">
                          有冷氣
                        </span>
                      )}
                      {space.accessible && (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700">
                          無障礙
                        </span>
                      )}
                    </div>
                    <p className="pt-1 text-xs text-gray-500">開放時間：{space.openingHours}</p>
                  </div>
                </Popup>
              </Marker>
            ))}

        {/* ---------------------------- Residents ------------------------ */}
        {layers.residents &&
          residents.map((resident) => (
            <CircleMarker
              key={resident.id}
              center={[resident.lat, resident.lng]}
              radius={5}
              pathOptions={{
                color: 'white',
                fillColor: RISK_FILL[resident.level],
                fillOpacity: 1,
                weight: 2,
              }}
            >
              <Tooltip direction="top">
                {/* Name and level only. No heart rate, no temperature - a map
                    surface is the wrong place for individual health data. */}
                <span className="text-xs font-medium">
                  {resident.name} · {RISK_STYLES[resident.level].labelZh}
                </span>
              </Tooltip>
            </CircleMarker>
          ))}
      </MapContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend & layer controls
// ---------------------------------------------------------------------------

/**
 * Legend.
 *
 * Each swatch carries its text label rather than relying on a colour key, so
 * the map remains readable for a user with colour vision deficiency.
 */
export function MapLegend({ className }: { className?: string }) {
  const items: { level: RiskLevel; range: string }[] = [
    { level: 'HIGH', range: '熱指數 39°C 以上' },
    { level: 'MEDIUM', range: '熱指數 32–39°C' },
    { level: 'LOW', range: '熱指數 32°C 以下' },
  ];

  return (
    <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-2', className)}>
      {items.map((item) => (
        <span key={item.level} className="flex items-center gap-2 text-xs">
          <span
            className="size-3 shrink-0 rounded-full border-2"
            style={{ backgroundColor: `${RISK_FILL[item.level]}55`, borderColor: RISK_FILL[item.level] }}
            aria-hidden
          />
          <span className="font-medium">{RISK_STYLES[item.level].labelZh}</span>
          <span className="text-muted-foreground">{item.range}</span>
        </span>
      ))}

      <span className="flex items-center gap-2 text-xs">
        <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-[8px] text-white">
          •
        </span>
        <span className="text-muted-foreground">涼適空間</span>
      </span>
    </div>
  );
}

export function LayerControls({
  layers,
  onChange,
  showResidents = false,
  className,
}: {
  layers: MapLayers;
  onChange: (layers: MapLayers) => void;
  /** Only staff roles may enable the resident layer. */
  showResidents?: boolean;
  className?: string;
}) {
  const options: { key: keyof MapLayers; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'heatRisk', label: '熱風險', icon: Layers },
    { key: 'urbanHeat', label: '都市熱島', icon: Building2 },
    { key: 'greenSpace', label: '綠地覆蓋', icon: Trees },
    { key: 'coolingSpaces', label: '涼適空間', icon: AirVent },
    ...(showResidents
      ? [{ key: 'residents' as const, label: '長者分布', icon: Users }]
      : []),
  ];

  return (
    <Card className={className}>
      <CardContent className="flex flex-wrap gap-x-5 gap-y-3 p-4">
        {options.map((option) => (
          <div key={option.key} className="flex items-center gap-2">
            <Checkbox
              id={`layer-${option.key}`}
              checked={layers[option.key]}
              onCheckedChange={(checked) => onChange({ ...layers, [option.key]: Boolean(checked) })}
            />
            <Label
              htmlFor={`layer-${option.key}`}
              className="flex cursor-pointer items-center gap-1.5 text-sm font-normal"
            >
              <option.icon className="size-3.5 text-muted-foreground" />
              {option.label}
            </Label>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
