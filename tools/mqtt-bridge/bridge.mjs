#!/usr/bin/env node
/**
 * MQTT → HeatGuard bridge.
 *
 * WHY A BRIDGE EXISTS AT ALL
 * --------------------------
 * The platform ingests over HTTP with a per-device key, which is the right
 * interface for a device that can hold a credential and speak TLS. Plenty of
 * cheap household sensors cannot: they publish a number to an MQTT broker and
 * that is the whole of their world. Asking a care provider to replace working
 * hardware because the platform only speaks one protocol is not a serious
 * answer, so this translates.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not weaken the ingest contract to make translation easier. Every
 * message still ends up as an authenticated post from one identified device,
 * carrying only fields that device is permitted to report, and is validated by
 * the platform exactly as a direct post would be. The bridge holds the keys;
 * the sensors never see them.
 *
 * That makes the bridge a trusted component, and it should be treated as one:
 * it runs on the home gateway or the care provider's network, not on the
 * public internet, and its mapping file contains credentials.
 *
 * TOPIC MAPPING
 * -------------
 * A mapping file says which topic feeds which device and field:
 *
 *   {
 *     "server": "http://localhost:4000",
 *     "broker": "mqtt://localhost:1883",
 *     "devices": [
 *       {
 *         "key": "hgk_...",
 *         "topics": {
 *           "home/livingroom/temperature": "indoorTempC",
 *           "home/livingroom/humidity": "indoorHumidityPct"
 *         }
 *       }
 *     ]
 *   }
 *
 * Payloads may be a bare number ("27.4"), or JSON with a `value` field
 * ({"value": 27.4, "ts": "..."}), which is what most sensor firmware emits.
 *
 * USAGE
 *   node bridge.mjs --config mapping.json
 *   node bridge.mjs --config mapping.json --dry-run   # log, do not post
 */

