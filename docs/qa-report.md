# QA report

Verification performed against the running system — live API calls and a real
browser — not by inspection. Everything below was observed, and the notable
defects found and fixed along the way are recorded rather than quietly
swept up.

## Automated gates

| Gate | Result |
|---|---|
| `npm run typecheck` | **0 errors** across client, server, shared and tests |
| `npm test` | **133 passed** (6 files); demo-arc test run 3× for flakiness |
| `npm run build` | Succeeds; 2,675 modules |

## Requirement verification

### The CMS genuinely controls the platform

| Claim | How verified | Result |
|---|---|---|
| Threshold change re-levels residents | `PATCH /api/risk-rules` medium 32 → 36 | 8 MEDIUM → 1 MEDIUM, returned in `effect` |
| Preview computes without saving | `POST /api/risk-rules/preview` | Projected 37→42 LOW, 8→3 MEDIUM, named 5 residents; config unchanged |
| Preview reaches the browser | Typed 36 into the MEDIUM field in the CMS | Impact panel rendered the same figures live |
| Change is audited field by field | `GET /api/audit-log` | `Changed MEDIUM threshold · 32C → 36C` |
| Reset restores defaults | `POST /api/risk-rules/reset` | Returned to 3 / 8 / 37 |
| Disabled cooling space leaves recommendations | Recommendation engine filters `status === 'ACTIVE'` | Covered by test |
| Disabled template stops sending | `renderNotification` returns null when disabled | Covered by test |

### Demo storyline (requirement 35 / 61)

Ran `FULL_DEMO` at default speed against the live server, sampling every 10s:

```
  0–50s   LOW      HI 28.8 → 31.0   HR 73 → 80   AC off
 60–100s  MEDIUM   HI 32.1 → 37.3   HR 83 → 95   AC ON   (engaged automatically)
110–160s  HIGH     HI 39.7 → 46.6   HR 99 → 109  AC ON   (running, and losing)
170s      MEDIUM   HI 36.3          HR 96        AC ON
180s+     LOW      HI 31.4          HR 87        AC off
```

Confirmed during the run: heart rate deviating from the learned personal
baseline (0% → 43%), monitoring cadence tightening 300s → 30s, caregiver
notifications emitted (29), cooling-space recommendations appearing at HIGH,
and the CMS dashboard counts moving **without any page refresh**.

Also pinned as a test (`THE DEMO ARC`) so it cannot silently regress.

### Security and authorisation

Verified by direct API calls, bypassing the UI:

| Case | Expected | Actual |
|---|---|---|
| VIEWER `PATCH /api/risk-rules` | 403 | **403** |
| ELDER `GET /api/audit-log` | 403 | **403** |
| ELDER `GET /api/risk-rules` | 403 | **403** |
| ELDER reads another resident | 403 | **403** |
| CAREGIVER reads unassigned resident | 403 | **403** |
| CAREGIVER reads assigned resident | 200 | **200** |
| No credentials `GET /api/users` | 401 | **401** |

### Safety constraints

| Constraint | Verified |
|---|---|
| `privacy.showPhysiologyOnMap` cannot be enabled | 422 `PRIVACY_CONSTRAINT` |
| Content rejects English medical claims | 400, `fieldErrors.title` |
| Content rejects **Chinese** medical claims | 400, `fieldErrors.titleZh` (see note below) |
| Legitimate safety content passes | 201 |
| Built-in policy rules cannot be deleted | 409 `BUILT_IN_RULE` |
| Merged config re-validated as a whole | 400 on `medium: 45` with unchanged `high: 39` |
| Explanations never assert a diagnosis | Test across full input range |

### Accessibility

- Risk is never conveyed by colour alone: every indicator pairs colour with an
  icon and a text label, enforced centrally in `RISK_STYLES` / `RiskBadge`.
- Focus is restyled, never removed.
- Mobile bottom navigation targets are 64px (80px in elderly mode), above the
  44px minimum.
- `prefers-reduced-motion` is respected globally.
- Form errors use `aria-invalid` + `aria-describedby`; toasts use `role="alert"`
  for errors and `role="status"` otherwise; tables carry `scope` and
  `aria-sort`.
- Elderly mode verified at 375×812: large type, four sections, help button.

### Interfaces rendered and exercised

Login, resident dashboard (LOW and HIGH states), elderly mode, monitor,
predict, guide, heat map, caregiver dashboard, devices, settings, privacy;
CMS dashboard, users, user detail, caregivers, devices, sensors, risk rules,
action rules, heat map, cooling spaces, alerts, notifications, content, data
sources, system, audit log. 26 page modules, smallest 10.5 KB — no stubs.

## Defects found and fixed

