# Risk engine

## The clinical premise

An absolute heart-rate threshold is a poor signal for an individual elderly
person. 98 BPM is unremarkable for one resident and a meaningful deviation for
another. Every physiological judgement in this platform is therefore expressed
relative to a **learned personal baseline**, never against a fixed cut-off.

This is the proposal's central idea, and it is enforced in code
(`shared/domain/baselineEngine.ts`) and pinned by test:

```ts
it('THE CENTRAL PROPERTY: the same BPM is normal for one person and a deviation for another')
```

## 1. Heat index

`shared/domain/heatIndex.ts` implements the NOAA / NWS Rothfusz regression
including both documented adjustments, converted to Celsius. Below ~26.7°C
(80°F) the regression is invalid, so NOAA's simpler linear formula is used
instead.

Verified against published reference values:

| Air temp | RH | NOAA table | Engine |
|---|---|---|---|
| 32.2°C (90°F) | 70% | 40.6°C (105°F) | 40.6°C |
| 30.0°C (86°F) | 70% | 35.0°C (95°F) | 35.0°C |
| 34.4°C (94°F) | 60% | 43.3°C (110°F) | 43.3°C |

Also computed: **dew point** (Magnus), used to explain why a given humidity
makes a temperature feel worse, and **wet bulb** (Stull), because above roughly
35°C wet-bulb the body can no longer shed heat by sweating at all.

## 2. Personal baseline

### Learning

`learnPersonalBaseline` uses a **trimmed 10th–90th percentile range**, not
min/max. A single exertion spike or a dropped sample would widen a min/max
"normal" band enough to mask genuine deviations afterwards.

Baselines are learned from **resting (overnight) samples only**. A daytime
average is contaminated by activity.

Confidence grows with sample count and saturates near 200 samples. Below 12
samples the engine falls back to a population default at explicitly low
confidence.

### Evaluation

Deviation is measured from the **top of the range**, not the mean, so a reading
inside the band reports 0% rather than a misleading number:

```
baseline 65–82 BPM, current 98 BPM
  → 16 BPM above the top
  → 20% deviation
  → 「高於個人平常基準 20%」
```

### Scoring

`calculatePhysiologicalDeviation` maps deviation onto 0–100 through the
CMS-configured window (`physiology.minDeviationPct` … `maxDeviationPct`), with
a slightly convex curve — deviation *growing* matters more than deviation
*beginning*.

The result is then **damped by baseline confidence**:

```ts
damped = score * (0.55 + 0.45 * confidence)
```

A baseline learned from few samples must not drive a confident risk claim.

### Activity

Counter-intuitively, **low** activity scores high risk. Lethargy and reduced
movement often precede a heat emergency in elderly people, so
`calculateActivityRisk` scores a *drop below* the personal activity baseline.

## 3. The five factors

| Factor | Default weight | What it measures |
|---|---|---|
| `environmental` | 0.35 | Indoor heat index across the configured threshold band |
| `physiological` | 0.25 | Heart-rate deviation from personal baseline |
| `heatwave` | 0.15 | Consecutive hot days plus overnight temperature |
| `ventilation` | 0.15 | Humidity, indoor–outdoor stagnation, air quality |
| `activity` | 0.10 | Drop below the personal activity baseline |

Each is normalised to 0–100 then weighted. Weights are **normalised
defensively** at use, so a mis-entered CMS value cannot push the composite
outside 0–100.

Two factors deserve explanation:

**Ventilation** combines two independent problems: humidity above the concern
threshold blocks evaporative cooling (sweating stops working), and indoor air
that is no cooler than outdoor means the home offers no refuge — a genuine and
under-recognised danger for residents who keep windows shut. Air quality
dampens the case for simply opening a window.

**Heatwave** exists because sustained heat matters independently of today's
peak. Cumulative strain, and overnight temperatures that never let the body
recover, are what drive elderly mortality during heatwaves.

## 4. Level resolution

Heat index drives the primary banding, exactly as the proposal specifies:

| Level | Heat index |
|---|---|
| LOW | below 32°C |
| MEDIUM | 32°C – 39°C |
| HIGH | 39°C and above |

The composite score can then **escalate — but never de-escalate** — the level:

```ts
if (score >= highScore)   level = 'HIGH';
else if (score >= mediumScore && level < MEDIUM) level = 'MEDIUM';
```

The asymmetry is deliberate. A dangerous physiological deviation must not be
hidden by a merely warm room; equally, a low score must not soften a genuinely
dangerous heat index.

All thresholds and weights come from `RiskRuleConfig`, which the CMS owns.
`shared/domain/config.ts` holds the only hard-coded defaults in the codebase.

