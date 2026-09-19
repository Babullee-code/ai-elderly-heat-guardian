#!/usr/bin/env node
/**
 * HeatGuard device client — a reference implementation.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The platform accepts readings from real hardware over HTTP (see
 * `docs/api.md`, /api/ingest). This is a working client for that interface,
 * small enough to read in one sitting and to port to whatever the device
 * actually runs. It is the thing that proves the ingest path is real: run it,
 * and a resident's screen changes.
 *
 * It ships with a simulated sensor so it can be demonstrated with no hardware
 * present. `readSensor()` is the ONLY function that needs replacing to talk to
 * a real one — everything else, the credential handling, the retry behaviour,
 * the offline buffer, is identical either way.
 *
 * WHAT A DEVICE CLIENT HAS TO GET RIGHT
 * -------------------------------------
 * Posting a number is the easy part. What matters in somebody's home, on
 * domestic wifi, is what happens when the network is not there:
 *
 *   - It must not lose readings while offline. They are buffered and sent when
 *     the link returns, with their ORIGINAL timestamps, because when a
 *     measurement was taken is part of the measurement.
 *   - It must not stampede a recovering server. Retries back off.
 *   - It must not retry forever into a guaranteed rejection. The platform
 *     refuses measurements older than 15 minutes, so those are dropped.
 *   - It must report partial rejections rather than swallow them. If the
 *     server took the heart rate and refused the skin temperature, somebody
 *     needs to see that.
 *
 * USAGE
 *   node client.mjs --key hgk_xxx                     # simulated sensor
 *   node client.mjs --key hgk_xxx --interval 10       # every 10 seconds
 *   node client.mjs --key hgk_xxx --server https://…  # a deployed platform
 *   node client.mjs --key hgk_xxx --once              # one reading, then exit
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { server: 'http://localhost:4000', interval: 30, once: false, key: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--key') args.key = argv[++i];
    else if (arg === '--server') args.server = argv[++i];
    else if (arg === '--interval') args.interval = Number(argv[++i]);
    else if (arg === '--once') args.once = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.key) {
  console.log(
    [
      '',
      'HeatGuard device client',
      '',
      '  --key <key>        Device ingest key (required). Issue one in the admin',
      '                     console: 裝置管理 → 金鑰 → 產生金鑰',
      '  --server <url>     Platform base URL (default http://localhost:4000)',
      '  --interval <sec>   Seconds between readings (default 30)',
      '  --once             Send a single reading and exit',
      '',
      'The key identifies exactly one device. Keep it out of shared shells and',
      'out of version control — anything holding it can report as that sensor.',
      '',
    ].join('\n'),
  );
  process.exit(args.key ? 0 : 1);
}

/**
 * How long a buffered reading is still worth sending.
 *
 * Matches the platform's own backdating limit. Retrying past it would be
 * posting into a guaranteed rejection, which looks like a working retry loop
 * while achieving nothing.
 */
const MAX_BUFFER_AGE_SEC = 15 * 60;

/** Retry backoff, doubling, in milliseconds. */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 120_000;

// ---------------------------------------------------------------------------
// The sensor
// ---------------------------------------------------------------------------

/**
 * A plausible household sensor.
 *
 * REPLACE THIS FUNCTION to use real hardware — read your I2C/GPIO/serial
 * device and return the fields it measures. Nothing else in this file changes.
 *
 * Return only fields the device genuinely measures: the platform rejects a
 * thermometer that claims to know a heart rate, and it is right to.
 */
let simulatedTemp = 27 + Math.random() * 2;
let simulatedHumidity = 60 + Math.random() * 8;

