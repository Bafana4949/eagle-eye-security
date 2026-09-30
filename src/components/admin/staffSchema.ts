/**
 * Request contract of POST /api/admin/users (create a staff account). Shared by the admin form
 * (client-side checks) and the route handler (the authoritative check). Pure: no React, no
 * server-only imports.
 *
 * The organisation is NEVER part of the request: the server always uses the calling admin's
 * own organisation.
 */
import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 10;
/** bcrypt (Supabase Auth) ignores bytes after 72. */
export const MAX_PASSWORD_LENGTH = 72;

/** Same pattern as loginToEmail() in src/lib/auth/signIn.ts (guard short logins). */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STAFF_ROLES = ['guard', 'supervisor', 'client_viewer', 'admin', 'super_admin'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value));

export const createStaffSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    role: z.enum(STAFF_ROLES),
    login: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('username'),
        username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN)
      }),
      z.object({
        kind: z.literal('email'),
        email: z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
      })
    ]),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH)
      .max(MAX_PASSWORD_LENGTH)
      .refine((value) => value.trim().length === value.length, 'Password must not start or end with a space'),
    employeeNumber: optionalText(50),
    phoneNumber: optionalText(50),
    preferredLanguage: z.enum(['en', 'af', 'zu']),
    siteIds: z
      .array(z.string().regex(UUID_PATTERN))
      .max(100)
      .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])
  })
  .strict();

export type CreateStaffRequest = z.input<typeof createStaffSchema>;
export type CreateStaffInput = z.output<typeof createStaffSchema>;

export type CreateStaffErrorCode =
  | 'invalid_input'
  | 'invalid_json'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'cross_origin'
  | 'not_signed_in'
  | 'account_disabled'
  | 'forbidden'
  | 'super_admin_required'
  | 'invalid_sites'
  | 'login_taken'
  | 'weak_password'
  | 'server_misconfigured'
  | 'auth_service_error'
  | 'provisioning_failed';

export interface CreatedStaffAccount {
  id: string;
  /** The Supabase Auth e-mail the person signs in with (guards: login@guard domain). */
  email: string;
  /** What the person types at sign-in (username for guards, otherwise the e-mail). */
  login: string;
  role: StaffRole;
  siteIds: string[];
}

export type CreateStaffResponse =
  | { ok: true; user: CreatedStaffAccount }
  | {
      ok: false;
      error: CreateStaffErrorCode;
      /** Field paths that failed validation (invalid_input only). */
      fields?: string[];
      /** provisioning_failed: whether the half-created auth account was removed again. */
      rolledBack?: boolean;
      stage?: 'profile' | 'role' | 'sites';
    };

/** Random password for a new account (shown once to the admin). No ambiguous characters. */
export function generateStaffPassword(length = 14, randomFill: (bytes: Uint8Array) => Uint8Array = defaultRandomFill): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = randomFill(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

function defaultRandomFill(bytes: Uint8Array): Uint8Array {
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable; cannot generate a password.');
  }
  return cryptoObj.getRandomValues(bytes);
}
