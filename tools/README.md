# Device connectors

Three ways to get a real reading into the platform. All of them end at the same
place — an authenticated post to `/api/ingest/readings` from one identified
device — because that is the only door in, and widening it for convenience
would defeat the point of having one.

```
  a device that speaks HTTP ─────────────────► /api/ingest/readings
                                                       ▲
  a device that speaks MQTT ──► broker ──► bridge ──────┘
```

| | What it is | When to use it |
|---|---|---|
| **Pairing wizard** | In the admin console: 裝置管理 → 連接新裝置 | Always. It registers the device, issues its key and waits for a real reading |
| **`device-client/`** | A reference HTTP client, simulated sensor included | Demonstrating the pipeline; the starting point for real firmware |
| **`mqtt-bridge/`** | Translates MQTT topics into ingest posts | Sensors that only publish to a broker |

---

## Pairing wizard

Start here. It does the four things that are easy to get out of order —
register, credential, configure, confirm — and it will not say 已連接 until a
reading has actually arrived. A pairing flow that reports success on
registration is how you end up with a roster full of devices nobody has ever
heard from.

The wizard hands you a command with the key already in it.

## `device-client/` — reference HTTP client

```bash
node tools/device-client/client.mjs --key hgk_xxx --interval 10
```

Ships with a simulated sensor, so it runs with no hardware present.
**`readSensor()` is the only function to replace** for a real one — the
credential handling, retries, backoff and offline buffer are the same either
way, and those are the parts worth copying.

What it gets right, and what firmware ported from it should keep:

- **Buffers while offline** and sends on recovery with the *original*
  timestamps. When a measurement was taken is part of the measurement.
- **Backs off** rather than hammering a server that is coming back up.
- **Drops readings older than 15 minutes**, which the platform refuses anyway.
  Retrying into a guaranteed rejection looks like a working retry loop and
  achieves nothing.
- **Reports partial rejections** instead of swallowing them.
- **Asks the platform what it may report** (`GET /api/ingest/self`) rather than
  hard-coding field names from documentation.

```
--key <key>        Device ingest key (required)
--server <url>     Platform base URL (default http://localhost:4000)
--interval <sec>   Seconds between readings (default 30)
--once             Send a single reading and exit
```

## `mqtt-bridge/` — for sensors that only speak MQTT

Plenty of cheap household sensors publish a number to a broker and that is the
whole of their world. Asking a care provider to replace working hardware
because the platform speaks one protocol is not a serious answer.

```bash
cp tools/mqtt-bridge/mapping.example.json tools/mqtt-bridge/mapping.json
# fill in real keys, then:
node tools/mqtt-bridge/bridge.mjs --config tools/mqtt-bridge/mapping.json
```

The bridge **holds the keys; the sensors never see them**. That makes it a
trusted component: run it on the home gateway or the provider's network, not
anywhere public. `mapping.json` is gitignored because it contains credentials.

It batches fields briefly (default 2s) before posting, because sensors publish
each field on its own topic and posting separately would produce three partial
readings where one complete one was available.

Payloads may be a bare number (`27.4`) or JSON (`{"value": 27.4, "ts": "..."}`);
a timestamp in the payload is used, because the sensor knows better than the
bridge when it took the reading.

### Trying it without hardware or a broker

```bash
# terminal 1 — a local broker plus a fake sensor
node tools/mqtt-bridge/test-broker.mjs --interval 3 --min 21 --max 23

# terminal 2 — the bridge
node tools/mqtt-bridge/bridge.mjs --config tools/mqtt-bridge/mapping.json
```

`--dry-run` logs what would be posted without posting it, which is the fastest
way to check a topic mapping.

---

## What happens after a device becomes real

Posting once changes a device permanently, and this is worth understanding
before you pair anything:

- Its measurements outrank the simulator.
- The value corrects the simulated household, so a real 41.5 °C drives heart
  rate in the coupled model rather than only appearing on screen.
- **The simulator never stands in for it again.** If it falls silent, its
  values are held and marked `OFFLINE` rather than replaced by a plausible
  invented number. Hiding a failed sensor in someone's home behind a
  believable reading is the one outcome this platform is built to prevent.

To return a device to simulated operation, **revoke its key** — that is an
administrator stating it no longer reports, which is a different thing from a
sensor going quiet.
