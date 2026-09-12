/**
 * Live data store.
 *
 * A single WebSocket connection feeds every screen. Components select the
 * slice they need from this store rather than each polling the API, which is
 * what keeps the CMS, the caregiver dashboard and the elderly app showing the
 * same numbers at the same moment.
 *
 * The store holds no derived risk logic of its own: it stores exactly what
 * the server computed. Recomputing risk client-side would let two screens
 * disagree, which for a safety product is worse than being a frame behind.
 */

import { create } from 'zustand';
import type {
  Alert,
  CityRisk,
  Device,
  LiveSnapshot,
  Notification,
  PlatformStats,
  RiskAssessment,
  RiskHistoryPoint,
  SimulationState,
  SmartHomeState,
} from '@shared/types/domain';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface LiveStore {
  connection: ConnectionState;
  /** Ticks received since the connection opened - proves liveness in the UI. */
  updates: number;
  lastUpdateAt: string | null;

  assessments: Record<string, RiskAssessment>;
  smartHome: Record<string, SmartHomeState>;
  history: Record<string, RiskHistoryPoint[]>;
  stats: PlatformStats | null;
  simulation: SimulationState | null;
  cityRisk: CityRisk[];
  alerts: Alert[];
  notifications: Notification[];
  devices: Device[];
  configVersion: number;

  connect: () => void;
  disconnect: () => void;
  applySnapshot: (snapshot: LiveSnapshot) => void;
}

import { STATIC_DEMO } from '@/lib/api';

let socket: WebSocket | null = null;
let demoUnsubscribe: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let intentionalClose = false;

export const useLiveStore = create<LiveStore>((set, getState) => ({
  connection: 'connecting',
  updates: 0,
  lastUpdateAt: null,

  assessments: {},
  smartHome: {},
  history: {},
  stats: null,
  simulation: null,
  cityRisk: [],
  alerts: [],
  notifications: [],
  devices: [],
  configVersion: 0,

  applySnapshot: (snapshot) =>
    set((state) => ({
      assessments: snapshot.assessments,
      smartHome: snapshot.smartHome,
      history: snapshot.history,
      stats: snapshot.stats,
      simulation: snapshot.simulation,
      cityRisk: snapshot.cityRisk,
      alerts: snapshot.alerts,
      notifications: snapshot.notifications,
      devices: snapshot.devices,
      configVersion: snapshot.configVersion,
      updates: state.updates + 1,
      lastUpdateAt: snapshot.at,
    })),

  connect: () => {
    /**
     * In the static build there is no socket. The in-browser backend runs the
     * same tick loop and pushes the same LiveSnapshot, so every selector and
     * every component below this point is unchanged.
     */
    if (STATIC_DEMO) {
      if (demoUnsubscribe) return;
      void import('@/demo/backend').then(({ demoBackend }) => {
        demoBackend.ensureInitialised();
        demoBackend.start();
        demoUnsubscribe = demoBackend.subscribe((snapshot) => {
          getState().applySnapshot(snapshot);
        });
        set({ connection: 'open' });
      });
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    intentionalClose = false;
    set({ connection: 'connecting' });

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;

    try {
      socket = new WebSocket(url);
    } catch {
      set({ connection: 'error' });
      scheduleReconnect(getState);
      return;
    }

    socket.onopen = () => {
      reconnectAttempts = 0;
      set({ connection: 'open' });
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as {
          type: string;
          payload: LiveSnapshot;
        };
        if (message.type === 'snapshot') {
          getState().applySnapshot(message.payload);
        }
      } catch {
        // A malformed frame should not take the dashboard down.
      }
    };

    socket.onerror = () => set({ connection: 'error' });

    socket.onclose = () => {
      socket = null;
      set({ connection: 'closed' });
      if (!intentionalClose) scheduleReconnect(getState);
    };
  },

  disconnect: () => {
    // The demo backend keeps running for the life of the tab: tearing it down
    // on unmount would discard all session state on a route change.
    if (STATIC_DEMO) return;

    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
    set({ connection: 'closed' });
  },
}));

/**
 * Reconnect with exponential backoff, capped at 10 seconds.
 *
 * A demo laptop that sleeps mid-presentation should reconnect on its own
 * rather than needing a page refresh.
 */
function scheduleReconnect(getState: () => LiveStore): void {
  if (reconnectTimer) return;
  const delay = Math.min(10_000, 500 * 2 ** reconnectAttempts);
  reconnectAttempts++;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    getState().connect();
  }, delay);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Shared empty array.
 *
 * A selector must return a STABLE reference when nothing changed. Writing
 * `?? []` would mint a fresh array on every call, and because zustand reads
 * selectors through useSyncExternalStore, React would see a new snapshot on
 * every render and loop forever.
 */
const EMPTY: never[] = [];

/**
 * Memoise a derived selector on its single input reference.
 *
 * The store replaces `alerts`, `devices` and `notifications` wholesale on each
 * tick, so reference equality is exactly the right cache key: the derived
 * array is recomputed once per tick and returned unchanged in between.
 */
function derive<In, Out>(compute: (input: In) => Out): (input: In) => Out {
  let lastInput: In | symbol = Symbol('empty');
  let lastOutput: Out;

  return (input: In) => {
    if (input !== lastInput) {
      lastInput = input;
      lastOutput = compute(input);
    }
    return lastOutput;
  };
}

export const selectAssessment = (userId: string | null | undefined) => (s: LiveStore) =>
  userId ? (s.assessments[userId] ?? null) : null;

export const selectSmartHome = (userId: string | null | undefined) => (s: LiveStore) =>
  userId ? (s.smartHome[userId] ?? null) : null;

export const selectHistory =
  (userId: string | null | undefined) =>
  (s: LiveStore): RiskHistoryPoint[] =>
    (userId ? s.history[userId] : undefined) ?? EMPTY;

/**
 * Per-user device lists, memoised per user id so each caller keeps a stable
 * reference between ticks.
 */
const deviceCache = new Map<string, (devices: Device[]) => Device[]>();

export const selectUserDevices =
  (userId: string | null | undefined) =>
  (s: LiveStore): Device[] => {
    if (!userId) return EMPTY;

    let compute = deviceCache.get(userId);
    if (!compute) {
      compute = derive((devices: Device[]) => devices.filter((d) => d.userId === userId));
      deviceCache.set(userId, compute);
    }
    return compute(s.devices);
  };

const openAlerts = derive((alerts: Alert[]) => alerts.filter((a) => a.status !== 'RESOLVED'));
export const selectOpenAlerts = (s: LiveStore): Alert[] => openAlerts(s.alerts);

const alertCache = new Map<string, (alerts: Alert[]) => Alert[]>();

export const selectAlertsForUser =
  (userId: string | null | undefined) =>
  (s: LiveStore): Alert[] => {
    if (!userId) return EMPTY;

    let compute = alertCache.get(userId);
    if (!compute) {
      compute = derive((alerts: Alert[]) => alerts.filter((a) => a.userId === userId));
      alertCache.set(userId, compute);
    }
    return compute(s.alerts);
  };

const unread = derive((notifications: Notification[]) => notifications.filter((n) => !n.read));
export const selectUnreadNotifications = (s: LiveStore): Notification[] => unread(s.notifications);
