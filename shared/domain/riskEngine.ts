/**
 * The risk engine.
 *
 * Turns a normalised reading snapshot plus a learned personal baseline into a
 * composite risk score, a risk level, the weighted factors behind it, and a
 * natural-language explanation of *why* the number moved.
 *
 * Every threshold and weight is read from the RiskRuleConfig argument, which
 * the CMS owns. Nothing here is hard-coded, which is what makes an admin
 * changing the MEDIUM threshold from 32C to 33C genuinely change the platform.
 */

import type {
  ReadingProvenance,
  AIExplanation,
  AIExplanationLine,
  BaselineEvaluation,
  PersonalBaseline,
  ReadingSnapshot,
  RiskAssessment,
  RiskFactor,
  RiskFactorKey,
  RiskHistoryPoint,
  RiskLevel,
  RiskRuleConfig,
} from '../types/domain.js';
import { RISK_ORDER } from '../types/domain.js';
import {
  calculateActivityRisk,
  calculatePhysiologicalDeviation,
  evaluateBaseline,
} from './baselineEngine.js';
import { calculateDewPoint, calculateHeatIndex, clamp, normalise, round1 } from './heatIndex.js';
import { defaultProvenance } from './provenance.js';

// ---------------------------------------------------------------------------
// Individual factor calculations
// ---------------------------------------------------------------------------

/**
 * Environmental risk from the indoor heat index, scaled across the
 * CMS-configured threshold band. At the LOW threshold this is 0; at the HIGH
 * threshold it reaches 100 and saturates above.
 */
export function calculateEnvironmentalRisk(
  heatIndexC: number,
  config: RiskRuleConfig,
): number {
  const { low, high } = config.thresholds;
  return Math.round(normalise(heatIndexC, low, high));
}

/**
 * Ventilation risk. Two independent problems compound here:
 *  1. High absolute humidity blocks evaporative cooling (sweating stops working).
 *  2. Indoor air being no cooler than outdoor air means the home offers no
 *     refuge - a classic and under-recognised danger for elderly residents
 *     who keep windows shut.
 */
export function calculateVentilationRisk(
  reading: ReadingSnapshot,
  config: RiskRuleConfig,
): number {
  const { humidityConcernPct, ventilationDeltaC } = config.environment;

  // Humidity component: 0 at the concern threshold, 100 at fully saturated.
  const humidityRisk = normalise(reading.indoorHumidityPct, humidityConcernPct, 100);

  // Stagnation component: indoor should be meaningfully cooler than outdoor.
  const delta = reading.outdoorTempC - reading.indoorTempC;
  const stagnationRisk = delta >= ventilationDeltaC ? 0 : normalise(ventilationDeltaC - delta, 0, 6);

  // Air quality dampens the case for simply opening a window.
  const aqiRisk = normalise(reading.airQualityIndex, 100, 200);

  const combined = humidityRisk * 0.55 + stagnationRisk * 0.35 + aqiRisk * 0.1;
  return Math.round(clamp(combined, 0, 100));
}

/**
 * Heatwave risk from consecutive hot days. Sustained heat matters
 * independently of today's peak: cumulative strain and overnight
 * temperatures that never let the body recover are what drive elderly
 * mortality during heatwaves.
 */
