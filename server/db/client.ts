/**
 * Prisma client singleton.
 *
 * `tsx watch` re-imports modules on change, so the client is cached on
 * globalThis to avoid exhausting SQLite connections during development.
 */

import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * JSON helpers.
 *
 * Structured payloads are stored as TEXT rather than a provider-specific JSON
 * column so the schema works unchanged on both SQLite and PostgreSQL. All
 * (de)serialisation is funnelled through these two functions so a malformed
 * row can never crash a request handler.
 */

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    console.warn('[db] Failed to parse stored JSON, using fallback');
    return fallback;
  }
}
