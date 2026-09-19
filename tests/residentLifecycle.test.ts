/**
 * Resident lifecycle tests.
 *
 * Two things are pinned here. The first is that a partial update leaves alone
 * what it does not mention - a rule that sounds obvious and was not true: the
 * update schema re-applied its own defaults, so changing a phone number
 * erased the resident's medical history. That went unnoticed for as long as
 * nothing called the route, and became a live data-loss bug the moment an
 * edit form was wired to it.
 *
 * The second is the lifecycle itself: archiving is reversible and keeps the
 * record, erasure is not and does not.
 */

import { describe, expect, it } from 'vitest';
import {
  elderlyUserCreateSchema,
  elderlyUserUpdateSchema,
} from '../shared/schemas/index';
import { UNMONITORED_STATUSES, isRostered } from '../shared/types/domain';

const VALID_CREATE = {
  name: '王奶奶',
  nameEn: 'Grandma Wang',
  age: 78,
  gender: 'F' as const,
  city: '臺北市',
  district: '大安區',
  lat: 25.023,
  lng: 121.5459,
  phone: '0967698897',
  address: '台北市大安區示範路 98 號',
  conditions: ['高血壓', '第二型糖尿病'],
  medications: ['Metformin'],
  permissions: {
    automaticCooling: true,
    caregiverNotifications: true,
    locationSharing: true,
    physiologicalDataStorage: true,
    cityDataContribution: true,
  },
  emergencyContact: { name: '王先生', relationship: '家人', phone: '0973892279' },
};

describe('elderlyUserUpdateSchema', () => {
  it('leaves untouched fields out of the patch entirely', () => {
    /**
     * The defect. A phone-only edit used to come back carrying
     * `conditions: []` and `medications: []`, which the update then wrote -
     * erasing the history the vulnerability factor scores a resident on.
     */
    const parsed = elderlyUserUpdateSchema.parse({ phone: '0900111222' });

    expect(parsed).toEqual({ phone: '0900111222' });
    expect('conditions' in parsed).toBe(false);
    expect('medications' in parsed).toBe(false);
    expect('status' in parsed).toBe(false);
  });

  it('still accepts an explicit change to those fields', () => {
    // Absent means "leave alone"; present means "set to this", including
    // present-and-empty, which is a real thing an operator may want.
    const parsed = elderlyUserUpdateSchema.parse({ conditions: [] });
    expect(parsed.conditions).toEqual([]);
  });

  it('accepts ARCHIVED as a status', () => {
    expect(elderlyUserUpdateSchema.parse({ status: 'ARCHIVED' }).status).toBe('ARCHIVED');
  });

  it('still rejects nonsense', () => {
    expect(() => elderlyUserUpdateSchema.parse({ age: 12 })).toThrow();
    expect(() => elderlyUserUpdateSchema.parse({ gender: 'X' })).toThrow();
  });
});

describe('elderlyUserCreateSchema', () => {
  it('still defaults the optional lists on create', () => {
    // Creation is where a default belongs: a new resident genuinely has no
    // recorded conditions until somebody enters them.
    const { conditions, ...withoutConditions } = VALID_CREATE;
    const parsed = elderlyUserCreateSchema.parse(withoutConditions);

    expect(parsed.conditions).toEqual([]);
    expect(parsed.status).toBe('ACTIVE');
  });
});

describe('resident lifecycle states', () => {
  it('treats archived residents as unmonitored', () => {
    expect(UNMONITORED_STATUSES).toContain('ARCHIVED');
    expect(UNMONITORED_STATUSES).not.toContain('ACTIVE');
  });

  it('takes archived residents off the roster, and nobody else', () => {
    expect(isRostered('ARCHIVED')).toBe(false);
    expect(isRostered('ACTIVE')).toBe(true);
    // Suspended is a pause, not a removal - they stay visible so somebody
    // remembers to bring them back.
    expect(isRostered('SUSPENDED')).toBe(true);
    expect(isRostered('INACTIVE')).toBe(true);
  });
});
