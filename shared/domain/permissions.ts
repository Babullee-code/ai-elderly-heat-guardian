/**
 * Role-based access control.
 *
 * The server is the authority: every mutating admin route checks these
 * permissions against the requesting account's role. The client uses the same
 * table only to hide controls the user cannot use - hiding a button is a
 * courtesy, not a security boundary.
 */

import type { Permission, Role } from '../types/domain.js';

const ALL_PERMISSIONS: Permission[] = [
  'user:read', 'user:write', 'user:suspend',
  'caregiver:read', 'caregiver:write',
  'device:read', 'device:write',
  'sensor:read',
  'risk-rule:read', 'risk-rule:write',
  'action-rule:read', 'action-rule:write',
  'alert:read', 'alert:write',
  'notification:read', 'notification:write',
  'cooling-space:read', 'cooling-space:write',
  'city-risk:read', 'city-risk:write',
  'content:read', 'content:write',
  'data-source:read', 'data-source:write',
  'system:read', 'system:write',
  'audit:read',
  'account:write',
  'simulation:control',
];

/** Every read permission, used to build the VIEWER role. */
const READ_ONLY: Permission[] = ALL_PERMISSIONS.filter((p) => p.endsWith(':read'));

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  // Full control, including account management and destructive settings.
  SUPER_ADMIN: [...ALL_PERMISSIONS],

  // Runs the platform day to day but cannot create or elevate accounts.
  ADMIN: ALL_PERMISSIONS.filter((p) => p !== 'account:write'),

  // Sees and acts on their assigned users only; route-level scoping enforces
  // *which* users, this table enforces *what* they may do.
  CAREGIVER: [
    'user:read',
    'caregiver:read',
    'device:read',
    'sensor:read',
    'alert:read',
    'alert:write',
    'notification:read',
    'cooling-space:read',
    'city-risk:read',
    'content:read',
  ],

  // The elderly user themselves - no administrative surface at all.
  ELDER: ['cooling-space:read', 'city-risk:read', 'content:read'],

  // Read-only observer, e.g. a judge or auditor.
  VIEWER: [...READ_ONLY],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function hasAnyPermission(role: Role, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/** Roles allowed into the /admin surface at all. */
export function canAccessAdmin(role: Role): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'VIEWER';
}

/** Roles allowed into the caregiver dashboard. */
export function canAccessCaregiver(role: Role): boolean {
  return role !== 'ELDER';
}

export const ROLE_LABELS: Record<Role, { label: string; labelZh: string; description: string }> = {
  SUPER_ADMIN: {
    label: 'Super Admin',
    labelZh: '系統管理員',
    description: 'Full control including account management.',
  },
  ADMIN: {
    label: 'Admin',
    labelZh: '管理者',
    description: 'System management, excluding critical account controls.',
  },
  CAREGIVER: {
    label: 'Caregiver',
    labelZh: '照護者',
    description: 'Access limited to assigned elderly users.',
  },
  ELDER: {
    label: 'Resident',
    labelZh: '長者',
    description: 'Personal dashboard only. No administrative access.',
  },
  VIEWER: {
    label: 'Viewer',
    labelZh: '檢視者',
    description: 'Read-only access across the platform.',
  },
};
