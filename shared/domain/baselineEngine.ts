/**
 * Personal baseline engine.
 *
 * The proposal's central clinical idea: an absolute heart-rate threshold is a
 * poor signal for an individual elderly person. 98 BPM is unremarkable for one
 * user and a meaningful deviation for another. Every physiological judgement
 * in the platform is therefore expressed relative to a *learned personal
 * baseline*, never against a fixed cut-off.
 */

import type {
  BaselineEvaluation,
  BaselineState,
  PersonalBaseline,
  RiskRuleConfig,
  WearableReading,
} from '../types/domain.js';
import { clamp, round1 } from './heatIndex.js';

/**
 * Learn a personal baseline from historical wearable samples.
 *
 * Uses a trimmed inter-percentile range (10th-90th) rather than min/max so a
 * single exertion spike or a dropped sample does not widen the "normal" band
 * and mask a genuine deviation later.
 *
 * @param userId The user the baseline belongs to.
 * @param readings Historical wearable samples. Should cover a resting period.
 * @param fallback Used when there are too few samples to learn from.
 */
/**
 * What a usable baseline requires.
 *
 * Twelve samples is the point at which a trimmed percentile range stops being
 * dominated by individual readings. Three nights is the point at which it
 * stops describing one particular evening - people sleep badly, or warmly, or
 * after a heavy meal, and a band learned from one night carries all of that
 * into every judgement afterwards.
 */
export const BASELINE_REQUIREMENTS = {
  minSamples: 12,
  minNights: 3,
} as const;

/**
 * Hour at which one night is considered to have ended.
 *
 * A night spans midnight, so attributing samples to the calendar date they
 * fall on would split a single night in two and report twice the coverage
 * actually gathered. Samples before this hour belong to the evening that
 * started the day before.
 */
const NIGHT_BOUNDARY_HOUR = 6;

/**
 * Distinct nights covered by a set of samples.
 *
 * Uses local time deliberately: the resting-hours filter that selects these
 * samples does too, and the platform is deployed where its residents live.
 * Mixing local hours with UTC dates would miscount every night by eight hours.
 */
export function countNights(readings: WearableReading[]): number {
  const nights = new Set<string>();

  for (const reading of readings) {
    const at = new Date(reading.recordedAt);
    if (Number.isNaN(at.getTime())) continue;

    const night = new Date(at);
    night.setHours(night.getHours() - NIGHT_BOUNDARY_HOUR);
    nights.add(
      `${night.getFullYear()}-${night.getMonth() + 1}-${night.getDate()}`,
    );
  }

  return nights.size;
}

export interface BaselineReadiness {
  state: BaselineState;
  sampleCount: number;
  nightsCovered: number;
  requiredSamples: number;
  requiredNights: number;
  /** 0..1 across both requirements, for a progress indicator. */
  progress: number;
  /**
   * True while the range shown belongs to the age group rather than to this
   * person. Nothing in the UI may call it personal while this is true.
   */
  usingTypicalRanges: boolean;
  summaryZh: string;
  summary: string;
}

/** Where a baseline stands against what a usable one needs. */
export function baselineReadiness(baseline: PersonalBaseline): BaselineReadiness {
  const { minSamples, minNights } = BASELINE_REQUIREMENTS;

  const sampleCount = baseline.sampleCount;
  // Baselines persisted before nights were recorded: infer nothing, and let
  // sample count alone decide. Claiming coverage that was never measured would
  // be worse than reporting a baseline as less mature than it is.
  const nightsCovered = baseline.nightsCovered ?? 0;

  const hasSamples = sampleCount >= minSamples;
  const hasNights = nightsCovered >= minNights;

  const state: BaselineState = !hasSamples
    ? 'LEARNING'
    : hasNights
      ? 'READY'
      : 'PROVISIONAL';

  const progress =
    (Math.min(1, sampleCount / minSamples) + Math.min(1, nightsCovered / minNights)) / 2;

  const remainingNights = Math.max(0, minNights - nightsCovered);

  const summaryZh =
    state === 'READY'
      ? '已建立個人生理基準。'
      : state === 'PROVISIONAL'
        ? `已使用本人資料，但僅涵蓋 ${nightsCovered} 天，再累積約 ${remainingNights} 天會更準確。`
        : `尚在建立個人基準（已取得 ${sampleCount}/${minSamples} 筆靜息資料），目前先以同齡常見範圍判讀。`;

  const summary =
    state === 'READY'
      ? 'Personal baseline established.'
      : state === 'PROVISIONAL'
        ? `Learned from this resident, but only across ${nightsCovered} day(s); about ${remainingNights} more will settle it.`
        : `Still learning (${sampleCount}/${minSamples} resting samples); using typical ranges for the age group meanwhile.`;

  return {
    state,
    sampleCount,
    nightsCovered,
    requiredSamples: minSamples,
    requiredNights: minNights,
    progress: Math.round(progress * 100) / 100,
    usingTypicalRanges: state === 'LEARNING',
    summaryZh,
    summary,
  };
}