import fs from 'node:fs';
import mqtt from 'mqtt';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { config: null, dryRun: false, batchMs: 2000 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') args.config = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--batch-ms') args.batchMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.config) {
  console.log(
    [
      '',
      'MQTT → HeatGuard bridge',
      '',
      '  --config <file>    Mapping file (required). See mapping.example.json',
      '  --dry-run          Log what would be posted, without posting',
      '  --batch-ms <ms>    How long to gather a device\'s fields before posting',
      '                     (default 2000). Sensors publish each field on its own',
      '                     topic, so batching turns four messages into one post.',
      '',
      'The mapping file contains device keys. Keep it out of version control and',
      'run this on the home gateway, not on anything public.',
      '',
    ].join('\n'),
  );
  process.exit(args.config ? 0 : 1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
} catch (err) {
  console.error('Cannot read mapping file: ' + err.message);
  process.exitCode = 1;
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}

const SERVER = config.server ?? 'http://localhost:4000';
const BROKER = config.broker ?? 'mqtt://localhost:1883';

/**
 * topic → { key, field }
 *
 * Flattened at startup so each incoming message is a single map lookup rather
 * than a scan. A broker under load delivers a lot of messages.
 */
const routes = new Map();

for (const device of config.devices ?? []) {
  for (const [topic, field] of Object.entries(device.topics ?? {})) {
    if (routes.has(topic)) {
      console.error(
        'Mapping error: topic "' + topic + '" is claimed twice. ' +
        'One topic feeds one field on one device.',
      );
      process.exit(1);
    }
    routes.set(topic, { key: device.key, field, label: device.label ?? '' });
  }
}

if (routes.size === 0) {
  console.error('Mapping file defines no topics; nothing to bridge.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/**
 * Turn a raw MQTT payload into a number and, if it carries one, a timestamp.
 *
 * Returns null when the payload is not a reading. A malformed message is
 * dropped with a log line rather than forwarded: the platform would reject it
 * anyway, and posting known-bad data wastes a request and muddies the device's
 * rejection record.
 */
function parsePayload(raw) {
  const text = raw.toString().trim();
  if (text.length === 0) return null;

  // Bare number, which is what most simple firmware publishes.
  const bare = Number(text);
  if (Number.isFinite(bare)) return { value: bare, observedAt: null };

  try {
    const json = JSON.parse(text);
    const value = Number(json.value ?? json.val ?? json.reading);
    if (!Number.isFinite(value)) return null;

    // Accept a timestamp if the sensor supplied one - when a measurement was
    // taken is part of the measurement, and the sensor knows better than we do.
    const ts = json.ts ?? json.timestamp ?? json.observedAt ?? null;
    const observedAt = ts ? new Date(ts) : null;

    return {
      value,
      observedAt:
        observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt.toISOString() : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

/**
 * Pending fields per device key.
 *
 * Sensors publish each field on its own topic, typically within a few hundred
 * milliseconds of each other. Posting each one separately would triple the
 * request count and produce three partial readings where one complete one was
 * available, so fields are gathered briefly and sent together.
 */
const pending = new Map();

const stamp = () => new Date().toLocaleTimeString();

function schedule(key) {
  const entry = pending.get(key);
  if (entry.timer) return;

  entry.timer = setTimeout(() => {
    entry.timer = null;
    const readings = entry.readings;
    const observedAt = entry.observedAt;
    entry.readings = {};
    entry.observedAt = null;
    void flush(key, readings, observedAt);
  }, args.batchMs);
}

async function flush(key, readings, observedAt) {
  const fields = Object.keys(readings);
  if (fields.length === 0) return;

  const label = pending.get(key)?.label || key.slice(0, 12);

  if (args.dryRun) {
    console.log(
      stamp() + '  [dry-run] ' + label + '  ' +
      fields.map((f) => f + '=' + readings[f]).join(' '),
    );
    return;
  }

  try {
    const res = await fetch(SERVER + '/api/ingest/readings', {
      method: 'POST',
      headers: { 'X-Device-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(observedAt ? { observedAt, readings } : { readings }),
    });

    const body = await res.json().catch(() => ({}));

    if (res.status === 401) {
      console.error(stamp() + '  ' + label + ': key rejected — check the mapping file');
      return;
    }

    const accepted = (body.accepted ?? []).map((a) => a.field + '=' + a.value).join(' ');
    const rejected = (body.rejected ?? []).map((r) => r.field + ':' + r.code).join(' ');

    console.log(
      stamp() + '  ' + label + '  ' + accepted +
      (rejected ? '  REJECTED ' + rejected : ''),
    );
  } catch (err) {
    // The bridge does not buffer. A sensor publishing every few seconds will
    // supply another reading shortly, and replaying a stale one on recovery
    // would tell the platform the room is something it no longer is.
    console.error(stamp() + '  ' + label + ': platform unreachable (' + err.message + ')');
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

console.log(
  [
    '',
    'MQTT → HeatGuard bridge',
    '  broker    ' + BROKER,
    '  platform  ' + SERVER,
    '  topics    ' + routes.size,
    '  batching  ' + args.batchMs + 'ms',
    args.dryRun ? '  MODE      dry-run (nothing is posted)' : '',
    '',
  ].filter(Boolean).join('\n'),
);

const client = mqtt.connect(BROKER);

client.on('connect', () => {
  console.log(stamp() + '  connected to broker');

  for (const topic of routes.keys()) {
    client.subscribe(topic, (err) => {
      if (err) console.error(stamp() + '  cannot subscribe to ' + topic + ': ' + err.message);
      else console.log(stamp() + '  subscribed  ' + topic + ' → ' + routes.get(topic).field);
    });
  }
});

client.on('message', (topic, raw) => {
  const route = routes.get(topic);
  if (!route) return;

  const parsed = parsePayload(raw);

  if (!parsed) {
    console.error(
      stamp() + '  ' + topic + ': payload is not a reading (' +
      raw.toString().slice(0, 40) + ')',
    );
    return;
  }

  if (!pending.has(route.key)) {
    pending.set(route.key, { readings: {}, observedAt: null, timer: null, label: route.label });
  }

  const entry = pending.get(route.key);
  entry.readings[route.field] = parsed.value;
  // Keep the earliest timestamp in the batch: it bounds how old any value in
  // this post might be, and overstating freshness is the failure that matters.
  if (parsed.observedAt && (!entry.observedAt || parsed.observedAt < entry.observedAt)) {
    entry.observedAt = parsed.observedAt;
  }

  schedule(route.key);
});

client.on('error', (err) => {
  console.error(stamp() + '  broker error: ' + err.message);
});

client.on('offline', () => {
  console.error(stamp() + '  broker offline — readings are being missed, not queued');
});

process.on('SIGINT', () => {
  console.log('\n' + stamp() + '  stopping');
  client.end(true, () => process.exit(0));
});
