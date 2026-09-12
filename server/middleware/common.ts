/**
 * Validation, audit and error-handling middleware.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { AuditLogEntry } from '../../shared/types/domain.js';
import { auditRepo } from '../db/repositories.js';

/**
 * Validate `req.body` against a Zod schema, replacing it with the parsed
 * result so handlers receive typed, coerced, sanitised input.
 *
 * Field errors are returned in a shape the client forms can render inline.
 */
export function validate<T extends ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'Some fields need attention.',
        messageZh: '部分欄位需要修正。',
        fieldErrors: flattenZodError(result.error),
      });
      return;
    }

    req.body = result.data as z.infer<T>;
    next();
  };
}

/** Turn a ZodError into `{ 'path.to.field': 'message' }`. */
export function flattenZodError(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Record an administrative action in the audit log.
 *
 * Called explicitly from handlers rather than wired in as blanket middleware,
 * because a useful audit entry needs the old and new values, which only the
 * handler knows.
 */
export async function recordAudit(
  req: Request,
  entry: {
    action: string;
    actionZh: string;
    entity: string;
    entityId: string;
    oldValue?: unknown;
    newValue?: unknown;
  },
): Promise<AuditLogEntry> {
  const account = req.account;

  return auditRepo.create({
    actorId: account?.id ?? 'anonymous',
    actorName: account?.nameZh ?? account?.name ?? 'Anonymous',
    actorRole: account?.role ?? 'VIEWER',
    action: entry.action,
    actionZh: entry.actionZh,
    entity: entry.entity,
    entityId: entry.entityId,
    oldValue: entry.oldValue === undefined ? null : stringifyValue(entry.oldValue),
    newValue: entry.newValue === undefined ? null : stringifyValue(entry.newValue),
  });
}

/** Compact, readable representation of an audited value. */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

/**
 * Read a named path parameter as a string.
 *
 * Express 5 types `req.params` values as `string | string[]`, because a
 * wildcard segment can match several path parts. None of this API's routes
 * use wildcards, so a named parameter is always a single value - this helper
 * makes that explicit rather than scattering casts through the handlers.
 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Read a query-string value as a single string, or undefined. */
export function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}

/** 404 for unmatched API routes. */
export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `No API route matches ${req.method} ${req.originalUrl}.`,
    messageZh: '找不到對應的 API 路徑。',
  });
}

/**
 * Final error handler.
 *
 * Never returns a stack trace to the client. In development the message is
 * included to keep debugging practical; in production only a generic message
 * is sent and the detail stays in the server log.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const isProduction = process.env.NODE_ENV === 'production';

  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_FAILED',
      message: 'Some fields need attention.',
      messageZh: '部分欄位需要修正。',
      fieldErrors: flattenZodError(error),
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error('[api] Unhandled error:', error);

  // Prisma's "record not found" surfaces as a specific code; map it to 404 so
  // the client can show a sensible empty state instead of a server error.
  if (typeof message === 'string' && message.includes('P2025')) {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'That record no longer exists.',
      messageZh: '此資料已不存在。',
    });
    return;
  }

  if (typeof message === 'string' && message.includes('P2002')) {
    res.status(409).json({
      error: 'CONFLICT',
      message: 'A record with that unique value already exists.',
      messageZh: '已存在具有相同唯一值的資料。',
    });
    return;
  }

  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: isProduction
      ? 'Something went wrong on our side. Please try again.'
      : `Server error: ${message}`,
    messageZh: '系統發生問題，請稍後再試。',
  });
}
