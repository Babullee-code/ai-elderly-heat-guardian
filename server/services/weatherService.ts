/**
 * Weather provider adapter.
 *
 * The only place in the server that talks to an outside network. Everything
 * about *what the platform does* with weather - freshness, degradation, how a
 * failure is reported - lives in `shared/domain/weather.ts` and is testable
 * without a socket. This file is the socket.
 *
 * OFF BY DEFAULT, ON PURPOSE
 * --------------------------
 * A checkout of this repository makes no outbound requests until somebody
 * turns the provider on. Two reasons: a demo that silently depends on a third
 * party fails in the room rather than in CI, and a monitoring prototype should
 * not start calling an external service because it happened to be started.
 * `ds-weather` therefore reads NOT_CONFIGURED until enabled, which is the
 * truth rather than a placeholder.
 *
 * WHAT IS SENT
 * ------------
 * A district's latitude and longitude, and nothing else. No resident data, no
 * identifiers, no device information. Taipei's twelve district centroids are
 * public coordinates that reveal nothing about who is being monitored.
 */

import type { DataSource } from '../../shared/types/domain.js';
import {
  type WeatherHealth,
  type WeatherObservation,
  WEATHER_TUNING,
  countHeatwaveDays,
  initialHealth,
  mayAttempt,
  recordFailure,
  recordSuccess,
  refreshState,
} from '../../shared/domain/weather.js';
import { TAIPEI_DISTRICTS } from '../db/seedData.js';

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface WeatherProviderLocation {
  id: string;
  lat: number;
  lng: number;
}

/**
 * Something that can answer "what is it like outside, here, now".
 *
 * An interface rather than a concrete client so the Central Weather
 * Administration's API - which needs a key and returns a different shape - can
 * be added later without touching the service, the sources or the UI.
 */
export interface WeatherProvider {
  id: string;
  name: string;
  nameZh: string;
  /** Default endpoint. The operator may point the service elsewhere. */
  endpoint: string;
  fetchCurrent(
    location: WeatherProviderLocation,
    signal: AbortSignal,
    endpoint: string,
  ): Promise<WeatherObservation>;
  /**
   * Fetch several places in one request, where the provider supports it.
   *
   * Optional because not every service does. Where one does, using it is not
   * an optimisation but basic courtesy: twelve parallel requests to a free
   * public API on every poll invites the rate limiting that shows up as a
   * partial failure, and a monitoring platform that manufactures its own
   * degraded states is not measuring the provider, it is measuring itself.
   */
  fetchMany?(
    locations: WeatherProviderLocation[],
    signal: AbortSignal,
    endpoint: string,
  ): Promise<WeatherObservation[]>;
}

// ---------------------------------------------------------------------------
// Open-Meteo
// ---------------------------------------------------------------------------

/**
 * Open-Meteo: a free, keyless forecast API.
 *
 * Chosen for the prototype because it needs no credential, which means this
 * repository can demonstrate a real weather feed without anyone having to
 * obtain and store an API key first. Production in Taiwan would use the CWA
 * open data service; that is a second implementation of this interface, not a
 * rewrite of anything above it.
 */
