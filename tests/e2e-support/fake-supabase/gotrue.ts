/**
 * E2E TEST SUPPORT ONLY: the Supabase Auth (GoTrue) subset the app uses, plus JWT checks for
 * every other service.
 *
 *   POST /auth/v1/token?grant_type=password | refresh_token | pkce
 *   GET  /auth/v1/user            PUT /auth/v1/user
 *   POST /auth/v1/logout?scope=   POST /auth/v1/recover   GET /auth/v1/health | /settings
 *   POST /auth/v1/verify          (type recovery + token_hash, i.e. verifyOtp from a reset link)
 *   /auth/v1/admin/users[/:id]    (service_role only: create / list / get / update / delete)
 *
 * Error bodies follow GoTrue (API version 2024-01-01): { code, error_code, msg } with the same
 * HTTP statuses, so auth-js raises the same AuthApiError codes (invalid_credentials,
 * email_not_confirmed, user_banned, refresh_token_not_found, session_not_found, bad_jwt ...).
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TEST_ANON_KEY, TEST_JWT_SECRET } from '../constants';
import { signJwt, verifyJwt, type JwtPayload } from '../jwt';
import { HttpError, apiKey, bearerToken, parseJsonBody, send } from './http';
import type { AuthUser, Caller, FakeSupabaseState, SessionRecord } from './state';

const API_VERSION_HEADERS = { 'X-Supabase-Api-Version': '2024-01-01' };
const REFRESH_REUSE_INTERVAL_MS = 10_000;
/** GoTrue's default mailer OTP / link lifetime. */
const RECOVERY_LINK_TTL_MS = 3600_000;

export function authError(status: number, code: string, msg: string): HttpError {
  return new HttpError(status, { code, error_code: code, msg }, API_VERSION_HEADERS);
}

/** PostgREST-style 401 (also used by Storage, with its own body shape). */
function jwtRejected(service: 'rest' | 'storage', message: string, expired: boolean): HttpError {
  if (service === 'storage') {
    return new HttpError(400, { statusCode: '400', error: 'InvalidJWT', message: expired ? 'jwt expired' : message });
  }
  return new HttpError(
    401,
    { code: expired ? 'PGRST303' : 'PGRST301', message: expired ? 'JWT expired' : message, details: null, hint: null },
    { 'WWW-Authenticate': `Bearer error="invalid_token", error_description="${expired ? 'JWT expired' : message}"` }
  );
}

/**
 * Who is calling (API gateway + PostgREST semantics): the `apikey` header must be a valid project
 * key; the bearer token (or the apikey when there is none) decides the database role.
 */
export function resolveCaller(state: FakeSupabaseState, req: IncomingMessage, service: 'rest' | 'storage'): Caller {
  const key = apiKey(req);
  const bearer = bearerToken(req);
  if (!key && !bearer) {
    throw new HttpError(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
  }
  if (key) {
    const checked = verifyJwt(key, TEST_JWT_SECRET);
    if (!checked.ok || (checked.payload.role !== 'anon' && checked.payload.role !== 'service_role')) {
      throw new HttpError(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
    }
  }
  const token = bearer ?? key ?? TEST_ANON_KEY;
  const verified = verifyJwt(token, TEST_JWT_SECRET);
  if (!verified.ok) throw jwtRejected(service, verified.message, verified.reason === 'expired');
  const claims = verified.payload;
  if (claims.role === 'anon') return { role: 'anon' };
  if (claims.role === 'service_role') return { role: 'service_role' };
  if (claims.role === 'authenticated' && typeof claims.sub === 'string') {
    return {
      role: 'authenticated',
      userId: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      sessionId: typeof claims.session_id === 'string' ? claims.session_id : null,
      claims
    };
  }
  throw jwtRejected(service, `JWT role "${String(claims.role)}" is not allowed`, false);
}

export function userJson(user: AuthUser): Record<string, unknown> {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: user.emailConfirmedAt,
    phone: '',
    confirmed_at: user.emailConfirmedAt,
    last_sign_in_at: user.lastSignInAt,
    app_metadata: user.appMetadata,
    user_metadata: user.userMetadata,
    identities: [],
    created_at: user.createdAt,
    updated_at: user.updatedAt,
    is_anonymous: false,
    ...(user.bannedUntil ? { banned_until: user.bannedUntil } : {})
  };
}

function accessToken(state: FakeSupabaseState, user: AuthUser, session: SessionRecord): { token: string; iat: number; exp: number } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + state.jwtExpirySeconds;
  const payload: JwtPayload = {
    aud: 'authenticated',
    exp,
    iat,
    iss: `${state.baseUrl}/auth/v1`,
    sub: user.id,
    email: user.email,
    phone: '',
    app_metadata: user.appMetadata,
    user_metadata: user.userMetadata,
    role: 'authenticated',
    aal: 'aal1',
    amr: session.amr,
    session_id: session.id,
    is_anonymous: false
  };
  return { token: signJwt(payload, TEST_JWT_SECRET), iat, exp };
}

