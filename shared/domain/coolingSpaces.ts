/**
 * Cooling-space recommendation.
 *
 * Ranks nearby refuges for a user at elevated heat risk. Distance alone is the
 * wrong ranking: a park with no air conditioning two minutes away is worse
 * than an accessible air-conditioned library eight minutes away for a frail
 * 78-year-old. The match score encodes that judgement.
 *
 * Spaces the CMS has disabled are excluded entirely, which is how an admin
 * toggling a location off makes it disappear from user recommendations.
 */

import type {
  CoolingSpace,
  CoolingSpaceRecommendation,
  CoolingSpaceType,
  ElderlyUser,
  RiskLevel,
} from '../types/domain.js';
import { RISK_ORDER } from '../types/domain.js';
import { clamp } from './heatIndex.js';

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres between two coordinates. */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Walking time estimate. Uses 3.2 km/h rather than a healthy-adult 5 km/h,
 * because the users of this platform are elderly and often walking in heat.
 */
export function walkingMinutes(distanceKm: number): number {
  return Math.max(1, Math.round((distanceKm / 3.2) * 60));
}

/** Is the space open at the given local time? */
export function isOpenNow(space: CoolingSpace, now: Date = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const open = parseTime(space.opensAt);
  const close = parseTime(space.closesAt);

  if (open === null || close === null) return true; // treat unparseable as always open
  if (close <= open) return minutes >= open || minutes < close; // wraps past midnight
  return minutes >= open && minutes < close;
}

function parseTime(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

export const COOLING_SPACE_LABELS: Record<CoolingSpaceType, { label: string; labelZh: string; icon: string }> = {
  LIBRARY: { label: 'Library', labelZh: '圖書館', icon: 'library' },
  COMMUNITY_CENTER: { label: 'Community centre', labelZh: '社區活動中心', icon: 'users' },
  PUBLIC_BUILDING: { label: 'Public building', labelZh: '公共建築', icon: 'building-2' },
  AIR_CONDITIONED_PUBLIC_SPACE: { label: 'Air-conditioned public space', labelZh: '公共冷氣空間', icon: 'air-vent' },
  PARK: { label: 'Park', labelZh: '公園', icon: 'trees' },
  MRT_STATION: { label: 'MRT station', labelZh: '捷運站', icon: 'train-front' },
  HEALTH_CENTER: { label: 'Health centre', labelZh: '衛生所', icon: 'stethoscope' },
};

export interface RecommendArgs {
  user: Pick<ElderlyUser, 'lat' | 'lng' | 'permissions'>;
  spaces: CoolingSpace[];
  /** The user's current risk level - raises the weight on air conditioning. */
  level: RiskLevel;
  /** Maximum distance to consider, in km. */
  maxDistanceKm?: number;
  limit?: number;
  now?: Date;
}

/**
 * Rank cooling spaces for a user.
 *
 * Scoring, all normalised to 0..100 then weighted:
 *  - proximity        (nearer is better)
 *  - air conditioning (decisive at HIGH risk)
 *  - accessibility    (step-free access matters for this population)
 *  - open now         (a closed building is not a refuge)
 *  - local heat risk  (a cool district beats a hot one)
 */
export function recommendCoolingSpaces(args: RecommendArgs): CoolingSpaceRecommendation[] {
  const { user, spaces, level, maxDistanceKm = 5, limit = 8, now = new Date() } = args;

  // A user who has not shared location cannot receive distance-ranked
  // recommendations. Returning nothing here is what drives the honest
  // "location sharing is off" empty state rather than inventing a location.
  if (!user.permissions.locationSharing) return [];

  const highRisk = RISK_ORDER[level] >= RISK_ORDER.MEDIUM;

  const weights = {
    proximity: highRisk ? 0.3 : 0.4,
    airConditioning: highRisk ? 0.3 : 0.2,
    accessibility: 0.15,
    openNow: 0.2,
    localRisk: 0.15,
  };

  const candidates = spaces
    .filter((s) => s.status === 'ACTIVE')
    .map((space) => {
      const distanceKm = Math.round(haversineKm(user, space) * 100) / 100;
      const openNow = isOpenNow(space, now);

      const proximityScore = clamp(100 - (distanceKm / maxDistanceKm) * 100, 0, 100);
      const acScore = space.airConditioned ? 100 : 30;
      const accessScore = space.accessible ? 100 : 40;
      const openScore = openNow ? 100 : 0;
      const localRiskScore = { LOW: 100, MEDIUM: 55, HIGH: 15 }[space.riskLevel];

      const matchScore = Math.round(
        proximityScore * weights.proximity +
          acScore * weights.airConditioning +
          accessScore * weights.accessibility +
          openScore * weights.openNow +
          localRiskScore * weights.localRisk,
      );

      const reasons: string[] = [];
      const reasonsZh: string[] = [];

      if (space.airConditioned) {
        reasons.push('air conditioned');
        reasonsZh.push('有冷氣');
      }
      if (space.accessible) {
        reasons.push('step-free access');
        reasonsZh.push('無障礙進出');
      }
      if (distanceKm <= 1) {
        reasons.push('close by');
        reasonsZh.push('距離很近');
      }
      if (openNow) {
        reasons.push('open now');
        reasonsZh.push('現在開放');
      } else {
        reasons.push('currently closed');
        reasonsZh.push('目前休息中');
      }

      return {
        ...space,
        distanceKm,
        walkingMinutes: walkingMinutes(distanceKm),
        openNow,
        matchScore,
        reason: reasons.join(', '),
        reasonZh: reasonsZh.join('、'),
      } satisfies CoolingSpaceRecommendation;
    })
    .filter((s) => s.distanceKm <= maxDistanceKm);

  return candidates
    .sort((a, b) => b.matchScore - a.matchScore || a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
