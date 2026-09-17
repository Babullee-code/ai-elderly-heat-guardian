# AI 守護高齡者

**AI Elderly Heat Protection & Climate Adaptation Platform**
監測 MONITOR → 預判 PREDICT → 指引 GUIDE

> 「提早發現危險，提早採取行動。」

A working prototype of a connected climate-health platform for elderly
residents: it monitors home environment and physiology, predicts heat risk
against a *learned personal baseline* rather than a fixed threshold, and acts —
engaging authorised cooling, notifying caregivers, and recommending nearby
cooling locations.

---

## What makes this more than a dashboard

Three properties are worth checking, because they are the ones usually faked in
a prototype:

**1. The CMS genuinely controls the running platform.**
The server owns the risk engine and the simulation clock. Changing the MEDIUM
threshold at `/admin/risk-rules` mutates the single configuration the engine
reads; the next tick re-levels every resident and pushes the result to every
open browser over a WebSocket. Disable a cooling location and it disappears
from residents' recommendations. Disable an air conditioner and cooling starts
reporting as *blocked, with the reason*. Disable a notification template and
that notification stops being sent.

**2. Nothing is hard-coded to look good.**
The headline figures on the CMS dashboard — 48 active residents, 3 HIGH,
8 MEDIUM — are not literals. They are derived by running the real risk engine
over seeded ambient conditions. Change a threshold and they change.

**3. Refusals are reported, not swallowed.**
An automatic action that cannot run is shown to the resident with the reason it
did not run. A test notification suppressed by quiet hours reports the
suppression rather than a false success. This is the difference between an
automation you can trust and one you cannot.

---

## Quick start

```bash
npm install
npm run setup     # generate Prisma client, create the SQLite schema, seed data
npm run dev       # API on :4000, web app on :5173
```

Open <http://localhost:5173> and sign in with any demo account.

> **Windows PowerShell 5.1** does not support `&&` as a statement separator.
> Run each command on its own line, or chain with `;` —
> `npm run setup; if ($?) { npm run dev }`.
>
> If a previous run is still holding a port, `taskkill /F /IM node.exe` frees
> both `:4000` and `:5173`.

### Demo accounts

No passwords. Select a role on the login screen.

| Email | Role | Lands on |
|---|---|---|
| `admin@example.com` | SUPER_ADMIN | `/admin` — full control |
| `elder@example.com` | ELDER (王奶奶) | `/app` — resident dashboard |
| `caregiver@example.com` | CAREGIVER (王先生) | `/app/caregiver` |
| `viewer@example.com` | VIEWER | `/admin` — read-only |