| # | Defect | Cause | Fix |
|---|---|---|---|
| 1 | CMS crashed with "Maximum update depth exceeded" | Store selectors (`selectOpenAlerts` etc.) built a new array per call, so `useSyncExternalStore` saw a changed snapshot every render | Memoised derived selectors on their input reference; shared `EMPTY` constant for absent slices |
| 2 | Cohort was 11 HIGH / 0 MEDIUM instead of 3 / 8 | Seed ambient values set as though they were heat-index values rather than air temperatures | Calibrated every resident against the real NOAA curve |
| 3 | Demo never reached HIGH; oscillated LOW↔MEDIUM | Simulated air conditioner had unbounded capacity and always won | Modelled finite capacity (~6°C below outdoor, scaled by insulation) — physically correct, and the reason heat deaths occur in homes that *have* air conditioning |
| 4 | Wang's baseline read 71–76 BPM, not the specified 65–82 | Seed's resting-sample variance too narrow, and only ~18 night samples | Widened resting spread, extended history to 72h (54 resting samples) |
| 5 | At-risk residents showed +0% deviation | Baseline learned from their *elevated* readings, so the engine treated their stressed state as normal | Learn from resting samples at the resident's own band, with damped thermal term — the precise failure the personal-baseline approach exists to avoid |
| 6 | Server crashed each tick: `replaceAlert is not a function` | Method referenced but never defined | Implemented |
| 7 | Alert centre empty while dashboard showed residents at risk | Alerts only raised on *transition*; residents already above threshold at boot produced none | Open cases at startup for anyone already at MEDIUM+ |
| 8 | ~60 type errors across server routes | Express 5 types `req.params.x` as `string \| string[]` | Added typed `pathParam` accessor rather than scattering casts |

### Second audit — controls that presented as working and did not

A later audit of the input pipeline found four more, missed by the first pass
because each one *looked* correct in the UI. Two were privacy switches, which
makes them worse than a missing feature: the resident was told the control did
something it did not.

| # | Defect | Cause | Fix |
|---|---|---|---|
| 9 | `physiologicalDataStorage` did not stop storage | `recordWearable()` ran unconditionally; the consent only gated the re-learn endpoint | Storage gated. Risk is still evaluated from the live reading; what the resident gives up is history and baseline learning, which is what declining means |
| 10 | `cityDataContribution` enforced nowhere | Existed only as a default value; district counts included everyone | Counts recomputed each tick from live consent |
| 11 | `escalateAfterMinutes` was a dead setting | Editable, audited and displayed while no timer acted on it | Unacknowledged HIGH alerts now escalate once, record the emergency contact on the timeline, and notify caregivers holding emergency permission |
| 12 | Data sources reported invented figures | Weather feed shown ONLINE with 128,450 records and a 0.2% error rate; nothing had ever called it | Unconnected feeds report OFFLINE with zero records; simulated feeds are labelled as such |

Verified against a running server: consent off → 0 new wearable rows over two
persist cycles (consent on → 2); withdrawing city consent → district total
48 → 47; `escalateAfterMinutes=1` → 3 HIGH alerts escalated, 8 MEDIUM correctly
untouched.

The escalation decision and both consent predicates were extracted to
`shared/domain/alertPolicy.ts` as pure functions and pinned by 11 new tests, so
they are shared by both backends rather than diverging.

**Correction to this report:** its first version stated that an audit found no
placeholders or no-op handlers. That was wrong — the audit searched for
`TODO`/`onClick={() => {}}` patterns, which these four defects do not match.
A control can be fully wired to a backend that ignores it.

### Test defects (my assertions, not the engine)

Three initial failures were wrong reference values in my own tests, corrected
after checking the engine against the published NOAA table: 86°F/70% is 95°F
(not 92°F) and 94°F/60% is 110°F (not 111°F). One phase-boundary test was
rewritten to derive boundaries from the scenario definition rather than pinning
literal seconds.

## Known limitations

Architectural limitations (in-process state, the read-only socket, the chart
window cap, indicative historical scores) are documented once in
[`architecture.md`](architecture.md#known-limitations) rather than repeated here.
Limitations specific to this verification run:

- **Bundle is ~2 MB** (529 KB gzipped), dominated by Recharts and Leaflet.
  Acceptable for a local demo; production should code-split by route.
- **Authentication is a demo stub** — see README. Authorisation is real.
- **Timezone** follows the host clock; `isOpenNow` and quiet hours use local
  time. A deployment would pin Asia/Taipei.
- Testing was done in Chromium at 1280×720 and 375×812. Other engines and
  intermediate breakpoints were not exhaustively swept.

## Note on the Chinese content-filter test

An initial run appeared to show the Chinese medical-claim patterns failing. On
investigation the regex was correct — the Windows shell had mangled the UTF-8
into `????` before it reached the server, so the filter was never given Chinese
text. Re-tested by posting a UTF-8 file directly: the claim was correctly
rejected on `titleZh`. The three junk articles created during that test were
deleted, and the content set verified back to the seeded 7.