function sessionJson(state: FakeSupabaseState, user: AuthUser, session: SessionRecord, refreshToken: string): Record<string, unknown> {
  const { token, exp } = accessToken(state, user, session);
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: state.jwtExpirySeconds,
    expires_at: exp,
    refresh_token: refreshToken,
    user: userJson(user)
  };
}

function isBanned(user: AuthUser): boolean {
  return user.bannedUntil !== null && Date.parse(user.bannedUntil) > Date.now();
}

function passwordMatches(user: AuthUser, password: unknown): boolean {
  if (typeof password !== 'string' || user.password === null) return false;
  const a = createHash('sha256').update(user.password).digest();
  const b = createHash('sha256').update(password).digest();
  return timingSafeEqual(a, b);
}

/** Go duration ("876000h", "1h30m", "10s") → ms; 'none' → null. */
export function parseBanDuration(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === 'none' || value === null || value === '') return null;
  if (typeof value !== 'string') throw authError(400, 'validation_failed', 'ban_duration must be a string');
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    const n = Number(match[1]);
    total += match[2] === 'h' ? n * 3_600_000 : match[2] === 'm' ? n * 60_000 : match[2] === 's' ? n * 1000 : n;
    consumed += match[0].length;
  }
  if (consumed !== value.length || consumed === 0) throw authError(400, 'validation_failed', `invalid ban_duration "${value}"`);
  return total;
}

/** A user access token (verified, session alive, user exists) → user + session. */
function requireUserToken(state: FakeSupabaseState, req: IncomingMessage): { user: AuthUser; session: SessionRecord | null; claims: JwtPayload } {
  const token = bearerToken(req);
  if (!token) throw authError(401, 'no_authorization', 'This endpoint requires a Bearer token');
  const verified = verifyJwt(token, TEST_JWT_SECRET);
  if (!verified.ok) {
    const reason = verified.reason === 'expired' ? 'token has invalid claims: token is expired' : verified.message;
    throw authError(403, 'bad_jwt', `invalid JWT: unable to parse or verify signature, ${reason}`);
  }
  const claims = verified.payload;
  if (typeof claims.sub !== 'string' || claims.role !== 'authenticated') {
    throw authError(403, 'bad_jwt', 'invalid claim: missing sub claim');
  }
  const user = state.users.get(claims.sub);
  if (!user) throw authError(403, 'user_not_found', 'User from sub claim in JWT does not exist');
  const sessionId = typeof claims.session_id === 'string' ? claims.session_id : null;
  const session = sessionId ? state.sessions.get(sessionId) ?? null : null;
  if (sessionId && (!session || session.revoked)) {
    throw authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
  }
  return { user, session, claims };
}

function requireServiceRole(req: IncomingMessage): void {
  const token = bearerToken(req) ?? apiKey(req);
  const verified = token ? verifyJwt(token, TEST_JWT_SECRET) : null;
  if (!verified || !verified.ok || verified.payload.role !== 'service_role') {
    throw authError(403, 'not_admin', 'User not allowed');
  }
}

