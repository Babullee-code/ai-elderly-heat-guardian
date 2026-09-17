/**
 * Alert escalation and consent-gating tests.
 *
 * These pin four defects found during the input-pipeline audit, all of which
 * were controls that appeared to work and did not:
 *
 *  1. `physiologicalDataStorage` did not stop physiological writes
 *  2. `cityDataContribution` was enforced nowhere at all
 *  3. `escalateAfterMinutes` was editable and audited but no timer acted on it
 *  4. (not unit-testable) data sources reported invented health figures
 *
 * A consent switch that does not do what it says is worse than not offering
 * one, so these behaviours are pinned rather than left to manual checking.
 */

import { describe, expect, it } from 'vitest';
import {
  mayContributeToCityStats,
  mayStorePhysiology,
  shouldEscalate,
} from '../shared/domain/alertPolicy';
import { cloneDefaultConfig } from '../shared/domain/config';
import type { Alert, RiskLevel } from '../shared/types/domain';

const NOW = new Date('2026-09-17T14:00:00Z');

function alert(overrides: Partial<Alert> = {}): Pick<
  Alert,
  'status' | 'level' | 'createdAt' | 'acknowledgedAt'
> {
  return {
    status: 'NEW',
    level: 'HIGH' as RiskLevel,
    // 30 minutes old by default - well past the 10-minute default window.
    createdAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    acknowledgedAt: null,
    ...overrides,
  };
}

describe('shouldEscalate', () => {
  const config = cloneDefaultConfig();

  it('escalates a HIGH alert nobody has acknowledged', () => {
    const decision = shouldEscalate(alert(), config, NOW);
    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe('ESCALATE');
    expect(decision.ageMinutes).toBe(30);
  });

  it('does NOT escalate inside the configured window', () => {
    const recent = alert({ createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() });
    const decision = shouldEscalate(recent, config, NOW);

    expect(decision.escalate).toBe(false);
    expect(decision.reason).toBe('WITHIN_WINDOW');
  });

  it('ACKNOWLEDGEMENT STOPS ESCALATION - the point of the acknowledge step', () => {
    expect(
      shouldEscalate(alert({ status: 'ACKNOWLEDGED' }), config, NOW).escalate,
    ).toBe(false);

    expect(
      shouldEscalate(
        alert({ acknowledgedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() }),
        config,
        NOW,
      ).escalate,
    ).toBe(false);
  });

  it('never escalates twice', () => {
    const decision = shouldEscalate(alert({ status: 'ESCALATED' }), config, NOW);
    expect(decision.escalate).toBe(false);
    expect(decision.reason).toBe('ALREADY_HANDLED');
  });

  it('never escalates a resolved alert', () => {
    expect(shouldEscalate(alert({ status: 'RESOLVED' }), config, NOW).escalate).toBe(false);
  });

  it('only escalates HIGH - an unread MEDIUM advisory is not an emergency', () => {
    expect(shouldEscalate(alert({ level: 'MEDIUM' }), config, NOW).reason).toBe('NOT_HIGH');
    expect(shouldEscalate(alert({ level: 'LOW' }), config, NOW).reason).toBe('NOT_HIGH');
  });

  it('CMS CONTROL: the configured window actually moves the boundary', () => {
    const eightMinutesOld = alert({
      createdAt: new Date(NOW.getTime() - 8 * 60_000).toISOString(),
    });

    // Default window is 10 minutes, so 8 minutes is still inside it.
    expect(shouldEscalate(eightMinutesOld, config, NOW).escalate).toBe(false);

    const impatient = cloneDefaultConfig();
    impatient.notificationPolicy.escalateAfterMinutes = 5;
    expect(shouldEscalate(eightMinutesOld, impatient, NOW).escalate).toBe(true);

    const patient = cloneDefaultConfig();
    patient.notificationPolicy.escalateAfterMinutes = 60;
    expect(shouldEscalate(alert(), patient, NOW).escalate).toBe(false);
  });
});

describe('consent gating', () => {
  const consents = (overrides: Record<string, boolean> = {}) => ({
    automaticCooling: true,
    caregiverNotifications: true,
    locationSharing: true,
    physiologicalDataStorage: true,
    cityDataContribution: true,
    ...overrides,
  });

  it('STORAGE CONSENT: declining stops physiological data being written', () => {
    expect(mayStorePhysiology({ permissions: consents() })).toBe(true);
    expect(
      mayStorePhysiology({ permissions: consents({ physiologicalDataStorage: false }) }),
    ).toBe(false);
  });

  it('CITY STATS CONSENT: declining removes the resident from district counts', () => {
    expect(
      mayContributeToCityStats({ status: 'ACTIVE', permissions: consents() }),
    ).toBe(true);

    expect(
      mayContributeToCityStats({
        status: 'ACTIVE',
        permissions: consents({ cityDataContribution: false }),
      }),
    ).toBe(false);
  });

  it('a suspended resident is never counted, consent or not', () => {
    expect(
      mayContributeToCityStats({ status: 'SUSPENDED', permissions: consents() }),
    ).toBe(false);
    expect(
      mayContributeToCityStats({ status: 'INACTIVE', permissions: consents() }),
    ).toBe(false);
  });

  it('the two consents are independent of each other', () => {
    // Declining city statistics must not silently disable personal history,
    // and vice versa - they are separate promises to the resident.
    const noStats = consents({ cityDataContribution: false });
    expect(mayStorePhysiology({ permissions: noStats })).toBe(true);

    const noStorage = consents({ physiologicalDataStorage: false });
    expect(mayContributeToCityStats({ status: 'ACTIVE', permissions: noStorage })).toBe(true);
  });
});
