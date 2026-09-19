/**
 * Weather provider: health, degradation, and the input source it feeds.
 *
 * WHAT CHANGES HERE
 * -----------------
 * Outdoor conditions were the last values in the platform with no possible
 * real origin. Household sensors gained one in Phase 3; the weather feed was
 * still the simulator wearing a label that said so. This module lets a real
 * provider supply them, and - more importantly - defines what happens when
 * that provider stops answering.
 *
 * DEGRADATION IS THE POINT
 * ------------------------
 * Any adapter can call an API on a good day. What decides whether a monitoring
 * platform is trustworthy is the bad day: the provider times out, or returns a
 * 500, or answers with yesterday's reading, and the question is whether anyone
 * downstream can tell. Here they can:
 *
 *   ONLINE    a recent successful fetch
 *   DEGRADED  failing, but the last observation is still usable
 *   OFFLINE   failing long enough that the last observation is no longer current
 *
 * and once a real provider has ever delivered, the simulator does NOT resume
 * covering for it. The outdoor values are held and labelled, exactly as a
 * silent household sensor's are. That rule is the same everywhere in this
 * system for the same reason: a plausible invented number is worse than a
 * visible gap.
 *
 * This module is pure. The HTTP call, the timers and the cache live in
 * `server/services/weatherService.ts`; everything here can be reasoned about
 * and tested without a network.
 */

import type {
  HouseholdState,
  MeasurementField,
  SourceReport,
} from '../types/domain.js';
import { SOURCE_PRIORITY, WEATHER_SOURCE_FIELDS, type InputSource } from './inputSources.js';

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** One reading of outdoor conditions for one place. */
export interface WeatherObservation {
  /** District id this observation is for. */
  locationId: string;
  tempC: number;
  humidityPct: number;
  /**
   * Consecutive recent days at or above the heat threshold.
   *
   * Comes from the provider's own daily history rather than a seeded constant,
   * which is what makes the heatwave risk factor mean something: three days of
   * accumulated heat load is a materially different situation from one hot
   * afternoon, and the platform now knows which it is looking at.
   */
  heatwaveDays: number;
  /** When the provider says the measurement was taken. */
  observedAt: string;
  /** When this platform received it. */
  fetchedAt: string;
  /** Human-readable provider name, for the console and for provenance. */
  provider: string;
}

/**
 * Daily maximum at or above which a day counts toward a heatwave.
 *
 * Taiwan's CWA issues high-temperature information at 36C; 35C is the more
 * common threshold in public-health literature for elevated heat mortality,
 * and this platform is about health outcomes rather than warnings. Stated here
 * rather than buried so that changing it is a deliberate act.
 */
export const HEATWAVE_THRESHOLD_C = 35;