> These are demonstration accounts with no authentication. See
> [Production considerations](#production-considerations).

**Start here:** sign in as **admin**, then press **示範控制 → 開始模擬熱風險**.

---

## Live demo (GitHub Pages)

A browser-only build is deployed to GitHub Pages on every push to `main`.

**Important:** GitHub Pages serves static files — it cannot run the Express
server, the WebSocket or the database. The Pages build therefore runs the same
platform *inside the browser*:

- **Unchanged:** every piece of domain logic — heat index, personal-baseline
  learning, the risk engine, the policy engine, cooling-space ranking,
  notification rendering and the simulation. All of it is imported from
  `shared/`, which was deliberately kept free of I/O.
- **Replaced:** the transport only — Prisma becomes an in-memory store
  (`src/demo/backend.ts`), and the WebSocket becomes a local tick loop. HTTP
  requests are intercepted at the fetch layer (`src/demo/routes.ts`), so
  `src/lib/api.ts` and all 26 pages are byte-identical in both modes.

Consequences, stated in-app by a banner rather than left for the visitor to
discover:

| | Full stack | Pages build |
|---|---|---|
| Risk engine | Server | Browser |
| State survives refresh | Yes | **No** — resets to seed |
| Two browsers share state | Yes | **No** |
| Data persisted | SQLite | In memory only |
| Authorisation enforced | Server-side, real | Present and demonstrable, but not a boundary |

The Node server remains the reference implementation. Build it locally with:

```bash
npm run build:static     # VITE_STATIC_DEMO=true, writes dist/ + 404.html
npm run preview:static   # serve dist/ with no backend running
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | API + web, both with hot reload |
| `npm run dev:server` | API only (`:4000`) |
| `npm run dev:web` | Vite only (`:5173`, proxies `/api` and `/ws`) |
| `npm run setup` | `db:generate` + `db:push` + `db:seed` |
| `npm run db:reset` | Delete the database and rebuild it from seed |
| `npm run db:seed` | Re-seed (wipes and rebuilds; idempotent) |
| `npm test` | Vitest suite (133 tests) |
| `npm run typecheck` | `tsc --noEmit` across client, server and shared |
| `npm run build` | Type-check then build the production bundle |

### Environment variables

`.env` (a working copy is committed as `.env.example`):

```ini
DATABASE_URL="file:./dev.db"   # swap for a postgres:// URL to migrate
PORT=4000
NODE_ENV=development
SIM_TICK_MS=2000               # how often risk is recomputed for every resident
```

No secrets are stored in the database or in CMS configuration. The
`/admin/data-sources` screen deliberately holds endpoints and intervals only.

---

## Architecture in one paragraph

The **server owns the truth**. It runs the simulation clock, the risk engine
and the policy engine, and broadcasts a complete snapshot over WebSocket on
every tick. The React client — resident app, caregiver dashboard and CMS alike
— renders that snapshot and never recomputes risk locally. That is why three
screens open side by side cannot disagree, and why no screen needs refreshing
during the demo.

```
sensors ─▶ ingestion ─▶ normalisation ─▶ personal baseline
                                              │
                                              ▼
                                         RISK ENGINE ──▶ risk level
                                              │
                                              ▼
                                        POLICY ENGINE ──▶ actions
                                              │
              ┌───────────────┬────────────────┼────────────────┐
              ▼               ▼                ▼                ▼
          resident        caregiver       smart home      city guidance
              └───────────────┴────────────────┴────────────────┘
                                    ▲
                                    │ configures every stage
                                   CMS
```

Full detail: [`docs/architecture.md`](docs/architecture.md).

### Layout

```
shared/          domain logic shared verbatim by client and server
  domain/        heatIndex, baselineEngine, riskEngine, actionEngine,
                 simulationEngine, coolingSpaces, notificationEngine,
                 permissions, config
  types/         the single type vocabulary
  schemas/       Zod schemas — validation for every mutation
server/
  db/            Prisma client, repositories (the database abstraction), seed
  services/      platformState — simulation clock, risk loop, broadcast
  routes/        REST API
  middleware/    auth, validation, audit, error handling
src/
  pages/app/     resident & caregiver interface
  pages/admin/   administration CMS
  components/    ui primitives, domain components, charts, map
  store/         live (WebSocket) and session state
tests/           133 tests over the domain logic
docs/            architecture, risk engine, CMS, API, demo script
```

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System design, data flow, why the server owns state |
| [`docs/risk-engine.md`](docs/risk-engine.md) | Heat index, personal baseline, factor weighting, level resolution |
| [`docs/cms-architecture.md`](docs/cms-architecture.md) | How each CMS surface controls platform behaviour |
| [`docs/api.md`](docs/api.md) | Every endpoint, with auth and validation |
| [`docs/demo-script.md`](docs/demo-script.md) | The competition walkthrough, timed |
| [`docs/frontend-contract.md`](docs/frontend-contract.md) | UI conventions and constraints |

---

## Testing

```bash
npm test
```

133 tests covering the parts where being wrong matters:

- **Heat index** against published NOAA reference values, with monotonicity and
  boundary-adjustment checks.
- **Personal baseline** — including the central property that the *same* heart
  rate is normal for one resident and a significant deviation for another.
- **Risk engine** — threshold banding, the rule that composite score may
  escalate but never de-escalate a level, and the required
  `LOW → MEDIUM → HIGH → RECOVERY` transition sequence.
- **Policy engine** — cumulative actions, and that cooling is refused unless
  admin policy *and* user consent *and* working hardware all permit it.
- **Permissions** — notably that an ELDER account is exposed no admin surface.
- **Simulation** — that running the air conditioner actually lowers the heat
  index, and that an offline sensor holds its last value instead of inventing
  one.
- **The demo arc itself**, end to end, so the competition storyline cannot
  silently regress.

---

## Production considerations

This is a competition prototype. What would need to change before real use:

**Authentication is a demo stub.** Accounts are selected by email with no
password, and the API identifies a caller by an `x-account-id` header. Replace
`server/middleware/auth.ts` with verified sessions or signed JWTs, add rate
limiting and CSRF protection, and serve over TLS. *Authorisation* is already
enforced server-side on every mutating route and would survive the swap.

**All sensor data is simulated.** No real hardware is connected. Every
generated reading carries `simulated: true`, and the interface says so. The
ingestion boundary is `server/services/platformState.ts`; real device feeds
would replace `tickReadings` and nothing downstream would change.

**SQLite is a prototype choice.** No model uses a SQLite-specific feature, and
structured payloads are stored as TEXT containing JSON, so migrating is
changing the Prisma `provider` and `DATABASE_URL`. Consider real JSON columns
on PostgreSQL and a retention policy for reading tables.

**Live state is in memory.** Current assessments and the simulation clock live
in the server process. A multi-instance deployment needs shared state (Redis)
and a horizontally scalable socket layer.

**Clinical validation.** The risk weightings are a defensible engineering model,
not a validated clinical instrument. The platform deliberately reports risk
direction and measurements and never asserts a diagnosis — this constraint is
enforced in the explanation generator, in the action copy, and by validation on
admin-authored content. Real deployment would require clinical review,
regulatory assessment, and a genuine escalation pathway to emergency services.

**Privacy.** Individual physiological data is never exposed on the city map;
that constraint is enforced server-side and cannot be overridden from the CMS.
A real deployment needs a data protection assessment, explicit consent records,
and an implemented retention policy.

---

## Licence & data

Fictional residents, devices and readings. Taipei district names and
coordinates are real so the map is geographically coherent; the cooling
locations are representative rather than an authoritative register.