function readSensor(accepts) {
  // Slow drift, so consecutive readings look like a real room rather than a
  // sequence of independent random numbers.
  simulatedTemp += (Math.random() - 0.45) * 0.3;
  simulatedHumidity += (Math.random() - 0.5) * 1.2;

  simulatedTemp = Math.min(45, Math.max(16, simulatedTemp));
  simulatedHumidity = Math.min(99, Math.max(25, simulatedHumidity));

  const all = {
    indoorTempC: Number(simulatedTemp.toFixed(1)),
    indoorHumidityPct: Math.round(simulatedHumidity),
    airQualityIndex: Math.round(50 + Math.random() * 30),
    heartRateBpm: Math.round(70 + Math.random() * 12),
    skinTempC: Number((33.2 + Math.random() * 0.6).toFixed(1)),
    activityStepsPerHour: Math.round(80 + Math.random() * 120),
  };

  // Send only what this device is permitted to report.
  const readings = {};
  for (const field of accepts) {
    if (all[field] !== undefined) readings[field] = all[field];
  }
  return readings;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const headers = { 'X-Device-Key': args.key, 'Content-Type': 'application/json' };

/** Ask the platform what this device is, and what it may report. */
async function identify() {
  const res = await fetch(args.server + '/api/ingest/self', { headers });

  if (res.status === 401) {
    throw new Error('Key rejected. Issue a new one in 裝置管理 → 金鑰.');
  }
  if (!res.ok) {
    throw new Error('Could not identify: HTTP ' + res.status);
  }

  return res.json();
}

/** Post one batch. Returns the server's verdict, or throws on transport failure. */
async function post(readings, observedAt) {
  const res = await fetch(args.server + '/api/ingest/readings', {
    method: 'POST',
    headers,
    body: JSON.stringify({ observedAt, readings }),
  });

  const body = await res.json().catch(() => ({}));

  /**
   * A 4xx is the server telling us something true about this request. Sending
   * the identical payload again will fail identically, so it is not a retry
   * case — it is something to report and move past.
   */
  if (res.status >= 400 && res.status < 500) {
    return { fatal: true, status: res.status, body };
  }

  if (!res.ok) {
    throw new Error('HTTP ' + res.status);
  }

  return { fatal: false, status: res.status, body };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/** Readings taken while the link was down, oldest first. */
const buffer = [];
let consecutiveFailures = 0;

const stamp = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs() {
  const step = BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(step, BACKOFF_MAX_MS);
}

/** Drop buffered readings the platform would refuse anyway. */
function pruneBuffer() {
  const cutoff = Date.now() - MAX_BUFFER_AGE_SEC * 1000;
  const before = buffer.length;

  while (buffer.length > 0 && new Date(buffer[0].observedAt).getTime() < cutoff) {
    buffer.shift();
  }

  const dropped = before - buffer.length;
  if (dropped > 0) {
    console.log(
      stamp() + '  dropped ' + dropped + ' reading(s) older than ' +
      MAX_BUFFER_AGE_SEC / 60 + ' min',
    );
  }
}

function describe(result) {
  const accepted = result.body.accepted ?? [];
  const rejected = result.body.rejected ?? [];
  const parts = [];

  if (accepted.length > 0) {
    parts.push(accepted.map((a) => a.field + '=' + a.value).join(' '));
  }

  // Partial rejections are reported, never swallowed. A device that quietly
  // drops half its payload is worse than one that errors outright.
  for (const r of rejected) {
    parts.push('REJECTED ' + r.field + ': ' + r.code);
  }

  return parts.join('  ');
}

async function send(entry) {
  const result = await post(entry.readings, entry.observedAt);

  if (result.fatal) {
    const detail = result.body.messageZh ?? result.body.message ?? '';
    console.error(
      stamp() + '  refused (' + result.status + ' ' + result.body.error + '): ' + detail,
    );
    return;
  }

  console.log(stamp() + '  ' + describe(result));
}

async function tick(device) {
  const entry = {
    readings: readSensor(device.accepts.map((a) => a.field)),
    observedAt: new Date().toISOString(),
  };

  if (Object.keys(entry.readings).length === 0) {
    console.error(stamp() + '  this device is permitted no fields; nothing to send');
    return;
  }

  buffer.push(entry);
  pruneBuffer();

  try {
    // Oldest first, so a recovered link replays the gap in order.
    while (buffer.length > 0) {
      await send(buffer[0]);
      buffer.shift();
    }
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    const wait = Math.round(backoffMs() / 1000);
    console.error(
      stamp() + '  unreachable (' + err.message + ') — ' + buffer.length +
      ' reading(s) buffered, retrying in ' + wait + 's',
    );
    await sleep(backoffMs());
  }
}

(async () => {
  let device;

  try {
    device = await identify();
  } catch (err) {
    console.error('Cannot start: ' + err.message);
    /**
     * Set the code and return rather than calling process.exit().
     *
     * An abrupt exit while the failed fetch's socket is still closing makes
     * libuv print an assertion on Windows, so a perfectly clear error message
     * is followed by what looks like a crash.
     */
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      '',
      'HeatGuard device client',
      '  device    ' + device.deviceId + '  (' + device.nameZh + ')',
      '  type      ' + device.type,
      '  reports   ' + device.accepts.map((a) => a.field).join(', '),
      '  server    ' + args.server,
      '  interval  ' + args.interval + 's',
      '  sensor    simulated — replace readSensor() for real hardware',
      '',
    ].join('\n'),
  );

  if (args.once) {
    await tick(device);
    return;
  }

  // Ctrl+C should not look like a crash.
  process.on('SIGINT', () => {
    const unsent = buffer.length > 0 ? ' (' + buffer.length + ' unsent)' : '';
    console.log('\n' + stamp() + '  stopped' + unsent);
    process.exit(0);
  });

  for (;;) {
    await tick(device);
    await sleep(args.interval * 1000);
  }
})();