export function learnPersonalBaseline(
  userId: string,
  readings: WearableReading[],
  fallback?: Pick<PersonalBaseline, 'heartRate' | 'skinTemp' | 'activityStepsPerHour'>,
): PersonalBaseline {
  const MIN_SAMPLES = BASELINE_REQUIREMENTS.minSamples;
  const nightsCovered = countNights(readings);

  if (readings.length < MIN_SAMPLES) {
    const base =
      fallback ?? {
        heartRate: { min: 62, max: 84, mean: 73 },
        skinTemp: { min: 33.0, max: 34.6, mean: 33.8 },
        activityStepsPerHour: { min: 40, max: 320, mean: 150 },
      };
    return {
      userId,
      ...base,
      sampleCount: readings.length,
      nightsCovered,
      // Confidence scales with how close we are to a usable sample count.
      confidence: round2(clamp(readings.length / MIN_SAMPLES, 0, 1) * 0.6),
      learnedAt: new Date().toISOString(),
    };
  }

  const hr = percentileRange(readings.map((r) => r.heartRateBpm));
  const skin = percentileRange(readings.map((r) => r.skinTempC));
  const steps = percentileRange(readings.map((r) => r.activityStepsPerHour));

  return {
    userId,
    heartRate: { min: Math.round(hr.min), max: Math.round(hr.max), mean: Math.round(hr.mean) },
    skinTemp: { min: round1(skin.min), max: round1(skin.max), mean: round1(skin.mean) },
    activityStepsPerHour: {
      min: Math.round(steps.min),
      max: Math.round(steps.max),
      mean: Math.round(steps.mean),
    },
    sampleCount: readings.length,
    nightsCovered,
    // More samples means more confidence, saturating around 200 samples.
    confidence: round2(clamp(0.6 + (readings.length / 200) * 0.39, 0, 0.99)),
    learnedAt: new Date().toISOString(),
  };
}

/**
 * Evaluate a current heart rate against the user's personal baseline.
 *
 * Deviation is measured from the *top* of the normal range, so a reading
 * inside the band reports 0% deviation rather than a misleading number
 * relative to the mean.
 */
export function evaluateBaseline(
  heartRateBpm: number,
  baseline: PersonalBaseline,
): BaselineEvaluation {
  const readiness = baselineReadiness(baseline);
  const personal = !readiness.usingTypicalRanges;
  const { min, max } = baseline.heartRate;
  const aboveBaseline = heartRateBpm > max;
  const belowBaseline = heartRateBpm < min;

  const deviationBpm = aboveBaseline ? Math.round(heartRateBpm - max) : 0;
  const deviationPct = aboveBaseline ? Math.round(((heartRateBpm - max) / max) * 100) : 0;

  let descriptionZh: string;
  let description: string;

  /**
   * Wording follows what was actually learned.
   *
   * Until the platform has this resident's own data it is comparing them with
   * typical values for their age group, and calling that "your personal
   * baseline" would be a claim it has not earned - on the one screen whose
   * entire premise is that personal is different from typical.
   */
  const scopeZh = personal ? '個人平常' : '同齡常見';
  const scope = personal ? 'personal baseline' : 'typical range for this age group';

  if (aboveBaseline) {
    descriptionZh = `高於${scopeZh}基準 ${deviationPct}%`;
    description = `${deviationPct}% above ${scope}`;
  } else if (belowBaseline) {
    descriptionZh = `低於${scopeZh}基準`;
    description = `Below ${scope}`;
  } else {
    descriptionZh = `在${scopeZh}範圍內`;
    description = `Within ${scope}`;
  }

  return {
    heartRateBpm: Math.round(heartRateBpm),
    range: { min, max },
    deviationPct,
    deviationBpm,
    aboveBaseline,
    belowBaseline,
    descriptionZh,
    description,
    confidence: baseline.confidence,
    personal,
    state: readiness.state,
  };
}

/**
 * Convert a baseline deviation into a normalised 0..100 physiological risk
 * score, shaped by the CMS-configured physiology window.
 *
 * Below `minDeviationPct` the deviation is treated as noise (score 0); at
 * `maxDeviationPct` it saturates at 100. Between the two the curve is slightly
 * convex, because deviation becoming larger matters more than it beginning.
 */
export function calculatePhysiologicalDeviation(
  evaluation: BaselineEvaluation,
  config: RiskRuleConfig,
): number {
  const { minDeviationPct, maxDeviationPct } = config.physiology;

  if (!evaluation.aboveBaseline) return 0;
  if (evaluation.deviationPct <= minDeviationPct) return 0;

  const span = Math.max(1, maxDeviationPct - minDeviationPct);
  const linear = clamp((evaluation.deviationPct - minDeviationPct) / span, 0, 1);

  // Convex easing: emphasises larger deviations without ever exceeding 100.
  const eased = Math.pow(linear, 0.85);
  const score = eased * 100;

  // A low-confidence baseline should not drive a confident risk claim, so the
  // score is damped toward zero when we have learned from few samples.
  const damped = score * (0.55 + 0.45 * evaluation.confidence);
  return Math.round(clamp(damped, 0, 100));
}

/**
 * Activity risk. For heat illness in the elderly, *unusually low* activity is
 * the warning sign - lethargy and reduced movement often precede a heat
 * emergency - so this scores a drop below the personal activity baseline.
 */
export function calculateActivityRisk(
  activityStepsPerHour: number,
  baseline: PersonalBaseline,
): number {
  const normalMin = Math.max(1, baseline.activityStepsPerHour.min);
  if (activityStepsPerHour >= normalMin) return 0;

  // Fully inactive relative to a normal minimum scores 100.
  const shortfall = (normalMin - activityStepsPerHour) / normalMin;
  return Math.round(clamp(shortfall * 100, 0, 100));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 10th-90th percentile range plus mean, robust to outliers. */
function percentileRange(values: number[]): { min: number; max: number; mean: number } {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { min: 0, max: 0, mean: 0 };

  const at = (p: number) => sorted[clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1)];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;

  return { min: at(0.1), max: at(0.9), mean };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
