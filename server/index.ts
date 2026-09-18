/**
 * Server entry point.
 *
 * Wires the Express API, boots the platform state, starts the simulation
 * clock and exposes a WebSocket that pushes the live snapshot to every
 * connected client on each tick.
 *
 * The WebSocket is what removes the need for any manual refresh during the
 * demo: the CMS, the caregiver dashboard and the elderly app all render from
 * the same broadcast object, so they cannot drift out of step with each other.
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, type WebSocket } from 'ws';

import { platformState } from './services/platformState.js';
import { errorHandler, notFound } from './middleware/common.js';
import { resolveAccount } from './middleware/auth.js';

import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { caregiversRouter } from './routes/caregivers.js';
import { devicesRouter, readingsRouter, sensorsRouter } from './routes/devices.js';
import { actionsRouter, riskRouter, riskRulesRouter } from './routes/risk.js';
import { alertsRouter, notificationsRouter } from './routes/alerts.js';
import { cityRiskRouter, coolingSpacesRouter } from './routes/places.js';
import {
  auditRouter,
  contentRouter,
  dataSourcesRouter,
  settingsRouter,
  systemRouter,
} from './routes/system.js';
import { ingestRouter } from './routes/ingest.js';
import { simulationRouter } from './routes/simulation.js';

const PORT = Number(process.env.PORT ?? 4000);

const app = express();

app.use(
  cors({
    // The Vite dev server proxies /api, so same-origin is the normal case.
    // Explicit origins are allowed for running the two servers separately.
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    credentials: true,
  }),
);

// Bodies are small JSON documents; the cap blocks oversized payloads early.
app.use(express.json({ limit: '512kb' }));

app.use((_req, res, next) => {
  // Basic hardening. A production deployment would add a full CSP and HSTS
  // behind TLS; these are the headers that matter for an API of this shape.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(resolveAccount);

// --- Health check (unauthenticated, for readiness probes) -------------------
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSec: platformState.getUptimeSec(),
    ticks: platformState.getTickCount(),
    version: '1.0.0',
  });
});

// --- API routes -------------------------------------------------------------
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/caregivers', caregiversRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/sensors', sensorsRouter);
app.use('/api/readings', readingsRouter);
app.use('/api/risk', riskRouter);
app.use('/api/risk-rules', riskRulesRouter);
app.use('/api/actions', actionsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/cooling-spaces', coolingSpacesRouter);
app.use('/api/city-risk', cityRiskRouter);
app.use('/api/content', contentRouter);
app.use('/api/data-sources', dataSourcesRouter);
app.use('/api/system', systemRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/audit-log', auditRouter);
// Device-authenticated, deliberately outside the console's account auth.
app.use('/api/ingest', ingestRouter);
app.use('/api/simulation', simulationRouter);

app.use('/api', notFound);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

interface Client {
  socket: WebSocket;
  alive: boolean;
}

const clients = new Set<Client>();

wss.on('connection', (socket) => {
  const client: Client = { socket, alive: true };
  clients.add(client);

  socket.on('pong', () => {
    client.alive = true;
  });

  // Send the current snapshot immediately so a newly opened tab is in sync
  // before the next tick rather than showing an empty dashboard for a second.
  send(socket, { type: 'snapshot', payload: platformState.buildSnapshot() });

  socket.on('message', (raw) => {
    // The socket is read-only for clients: state changes go through the HTTP
    // API so they pass validation, authorisation and audit logging. A ping is
    // the only message accepted, for latency measurement.
    try {
      const message = JSON.parse(String(raw)) as { type?: string };
      if (message.type === 'ping') {
        send(socket, { type: 'pong', payload: { at: new Date().toISOString() } });
      }
    } catch {
      // Ignore malformed frames rather than tearing down the connection.
    }
  });

  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
});

/** Drop connections that stopped responding, so the set does not leak. */
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.terminate();
      clients.delete(client);
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
}, 30_000);

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.error('[ws] Send failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  try {
    await platformState.initialise();
  } catch (error) {
    console.error(
      '[server] Failed to initialise platform state. Has the database been seeded? Run: npm run setup',
    );
    console.error(error);
    process.exit(1);
  }

  // Broadcast every snapshot the state machine produces.
  platformState.subscribe((snapshot) => {
    const payload = JSON.stringify({ type: 'snapshot', payload: snapshot });
    for (const client of clients) {
      if (client.socket.readyState === client.socket.OPEN) {
        try {
          client.socket.send(payload);
        } catch (error) {
          console.error('[ws] Broadcast failed:', error);
        }
      }
    }
  });

  platformState.start();

  server.listen(PORT, () => {
    const stats = platformState.getStats();
    console.log('');
    console.log('  AI 守護高齡者 - Heat Protection Platform');
    console.log(`  API      http://localhost:${PORT}/api`);
    console.log(`  WebSocket ws://localhost:${PORT}/ws`);
    console.log(
      `  State    ${stats.activeUsers} residents monitored - ${stats.highRiskUsers} HIGH, ${stats.mediumRiskUsers} MEDIUM, ${stats.lowRiskUsers} LOW`,
    );
    console.log(`  Devices  ${stats.onlineDevices}/${stats.totalDevices} online (${stats.devicesOnlinePct}%)`);
    console.log('');
  });
}

function shutdown(signal: string): void {
  console.log(`\n[server] ${signal} received, shutting down.`);
  clearInterval(heartbeat);
  platformState.stop();
  for (const client of clients) client.socket.close();
  server.close(() => process.exit(0));
  // Force exit if connections refuse to drain.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void start();