## 5. AI explanation

`generateAIExplanation` produces the reasoning shown in the AI Risk Analysis
card: a trend line comparing against ~30 minutes ago, humidity, physiology
relative to the personal baseline, activity, ventilation stagnation, heatwave
persistence, and a summary naming the largest contributor.

### The safety constraint

The platform **reports measurements and describes risk direction. It never
asserts a diagnosis.**

- Permitted: 「熱風險正在升高」, 「可能存在高熱風險」, 「建議採取降溫措施」
- Forbidden: 「你已經中暑」

This is enforced by test across the full range of inputs, and is also why
admin-authored content is validated against medical-claim language.

## 6. Monitoring cadence

The configured interval per level (default 300 / 120 / 30 seconds) is attached
to every assessment and surfaced to the resident in the INCREASE_MONITORING
action copy — so "monitoring frequency increased" is a statement about an
actual number the system is using.

## Worked example

Grandma Wang, during the HIGH phase of the demo:

```
Readings    indoor 33.0°C, 72% RH, outdoor 38.9°C, HR 106 BPM, 15 steps/hr
Baseline    67–80 BPM, learned from 54 resting samples, 71% confidence
Heat index  44.4°C

environmental   100 × 0.35 = 35.0   heat index at/above the HIGH threshold
physiological    84 × 0.25 = 21.0   106 BPM is 33% above the top of her range
heatwave         38 × 0.15 =  5.7   1 consecutive hot day, outdoor 38.9°C
ventilation      11 × 0.15 =  1.7   dew point 26.8°C, indoor–outdoor Δ 2.9°C
activity          0 × 0.10 =  0.0   15 steps/hr is within her usual minimum
                            ─────
composite score              73

Level: HIGH — heat index 44.4°C is above the 39°C threshold.

Explanation:
  過去 30 分鐘室內熱指數上升 3.5°C。
  目前濕度為 72%，汗水不易蒸發，散熱效率下降。
  目前心率 106 BPM，高於個人平常基準 33%。
  綜合判斷，主要風險來自環境熱負荷，建議立即採取降溫措施。
```

## Simulation fidelity

The simulation is physically coupled rather than independently randomised, so
the demo demonstrates something rather than animating it:

- Running the air conditioner **actually** pulls indoor temperature down and
  removes moisture, which lowers the heat index and then the risk score.
- **An air conditioner has finite capacity.** It can hold the room roughly 6°C
  below outdoor (scaled by the home's insulation), not to an arbitrary target.
  This is why a resident can reach HIGH risk *with the air conditioner
  running* — which is precisely why people die of heat in homes that have air
  conditioning, and why the platform escalates to recommending a cooling
  location rather than trusting the appliance.
- Heart rate chases thermal load with lag, so recovery is visibly gradual.
- An offline sensor **holds its last value**; it never invents a reading.

Every generated value carries `simulated: true`.

## Baseline warm-up

The platform's central clinical claim is that 98 BPM means different things for
different people. That claim is only true once it has learned what it means for
**this** person, so a baseline is a learned input with a visible maturity:

| State | Meaning | What the screen says |
|---|---|---|
| `LEARNING` | fewer than 12 resting samples | "同齡常見範圍" — typical values for the age group, **not** this person's |
| `PROVISIONAL` | their own data, but under 3 nights | their own range, with how much more would settle it |
| `READY` | 12+ samples across 3+ nights | "個人平常基準" |

**Two requirements, not one.** Twelve samples from a single evening are twelve
samples from a single evening — a resting heart rate varies night to night, and
a band drawn from one will be too narrow, producing false deviations later on
the screen a caregiver is meant to trust. A night is attributed to the evening
it began (boundary 06:00 local), because a night that spans midnight would
otherwise be counted twice.

**The wording follows what was learned.** A newly enrolled resident used to be
told "高於個人平常基準 24%" while the range came from cohort defaults — a
personal claim the platform had not earned, on the one screen whose entire
premise is that personal differs from typical. `BaselineEvaluation.personal`
now carries that distinction and every surface respects it.

**Learning uses resting samples only.** The relearn path previously fell back
to *all* readings when resting samples were thin, doing the very thing its own
comment warned against — and would now also promote the baseline to READY on
daytime data. It does not need that compromise: too few resting samples is a
state the platform can simply be in and say so.

Confidence still damps the physiological factor exactly as before
(`score × (0.55 + 0.45 × confidence)`). **The warm-up work changed no scores** —
it is descriptive. A LEARNING baseline therefore still contributes about 82% of
full physiological weight, which is arguably too confident for a borrowed
range; tightening it would be a versioned model change, not a side effect of
this one.
