/**
 * /api/auth - demo authentication.
 *
 * Accounts are pre-seeded and selected by email; there are no passwords.
 * The response returns the account id, which the client sends back as
 * `x-account-id`. See server/middleware/auth.ts for why this is acceptable
 * in a prototype and what a production swap would look like.
 */

import { Router } from 'express';
import { loginSchema } from '../../shared/schemas/index.js';
import { ROLE_PERMISSIONS } from '../../shared/domain/permissions.js';
import { accountRepo, caregiverRepo, userRepo } from '../db/repositories.js';
import { asyncHandler, validate } from '../middleware/common.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

/** List the demo accounts so the login screen can show them as buttons. */
authRouter.get(
  '/accounts',
  asyncHandler(async (_req, res) => {
    const accounts = await accountRepo.list();
    res.json({
      accounts,
      demo: true,
      notice:
        'These are demo accounts with no passwords. Do not use this authentication flow in production.',
      noticeZh: '這些是無密碼的示範帳號，請勿用於正式環境。',
    });
  }),
);

authRouter.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const account = await accountRepo.findByEmail(req.body.email);

    if (!account) {
      res.status(404).json({
        error: 'ACCOUNT_NOT_FOUND',
        message: 'No demo account uses that email address.',
        messageZh: '找不到使用此電子郵件的示範帳號。',
      });
      return;
    }

    res.json({
      account,
      permissions: ROLE_PERMISSIONS[account.role],
      token: account.id,
    });
  }),
);

/** Resolve the current session, including the linked person's details. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const account = req.account!;

    const elderlyUser = account.elderlyUserId
      ? await userRepo.findById(account.elderlyUserId)
      : null;
    const caregiver = account.caregiverId
      ? await caregiverRepo.findById(account.caregiverId)
      : null;

    res.json({
      account,
      permissions: ROLE_PERMISSIONS[account.role],
      elderlyUser,
      caregiver,
    });
  }),
);
