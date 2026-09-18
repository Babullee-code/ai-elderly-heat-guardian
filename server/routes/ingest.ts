/**
 * Ingest API — the door real hardware comes in through.
 *
 * AUTHENTICATION IS PER DEVICE, NOT PER PERSON
 * --------------------------------------------
 * A sensor in someone's living room is not a user session. It presents its own
 * key, that key identifies exactly one device, and that device may write only
 * the fields its hardware measures, only for its own resident. A compromised
 * thermometer can therefore lie about the temperature in one room, and nothing
 * else: it cannot read anyone's data, cannot post physiological values, and
 * cannot touch another household.
 *
 * The key is stored as a SHA-256 hash and shown exactly once, at issue. That
 * is the ordinary handling for a credential, and it means a copy of the
 * database yields nothing that can be replayed against this endpoint.
 *
 * WHAT IS PROTOTYPE HERE
 * ----------------------
 * The demo's *console* auth is still the unsigned account-id header described
 * in `middleware/auth.ts`. This endpoint does not use it. What a production
 * deployment would add is transport-level mutual TLS or a signed nonce to stop
 * replay, and per-device rate limiting. What is already right is that the
 * credential is never stored in recoverable form.
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { Device } from '../../shared/types/domain.js';
import {
  INGESTABLE_FIELDS,
  INGEST_VALIDITY_SEC,
  PLAUSIBLE_RANGE,
  validateIngest,
} from '../../shared/domain/ingest.js';
import { deviceRepo } from '../db/repositories.js';
import { platformState } from '../services/platformState.js';
import { asyncHandler, validate } from '../middleware/common.js';

export const ingestRouter = Router();

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Hash a presented key the same way the stored one was hashed. */
export function hashIngestKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Mint a key for one device.
 *
 * Returned to the caller once and never stored in recoverable form. The prefix
 * is kept so an operator can confirm which key a device holds without the
 * console ever being able to authenticate as it.
 */
export function issueIngestKey(): { key: string; hash: string; prefix: string } {
  const key = `hgk_${randomBytes(24).toString('base64url')}`;
  return { key, hash: hashIngestKey(key), prefix: key.slice(0, 12) };
}

// ---------------------------------------------------------------------------
// Device authentication
// ---------------------------------------------------------------------------

const UNAUTHORISED = {
  error: 'DEVICE_AUTH_REQUIRED',
  message: 'Present a valid device key in the X-Device-Key header.',
  messageZh: '請於 X-Device-Key 標頭提供有效的裝置金鑰。',
};

/**
 * Resolve the device presenting this request, or null.
 *
 * The lookup is an exact match on the SHA-256 of the presented key. No
 * constant-time comparison is used or needed: what is compared is a digest,
 * not the secret, and timing that reveals which digest was searched for gives
 * an attacker nothing without a preimage. The secret is never held in a form
 * that could be compared byte by byte, which is the stronger property.
 */
async function authenticateDevice(key: string | undefined): Promise<Device | null> {
  if (!key || key.length < 8) return null;
  return deviceRepo.findByIngestKeyHash(hashIngestKey(key));
}

// ---------------------------------------------------------------------------
// POST /api/ingest/readings
// ---------------------------------------------------------------------------

const ingestSchema = z.object({
  /** ISO timestamp of the measurement. Defaults to now. */
  observedAt: z.string().optional(),
  /** Field name to value, e.g. { "indoorTempC": 34.2 }. */
  readings: z.record(z.string(), z.unknown()),
});

/**
 * POST /api/ingest/readings
 *
 * The whole point of Phase 3: a real device and the simulator now enter the
 * platform through the same interface. A measurement posted here becomes an
 * input source report, is ranked above the simulated ones, and is assembled
 * into a reading by exactly the code that handles simulated data.
 *
 * Partial acceptance is deliberate - see `validateIngest`.
 */
ingestRouter.post(
  '/readings',
  validate(ingestSchema),
  asyncHandler(async (req, res) => {
    const device = await authenticateDevice(req.header('x-device-key') ?? undefined);

    if (!device) {
      res.status(401).json(UNAUTHORISED);
      return;
    }

    if (device.status === 'DISABLED') {
      res.status(403).json({
        error: 'DEVICE_DISABLED',
        message: 'This device has been disabled by an administrator.',
        messageZh: '此裝置已由管理者停用。',
      });
      return;
    }

    const body = req.body as z.infer<typeof ingestSchema>;

    const { accepted, rejected } = validateIngest({
      device,
      values: body.readings,
      observedAt: body.observedAt,
    });

    if (accepted.length > 0) {
      await platformState.acceptIngest(device, accepted);
    }

    /**
     * 202 when something was refused: the request was understood and acted on
     * in part, and the caller has to be told which values did not make it. A
     * device that silently drops half its payload is worse than one that errors.
     */
    res.status(rejected.length > 0 ? 202 : 200).json({
      deviceId: device.deviceId,
      accepted: accepted.map((m) => ({ field: m.field, value: m.value, observedAt: m.observedAt })),
      rejected,
      /** How long these values will be treated as current. */
      validForSec: INGEST_VALIDITY_SEC,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/ingest/self
// ---------------------------------------------------------------------------

/**
 * What this device is permitted to report.
 *
 * A device can discover its own contract rather than having the field names
 * and ranges hard-coded into firmware by someone reading documentation.
 */
ingestRouter.get(
  '/self',
  asyncHandler(async (req, res) => {
    const device = await authenticateDevice(req.header('x-device-key') ?? undefined);

    if (!device) {
      res.status(401).json(UNAUTHORISED);
      return;
    }

    const fields = INGESTABLE_FIELDS[device.type] ?? [];

    res.json({
      deviceId: device.deviceId,
      nameZh: device.nameZh,
      type: device.type,
      status: device.status,
      lastIngestAt: device.lastIngestAt ?? null,
      accepts: fields.map((field) => ({ field, range: PLAUSIBLE_RANGE[field] })),
      validForSec: INGEST_VALIDITY_SEC,
    });
  }),
);
