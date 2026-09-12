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
export function learnPersonalBaseline(
  userId: string,
  readings: WearableReading[],
  fallback?: Pick<PersonalBaseline, 'heartRate' | 'skinTemp' | 'activityStepsPerHour'>,
): PersonalBaseline {
  const MIN_SAMPLES = 12;

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
  const { min, max } = baseline.heartRate;
  const aboveBaseline = heartRateBpm > max;
  const belowBaseline = heartRateBpm < min;

  const deviationBpm = aboveBaseline ? Math.round(heartRateBpm - max) : 0;
  const deviationPct = aboveBaseline ? Math.round(((heartRateBpm - max) / max) * 100) : 0;

  let descriptionZh: string;
  let description: string;

  if (aboveBaseline) {
    descriptionZh = `高於個人平常基準 ${deviationPct}%`;
    description = `${deviationPct}% above personal baseline`;
  } else if (belowBaseline) {
    descriptionZh = '低於個人平常基準';
    description = 'Below personal baseline';
  } else {
    descriptionZh = '在個人平常範圍內';
    description = 'Within personal baseline range';
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
