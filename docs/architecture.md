# Architecture

## The central decision

**The server owns the truth.** It runs the simulation clock, the risk engine
and the policy engine, and broadcasts a complete snapshot to every connected
client on each tick. The browser renders that snapshot and never recomputes
risk.

Everything else follows from this. The alternative — each client computing risk
from raw readings — would have been easier to build and is how most prototypes
of this shape are written. It was rejected for three reasons:

1. **Two screens could disagree.** In a safety product, the caregiver dashboard
   showing MEDIUM while the resident's phone shows HIGH is not a cosmetic bug.
2. **CMS control would be a lie.** If the client held the thresholds, an admin
   changing one would only affect screens that happened to refetch. Because the
   server holds them, a change re-levels every resident on the next tick and
   reaches every open browser within ~2 seconds.
3. **The demo would need refreshing.** Requirement: the full escalation story
   must play out without a manual refresh anywhere. A single push-based source
   of truth gives that for free.

The cost is that the client cannot work offline and is always a tick behind.
For this product that is the right trade.

## Data flow

```
  SENSORS (simulated)
      │  tickReadings() — physically coupled, not independent noise
      ▼
  DATA INGESTION ───────────► an offline device HOLDS its last value;
      │                        it never fabricates a reading
      ▼
  NORMALISATION  ReadingSnapshot
      │
      ▼
  PERSONAL BASELINE  learned from resting samples per resident
      │
      ▼
  RISK ENGINE   5 weighted factors ──► composite score 0-100
      │                                 heat index ──► level band
      ▼
  RISK LEVEL    LOW / MEDIUM / HIGH
      │
      ▼
  POLICY ENGINE  cumulative level actions ∪ CMS rule output
      │          then gated by: admin policy ∧ user consent ∧ hardware
      ▼
  ACTIONS ──┬── resident guidance
            ├── caregiver notification   (template, channel, quiet hours)
            ├── smart home               (appliance power)
            └── city guidance            (cooling-space ranking)
      │
      ▼
  PERSISTENCE  risk events, alerts, notifications, periodic readings, audit log
      │
      ▼
  BROADCAST    LiveSnapshot over WebSocket to every client

  CMS ──────► configures every stage above
```

## Module responsibilities

### `shared/` — domain logic

Imported verbatim by both the server and the browser. Pure functions, no I/O.

| Module | Responsibility |
|---|---|
| `heatIndex.ts` | NOAA Rothfusz regression, dew point, wet bulb |
| `baselineEngine.ts` | Learn a personal baseline; score deviation from it |
| `riskEngine.ts` | Five factors, composite score, level resolution, explanation |
| `actionEngine.ts` | Action catalogue, rule evaluation, cooling authorisation |
| `simulationEngine.ts` | Scenario phases and the household physics sources sample |
| `coolingSpaces.ts` | Distance, opening hours, recommendation ranking |
| `notificationEngine.ts` | Template interpolation |
| `provenance.ts` | Per-field origin and freshness: the only place staleness is decided |
| `inputSources.ts` | Input sources and the assembler that builds one reading from them |
| `ingest.ts` | Validation, the real-device source, and assimilation of real values |
| `permissions.ts` | Role → permission table |
| `config.ts` | **The only hard-coded thresholds in the codebase** |

The client imports these for one purpose only: so a preview (the rule builder's
"would fire for N residents") uses the *same* evaluator as the server rather
than a reimplementation that could drift.

### `server/`

| Module | Responsibility |
|---|---|
| `services/platformState.ts` | The simulation clock, live state, tick loop, broadcast |
| `db/repositories.ts` | The database abstraction — the only module touching Prisma |
| `routes/*.ts` | REST API: validate → authorise → mutate → audit → reload → respond |
| `middleware/auth.ts` | Account resolution, permission checks, caregiver scoping |
| `middleware/common.ts` | Zod validation, audit recording, error handling |

### `src/`

