/**
 * Alert escalation policy.
 *
 * Extracted as a pure function so the decision is unit-testable. It previously
 * did not exist at all: `notificationPolicy.escalateAfterMinutes` was
 * editable, audited and displayed in the CMS while nothing acted on it, which
 * meant an operator could reasonably believe an unanswered emergency was being
 * chased when it was not.
 */

import type { Alert, RiskRuleConfig } from '../types/domain.js';

export interface EscalationDecision {
  escalate: boolean;
  /** Minutes the alert has gone unacknowledged, for the timeline entry. */
  ageMinutes: number;
  reason:
    | 'ESCALATE'
    | 'NOT_HIGH'
    | 'ALREADY_HANDLED'
    | 'WITHIN_WINDOW';
}

/**
 * Decide whether an alert should escalate.
 *
 * Escalates only when ALL hold:
 *  - the alert is still NEW (nobody has acknowledged, resolved or escalated it)
 *  - it is a HIGH alert - a MEDIUM advisory going unread is not an emergency
 *  - it has gone unacknowledged for longer than the configured window
 *
 * Acknowledging an alert at any point stops escalation, which is the whole
 * point of the acknowledgement step.
 */
export function shouldEscalate(
  alert: Pick<Alert, 'status' | 'level' | 'createdAt' | 'acknowledgedAt'>,
  config: RiskRuleConfig,
  now: Date = new Date(),
): EscalationDecision {
  const ageMs = now.getTime() - new Date(alert.createdAt).getTime();
  const ageMinutes = Math.max(0, Math.round(ageMs / 60_000));

  // Anything already acknowledged, resolved or previously escalated is out of
  // scope: escalation fires once, and a human has since taken ownership.
  if (alert.status !== 'NEW' || alert.acknowledgedAt) {
    return { escalate: false, ageMinutes, reason: 'ALREADY_HANDLED' };
  }

  if (alert.level !== 'HIGH') {
    return { escalate: false, ageMinutes, reason: 'NOT_HIGH' };
  }

  const windowMs = config.notificationPolicy.escalateAfterMinutes * 60_000;
  if (ageMs < windowMs) {
    return { escalate: false, ageMinutes, reason: 'WITHIN_WINDOW' };
  }

  return { escalate: true, ageMinutes, reason: 'ESCALATE' };
}

// ---------------------------------------------------------------------------
// Consent predicates
// ---------------------------------------------------------------------------

/**
 * Whether physiological readings may be written to storage.
 *
 * Risk is still evaluated for a resident who declines - the live reading is
 * used and discarded. What they give up is history and baseline learning,
 * which is exactly what declining means.
 */
export function mayStorePhysiology(user: {
  permissions: { physiologicalDataStorage: boolean };
}): boolean {
  return user.permissions.physiologicalDataStorage;
}

/** Whether a resident is counted in district-level city statistics. */
export function mayContributeToCityStats(user: {
  status: string;
  permissions: { cityDataContribution: boolean };
}): boolean {
  return user.status === 'ACTIVE' && user.permissions.cityDataContribution;
}
