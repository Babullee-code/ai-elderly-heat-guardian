/**
 * Heat index (apparent temperature) calculation.
 *
 * Implements the NOAA / Rothfusz regression used by the US National Weather
 * Service, including the two documented adjustments, converted to Celsius.
 * The Rothfusz regression is only valid at higher temperatures, so below
 * roughly 26.7C (80F) NOAA specifies a simpler linear formula instead.
 *
 * Reference: NWS Technical Attachment SR 90-23.
 */

const cToF = (c: number): number => (c * 9) / 5 + 32;
const fToC = (f: number): number => ((f - 32) * 5) / 9;

/** Rothfusz coefficients, in Fahrenheit. */
const C1 = -42.379;
const C2 = 2.04901523;
const C3 = 10.14333127;
const C4 = -0.22475541;
const C5 = -6.83783e-3;
const C6 = -5.481717e-2;
const C7 = 1.22874e-3;
const C8 = 8.5282e-4;
const C9 = -1.99e-6;

/**
 * Compute the heat index in Celsius from air temperature (Celsius) and
 * relative humidity (%).
 *
 * @param tempC Air temperature in Celsius.
 * @param humidityPct Relative humidity, 0..100.
 * @returns Apparent temperature in Celsius, rounded to 1 decimal place.
 */
export function calculateHeatIndex(tempC: number, humidityPct: number): number {
  const rh = clamp(humidityPct, 0, 100);
  const t = cToF(tempC);

  // NOAA: below 80F use the simple formula, which is a better fit there.
  const simple = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094);
  if ((simple + t) / 2 < 80) {
    return round1(fToC(simple));
  }

  let hi =
    C1 +
    C2 * t +
    C3 * rh +
    C4 * t * rh +
    C5 * t * t +
    C6 * rh * rh +
    C7 * t * t * rh +
    C8 * t * rh * rh +
    C9 * t * t * rh * rh;

  // Low-humidity adjustment.
  if (rh < 13 && t >= 80 && t <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  }
  // High-humidity adjustment.
  if (rh > 85 && t >= 80 && t <= 87) {
    hi += ((rh - 85) / 10) * ((87 - t) / 5);
  }

  return round1(fToC(hi));
}

/**
 * Human-readable NOAA caution band for a heat index. Used for labelling only;
 * platform risk levels come from the CMS-configured thresholds, not from here.
 */
export function heatIndexBand(heatIndexC: number): {
  key: 'SAFE' | 'CAUTION' | 'EXTREME_CAUTION' | 'DANGER' | 'EXTREME_DANGER';
  label: string;
  labelZh: string;
} {
  if (heatIndexC < 27) return { key: 'SAFE', label: 'Comfortable', labelZh: '舒適' };
  if (heatIndexC < 32) return { key: 'CAUTION', label: 'Caution', labelZh: '注意' };
  if (heatIndexC < 39) return { key: 'EXTREME_CAUTION', label: 'Extreme Caution', labelZh: '特別注意' };
  if (heatIndexC < 52) return { key: 'DANGER', label: 'Danger', labelZh: '危險' };
  return { key: 'EXTREME_DANGER', label: 'Extreme Danger', labelZh: '極度危險' };
}

/**
 * Dew point in Celsius (Magnus formula). Used to explain why a given humidity
 * makes a temperature feel worse than the thermometer suggests.
 */
export function calculateDewPoint(tempC: number, humidityPct: number): number {
  const rh = clamp(humidityPct, 1, 100);
  const a = 17.27;
  const b = 237.7;
  const alpha = (a * tempC) / (b + tempC) + Math.log(rh / 100);
  return round1((b * alpha) / (a - alpha));
}

/**
 * Estimated wet-bulb temperature in Celsius (Stull approximation).
 * Above ~35C wet-bulb, the human body can no longer shed heat by sweating,
 * which is why this matters more than dry-bulb temperature for the elderly.
 */
export function calculateWetBulb(tempC: number, humidityPct: number): number {
  const rh = clamp(humidityPct, 1, 100);
  const wb =
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;
  return round1(wb);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Linear interpolation of `value` from [inMin,inMax] onto [0,100], clamped. */
export function normalise(value: number, inMin: number, inMax: number): number {
  if (inMax === inMin) return value >= inMax ? 100 : 0;
  return clamp(((value - inMin) / (inMax - inMin)) * 100, 0, 100);
}