| Module | Responsibility |
|---|---|
| `store/live.ts` | WebSocket connection, snapshot state, memoised selectors |
| `store/session.ts` | Signed-in account, permissions, elderly-mode preference |
| `lib/api.ts` | Typed fetch wrapper; normalises errors into `ApiError` |
| `components/domain/` | Risk indicators, cards, charts, table, map |
| `pages/app/`, `pages/admin/` | The two experiences |

## The tick loop

`platformState.tick()` runs every `SIM_TICK_MS` (default 2000):

1. Advance the scenario clock, if a scenario is running.
2. For each **ACTIVE** resident:
   a. Generate the next reading (`tickReadings`), coupled to appliance state.
   b. Derive smart-home state from current device records.
   c. Run the risk engine, then the policy engine.
   d. Apply or withdraw cooling — writing to the database **only on change**.
   e. Append to the rolling chart window (180 points, in memory).
   f. On a level transition: persist a risk event, raise or resolve an alert,
      emit notifications.
3. Every 15th tick, persist readings and sensor samples.
4. Every 600th tick, prune reading tables.
5. Recompute district heat risk.
6. Broadcast.

### What is persisted, and what is not

Persisting every tick would be poor engineering and would grow the database
without bound. The split:

**In memory** — current assessment, rolling chart window, simulation clock.
Reconstructible, high-frequency, and meaningless once stale.

**Persisted** — entities, risk events, alerts, notifications, periodic readings
(every 15th tick), configuration, and every administrative change. The
meaningful record.

## Cache invalidation

Every mutating admin route calls the matching `platformState.reload*()` after
writing. `reloadConfig()` additionally **re-evaluates every resident
immediately** rather than waiting for the next scheduled tick, so a threshold
change is visible on the same frame the admin saves it.

This is why the `PATCH /api/risk-rules` response can include `effect:
PlatformStats` — by the time it returns, the new counts are already true.

## Database abstraction

`server/db/repositories.ts` is the only module that imports Prisma. Route
handlers call repositories. Swapping SQLite for PostgreSQL, or Prisma for
anything else, is a change confined to that file.

Structured payloads (risk factors, explanations, permissions, timelines) are
stored as TEXT containing JSON rather than a provider-specific JSON column, and
all (de)serialisation goes through `toJson` / `fromJson`, which fall back
rather than throwing on a malformed row. No model uses a SQLite-specific
feature.

## Security posture

- **Authorisation is server-side.** Every mutating route checks a permission
  from the role table. The client hides controls a role cannot use, but that is
  a courtesy; a VIEWER token calling the API directly receives 403.
- **Validation is server-side.** Every mutation is parsed by a Zod schema. The
  client imports the same schemas for inline form feedback only.
- **Partial updates are re-validated as a whole.** A patch that is individually
  valid can produce an invalid result (raising `medium` above an unchanged
  `high`); `PATCH /api/risk-rules` re-checks the merged object.
- **Caregiver scoping.** A CAREGIVER account can only read residents assigned
  to them — enforced by `requireUserScope`, not by hiding rows.
- **Content validation rejects medical claims** — diagnosis, treatment and
  guarantee language, in both English and Chinese.
- **One setting cannot be enabled at all.** `privacy.showPhysiologyOnMap`
  returns 422 by design: individual physiological data must never reach the
  public city map, and an administrator cannot override that.
- **No secrets in the database.** Data-source configuration holds endpoints and
  intervals; credentials come from environment variables.
- Errors never return stack traces to the client.

## Input sources

The monitoring loop does not generate readings. It advances a household's
**physical state**, then asks **input sources** what they can observe of it.

```
advanceHousehold()        the world: room, weather, body - coupled, no sensors
        |
        v
  source.poll()           each source samples the fields it is responsible for
        |
        v
 assembleReading()        one reading + its provenance, from one set of facts
```

Sources are ranked; lower wins:

| Priority | Source | Status |
|---|---|---|
| 10 | `INGEST` — a real device posting to the API | **in use** |
| 20 | `WEATHER_PROVIDER` — a connected weather service | Phase 4 |
| 50 | `SIMULATED_DEVICE` — the simulator standing in for hardware | in use |
| 55 | `SIMULATED_WEATHER` | in use |
| 90 | `ENVIRONMENT_MODEL` — inference for fields nothing measures | in use |