export function calculateHeatwaveRisk(
  reading: ReadingSnapshot,
  config: RiskRuleConfig,
): number {
  const threshold = Math.max(1, config.environment.heatwaveDayThreshold);
  const dayRisk = normalise(reading.heatwaveDays, 0, threshold);

  // A hot night (outdoor still high) prevents physiological recovery.
  const overnightRisk = normalise(reading.outdoorTempC, config.thresholds.medium, config.thresholds.high);

  return Math.round(clamp(dayRisk * 0.7 + overnightRisk * 0.3, 0, 100));
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface RiskFactorInputs {
  reading: ReadingSnapshot;
  baseline: PersonalBaseline;
  config: RiskRuleConfig;
}

/** Build the five weighted factors that make up the composite score. */
export function buildRiskFactors(inputs: RiskFactorInputs): {
  factors: RiskFactor[];
  baselineEval: BaselineEvaluation;
  heatIndex: number;
} {
  const { reading, baseline, config } = inputs;

  const heatIndex = calculateHeatIndex(reading.indoorTempC, reading.indoorHumidityPct);
  const baselineEval = evaluateBaseline(reading.heartRateBpm, baseline);

  const raw: Record<RiskFactorKey, number> = {
    environmental: calculateEnvironmentalRisk(heatIndex, config),
    physiological: calculatePhysiologicalDeviation(baselineEval, config),
    heatwave: calculateHeatwaveRisk(reading, config),
    ventilation: calculateVentilationRisk(reading, config),
    activity: calculateActivityRisk(reading.activityStepsPerHour, baseline),
  };

  const dewPoint = calculateDewPoint(reading.indoorTempC, reading.indoorHumidityPct);
  const indoorOutdoorDelta = round1(reading.outdoorTempC - reading.indoorTempC);

  const meta: Record<
    RiskFactorKey,
    { label: string; labelZh: string; detail: string; detailZh: string }
  > = {
    environmental: {
      label: 'Environmental heat',
      labelZh: '環境熱負荷',
      detail: `Indoor heat index ${heatIndex}C (${reading.indoorTempC}C, ${Math.round(reading.indoorHumidityPct)}% RH)`,
      detailZh: `室內熱指數 ${heatIndex}°C（氣溫 ${reading.indoorTempC}°C、濕度 ${Math.round(reading.indoorHumidityPct)}%）`,
    },
    physiological: {
      label: 'Physiological deviation',
      labelZh: '生理偏離',
      detail: `Heart rate ${Math.round(reading.heartRateBpm)} BPM, ${baselineEval.description} (${baseline.heartRate.min}-${baseline.heartRate.max} BPM)`,
      detailZh: `心率 ${Math.round(reading.heartRateBpm)} BPM，${baselineEval.descriptionZh}（平常 ${baseline.heartRate.min}-${baseline.heartRate.max} BPM）`,
    },
    heatwave: {
      label: 'Heatwave persistence',
      labelZh: '熱浪持續',
      detail: `${reading.heatwaveDays} consecutive hot days, outdoor ${reading.outdoorTempC}C`,
      detailZh: `已連續高溫 ${reading.heatwaveDays} 天，室外 ${reading.outdoorTempC}°C`,
    },
    ventilation: {
      label: 'Ventilation & humidity',
      labelZh: '通風與濕度',
      detail: `Dew point ${dewPoint}C, indoor-outdoor delta ${indoorOutdoorDelta}C, AQI ${Math.round(reading.airQualityIndex)}`,
      detailZh: `露點 ${dewPoint}°C、室內外溫差 ${indoorOutdoorDelta}°C、空氣品質 ${Math.round(reading.airQualityIndex)}`,
    },
    activity: {
      label: 'Activity level',
      labelZh: '活動量',
      detail: `${Math.round(reading.activityStepsPerHour)} steps/hour, usual minimum ${baseline.activityStepsPerHour.min}`,
      detailZh: `每小時 ${Math.round(reading.activityStepsPerHour)} 步，平常最低 ${baseline.activityStepsPerHour.min} 步`,
    },
  };

  // Normalise weights defensively so a mis-entered CMS value cannot push the
  // composite score outside 0..100.
  const weightSum = Object.values(config.weights).reduce((s, w) => s + (w || 0), 0) || 1;

  const keys: RiskFactorKey[] = [
    'environmental',
    'physiological',
    'heatwave',
    'ventilation',
    'activity',
  ];

  const factors: RiskFactor[] = keys.map((key) => {
    const weight = (config.weights[key] ?? 0) / weightSum;
    const score = Math.round(clamp(raw[key], 0, 100));
    return {
      key,
      label: meta[key].label,
      labelZh: meta[key].labelZh,
      score,
      weight: Math.round(weight * 1000) / 1000,
      contribution: Math.round(score * weight * 10) / 10,
      detail: meta[key].detail,
      detailZh: meta[key].detailZh,
    };
  });

  return { factors, baselineEval, heatIndex };
}

/** Sum the weighted contributions into a 0..100 composite score. */
export function calculateTotalRisk(factors: RiskFactor[]): number {
  const total = factors.reduce((sum, f) => sum + f.contribution, 0);
  return Math.round(clamp(total, 0, 100));
}

/**
 * Resolve the risk level.
 *
 * Heat index drives the primary banding, exactly as the proposal specifies.
 * The composite score can then escalate - but never de-escalate - the level,
 * so a dangerous physiological deviation is not hidden by a merely warm room.
 */
export function getRiskLevel(
  heatIndexC: number,
  score: number,
  config: RiskRuleConfig,
): RiskLevel {
  const { medium, high } = config.thresholds;

  let level: RiskLevel = 'LOW';
  if (heatIndexC >= high) level = 'HIGH';
  else if (heatIndexC >= medium) level = 'MEDIUM';

  if (config.scoreEscalation.enabled) {
    if (score >= config.scoreEscalation.highScore) level = 'HIGH';
    else if (score >= config.scoreEscalation.mediumScore && RISK_ORDER[level] < RISK_ORDER.MEDIUM) {
      level = 'MEDIUM';
    }
  }

  return level;
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

/**
 * Produce the natural-language explanation shown in the AI Risk Analysis card.
 *
 * Deliberate safety constraint: this never asserts a diagnosis. It reports
 * measurements and describes risk direction ("熱風險正在升高"), never a
 * clinical claim such as "你已經中暑".
 */
export function generateAIExplanation(args: {
  factors: RiskFactor[];
  baselineEval: BaselineEvaluation;
  heatIndex: number;
  score: number;
  level: RiskLevel;
  reading: ReadingSnapshot;
  history: RiskHistoryPoint[];
  config: RiskRuleConfig;
}): AIExplanation {
  const { factors, baselineEval, heatIndex, score, level, reading, history, config } = args;
  const lines: AIExplanationLine[] = [];

  // --- Trend over the recent window -------------------------------------
  const trend = describeTrend(history, heatIndex);
  if (trend) lines.push(trend);

  // --- Humidity ---------------------------------------------------------
  const humidity = Math.round(reading.indoorHumidityPct);
  if (humidity >= config.environment.humidityConcernPct) {
    lines.push({
      zh: `目前濕度為 ${humidity}%，汗水不易蒸發，散熱效率下降。`,
      en: `Humidity is ${humidity}%, which slows sweat evaporation and reduces the body's ability to shed heat.`,
      factor: 'ventilation',
      direction: 'up',
    });
  } else {
    lines.push({
      zh: `目前濕度為 ${humidity}%，仍在可接受範圍。`,
      en: `Humidity is ${humidity}%, within an acceptable range.`,
      factor: 'ventilation',
      direction: 'flat',
    });
  }

  // --- Physiology relative to personal baseline -------------------------
  if (baselineEval.aboveBaseline) {
    lines.push({
      zh: `目前心率 ${baselineEval.heartRateBpm} BPM，高於個人平常基準 ${baselineEval.deviationPct}%。`,
      en: `Heart rate is ${baselineEval.heartRateBpm} BPM, ${baselineEval.deviationPct}% above the personal baseline.`,
      factor: 'physiological',
      direction: 'up',
    });
  } else if (baselineEval.belowBaseline) {
    lines.push({
      zh: `目前心率 ${baselineEval.heartRateBpm} BPM，略低於個人平常基準。`,
      en: `Heart rate is ${baselineEval.heartRateBpm} BPM, slightly below the personal baseline.`,
      factor: 'physiological',
      direction: 'flat',
    });
  } else {
    lines.push({
      zh: `目前心率 ${baselineEval.heartRateBpm} BPM，在個人平常範圍內（${baselineEval.range.min}-${baselineEval.range.max} BPM）。`,
      en: `Heart rate is ${baselineEval.heartRateBpm} BPM, within the personal range (${baselineEval.range.min}-${baselineEval.range.max} BPM).`,
      factor: 'physiological',
      direction: 'flat',
    });
  }

  // --- Activity ---------------------------------------------------------
  const activityFactor = factors.find((f) => f.key === 'activity');
  if (activityFactor && activityFactor.score >= 50) {
    lines.push({
      zh: '活動量偏低，與平常同一時段相比明顯減少。',
      en: 'Activity is low compared with the usual level for this time of day.',
      factor: 'activity',
      direction: 'up',
    });
  }

  // --- Ventilation stagnation ------------------------------------------
  const delta = round1(reading.outdoorTempC - reading.indoorTempC);
  if (delta < config.environment.ventilationDeltaC) {
    lines.push({
      zh: `室內溫度與室外僅相差 ${Math.abs(delta)}°C，室內未能提供有效降溫空間。`,
      en: `Indoor air is only ${Math.abs(delta)}C different from outdoor, so the home is not providing effective relief.`,
      factor: 'ventilation',
      direction: 'up',
    });
  }

  // --- Heatwave ---------------------------------------------------------
  if (reading.heatwaveDays >= config.environment.heatwaveDayThreshold) {
    lines.push({
      zh: `已連續 ${reading.heatwaveDays} 天高溫，累積熱負荷升高。`,
      en: `${reading.heatwaveDays} consecutive hot days have raised cumulative heat strain.`,
      factor: 'heatwave',
      direction: 'up',
    });
  }

  // --- Summary ----------------------------------------------------------
  const top = [...factors].sort((a, b) => b.contribution - a.contribution)[0];
  const summary = summaryFor(level, top);
  lines.push(summary);

  const headlines: Record<RiskLevel, { zh: string; en: string }> = {
    LOW: { zh: '目前熱風險偏低', en: 'Heat risk is currently low' },
    MEDIUM: { zh: '熱風險正在升高', en: 'Heat risk is rising' },
    HIGH: { zh: '可能存在高熱風險', en: 'Conditions indicate high heat risk' },
  };

  return {
    headline: headlines[level].zh,
    headlineEn: headlines[level].en,
    lines,
    // Confidence blends baseline confidence with how decisive the score is.
    confidence: Math.round(
      clamp(
        (0.55 + 0.4 * baselineEval.confidence) * (0.8 + 0.2 * (Math.abs(score - 50) / 50)),
        0,
        1,
      ) * 100,
    ) / 100,
    forecast: forecastFor(level, history, heatIndex).zh,
    forecastEn: forecastFor(level, history, heatIndex).en,
  };
}

function summaryFor(level: RiskLevel, top: RiskFactor | undefined): AIExplanationLine {
  const driver = top ? top.labelZh : '環境條件';
  const driverEn = top ? top.label.toLowerCase() : 'environmental conditions';

  if (level === 'HIGH') {
    return {
      zh: `綜合判斷，主要風險來自${driver}，建議立即採取降溫措施。`,
      en: `Overall, the leading contributor is ${driverEn}. Immediate cooling measures are advised.`,
      factor: 'summary',
      direction: 'up',
    };
  }
  if (level === 'MEDIUM') {
    return {
      zh: `綜合判斷，熱風險正在升高，主要來自${driver}，建議採取降溫措施。`,
      en: `Overall, heat risk is rising, led by ${driverEn}. Cooling measures are advised.`,
      factor: 'summary',
      direction: 'up',
    };
  }
  return {
    zh: '綜合判斷，目前狀況穩定，維持正常補水即可。',
    en: 'Overall, conditions are stable. Continue normal hydration.',
    factor: 'summary',
    direction: 'flat',
  };
}

/** Compare the current heat index against the window ~30 minutes ago. */
function describeTrend(history: RiskHistoryPoint[], heatIndex: number): AIExplanationLine | null {
  if (history.length < 4) return null;

  const lookback = Math.min(history.length - 1, 30);
  const past = history[history.length - 1 - lookback];
  if (!past) return null;

  const delta = round1(heatIndex - past.heatIndex);

  if (delta >= 1) {
    return {
      zh: `過去 30 分鐘室內熱指數上升 ${delta}°C。`,
      en: `The indoor heat index has risen ${delta}C over the past 30 minutes.`,
      factor: 'trend',
      direction: 'up',
    };
  }
  if (delta <= -1) {
    return {
      zh: `過去 30 分鐘室內熱指數下降 ${Math.abs(delta)}°C。`,
      en: `The indoor heat index has fallen ${Math.abs(delta)}C over the past 30 minutes.`,
      factor: 'trend',
      direction: 'down',
    };
  }
  return {
    zh: '過去 30 分鐘室內熱指數變化不大。',
    en: 'The indoor heat index has been broadly steady over the past 30 minutes.',
    factor: 'trend',
    direction: 'flat',
  };
}

function forecastFor(
  level: RiskLevel,
  history: RiskHistoryPoint[],
  heatIndex: number,
): { zh: string; en: string } {
  const rising =
    history.length >= 4 && heatIndex - history[Math.max(0, history.length - 10)].heatIndex > 0.5;

  if (level === 'HIGH') {
    return rising
      ? {
          zh: '若未降溫，未來 30 分鐘風險可能持續處於高位。',
          en: 'Without cooling, risk is likely to remain high over the next 30 minutes.',
        }
      : {
          zh: '降溫措施已生效，預期風險將於 30-60 分鐘內下降。',
          en: 'Cooling is taking effect; risk is expected to fall within 30-60 minutes.',
        };
  }
  if (level === 'MEDIUM') {
    return rising
      ? {
          zh: '依目前趨勢，未來 30 分鐘可能升至高風險。',
          en: 'On the current trend, risk may reach HIGH within 30 minutes.',
        }
      : {
          zh: '依目前趨勢，風險預期趨於平穩。',
          en: 'On the current trend, risk is expected to level off.',
        };
  }
  return {
    zh: '依目前趨勢，未來一小時預期維持低風險。',
    en: 'On the current trend, risk is expected to stay low for the next hour.',
  };
}

// ---------------------------------------------------------------------------
// Top-level assessment
// ---------------------------------------------------------------------------

export interface AssessRiskArgs {
  userId: string;
  reading: ReadingSnapshot;
  baseline: PersonalBaseline;
  config: RiskRuleConfig;
  history: RiskHistoryPoint[];
  previousLevel: RiskLevel | null;
  /**
   * Per-field data provenance.
   *
   * Optional so the engine can be exercised without device context - a unit
   * test cares about scoring, not freshness. When omitted, everything is
   * reported as simulated and live, which is what a synthetic reading is.
   */
  provenance?: ReadingProvenance;
}

/**
 * Run a complete risk evaluation. Actions are attached separately by the
 * policy engine (see actionEngine.ts) because they depend on device state and
 * user permissions, which are not the risk engine's concern.
 */
export function assessRisk(args: AssessRiskArgs): Omit<RiskAssessment, 'actions'> {
  const { userId, reading, baseline, config, history, previousLevel } = args;
  const provenance = args.provenance ?? defaultProvenance(reading);

  const { factors, baselineEval, heatIndex } = buildRiskFactors({ reading, baseline, config });
  const score = calculateTotalRisk(factors);
  const level = getRiskLevel(heatIndex, score, config);

  const explanation = generateAIExplanation({
    factors,
    baselineEval,
    heatIndex,
    score,
    level,
    reading,
    history,
    config,
  });

  return {
    userId,
    timestamp: reading.timestamp,
    score,
    level,
    heatIndex,
    factors,
    explanation,
    baseline: baselineEval,
    previousLevel,
    escalated: previousLevel !== null && RISK_ORDER[level] > RISK_ORDER[previousLevel],
    recovered: previousLevel !== null && RISK_ORDER[level] < RISK_ORDER[previousLevel],
    readings: reading,
    provenance,
    monitoringIntervalSec: config.monitoringIntervalSec[level],
  };
}
