# CMS architecture

The CMS is a **control layer**, not a reporting layer. Every screen below
changes how the platform behaves for real residents on the next tick.

## How control actually reaches the platform

Each mutating route follows the same path:

```
validate (Zod)
  → authorise (server-side permission check)
    → write (repository)
      → audit (field-level, with before/after)
        → platformState.reload*()   ← the step that makes it real
          → re-evaluate + broadcast
            → every open browser updates
```

`reloadConfig()` re-evaluates every monitored resident immediately rather than
waiting for the next scheduled tick, which is why a threshold change is visible
on the same frame the admin saves it.

## Screen by screen: what it controls

### `/admin/risk-rules` — 風險規則

The single configuration the risk engine reads. Thresholds, factor weights,
score escalation, monitoring cadence, physiology window, environment
parameters, smart-home policy, notification policy.

**Impact preview.** Before saving, the draft is sent to
`POST /api/risk-rules/preview`, which runs the *real* engine over the *real*
current readings and reports how many residents would move and to where —
without saving. This is the clearest demonstration in the product that the
configuration is load-bearing.

| Change | Effect |
|---|---|
| MEDIUM threshold 32 → 36 | 8 residents move MEDIUM → LOW, dashboard counts change, threshold band on every risk chart moves |
| `allowAutomaticCooling` → false | Platform stops auto-cooling everyone; residents see the cooling action marked *not executed — platform policy* |
| `minLevelForCooling` → LOW | Cooling engages earlier for everyone |
| `monitoringIntervalSec.HIGH` → 15 | Resident-facing copy reads "every 15 seconds" |
| `minLevelForCaregiver` → HIGH | MEDIUM alerts stop notifying caregivers |

### `/admin/action-rules` — 行動政策

The policy engine and its IF/THEN rule builder. Rules are unioned on top of the
proposal's cumulative level model.

The list shows **which rules are firing right now and for whom**, so the policy
reads as live behaviour rather than declaration. The builder's "would fire for
N residents" figure uses `evaluateRule` / `buildRuleContext` imported from the
shared domain — the same functions the server uses — so the preview cannot
drift from reality.

Built-in rules encode the proposal's baseline model. They can be disabled but
not deleted (the API returns 409), so the platform always retains a baseline
policy.

### `/admin/users` and `/admin/users/:id`

Roster with live risk, sorted highest-risk first. The detail page carries
profile, learned baseline, risk history, environment and wearable history,
devices, caregivers, permissions and alerts.

- **Suspend** stops monitoring entirely — no risk calculation, no notifications,
  no automation.
- **Re-learn baseline** re-runs learning over stored resting samples. If the
  resident has not consented to physiological data storage the API returns 409,
  and the UI shows that refusal as a meaningful outcome rather than an error.
- **Permission switches** are the same ones the resident sees in their privacy
  centre, and have the same real effects.

### `/admin/devices` — 裝置管理

Device actions are consequential, and the confirm dialog says how:

| Action | Effect |
|---|---|
| Disable a temperature sensor | That reading stops updating; the platform holds the last value and marks it stale everywhere |
| Disable an air conditioner | Cooling reports as *blocked — no usable appliance*; the resident is told |
| Reconnect | Device resumes reporting on the next tick |
| Toggle power | Directly switches an actuator (refused with 409 if offline) |

### `/admin/sensors` — 感測器監控

Live readings across the platform. A stale row is visibly marked: when a sensor
is offline the platform holds its last value rather than fabricating one, and a
monitoring console that presented a held value as current would be worse than
useless.

### `/admin/alerts` — 警示中心

Alerts are raised by the risk engine on escalation, and on startup for
residents already above threshold. Each alert carries the assessment snapshot
at trigger time — the sensor data, the AI reasoning, the factors, the actions
taken — plus the *current* assessment alongside, so a responder can see whether
the situation has changed.

One heat episode produces one alert thread: an existing open alert is escalated
rather than duplicated.

### `/admin/notifications` — 通知中心

Templates with a **live preview** that interpolates the draft against real
current data, so the admin sees the actual sentence before saving.

- Editing a template changes the message caregivers receive.
- Disabling one stops that notification being sent at all.
- **Test send reports suppression as suppression.** A send blocked by consent,
  caregiver minimum level, quiet hours or the cooldown returns 409 with the
  reason. Reporting that as success would teach the admin their switches do
  nothing.

### `/admin/cooling-spaces` — 涼適空間

Disabling a location removes it from residents' recommendations immediately —
the recommendation engine filters on ACTIVE status. If none remain active, the
RECOMMEND_COOLING_SPACE action reports as blocked.

Supports create, edit, delete, bulk import (validated client-side before
sending, duplicates skipped by name), and a map preview.

### `/admin/heat-map` — 熱風險地圖

District-level risk, live from the socket, so the map moves during a scenario.
This is the only surface that may plot individual residents, and the marker
carries **a name and a risk level only** — never a heart rate, temperature or
address.

### `/admin/content` — 衛教內容

Educational material surfaced to residents by risk level.

Server validation **rejects medical claims** — diagnosis, treatment and
guarantee language in both English and Chinese. The rule is stated in the
editor before an admin can hit it, because a guardrail that only appears as an
error reads as a bug rather than a deliberate safety constraint.

### `/admin/data-sources` — 資料來源

Endpoints, intervals and retry counts. **No credentials are stored here** —
secrets come from environment variables, so a CMS data leak does not leak
access to anything.

Sync reports the number of rows the platform actually holds for that source.
The prototype has no outbound network dependency and says so rather than
implying an integration that is not there.

### `/admin/system` — 系統健康

Real checks, not decorations: the database service pings SQLite, the sensor
service reports the actual proportion of devices reporting, the risk engine
reports its real evaluation count.

Platform settings are editable by type, with one exception:
`privacy.showPhysiologyOnMap` returns **422 by design**. Individual
physiological data must never reach the public city map, and an administrator
cannot override that. A constraint an admin can switch off is not a constraint.

### `/admin/audit-log` — 操作紀錄

Every administrative change with actor, timestamp, entity and before/after
values. Threshold changes are audited **field by field**, so one save produces
entries like:

```
14:32  Admin  Changed MEDIUM threshold   32C → 33C
```

rather than one opaque blob. Read-only: an audit log an administrator can edit
is not an audit log.

## Role-based access

| Role | Capability |
|---|---|
| `SUPER_ADMIN` | Everything, including account management |
| `ADMIN` | Everything except `account:write` |
| `CAREGIVER` | Assigned residents only; may act on their alerts |
| `ELDER` | No administrative surface at all |
| `VIEWER` | Read-only across the platform |

Enforced server-side on every mutating route. The client hides controls a role
cannot use, but that is a courtesy — a VIEWER calling the API directly receives
403, and this is covered by test.

A CAREGIVER is additionally *scoped*: they can only read residents assigned to
them, enforced by `requireUserScope` rather than by filtering rows in the UI.

## Demo controls

`/api/simulation` drives the server-side scenario clock. Because the clock
lives on the server, a scenario started from the CMS is immediately visible in
the resident app and the caregiver dashboard, on every connected browser.

Available: scenario selection (full demo, sustained heatwave, overnight
recovery, cooling unavailable), speed multiplier, manual temperature / humidity
/ heart-rate offsets, pause, and reset to the seeded baseline.