A device that has posted even once is treated as **real** from then on: the
simulator stops standing in for it, so its silence reads as offline rather than
being papered over. Issuing a key alone does not do this — a key is an
intention, a posted reading is evidence.

Three rules the assembler enforces:

1. **A source that cannot report, reports nothing.** A sensor that has lost
   power does not transmit an old value, so `simulatedDeviceSource` returns an
   empty measurement list rather than a stale number. What to show instead is
   the assembler's decision, not the sensor's.
2. **A fallback never covers for a failure.** If a household has a thermometer
   and it is dead, the value is HELD — the environment model is *blocked* for
   that field. Substituting a modelled guess would hide the failure behind a
   plausible number. The model only supplies fields no device covers at all.
3. **Value and provenance are produced together**, from the same reports, so
   they cannot disagree.

### Physics is separate from measurement

`HouseholdState` is what is physically true in a home; `ReadingSnapshot` is
what its sensors managed to observe. Held values live on the reading and never
enter the state, so a room keeps heating while its thermometer is offline — and
when that sensor reconnects it reports how hot the room *is*, not the value it
froze at. That is both more honest and the precondition for the SENSOR_OFFLINE
scenario in Phase 5.

The practical payoff is that a source is an interface, not a simulation detail.
An HTTP ingest endpoint and a weather provider are additional sources at higher
priority; the monitoring engine, the risk engine and every screen accept them
without changes.

## Data provenance

A `ReadingSnapshot` carries one `simulated` flag and one timestamp for all
nine measurements, so it cannot distinguish "indoor temperature is live from
the living-room sensor" from "the wearable went quiet four minutes ago".
`ReadingProvenance` travels **alongside** the snapshot on every
`RiskAssessment`, one `FieldProvenance` per field:

| Quality | Meaning |
|---|---|
| `LIVE` | Measured within the last 60s |
| `RECENT` | 60–300s old; still usable for a risk decision |
| `STALE` | Older than 300s |
| `OFFLINE` | The device is down, disabled, or the resident is not monitored |

| Origin | Meaning |
|---|---|
| `DEVICE` | A real device reported it |
| `SIMULATOR` | The simulation engine produced it |
| `HELD` | The last successful reading, retained because the source went away |
| `DEFAULT` | No sensor installed; estimated from the environment model |
| `WEATHER_API` | A weather provider supplied it (not yet connected) |

Three distinctions the layer exists to preserve:

1. **Held is not fabricated.** When a sensor drops out the platform retains its
   last value and labels it `HELD`, with the age measured from the device's
   last contact rather than from the snapshot that carried it.
2. **Estimated is not degraded.** 42 of the 50 seeded households have no
   air-quality sensor; that value is modelled, current, and marked `DEFAULT`.
   Reporting it as `OFFLINE` would put almost every resident in a permanent
   warning state and train readers to ignore the badge. `estimatedFields` is
   therefore reported separately from `degradedFields`.
3. **Unmonitored is not fresh.** A suspended resident's reading is frozen
   because nothing refreshes it. Their provenance is rebuilt each tick with
   `monitored: false` so it reads `OFFLINE`, rather than reporting whatever
   age it happened to be frozen at.

Provenance is **descriptive only**. It does not enter the risk score — a
degraded input produces the same number it would have produced live, so the
score stays reproducible. Making data quality influence the score would be a
versioned model change, not a side effect of this layer.

## Known limitations

- Live state is in-process; multiple server instances would need shared state.
- The WebSocket is read-only for clients: all mutations go through HTTP so they
  pass validation, authorisation and audit logging.
- The rolling chart window is capped at 180 points per resident.
- `WEATHER_API` is defined but unused: no weather provider is connected, so
  outdoor values are labelled `SIMULATOR` rather than claiming a live feed.
- Historical chart points carry the heat-index band as an indicative score
  rather than a recomputed composite, because the factor inputs for those older
  samples (activity, heatwave day count) were not persisted. Recomputing them
  would look more precise than the data supports.