export const openMeteoProvider: WeatherProvider = {
  id: 'open-meteo',
  name: 'Open-Meteo',
  nameZh: 'Open-Meteo 氣象服務',
  endpoint: 'https://api.open-meteo.com/v1/forecast',

  async fetchCurrent(location, signal, endpoint) {
    const [only] = await openMeteoProvider.fetchMany!([location], signal, endpoint);
    if (!only) throw new Error('Provider returned no observation for this location');
    return only;
  },

  async fetchMany(locations, signal, endpoint) {
    const url = new URL(endpoint);
    url.searchParams.set('latitude', locations.map((l) => l.lat.toFixed(4)).join(','));
    url.searchParams.set('longitude', locations.map((l) => l.lng.toFixed(4)).join(','));
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m');
    // Daily maxima for the past week, so heatwave days are counted from real
    // history rather than carried as a seeded constant that never changes.
    url.searchParams.set('daily', 'temperature_2m_max');
    url.searchParams.set('past_days', '7');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'Asia/Taipei');

    const response = await fetch(url, { signal });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    type Entry = {
      current?: { time?: string; temperature_2m?: number; relative_humidity_2m?: number };
      daily?: { temperature_2m_max?: (number | null)[] };
    };

    // One coordinate returns an object; several return an array.
    const raw = (await response.json()) as Entry | Entry[];
    const entries = Array.isArray(raw) ? raw : [raw];

    if (entries.length !== locations.length) {
      throw new Error(
        `Provider returned ${entries.length} results for ${locations.length} locations`,
      );
    }

    const fetchedAt = new Date().toISOString();

    return locations.map((location, i) => {
      const entry = entries[i];
      const tempC = entry.current?.temperature_2m;
      const humidityPct = entry.current?.relative_humidity_2m;

      // A 200 with the fields missing is a failure, not a reading. Treating it
      // as one would put an undefined straight into the risk engine.
      if (typeof tempC !== 'number' || typeof humidityPct !== 'number') {
        throw new Error(`No current temperature and humidity for ${location.id}`);
      }

      // The final daily entry is today, which is incomplete; count the days
      // before it, which are settled.
      const daily = (entry.daily?.temperature_2m_max ?? []).filter(
        (v): v is number => typeof v === 'number',
      );

      return {
        locationId: location.id,
        tempC,
        humidityPct,
        heatwaveDays: countHeatwaveDays(daily.slice(0, -1)),
        observedAt: entry.current?.time
          ? new Date(entry.current.time).toISOString()
          : fetchedAt,
        fetchedAt,
        provider: openMeteoProvider.nameZh,
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 8000;

class WeatherService {
  private provider: WeatherProvider = openMeteoProvider;
  /**
   * The endpoint actually called.
   *
   * Held here rather than read off the provider because the console exposes it
   * as editable configuration, and a field an operator can change that changes
   * nothing is exactly the kind of decoration this project has been removing.
   * Pointing it at a staging proxy, or at a different CWA host, is a real
   * operational need - and it is also the honest way to take the provider away
   * and watch what the platform does without it.
   */
  private endpoint: string = openMeteoProvider.endpoint;
  private enabled = false;
  private health: WeatherHealth = initialHealth(false);
  private observations = new Map<string, WeatherObservation>();
  private inFlight: Promise<void> | null = null;

  /** Districts to poll, derived from the seeded city data. */
  private locations: WeatherProviderLocation[] = TAIPEI_DISTRICTS.map((d) => ({
    id: d.name,
    lat: d.lat,
    lng: d.lng,
  }));

  isEnabled(): boolean {
    return this.enabled;
  }

  getProvider(): WeatherProvider {
    return this.provider;
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  /**
   * Whether this provider has ever delivered a real observation.
   *
   * The weather equivalent of a device having posted at least once: until it
   * is true the simulator legitimately stands in, and after it is true the
   * simulator must not, because the provider's silence has become information.
   */
  hasDelivered(): boolean {
    return this.observations.size > 0;
  }

  /** Point the service at a different URL, and retry immediately. */
  setEndpoint(endpoint: string): void {
    if (endpoint === this.endpoint) return;
    this.endpoint = endpoint;
    // A changed endpoint is a new situation: clear the backoff so the next
    // attempt happens now rather than after a wait earned by the old one.
    this.health = { ...this.health, retryAfter: null, consecutiveFailures: 0 };
  }

  getHealth(now = new Date()): WeatherHealth {
    // Re-evaluated on read: a provider can go stale without erroring, and the
    // console must not keep showing the ONLINE it earned an hour ago.
    this.health = refreshState(this.health, this.anyObservation(), this.enabled, now);
    return this.health;
  }

  getObservation(locationId: string): WeatherObservation | null {
    return this.observations.get(locationId) ?? null;
  }

  listObservations(): WeatherObservation[] {
    return [...this.observations.values()];
  }

  /** Any observation, used to decide whether a failing provider is still usable. */
  private anyObservation(): WeatherObservation | null {
    const all = this.listObservations();
    if (all.length === 0) return null;
    return all.reduce((newest, o) =>
      new Date(o.observedAt).getTime() > new Date(newest.observedAt).getTime() ? o : newest,
    );
  }

  /**
   * Turn the provider on or off.
   *
   * Disabling keeps the observations it already fetched. They are real
   * measurements and they age out on their own; deleting them would replace
   * genuine, if stale, data with nothing.
   */
  setEnabled(enabled: boolean): WeatherHealth {
    this.enabled = enabled;
    this.health = enabled
      ? { ...this.health, state: 'OFFLINE', retryAfter: null, consecutiveFailures: 0 }
      : { ...initialHealth(false) };
    return this.health;
  }

  /**
   * Fetch every district, if the backoff allows it.
   *
   * Called from the tick loop, which runs far more often than
   * `pollIntervalSec` - so the interval check here is what actually decides
   * the request rate. Hammering a free public API every two seconds would be
   * both rude and pointless: outdoor temperature does not change that fast.
   */
  async poll(now = new Date()): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) return;

    if (!mayAttempt(this.health, this.enabled, now)) return;

    const newest = this.anyObservation();
    if (newest && this.health.state === 'ONLINE') {
      const ageSec = (now.getTime() - new Date(newest.fetchedAt).getTime()) / 1000;
      if (ageSec < WEATHER_TUNING.pollIntervalSec) return;
    }

    this.inFlight = this.fetchAll(now).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /** Fetch once, ignoring the backoff. Used by the console's test button. */
  async fetchNow(now = new Date()): Promise<WeatherHealth> {
    await this.fetchAll(now);
    return this.health;
  }

  private async fetchAll(now: Date): Promise<void> {
    const started = Date.now();

    try {
      const succeeded = await this.fetchLocations();

      if (succeeded.length === 0) {
        throw new Error('No district returned a usable observation');
      }

      for (const observation of succeeded) {
        this.observations.set(observation.locationId, observation);
      }

      this.health = recordSuccess(this.health, Date.now() - started, now);

      if (succeeded.length < this.locations.length) {
        // Some districts answered and some did not. The platform is working
        // from real data, but not complete real data, and an operator should
        // see that rather than a clean ONLINE.
        this.health = {
          ...this.health,
          state: 'DEGRADED',
          lastError: `${this.locations.length - succeeded.length} of ${this.locations.length} districts did not respond`,
        };
      }
    } catch (error) {
      this.health = recordFailure(
        this.health,
        error instanceof Error ? error.message : String(error),
        this.anyObservation(),
        now,
      );
    }
  }

  /**
   * Fetch every district, in one request where the provider allows it.
   *
   * The per-location fallback keeps one district's failure from being the
   * provider's failure - `fetchAll` decides that from how many succeeded.
   */
  private async fetchLocations(): Promise<WeatherObservation[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      if (this.provider.fetchMany) {
        return await this.provider.fetchMany(this.locations, controller.signal, this.endpoint);
      }

      const results = await Promise.all(
        this.locations.map(async (location) => {
          try {
            return await this.provider.fetchCurrent(location, controller.signal, this.endpoint);
          } catch {
            return null;
          }
        }),
      );

      return results.filter((r): r is WeatherObservation => r !== null);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Describe the provider as a DataSource row for the console.
   *
   * Every number here is measured. Phase 0 removed the invented health figures
   * this page used to print; this is what replaces them for the weather feed.
   */
  describe(base: DataSource, now = new Date()): DataSource {
    const health = this.getHealth(now);
    const newest = this.anyObservation();

    const status =
      health.state === 'NOT_CONFIGURED'
        ? 'OFFLINE'
        : health.state === 'ONLINE'
          ? 'ONLINE'
          : health.state === 'DEGRADED'
            ? 'DEGRADED'
            : 'OFFLINE';

    return {
      ...base,
      name: this.provider.name,
      nameZh: this.provider.nameZh,
      provider: this.enabled ? this.provider.name : `${this.provider.name} (not connected)`,
      status,
      lastSyncAt: health.lastSuccessAt ?? newest?.fetchedAt ?? new Date(0).toISOString(),
      recordCount: this.observations.size,
      errorRatePct:
        health.attempts === 0 ? 0 : Math.round((health.failures / health.attempts) * 100),
      config: {
        // What is actually called, not what the provider ships as a default.
        endpoint: this.endpoint,
        intervalSec: WEATHER_TUNING.pollIntervalSec,
        retries: WEATHER_TUNING.failuresBeforeOffline,
      },
      enabled: this.enabled,
    };
  }

  /**
   * Point the service at a different provider.
   *
   * Exists for the tests, which need a provider that fails on demand - killing
   * a real one to prove degradation is not something a test suite can do.
   */
  useProvider(provider: WeatherProvider): void {
    this.provider = provider;
    this.endpoint = provider.endpoint;
    this.observations.clear();
    this.health = initialHealth(this.enabled);
  }
}

export const weatherService = new WeatherService();