function requireApiKey(req: IncomingMessage): void {
  const key = apiKey(req);
  const verified = key ? verifyJwt(key, TEST_JWT_SECRET) : null;
  if (!verified || !verified.ok || (verified.payload.role !== 'anon' && verified.payload.role !== 'service_role')) {
    throw new HttpError(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
  }
}

function bodyObject(buf: Buffer): Record<string, unknown> {
  const parsed = parseJsonBody(buf);
  if (parsed === undefined) return {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw authError(400, 'validation_failed', 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

async function applyUserUpdate(state: FakeSupabaseState, user: AuthUser, body: Record<string, unknown>, admin: boolean): Promise<void> {
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.length < 6) {
      throw new HttpError(422, { code: 'weak_password', error_code: 'weak_password', msg: 'Password should be at least 6 characters.', weak_password: { reasons: ['length'] } }, API_VERSION_HEADERS);
    }
    user.password = body.password;
  }
  if (body.email !== undefined) {
    if (typeof body.email !== 'string' || !EMAIL.test(body.email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
    const email = body.email.trim().toLowerCase();
    const other = state.userByEmail(email);
    if (other && other.id !== user.id) throw authError(422, 'email_exists', 'A user with this email address has already been registered');
    user.email = email;
    await state.asSuperuser((db) => db.query(`UPDATE auth.users SET email = $2 WHERE id = $1`, [user.id, email]));
  }
  const data = admin ? body.user_metadata : body.data;
  if (data !== undefined) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw authError(400, 'validation_failed', 'user_metadata must be an object');
    user.userMetadata = { ...user.userMetadata, ...(data as Record<string, unknown>) };
  }
  if (admin) {
    if (body.app_metadata !== undefined) {
      if (!body.app_metadata || typeof body.app_metadata !== 'object') throw authError(400, 'validation_failed', 'app_metadata must be an object');
      user.appMetadata = { ...user.appMetadata, ...(body.app_metadata as Record<string, unknown>) };
    }
    if (body.email_confirm === true && !user.emailConfirmedAt) user.emailConfirmedAt = new Date().toISOString();
    const ban = parseBanDuration(body.ban_duration);
    if (ban !== undefined) {
      user.bannedUntil = ban === null ? null : new Date(Date.now() + ban).toISOString();
      if (ban !== null) for (const session of state.sessions.values()) if (session.userId === user.id) state.revokeSession(session.id);
    }
  }
  user.updatedAt = new Date().toISOString();
}

export async function handleAuth(
  state: FakeSupabaseState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  subpath: string,
  body: Buffer
): Promise<void> {
  const method = req.method ?? 'GET';
  const ok = (status: number, payload: unknown) => send(req, res, status, payload, API_VERSION_HEADERS);

  if (subpath === 'health' && method === 'GET') return ok(200, { version: 'e2e-fake', name: 'GoTrue', description: 'E2E fake' });
  if (subpath === 'settings' && method === 'GET') {
    return ok(200, { external: { email: true }, disable_signup: true, mailer_autoconfirm: false, phone_autoconfirm: false, sms_provider: '' });
  }

  requireApiKey(req);

  if (subpath === 'token' && method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    const input = bodyObject(body);
    if (grant === 'password') {
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const user = email ? state.userByEmail(email) : undefined;
      if (!user || !passwordMatches(user, input.password)) throw authError(400, 'invalid_credentials', 'Invalid login credentials');
      if (!user.emailConfirmedAt) throw authError(400, 'email_not_confirmed', 'Email not confirmed');
      if (isBanned(user)) throw authError(400, 'user_banned', 'User is banned');
      const { session, refreshToken } = state.newSession(user.id, 'password');
      user.lastSignInAt = new Date().toISOString();
      return ok(200, sessionJson(state, user, session, refreshToken));
    }
    if (grant === 'refresh_token') {
      const token = typeof input.refresh_token === 'string' ? input.refresh_token : '';
      const record = token ? state.refreshTokens.get(token) : undefined;
      const session = record ? state.sessions.get(record.sessionId) : undefined;
      if (!record || !session || session.revoked) {
        throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      }
      const user = state.users.get(record.userId);
      if (!user) throw authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      if (isBanned(user)) throw authError(400, 'user_banned', 'User is banned');
      if (record.revokedAt !== null) {
        // GoTrue allows a short reuse window (parallel tabs / proxy refreshing at the same time).
        if (record.child && Date.now() - record.revokedAt <= REFRESH_REUSE_INTERVAL_MS) {
          return ok(200, sessionJson(state, user, session, record.child));
        }
        state.revokeSession(session.id);
        throw authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used');
      }
      const child = state.newRefreshToken(session);
      record.revokedAt = Date.now();
      record.child = child;
      return ok(200, sessionJson(state, user, session, child));
    }
    if (grant === 'pkce') {
      const code = typeof input.auth_code === 'string' ? input.auth_code : '';
      const verifier = typeof input.code_verifier === 'string' ? input.code_verifier : '';
      const flow = state.recoveries.find((candidate) => candidate.authCode === code && !candidate.used);
      if (!flow || !flow.userId) throw authError(404, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
      const challenge =
        flow.codeChallengeMethod === 'plain' ? verifier : createHash('sha256').update(verifier).digest('base64url');
      if (!flow.codeChallenge || challenge !== flow.codeChallenge) {
        throw authError(403, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
      }
      flow.used = true;
      const user = state.users.get(flow.userId);
      if (!user) throw authError(404, 'user_not_found', 'User not found');
      const { session, refreshToken } = state.newSession(user.id, 'recovery');
      return ok(200, sessionJson(state, user, session, refreshToken));
    }
    throw authError(400, 'validation_failed', `unsupported grant_type "${grant ?? ''}"`);
  }

  if (subpath === 'user') {
    const { user } = requireUserToken(state, req);
    if (method === 'GET') return ok(200, userJson(user));
    if (method === 'PUT') {
      await applyUserUpdate(state, user, bodyObject(body), false);
      return ok(200, userJson(user));
    }
  }

  if (subpath === 'logout' && method === 'POST') {
    const token = bearerToken(req);
    const verified = token ? verifyJwt(token, TEST_JWT_SECRET) : null;
    if (!verified || !verified.ok) return send(req, res, 204, null);
    const scope = url.searchParams.get('scope') ?? 'global';
    const sessionId = typeof verified.payload.session_id === 'string' ? verified.payload.session_id : null;
    const userId = typeof verified.payload.sub === 'string' ? verified.payload.sub : null;
    for (const session of state.sessions.values()) {
      if (session.userId !== userId) continue;
      const isCurrent = session.id === sessionId;
      if (scope === 'global' || (scope === 'local' && isCurrent) || (scope === 'others' && !isCurrent)) state.revokeSession(session.id);
    }
    return send(req, res, 204, null);
  }

  if (subpath === 'recover' && method === 'POST') {
    const input = bodyObject(body);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
    const user = state.userByEmail(email);
    state.recoveries.push({
      email,
      userId: user?.id ?? null,
      redirectTo: url.searchParams.get('redirect_to'),
      codeChallenge: typeof input.code_challenge === 'string' ? input.code_challenge : null,
      codeChallengeMethod: typeof input.code_challenge_method === 'string' ? input.code_challenge_method.toLowerCase() : null,
      authCode: randomUUID(),
      tokenHash: createHash('sha224').update(`${email}:${randomUUID()}`).digest('hex'),
      createdAt: new Date().toISOString(),
      used: false
    });
    // Like GoTrue: the same answer whether or not the address exists (no account enumeration).
    return ok(200, {});
  }

  // Token-hash links ({{ .SiteURL }}/auth/reset?token_hash=...&type=recovery → verifyOtp).
  if (subpath === 'verify' && method === 'POST') {
    const input = bodyObject(body);
    if (input.type !== 'recovery') {
      throw authError(400, 'validation_failed', `Only type "recovery" is supported by the E2E fake (got "${String(input.type)}")`);
    }
    const tokenHash = typeof input.token_hash === 'string' ? input.token_hash : '';
    const flow = tokenHash ? state.recoveries.find((candidate) => candidate.tokenHash === tokenHash) : undefined;
    if (!flow || flow.used || !flow.userId || Date.now() - Date.parse(flow.createdAt) > RECOVERY_LINK_TTL_MS) {
      throw authError(403, 'otp_expired', 'Email link is invalid or has expired');
    }
    const user = state.users.get(flow.userId);
    if (!user) throw authError(403, 'otp_expired', 'Email link is invalid or has expired');
    if (isBanned(user)) throw authError(400, 'user_banned', 'User is banned');
    flow.used = true;
    const { session, refreshToken } = state.newSession(user.id, 'otp');
    user.lastSignInAt = new Date().toISOString();
    return ok(200, sessionJson(state, user, session, refreshToken));
  }

  if (subpath === 'signup' && method === 'POST') throw authError(422, 'signup_disabled', 'Signups not allowed for this instance');
  if ((subpath === 'otp' || subpath === 'magiclink') && method === 'POST') throw authError(422, 'otp_disabled', 'Signups not allowed for otp');

  const admin = /^admin\/users(?:\/([^/]+))?$/.exec(subpath);
  if (admin) {
    requireServiceRole(req);
    const id = admin[1] ? decodeURIComponent(admin[1]) : null;
    if (!id && method === 'GET') {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const perPage = Math.max(1, Number(url.searchParams.get('per_page') ?? '50') || 50);
      const all = [...state.users.values()];
      return ok(200, { aud: 'authenticated', users: all.slice((page - 1) * perPage, page * perPage).map(userJson), total: all.length });
    }
    if (!id && method === 'POST') {
      const input = bodyObject(body);
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!EMAIL.test(email)) throw authError(400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (state.userByEmail(email)) throw authError(422, 'email_exists', 'A user with this email address has already been registered');
      if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length < 6)) {
        throw new HttpError(422, { code: 'weak_password', error_code: 'weak_password', msg: 'Password should be at least 6 characters.', weak_password: { reasons: ['length'] } }, API_VERSION_HEADERS);
      }
      const newId = typeof input.id === 'string' ? input.id : randomUUID();
      const ban = parseBanDuration(input.ban_duration);
      const user = await state.asSuperuser((db) =>
        state.createAuthUser(db, {
          id: newId,
          email,
          password: typeof input.password === 'string' ? input.password : null,
          emailConfirmed: input.email_confirm === true,
          userMetadata: (input.user_metadata as Record<string, unknown> | undefined) ?? {},
          appMetadata: (input.app_metadata as Record<string, unknown> | undefined) ?? {},
          bannedUntil: ban ? new Date(Date.now() + ban).toISOString() : null
        })
      );
      return ok(200, userJson(user));
    }
    if (id) {
      const user = state.users.get(id);
      if (!user) throw authError(404, 'user_not_found', 'User not found');
      if (method === 'GET') return ok(200, userJson(user));
      if (method === 'PUT') {
        await applyUserUpdate(state, user, bodyObject(body), true);
        return ok(200, userJson(user));
      }
      if (method === 'DELETE') {
        try {
          await state.asSuperuser((db) => db.query(`DELETE FROM auth.users WHERE id = $1`, [id]));
        } catch {
          // GoTrue answers a database refusal (e.g. RESTRICT foreign keys on shifts) this way.
          throw authError(500, 'unexpected_failure', 'Database error deleting user');
        }
        state.users.delete(id);
        for (const session of state.sessions.values()) if (session.userId === id) state.revokeSession(session.id);
        return ok(200, userJson(user));
      }
    }
  }

  throw authError(404, 'not_found', `No Auth route for ${method} /auth/v1/${subpath}`);
}

export interface RecoveryLink {
  email: string;
  accountExists: boolean;
  redirectTo: string | null;
  /** PKCE link (default template → /verify → <redirect_to>?code=<auth code>), or null. */
  link: string | null;
  /** Token-hash link (custom template: <redirect_to>?token_hash=<hash>&type=recovery), or null. */
  tokenHashLink: string | null;
  createdAt: string;
  used: boolean;
}

/** Recovery links the fake "mailer" would have sent. Unknown addresses get no link (nothing is mailed). */
export function recoveryLinks(state: FakeSupabaseState): RecoveryLink[] {
  return state.recoveries.map((flow) => {
    let link: string | null = null;
    let tokenHashLink: string | null = null;
    if (flow.userId && flow.redirectTo) {
      // Only the PKCE code flow (what @supabase/ssr uses) is emulated; the implicit flow gets no code link.
      if (flow.codeChallenge) {
        const target = new URL(flow.redirectTo);
        target.searchParams.set('code', flow.authCode);
        link = target.toString();
      }
      const hashed = new URL(flow.redirectTo);
      hashed.searchParams.set('token_hash', flow.tokenHash);
      hashed.searchParams.set('type', 'recovery');
      tokenHashLink = hashed.toString();
    }
    return {
      email: flow.email,
      accountExists: flow.userId !== null,
      redirectTo: flow.redirectTo,
      link,
      tokenHashLink,
      createdAt: flow.createdAt,
      used: flow.used
    };
  });
}
