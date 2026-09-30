import type { SupabaseClient } from '@supabase/supabase-js';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { browserStorage, setCurrentUserPointer, type KeyValueStorage } from './identity';

/**
 * Guards sign in with a short login (e.g. employee number "wag1") instead of an e-mail
 * address. Such logins map to a Supabase Auth e-mail on a non-routable domain that an
 * admin uses when creating the guard account.
 */
export const DEFAULT_GUARD_LOGIN_DOMAIN = 'guards.eagleeye.local';

const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function guardLoginDomain(): string {
  return process.env.NEXT_PUBLIC_GUARD_LOGIN_DOMAIN || DEFAULT_GUARD_LOGIN_DOMAIN;
}

/**
 * Maps what the user typed to the Supabase Auth e-mail: an address containing '@' is used
 * as-is (lower-cased); anything else becomes `<login>@<guard login domain>`.
 * Returns null for input that can be neither.
 */
export function loginToEmail(login: string, domain: string = guardLoginDomain()): string | null {
  const value = typeof login === 'string' ? login.trim().toLowerCase() : '';
  if (!value) return null;
  if (value.includes('@')) {
    return /^[^\s@]+@[^\s@]+$/.test(value) ? value : null;
  }
  return LOGIN_PATTERN.test(value) ? `${value}@${domain.toLowerCase()}` : null;
}

export type SignInFailureReason =
  | 'invalid_input'
  | 'invalid_credentials'
  /** Supabase Auth rate limit (e.g. many guards signing in from one farm connection at shift change). */
  | 'rate_limited'
  /** The account exists but its e-mail was never confirmed (guard logins cannot receive mail). */
  | 'not_activated'
  | 'account_blocked'
  | 'network'
  | 'error';

export type SignInResult = { ok: true; userId: string } | { ok: false; reason: SignInFailureReason; message: string };

const MESSAGES: Record<Exclude<SignInFailureReason, 'error'>, string> = {
  invalid_input: 'Enter your login (or e-mail) and password.',
  invalid_credentials: 'Login or password is incorrect.',
  rate_limited: 'Too many sign-in attempts from this connection. Wait a minute, then try again.',
  not_activated: 'This account has not been activated yet. Ask your administrator to activate it.',
  account_blocked: 'This account is blocked. Contact your administrator.',
  network: 'No connection to the server. Signing in needs internet.'
};

function failure(reason: Exclude<SignInFailureReason, 'error'>): SignInResult {
  return { ok: false, reason, message: MESSAGES[reason] };
}

interface AuthErrorLike {
  status?: number;
  code?: string;
  message?: string;
  name?: string;
}

/**
 * Supabase Auth error → reason. The error code decides first; only "could not reach the server"
 * (no response, a 5xx, a timeout) counts as a connection problem — a 429 is the server
 * answering "slow down", not an outage.
 */
export function classifySignInError(error: unknown): SignInResult {
  const e = (error ?? {}) as AuthErrorLike;
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || e.status === 429) {
    return failure('rate_limited');
  }
  if (code === 'email_not_confirmed' || code === 'phone_not_confirmed') return failure('not_activated');
  if (code === 'user_banned') return failure('account_blocked');
  if (code === 'invalid_credentials') return failure('invalid_credentials');
  if (
    error instanceof TypeError ||
    isAuthRetryableFetchError(error) ||
    e.name === 'TimeoutError' ||
    e.status === 0 ||
    e.status === 408 ||
    (typeof e.status === 'number' && e.status >= 500)
  ) {
    return failure('network');
  }
  // Older Auth servers answer wrong credentials with a bare 400 and no code.
  if (e.status === 400 && !code) return failure('invalid_credentials');
  return { ok: false, reason: 'error', message: typeof e.message === 'string' && e.message ? e.message : String(error) };
}

/**
 * Password sign-in against Supabase Auth. Never succeeds without a real session. On success the
 * account is recorded as the holder of this device's session (the only cache the app may boot
 * from offline), replacing any previous account.
 */
export async function signIn(
  login: string,
  password: string,
  client?: Pick<SupabaseClient, 'auth'>,
  storage: KeyValueStorage | null = browserStorage()
): Promise<SignInResult> {
  const email = loginToEmail(login);
  if (!email || !password) return failure('invalid_input');
  const supabase = client ?? (await import('@/lib/supabase/client')).createClient();
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return classifySignInError(error);
    if (!data.session || !data.user) {
      return { ok: false, reason: 'error', message: 'Sign-in did not return a session.' };
    }
    setCurrentUserPointer(storage, data.user.id);
    return { ok: true, userId: data.user.id };
  } catch (error) {
    return classifySignInError(error);
  }
}
