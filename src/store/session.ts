/**
 * Session store.
 *
 * Holds the signed-in demo account, its permission set, and the two
 * presentation preferences that persist across reloads: elderly mode and
 * the language of the interface chrome.
 *
 * The permission list here drives which controls are RENDERED. It is not a
 * security boundary - the server re-checks every mutation. Hiding a button
 * the user cannot use is a courtesy; the API is what actually refuses.
 */

import { create } from 'zustand';
import type { Account, Caregiver, ElderlyUser, Permission } from '@shared/types/domain';
import { api, getStoredAccountId, setStoredAccountId } from '@/lib/api';

const ELDER_MODE_KEY = 'heatguard.elderMode';

function readElderMode(): boolean {
  try {
    return localStorage.getItem(ELDER_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

interface SessionStore {
  account: Account | null;
  permissions: Permission[];
  elderlyUser: ElderlyUser | null;
  caregiver: Caregiver | null;

  /** True until the initial session restore has settled. */
  loading: boolean;
  error: string | null;

  /** Simplified, larger interface for elderly users. */
  elderMode: boolean;

  restore: () => Promise<void>;
  login: (email: string) => Promise<Account>;
  logout: () => void;
  setElderMode: (on: boolean) => void;
  can: (permission: Permission) => boolean;
  /** The elderly user this session should display by default. */
  focusUserId: () => string | null;
}

export const useSession = create<SessionStore>((set, get) => ({
  account: null,
  permissions: [],
  elderlyUser: null,
  caregiver: null,
  loading: true,
  error: null,
  elderMode: readElderMode(),

  restore: async () => {
    const stored = getStoredAccountId();
    if (!stored) {
      set({ loading: false });
      return;
    }

    try {
      const me = await api.me();
      set({
        account: me.account,
        permissions: me.permissions,
        elderlyUser: me.elderlyUser,
        caregiver: me.caregiver,
        loading: false,
        error: null,
        // An elderly account defaults to the simplified interface unless the
        // user has explicitly chosen otherwise on this device.
        elderMode:
          localStorage.getItem(ELDER_MODE_KEY) !== null
            ? readElderMode()
            : Boolean(me.elderlyUser?.elderlyModeDefault && me.account.role === 'ELDER'),
      });
    } catch {
      // A stale account id (e.g. after a reseed) should not trap the user on
      // a broken screen - clear it and fall back to the login page.
      setStoredAccountId(null);
      set({ account: null, permissions: [], loading: false });
    }
  },

  login: async (email) => {
    set({ error: null });
    const result = await api.login(email);
    setStoredAccountId(result.token);

    const me = await api.me();
    set({
      account: me.account,
      permissions: me.permissions,
      elderlyUser: me.elderlyUser,
      caregiver: me.caregiver,
      elderMode: Boolean(me.elderlyUser?.elderlyModeDefault && me.account.role === 'ELDER'),
    });

    return result.account;
  },

  logout: () => {
    setStoredAccountId(null);
    try {
      localStorage.removeItem(ELDER_MODE_KEY);
    } catch {
      /* storage disabled */
    }
    set({ account: null, permissions: [], elderlyUser: null, caregiver: null, elderMode: false });
  },

  setElderMode: (on) => {
    try {
      localStorage.setItem(ELDER_MODE_KEY, String(on));
    } catch {
      /* storage disabled */
    }
    set({ elderMode: on });
  },

  can: (permission) => get().permissions.includes(permission),

  focusUserId: () => {
    const { account } = get();
    if (!account) return null;
    if (account.elderlyUserId) return account.elderlyUserId;
    // Admin and viewer accounts observe the demo protagonist by default.
    return 'user-001';
  },
}));