/** Count consecutive recent days at or above the threshold, most recent last. */
export function countHeatwaveDays(
  dailyMaxC: number[],
  threshold = HEATWAVE_THRESHOLD_C,
): number {
  let run = 0;
  for (let i = dailyMaxC.length - 1; i >= 0; i--) {
    if (dailyMaxC[i] >= threshold) run++;
    else break;
  }
  return run;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type WeatherProviderState = 'NOT_CONFIGURED' | 'ONLINE' | 'DEGRADED' | 'OFFLINE';

export interface WeatherHealth {
  state: WeatherProviderState;
  /** Failures since the last success. Drives the backoff. */
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The most recent error, verbatim, so an operator sees the real cause. */
  lastError: string | null;
  lastLatencyMs: number | null;
  attempts: number;
  failures: number;
  /** Not before this time may another attempt be made. */
  retryAfter: string | null;
}

export function initialHealth(enabled: boolean): WeatherHealth {
  return {
    state: enabled ? 'OFFLINE' : 'NOT_CONFIGURED',
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastLatencyMs: null,
    attempts: 0,
    failures: 0,
    retryAfter: null,
  };
}

export const WEATHER_TUNING = {
  /** How often to poll, when healthy. Weather does not change every tick. */
  pollIntervalSec: 600,
  /**
   * How long an observation stays current.
   *
   * Past this the provider is OFFLINE even if it has not errored, because an
   * hour-old outdoor temperature is not the present - and saying otherwise is
   * the failure mode this whole layer exists to prevent.
   */
  observationValiditySec: 3600,
  /** Failures before the provider is called OFFLINE rather than DEGRADED. */
  failuresBeforeOffline: 3,
  /** First backoff step; doubles per failure. */
  backoffBaseSec: 30,
  /** Backoff ceiling, so a long outage still retries about twice an hour. */
  backoffMaxSec: 1800,
} as const;

/** Exponential backoff with a ceiling, in seconds. */
export function backoffSec(consecutiveFailures: number): number {
  const step = WEATHER_TUNING.backoffBaseSec * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(step, WEATHER_TUNING.backoffMaxSec);
}

/**
 * Fold a successful fetch into the health record.
 *
 * Success clears the failure run outright. A provider that recovers is healthy;
 * carrying old failures forward would keep it in a degraded state long after
 * the problem passed, which trains operators to ignore the indicator.
 */
export function recordSuccess(
  health: WeatherHealth,
  latencyMs: number,
  now = new Date(),
): WeatherHealth {
  return {
    ...health,
    state: 'ONLINE',
    consecutiveFailures: 0,
    lastSuccessAt: now.toISOString(),
    lastError: null,
    lastLatencyMs: latencyMs,
    attempts: health.attempts + 1,
    retryAfter: null,
  };
}

/**
 * Fold a failed fetch into the health record.
 *
 * DEGRADED rather than OFFLINE while a usable observation survives: the
 * platform is still working from real data, just not fresh data, and an
 * operator needs to be able to tell those apart when deciding whether to act.
 */
export function recordFailure(
  health: WeatherHealth,
  error: string,
  observation: WeatherObservation | null,
  now = new Date(),
): WeatherHealth {
  const consecutiveFailures = health.consecutiveFailures + 1;
  const usable = observation !== null && observationIsCurrent(observation, now);

  const state: WeatherProviderState =
    usable && consecutiveFailures < WEATHER_TUNING.failuresBeforeOffline ? 'DEGRADED' : 'OFFLINE';

  return {
    ...health,
    state,
    consecutiveFailures,
    lastFailureAt: now.toISOString(),
    lastError: error,
    attempts: health.attempts + 1,
    failures: health.failures + 1,
    retryAfter: new Date(now.getTime() + backoffSec(consecutiveFailures) * 1000).toISOString(),
  };
}

/** Whether an observation is recent enough to be treated as the present. */
export function observationIsCurrent(
  observation: WeatherObservation,
  now = new Date(),
): boolean {
  const ageSec = (now.getTime() - new Date(observation.observedAt).getTime()) / 1000;
  return ageSec <= WEATHER_TUNING.observationValiditySec;
}

/**
 * Re-evaluate state on a tick, with no fetch attempted.
 *
 * Needed because a provider can rot without erroring: if nothing has been
 * fetched for an hour the last observation quietly stops being current, and
 * the console must say OFFLINE rather than showing the ONLINE it earned an
 * hour ago.
 */
export function refreshState(
  health: WeatherHealth,
  observation: WeatherObservation | null,
  enabled: boolean,
  now = new Date(),
): WeatherHealth {
  if (!enabled) return { ...health, state: 'NOT_CONFIGURED' };
  if (health.state === 'NOT_CONFIGURED') return { ...health, state: 'OFFLINE' };

  const usable = observation !== null && observationIsCurrent(observation, now);

  if (!usable && health.state !== 'OFFLINE') {
    return { ...health, state: 'OFFLINE' };
  }

  return health;
}

/** Whether a fetch may be attempted right now. */
export function mayAttempt(health: WeatherHealth, enabled: boolean, now = new Date()): boolean {
  if (!enabled) return false;
  if (!health.retryAfter) return true;
  return now.getTime() >= new Date(health.retryAfter).getTime();
}

// ---------------------------------------------------------------------------
// The input source
// ---------------------------------------------------------------------------

/**
 * Outdoor conditions from a real provider.
 *
 * Outranks the simulated weather source. When the provider is failing this
 * source reports nothing, and because it is a non-fallback source responsible
 * for these fields, the assembler holds the previous values rather than
 * letting anything else invent replacements.
 */
export function weatherProviderSource(
  locationId: string,
  observation: WeatherObservation | null,
  health: WeatherHealth,
  now: Date = new Date(),
): InputSource {
  const id = `weather:provider:${locationId}`;

  /**
   * A provider that has started failing keeps serving its last observation -
   * that measurement is real, and holding it beats inventing a replacement.
   * What must change is the label: nothing is keeping that value current any
   * more, so it is capped at RECENT and carries the reason.
   *
   * OFFLINE is different. There the source reports nothing at all, and because
   * it is a non-fallback source responsible for these fields, the assembler
   * holds the previous values rather than letting the simulator resume. Same
   * rule as a household sensor that has gone quiet, for the same reason.
   */
  const usable =
    observation !== null &&
    observationIsCurrent(observation, now) &&
    health.state !== 'NOT_CONFIGURED' &&
    health.state !== 'OFFLINE';

  const degraded = usable && health.state === 'DEGRADED';

  const values: Partial<Record<MeasurementField, number>> = observation
    ? {
        outdoorTempC: observation.tempC,
        outdoorHumidityPct: observation.humidityPct,
        heatwaveDays: observation.heatwaveDays,
      }
    : {};

  return {
    id,
    kind: 'WEATHER',
    fields: WEATHER_SOURCE_FIELDS,
    priority: SOURCE_PRIORITY.WEATHER_PROVIDER,
    poll(): SourceReport {
      return {
        sourceId: id,
        kind: 'WEATHER',
        origin: 'WEATHER_API',
        fields: WEATHER_SOURCE_FIELDS,
        measurements: usable
          ? WEATHER_SOURCE_FIELDS.filter((f) => values[f] !== undefined).map((field) => ({
              field,
              value: values[field] as number,
              observedAt: observation!.observedAt,
            }))
          : [],
        available: usable,
        qualityCap: degraded ? 'RECENT' : undefined,
        // Measured by a meteorological service, not by this process.
        simulated: false,
        unavailableReasonZh:
          usable && !degraded ? undefined : unavailableReasonZh(health, observation, now),
        unavailableReason:
          usable && !degraded ? undefined : unavailableReason(health, observation, now),
        priority: SOURCE_PRIORITY.WEATHER_PROVIDER,
      };
    },
  };
}

function unavailableReasonZh(
  health: WeatherHealth,
  observation: WeatherObservation | null,
  now: Date,
): string {
  if (health.state === 'NOT_CONFIGURED') return '尚未連接氣象服務';
  if (health.state === 'DEGRADED') return '氣象服務連線異常，顯示最後一次取得的觀測值';
  if (!observation) return '氣象服務尚未回傳任何資料';
  if (!observationIsCurrent(observation, now)) return '氣象資料已過期，服務目前無法更新';
  return '氣象服務連線異常';
}

function unavailableReason(
  health: WeatherHealth,
  observation: WeatherObservation | null,
  now: Date,
): string {
  if (health.state === 'NOT_CONFIGURED') return 'No weather provider is connected';
  if (health.state === 'DEGRADED') {
    return 'The weather provider is failing; showing its last observation';
  }
  if (!observation) return 'The weather provider has not returned any data yet';
  if (!observationIsCurrent(observation, now)) {
    return 'The last weather observation has expired and cannot be refreshed';
  }
  return 'The weather provider is unreachable';
}

/**
 * Whether a live provider should be bypassed for this resident.
 *
 * A scripted demonstration works by driving outdoor temperature upward. Real
 * weather would override it, so the scenario would silently stop working - and
 * the alternative, adding an offset on top of the real value and still calling
 * it WEATHER_API, would be a lie about where the number came from.
 *
 * So during a scenario the focus resident's weather comes from the simulator
 * and is labelled SIMULATOR. Everyone else keeps the real feed.
 */
export function scenarioOverridesWeather(args: {
  isFocus: boolean;
  scenario: string | null;
}): boolean {
  return args.isFocus && Boolean(args.scenario) && args.scenario !== 'AMBIENT';
}

/** Seed a household's outdoor state from a real observation, where there is one. */
export function applyObservation(
  household: HouseholdState,
  observation: WeatherObservation | null,
): HouseholdState {
  if (!observation) return household;
  return {
    ...household,
    outdoorTempC: observation.tempC,
    outdoorHumidityPct: observation.humidityPct,
    heatwaveDays: observation.heatwaveDays,
  };
}
