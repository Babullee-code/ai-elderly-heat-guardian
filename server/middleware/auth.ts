/**
 * Authentication and authorisation middleware.
 *
 * PROTOTYPE AUTHENTICATION. The demo identifies a caller by an account id
 * sent in the `x-account-id` header, which the login screen stores after
 * selecting a demo account. There are no passwords and no signed tokens.
 *
 * What this is NOT: a production auth system. A real deployment would replace
 * `resolveAccount` with verified session cookies or signed JWTs and add rate
 * limiting, CSRF protection and audit-grade session tracking. That swap is
 * confined to this file.
 *
 * What it nonetheless does correctly, and deliberately: authorisation is
 * enforced on the SERVER for every mutating route. The client hides controls
 * a role cannot use, but hiding a button is a courtesy - the checks here are
 * the actual boundary. A VIEWER token cannot change a threshold by calling
 * the API directly.
 */

import type { NextFunction, Request, Response } from 'express';
import type { Account, Permission } from '../../shared/types/domain.js';
import { canAccessAdmin, hasPermission } from '../../shared/domain/permissions.js';
import { accountRepo } from '../db/repositories.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      account?: Account;
    }
  }
}

/** Attach the calling account, if the header identifies a known one. */
export async function resolveAccount(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('x-account-id') ?? '';
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const id = (header || bearer).trim();

  if (id) {
    const account = await accountRepo.findById(id);
    if (account) req.account = account;
  }

  next();
}

/** Require any authenticated account. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.account) {
    res.status(401).json({
      error: 'AUTH_REQUIRED',
      message: 'Sign in with a demo account to continue.',
      messageZh: '請先以示範帳號登入。',
    });
    return;
  }
  next();
}

/** Require a specific permission from the role table. */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.account) {
      res.status(401).json({
        error: 'AUTH_REQUIRED',
        message: 'Sign in with a demo account to continue.',
        messageZh: '請先以示範帳號登入。',
      });
      return;
    }

    if (!hasPermission(req.account.role, permission)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: `The ${req.account.role} role does not have the "${permission}" permission.`,
        messageZh: `目前角色（${req.account.role}）沒有「${permission}」權限。`,
      });
      return;
    }

    next();
  };
}

/** Gate the whole /admin API surface. */
export function requireAdminAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.account) {
    res.status(401).json({
      error: 'AUTH_REQUIRED',
      message: 'Sign in with a demo account to continue.',
      messageZh: '請先以示範帳號登入。',
    });
    return;
  }

  if (!canAccessAdmin(req.account.role)) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Administrative endpoints are not available to this role.',
      messageZh: '此角色無法使用管理功能。',
    });
    return;
  }

  next();
}

/**
 * Scope a caregiver to their assigned users.
 *
 * A CAREGIVER account may read a user only if that user is assigned to them.
 * Admin roles pass through. This prevents the caregiver dashboard from being
 * turned into a directory of every resident on the platform by changing an id
 * in the URL.
 */
export function requireUserScope(getUserId: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const account = req.account;
    if (!account) {
      res.status(401).json({ error: 'AUTH_REQUIRED', message: 'Sign in to continue.' });
      return;
    }

    const userId = getUserId(req);

    if (account.role === 'ELDER') {
      if (account.elderlyUserId !== userId) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'You can only view your own information.',
          messageZh: '您只能檢視自己的資料。',
        });
        return;
      }
      next();
      return;
    }

    if (account.role === 'CAREGIVER') {
      const { caregiverRepo } = await import('../db/repositories.js');
      const caregiver = account.caregiverId
        ? await caregiverRepo.findById(account.caregiverId)
        : null;

      if (!caregiver || !caregiver.assignedUserIds.includes(userId)) {
        res.status(403).json({
          error: 'FORBIDDEN',
          message: 'This resident is not assigned to you.',
          messageZh: '此長者未指派給您。',
        });
        return;
      }
    }

    next();
  };
}
