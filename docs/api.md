# API reference

Base URL `/api`. All responses JSON.

## Authentication

**Prototype only.** The caller is identified by an account id sent as
`x-account-id` (or `Authorization: Bearer <id>`). There are no passwords and no
signed tokens. See [README → Production considerations](../README.md#production-considerations).

*Authorisation*, by contrast, is real and server-enforced: every mutating route
checks a permission from the role table, and caregiver routes are additionally
scoped to assigned residents.

## Error shape

```jsonc
{
  "error": "VALIDATION_FAILED",
  "message": "Some fields need attention.",
  "messageZh": "部分欄位需要修正。",
  "fieldErrors": { "thresholds.medium": "Must sit between the LOW and HIGH thresholds" }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Zod rejected the body; `fieldErrors` is keyed by path |
| 401 | `AUTH_REQUIRED` | No valid account id |
| 403 | `FORBIDDEN` | Role lacks the permission, or resident not assigned |
| 404 | `NOT_FOUND` | No such record |
| 409 | *various* | A meaningful refusal — see below |
| 422 | `PRIVACY_CONSTRAINT` | Blocked by a platform constraint that cannot be overridden |
| 500 | `INTERNAL_ERROR` | Never includes a stack trace |

**409 responses are not failures.** They report that the platform correctly
declined: `CONSENT_REQUIRED`, `DEVICE_UNAVAILABLE`, `SOURCE_DISABLED`,
`BUILT_IN_RULE`, `NOT_MONITORED`, or a suppressed notification. The UI surfaces
the reason rather than treating it as an error.

---

## Auth — `/api/auth`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/accounts` | — | Demo accounts for the login screen |
| POST | `/login` | — | `{ email }` → account + permissions + token |
| GET | `/me` | auth | Current account, linked resident/caregiver |

## Residents — `/api/users`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `user:read` | Joined to live risk, sorted highest-risk first. Scoped for CAREGIVER/ELDER |
| GET | `/:id` | `user:read` + scope | Profile, baseline, history, devices, caregivers, events, alerts |
| POST | `/` | `user:write` | Joins the live loop immediately |
| PATCH | `/:id` | `user:write` | |
| PATCH | `/:id/permissions` | scope | Consent switches — takes effect next tick |
| POST | `/:id/suspend` | `user:suspend` | Toggles; suspended residents are not monitored |
| POST | `/:id/relearn-baseline` | `user:write` | 409 `CONSENT_REQUIRED` without data-storage consent |

### Resident lifecycle

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/:id/suspend` | `user:suspend` | Toggles a temporary pause |
| POST | `/:id/archive` | `user:write` | Off the roster, devices released and their keys revoked. **Reversible**; history and audit kept |
| POST | `/:id/restore` | `user:write` | Comes back as `INACTIVE`, not `ACTIVE` — their sensors are disabled and their baseline is stale |
| DELETE | `/:id` | `user:write` | **Irreversible.** Requires `{confirmName}` matching the resident's name exactly, and only works on an already-archived resident |

Archiving is what "delete" means for a person in a care system: the alerts
raised about them and the actions taken on their behalf stay in the audit
trail, because an audit trail whose subjects can vanish is not one. Erasure
exists for the case where somebody genuinely asks to be erased; the audit entry
recording who erased them is written *before* the deletion, and survives it.

`GET /api/users` excludes archived residents. `?includeArchived=true` brings
them back for the archive view.

## Caregivers — `/api/caregivers`

| Method | Path | Permission |
|---|---|---|
| GET | `/` | `caregiver:read` |
| GET | `/:id/dashboard` | `caregiver:read` — residents sorted highest-risk first, plus open alerts |
| POST | `/` | `caregiver:write` |
| PATCH | `/:id` | `caregiver:write` |
| POST | `/:id/toggle-status` | `caregiver:write` — inactive caregivers receive no notifications |
| POST | `/assign`, `/unassign` | `caregiver:write` |

## Devices & smart home — `/api/devices`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `device:read` | With owner and status summary |
| GET | `/:id` | `device:read` | Plus recent sensor samples |
| GET | `/user/:userId` | `device:read` + scope | |
| POST | `/` | `device:write` | |
| PATCH | `/:id` | `device:write` | |
| POST | `/:id/action` | `device:write` | `configure` \| `reconnect` \| `disable` \| `enable` \| `toggle-power` |
| DELETE | `/:id` | `device:write` | |
| POST | `/:id/ingest-key` | `device:write` | Issues or rotates the device's ingest key. **The key is in this response and nowhere else.** |
| DELETE | `/:id/ingest-key` | `device:write` | Revokes it |
| POST | `/smart-home/:userId` | scope | `{ appliance, on }` |
| POST | `/smart-home/:userId/cancel-automation` | scope | Cancels auto-cooling for this episode |
| POST | `/smart-home/:userId/restore-automation` | scope | |

## Ingest — `/api/ingest`

The door real hardware comes in through. **Authenticated per device, not per
person**: a sensor presents its own key in `X-Device-Key`, and that key
identifies exactly one device.

Keys are stored as a SHA-256 hash and shown once, at issue. A copy of the
database yields nothing replayable, and a lost key can only be replaced, which
revokes the old one.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/readings` | `X-Device-Key` | `{ readings: { field: value }, observedAt? }` |
| GET | `/self` | `X-Device-Key` | What this device may report, and the accepted ranges |

```bash
curl -X POST http://localhost:4000/api/ingest/readings \
  -H "X-Device-Key: hgk_..." \
  -H "Content-Type: application/json" \
  -d '{"readings":{"indoorTempC":34.2}}'
```

### What is refused

A device may post only the fields its hardware measures, only for its own
resident, and only values that could be real. Each rejection names itself:

| Code | Meaning |
|---|---|
| `FIELD_NOT_PERMITTED` | A thermometer may not report a heart rate |
| `OUT_OF_RANGE` | Outside physical plausibility — evidence of a broken sensor, not a dangerous room |
| `UNKNOWN_FIELD` | Not a measurement this platform records |
| `NOT_A_NUMBER` | |
| `TOO_OLD` | Older than 15 minutes; a short backlog is fine, yesterday's temperature is not the present |
| `IN_FUTURE` | Beyond 60s of clock skew |

**Partial acceptance is deliberate.** A watch posting a good heart rate and a
nonsense skin temperature has the heart rate used and the skin temperature
refused, and the response is **202** listing what did not make it. Rejecting the
whole batch would discard a genuine reading because of an unrelated fault.

### After a device becomes real

Posting once changes the device permanently:

- Its measurements outrank the simulator (priority 10 vs 50).
- The value corrects the simulated household, so a real 41.5 °C drives heart
  rate in the coupled model rather than only appearing on screen.
- **The simulator never stands in for it again.** If it falls silent past the
  10-minute validity window, its values are held and marked `OFFLINE` —
  filling the gap with a simulated number that looks exactly like a measurement
  would hide a failed sensor in someone's home.

### The weather source is live, not stored

`ds-weather` is a view of an actual provider rather than a row with a status
column. Its status, error rate, last sync and record count are measured.

| Action | Effect |
|---|---|
| `PATCH /api/data-sources/ds-weather` `{enabled}` | Connects or disconnects the provider — this is what decides whether the process makes outbound calls at all |
| `PATCH` `{config:{endpoint}}` | Changes the URL actually called. Not decoration: pointing it at a staging proxy, or at a black hole to rehearse an outage, is a real operation |
| `POST /api/data-sources/ds-weather/sync` | A real fetch. **502** with the provider's own error when it fails, and `synced:false` — never a cheerful row count for a request that did not reach the network |

## Sensors & readings

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/sensors` | `sensor:read` | Current value per reporting device, with a `stale` flag |
| GET | `/api/sensors/live` | `sensor:read` | Per-resident series |
| GET | `/api/readings/:userId/environment` | `sensor:read` + scope | |
| GET | `/api/readings/:userId/wearable` | `sensor:read` + scope | |
| GET | `/api/readings/:userId/live` | scope | |

## Risk — `/api/risk`

| Method | Path | Permission |
|---|---|---|
| GET | `/` | auth — platform stats, simulation state, config version |
| GET | `/:userId` | scope — assessment, smart home, history, live config |
| GET | `/:userId/events` | scope — level-transition history |

## Risk rules — `/api/risk-rules`

The CMS's control surface over the risk engine.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | `risk-rule:read` | Live config + version |
| PATCH | `/` | `risk-rule:write` | Deep-merges; **re-validates the merged whole**; audits field by field; returns `effect: PlatformStats` already reflecting the change |
| POST | `/preview` | `risk-rule:read` | Runs the real engine against real readings **without saving**; returns projected counts and which residents would move |
| POST | `/reset` | `risk-rule:write` | Restore proposal defaults |

## Action rules — `/api/actions`

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/catalogue` | `action-rule:read` | Every action with bilingual copy |
| GET | `/rules` | `action-rule:read` | Plus `firing` — which rules match right now, and for whom |
| POST | `/rules` | `action-rule:write` | |
| PATCH | `/rules/:id` | `action-rule:write` | |
| DELETE | `/rules/:id` | `action-rule:write` | 409 `BUILT_IN_RULE` for built-ins — disable instead |

## Alerts & notifications

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/alerts` | `alert:read` | Scoped for CAREGIVER; `?status=` filter |
| GET | `/api/alerts/:id` | `alert:read` | Trigger snapshot, AI reasoning, timeline, current assessment |
| PATCH | `/api/alerts/:id` | `alert:write` | Status, reassignment, note → timeline |
| GET | `/api/notifications` | `notification:read` | |
| POST | `/api/notifications/:id/read`, `/read-all` | auth | |
| GET | `/api/notifications/templates` | `notification:read` | Plus available variables |
| POST | `/api/notifications/templates/:key/preview` | `notification:read` | Renders a draft against live data |
| PATCH | `/api/notifications/templates/:key` | `notification:write` | Disabling stops that notification entirely |
| POST | `/api/notifications/test` | `notification:write` | **409 with `reason` when suppressed** by consent, preference, quiet hours or cooldown |

## Places

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/cooling-spaces` | `cooling-space:read` | Non-admins see ACTIVE only |
| GET | `/api/cooling-spaces/recommend/:userId` | scope | Distinguishes *blocked* (location sharing off) from *none in range* |
| POST/PATCH/DELETE | `/api/cooling-spaces[/:id]` | `cooling-space:write` | |
| POST | `/api/cooling-spaces/:id/toggle` | `cooling-space:write` | Disabled locations leave recommendations immediately |
| POST | `/api/cooling-spaces/import` | `cooling-space:write` | Bulk; skips duplicates by name |
| GET | `/api/city-risk` | `city-risk:read` | District aggregates only — no individual data |
| POST | `/api/city-risk/sync` | `city-risk:write` | Persist live district values |

## Content, sources, system, audit

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/content` | `content:read` | Non-admins see published only; `?level=`, `?category=` |
| POST/PATCH/DELETE | `/api/content[/:id]` | `content:write` | **Rejects medical-claim language** (EN + ZH) |
| GET | `/api/data-sources` | `data-source:read` | Never returns credentials |
| PATCH | `/api/data-sources/:id` | `data-source:write` | |
| POST | `/api/data-sources/:id/sync` | `data-source:write` | 409 `SOURCE_DISABLED` if disabled; reports real local row counts |
| GET | `/api/system` | `system:read` | Live service checks, uptime, tick count |
| GET | `/api/settings` | `system:read` | |
| PATCH | `/api/settings/:key` | `system:write` | Type-checked; `privacy.showPhysiologyOnMap` returns **422 by design** |
| GET | `/api/audit-log` | `audit:read` | `?entity=`, `?limit=` |

## Simulation — `/api/simulation`

| Method | Path | Permission |
|---|---|---|
| GET | `/` | auth — state, scenarios, phase labels |
| POST | `/` | `simulation:control` |

Actions: `start`, `stop`, `reset`, `set-scenario`, `set-speed`, `set-focus`,
`set-offsets`.

## Health

`GET /api/health` — unauthenticated readiness probe.

---

## WebSocket — `/ws`

Connect and receive `{ type: 'snapshot', payload: LiveSnapshot }` immediately,
then on every tick (~2s).

```ts
interface LiveSnapshot {
  at: string;
  assessments: Record<string, RiskAssessment>;
  smartHome: Record<string, SmartHomeState>;
  history: Record<string, RiskHistoryPoint[]>;
  simulation: SimulationState;
  stats: PlatformStats;
  cityRisk: CityRisk[];
  alerts: Alert[];
  notifications: Notification[];
  devices: Device[];
  configVersion: number;
}
```

The socket is **read-only for clients**. All mutations go through HTTP so they
pass validation, authorisation and audit logging. The only accepted client
message is `{ type: 'ping' }`.

Clients reconnect automatically with exponential backoff capped at 10 seconds.
