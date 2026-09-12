# Competition demo script

**Total: about 6 minutes.** The full scenario runs ~3.5 minutes on its own, so
there is time to talk over it.

## Before you start

```bash
npm run db:reset   # optional — guarantees a clean, reproducible starting state
npm run dev
```

Open <http://localhost:5173>. Sign in as **平台管理者** (`admin@example.com`).

Optionally open a second browser window side by side, signed in as
**王奶奶** (`elder@example.com`), to show both surfaces moving together.

> **Nothing in this demo requires a page refresh.** The server owns the
> simulation clock and pushes every change over a WebSocket.

---

## 1 · The platform at rest (40 seconds)

Land on `/admin` — 系統總覽.

> "48 elderly residents are being monitored across Taipei right now. Three are
> at high risk, eight need attention, 97% of devices are online, and there are
> eleven open alerts."

**Make the key point early:**

> "None of those numbers are typed in. They come from running the real risk
> engine over each resident's conditions. I'll prove that in a moment by
> changing a threshold and watching them move."

Scroll to *需要關注的長者*. Point at 林阿嬤 and 陳爺爺 — both HIGH.

---

## 2 · Why someone is at risk (50 seconds)

Click into 陳爺爺 (83, 萬華區).

Show the **總覽** tab:

- Heat index ~46°C indoors, heart rate elevated against his personal baseline.
- The AI explanation — measurements and risk direction, no diagnosis.
- The factor breakdown: each factor's score × weight = contribution.

Switch to the **生理基準** tab:

> "This is the clinical heart of the proposal. His baseline — 62 to 74 BPM —
> was *learned* from his own resting measurements, not assumed. The same
> reading that's normal for one resident is a meaningful deviation for another.
> A fixed threshold can't do that."

Point out on the 裝置 tab why he is stuck at HIGH: **he has no air
conditioner, only a fan.**

---

## 3 · The demo scenario (3.5 minutes, talk over it)

Go back to `/admin`, press **示範控制**, then **開始模擬熱風險**.

Switch to the resident view (`/app`, or the second window).

### What to narrate as it happens

| Phase | On screen | Say |
|---|---|---|
| **0:00 LOW** | 「目前安全」, heat index ~29°C, heart rate inside her range | "Grandma Wang is fine. The question the screen answers is 目前安全嗎 — *am I safe right now*." |
| **0:50 rising** | Indoor temperature and humidity climbing | "An afternoon heatwave is building. Nothing has happened to her yet." |
| **1:00 MEDIUM** | Badge turns amber, air conditioner switches itself on | "Risk crossed MEDIUM. Her air conditioner just switched itself on — she didn't do that, and the card says the system did it and why it was allowed to." |
| **1:20** | Caregiver notification appears | "Her son has been notified. Not because she asked — because the policy engine fired." |
| **1:50 HIGH** | Badge turns red, 「請立即採取行動」 | "Now the important part. The air conditioner is still running — and it isn't enough. A domestic unit can only hold a room about 6°C below outdoor. This is exactly why people die of heat in homes that *have* air conditioning." |
| **2:00** | Monitoring cadence changes to 30s; cooling-space list appears | "Two things just happened automatically: monitoring tightened from 5 minutes to 30 seconds, and because the home can no longer protect her, the system is now recommending somewhere that can — with real walking distances and opening hours." |
| **2:40 recovery** | Heat index falling, badge back to amber then green | "The heat is passing and the room is winning again. Risk comes back down through MEDIUM to LOW." |

If you switch to `/admin` at any point during this, the high-risk count, the
alert feed and the heat map have all already moved. No refresh.

### If you are short on time

Open 示範控制 and set the speed multiplier to 2×.

---

## 4 · The CMS is a real control layer (90 seconds)

This is the section that separates this from a mock dashboard.

### a. Change a threshold

Go to `/admin/risk-rules`. Drag the **MEDIUM 門檻** slider from 32°C to 36°C.

**Before saving**, point at the impact preview:

> "It's telling me, right now, that eight residents would move from MEDIUM to
> LOW — and naming them. That's the real engine, run against their real current
> readings, without saving anything."

Press **儲存並套用**, then switch to `/admin`:

> "The dashboard counts have already changed. Every resident was re-levelled
> within one tick, and every open browser was updated."

Go to `/admin/audit-log`:

> "And it recorded exactly what I did: MEDIUM threshold, 32°C to 33°C — field
> by field, not one opaque blob."

**Put it back**: `/admin/risk-rules` → **還原預設值**.

### b. Turn off automatic cooling

Same page, 降溫與通知政策 tab → switch **允許自動降溫** off. Save.

Switch to the resident view:

> "The cooling action is still shown — but marked *not executed*, with the
> reason: platform policy has disabled automatic cooling. It doesn't fail
> silently. If an automation you're trusting with your safety doesn't act, you
> need to be told."

Switch it back on.

### c. Disable a cooling location

`/admin/cooling-spaces` → disable 大安社區活動中心.

Resident view → 指引: that location has disappeared from her recommendations.

### d. Edit a notification template

`/admin/notifications` → edit 高風險警示. Type in the title field and watch the
preview re-render against her live data.

> "That preview is the actual message her son would receive."

---

## 5 · Reach and rigour (60 seconds)

Pick two or three:

**`/app/heat-map`** — 12 Taipei districts modelled with urban density and green
coverage, cooling locations layered on.

> "And a privacy line we enforce in code: this map shows district aggregates
> only. Individual physiological data never appears on it. In
> `/admin/system` that setting is locked — the server returns an error if an
> administrator tries to switch it on. A constraint an admin can disable isn't
> a constraint."

**`/app/caregiver`** — the caregiver dashboard, highest-risk residents first.

**Elderly mode** — account menu → 高齡友善模式. The same data, recomposed:
large type, four cards, a help button. Not a separate app.

**`/admin/action-rules`** — the IF/THEN rule builder, showing which rules are
firing right now and for whom.

**Tests** — `npm test`: 122 tests, including the heat index against published
NOAA values, the personal-baseline property, and the full demo arc itself so it
cannot silently regress.

---

## Closing

> "Monitor, predict, guide. The promise is 提早發現危險，提早採取行動 — find the
> danger early, act early. What we've built is a platform where the
> administration layer genuinely controls the system, where the AI explains
> itself in terms a family can act on, and where — when it can't help — it says
> so instead of pretending."

---

## Recovery

| Problem | Fix |
|---|---|
| Numbers look wrong | 示範控制 → **重設模擬** |
| Want a clean database | `npm run db:reset` |
| Connection indicator not green | Check the API on :4000; the client reconnects automatically with backoff |
| Scenario finished | It falls back to ambient drift; press 開始模擬熱風險 again |

## Reference numbers at rest

| Figure | Value |
|---|---|
| Active residents | 48 (50 registered, 2 suspended/inactive) |
| HIGH / MEDIUM / LOW | 3 / 8 / 37 |
| Devices online | 191 of 197 (97%) |
| Open alerts | 11 |
| Cooling locations | 41 active of 42 |
| Caregivers | 4 active of 5 |
