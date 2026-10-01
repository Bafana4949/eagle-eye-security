/**
 * E2E TEST SUPPORT ONLY: mutable state of the fake Supabase server — the PGlite database
 * (real migrations + RLS), Auth users / sessions / refresh tokens, Storage object bytes,
 * the request log and scripted faults.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { cloneTestDb, createTestDb, listMigrationFiles, withClaims, type JwtClaims } from '../../db/harness';
import { seedE2EFixture, type CreateAuthUserInput, type E2EFixture } from '../fixture';
import type { JwtPayload } from '../jwt';
import { loadSchemaCache, type SchemaCache } from './schema';
import path from 'node:path';

export type Caller =
  | { role: 'anon' }
  | { role: 'service_role' }
  | { role: 'authenticated'; userId: string; email: string | null; sessionId: string | null; claims: JwtPayload };

export interface AuthUser {
  id: string;
  email: string;
  password: string | null;
  emailConfirmedAt: string | null;
  bannedUntil: string | null;
  userMetadata: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  revoked: boolean;
  amr: Array<{ method: string; timestamp: number }>;
}

export interface RefreshRecord {
  token: string;
  sessionId: string;
  userId: string;
  revokedAt: number | null;
  child: string | null;
}

export interface RecoveryRecord {
  email: string;
  userId: string | null;
  redirectTo: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  authCode: string;
  /** The e-mail template's {{ .TokenHash }} (verified with POST /auth/v1/verify). */
  tokenHash: string;
  createdAt: string;
  used: boolean;
}

/**
 * A magic link minted by POST /auth/v1/admin/generate_link (service role only). Like GoTrue it
 * is single-use, expires (magicLinkTtlSeconds) and a newer link for the same user replaces it.
 */
export interface MagicLinkRecord {
  userId: string;
  /** The account's e-mail when the link was minted (a later e-mail change invalidates it). */
  email: string;
  /** GoTrue's hashed_token (sha224 hex of e-mail + OTP); verifyOtp sends it back as token_hash. */
  tokenHash: string;
  emailOtp: string;
  redirectTo: string | null;
  createdAt: number;
  usedAt: number | null;
  /** Set when a newer link for the same user replaced this one. */
  supersededAt: number | null;
}

export interface StoredObject {
  bucket: string;
  name: string;
  bytes: Buffer;
  contentType: string;
  createdAt: string;
}

export interface RequestLogEntry {
  seq: number;
  at: string;
  method: string;
  path: string;
  status: number;
  role: string;
  userId: string | null;
  durationMs: number;
  /** PostgREST / Auth / Storage error code of the response, when there was one. */
  errorCode: string | null;
  fault: string | null;
}

export type FaultAction = 'network_error' | 'lose_response' | 'status' | 'delay';

export interface FaultRule {
  id: number;
  method: string | null;
  path: RegExp;
  action: FaultAction;
  status: number;
  body: unknown;
  delayMs: number;
  remaining: number;
  /** Free label (the outage switch uses 'outage'). */
  tag: string | null;
}

export interface FaultRuleInput {
  method?: string | null;
  /** Regular expression matched against the request path + query (e.g. "^/rest/v1/patrol_scans"). */
  path?: string;
  action: FaultAction;
  status?: number;
  body?: unknown;
  delayMs?: number;
  /** How many requests the rule applies to (default 1; use a large number for "until cleared"). */
  times?: number;
  tag?: string;
}

const REQUEST_LOG_LIMIT = 2000;

/**
 * Lifetime of an admin-generated magic link. GoTrue's default (MAILER_OTP_EXP) is one hour; the
 * fake uses five minutes because the app verifies the token immediately (POST /__test/config
 * { magicLinkTtlSeconds } shortens it further to test expiry).
 */
export const DEFAULT_MAGIC_LINK_TTL_SECONDS = 300;

export class FakeSupabaseState {
  template!: PGlite;
  db!: PGlite;
  schema!: SchemaCache;
  /** The schema cache of the migrated template (restored on every reset). */
  private templateSchema!: SchemaCache;
  fixture: E2EFixture | null = null;
  migrations: string[] = [];
  resets = 0;
  ready = false;

  jwtExpirySeconds = 3600;
  readonly users = new Map<string, AuthUser>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly refreshTokens = new Map<string, RefreshRecord>();
  readonly recoveries: RecoveryRecord[] = [];
  readonly magicLinks: MagicLinkRecord[] = [];
  magicLinkTtlSeconds = DEFAULT_MAGIC_LINK_TTL_SECONDS;
  readonly objects = new Map<string, StoredObject>();
  readonly requestLog: RequestLogEntry[] = [];
  requestSeq = 0;
  faults: FaultRule[] = [];
  private faultSeq = 0;
  realtimeUpgradesRefused = 0;
  private readonly inFlight = new Map<PGlite, number>();
  private resetChain: Promise<unknown> = Promise.resolve();

  /** Public URL of the server (JWT `iss`); set once the port is known. */
  constructor(public baseUrl: string) {}

  async init(): Promise<void> {
    this.template = await createTestDb();
    await this.template.exec(`SET TIME ZONE 'UTC'`);
    this.migrations = listMigrationFiles().map((file) => path.basename(file));
    this.templateSchema = await loadSchemaCache(this.template);
    this.schema = this.templateSchema;
    await this.reset({ seed: true });
    this.ready = true;
  }

  /** Fresh copy of the migrated database (+ E2E fixture). Serialised; in-flight requests finish first. */
  reset(options: { seed?: boolean } = {}): Promise<E2EFixture | null> {
    const run = this.resetChain.then(() => this.doReset(options.seed !== false));
    this.resetChain = run.catch(() => undefined);
    return run;
  }

  private async doReset(seed: boolean): Promise<E2EFixture | null> {
    const next = await cloneTestDb(this.template);
    await next.exec(`SET TIME ZONE 'UTC'`);
    this.users.clear();
    this.sessions.clear();
    this.refreshTokens.clear();
    this.recoveries.length = 0;
    this.magicLinks.length = 0;
    this.magicLinkTtlSeconds = DEFAULT_MAGIC_LINK_TTL_SECONDS;
    this.objects.clear();
    this.faults = [];
    this.jwtExpirySeconds = 3600;
    let fixture: E2EFixture | null = null;
    try {
      if (seed) fixture = await seedE2EFixture(next, (input) => this.createAuthUser(next, input).then(() => undefined));
    } catch (error) {
      await next.close();
      throw error;
    }
    const old = this.db as PGlite | undefined;
    this.db = next;
    // A reload after ad-hoc DDL (POST /__test/schema/reload) must not outlive the database it described.
    this.schema = this.templateSchema;
    this.fixture = fixture;
    this.resets += 1;
    if (old) {
      await this.waitIdle(old, 10_000);
      await old.close().catch(() => undefined);
    }
    return fixture;
  }

  private async waitIdle(db: PGlite, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.inFlight.get(db) ?? 0) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.inFlight.delete(db);
  }

  async close(): Promise<void> {
    await this.db?.close().catch(() => undefined);
    await this.template?.close().catch(() => undefined);
  }

  /**
   * One PostgREST-style transaction as the caller: SET LOCAL ROLE + request.jwt.* (see
   * tests/db/harness.ts withClaims) plus request.method / request.path / request.headers.
   */
  async runAs<T>(
    caller: Caller,
    request: { method: string; path: string; headers: Record<string, string> },
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    const db = this.db;
    this.inFlight.set(db, (this.inFlight.get(db) ?? 0) + 1);
    try {
      const claims: JwtClaims =
        caller.role === 'authenticated'
          ? { ...caller.claims, sub: caller.userId, role: 'authenticated', email: caller.email }
          : { role: caller.role, sub: null };
      return await withClaims(db, claims, async (tx) => {
        await tx.query(
          `SELECT set_config('request.method', $1, true), set_config('request.path', $2, true),
                  set_config('request.headers', $3, true)`,
          [request.method, request.path, JSON.stringify(request.headers)]
        );
        return fn(tx);
      });
    } finally {
      this.inFlight.set(db, (this.inFlight.get(db) ?? 1) - 1);
    }
  }

  /** Superuser access (fixtures, assertions, Auth bookkeeping). */
  async asSuperuser<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
    const db = this.db;
    this.inFlight.set(db, (this.inFlight.get(db) ?? 0) + 1);
    try {
      return await fn(db);
    } finally {
      this.inFlight.set(db, (this.inFlight.get(db) ?? 1) - 1);
    }
  }

  // ---------------------------------------------------------------- Auth users

  userByEmail(email: string): AuthUser | undefined {
    const wanted = email.trim().toLowerCase();
    for (const user of this.users.values()) if (user.email === wanted) return user;
    return undefined;
  }

  async createAuthUser(
    db: PGlite,
    input: Omit<CreateAuthUserInput, 'password'> & {
      password: string | null;
      appMetadata?: Record<string, unknown>;
      bannedUntil?: string | null;
    }
  ): Promise<AuthUser> {
    const now = new Date().toISOString();
    const email = input.email.trim().toLowerCase();
    const user: AuthUser = {
      id: input.id,
      email,
      password: input.password,
      emailConfirmedAt: input.emailConfirmed ? now : null,
      bannedUntil: input.bannedUntil ?? null,
      userMetadata: input.userMetadata ?? {},
      appMetadata: { provider: 'email', providers: ['email'], ...(input.appMetadata ?? {}) },
      createdAt: now,
      updatedAt: now,
      lastSignInAt: null
    };
    await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data) VALUES ($1, $2, $3, $4)`, [
      user.id,
      user.email,
      JSON.stringify(user.userMetadata),
      JSON.stringify(user.appMetadata)
    ]);
    this.users.set(user.id, user);
    return user;
  }

  newSession(userId: string, method: string): { session: SessionRecord; refreshToken: string } {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      createdAt: Date.now(),
      revoked: false,
      amr: [{ method, timestamp: Math.floor(Date.now() / 1000) }]
    };
    this.sessions.set(session.id, session);
    const refreshToken = this.newRefreshToken(session);
    return { session, refreshToken };
  }

  newRefreshToken(session: SessionRecord): string {
    const token = randomBytes(18).toString('base64url');
    this.refreshTokens.set(token, { token, sessionId: session.id, userId: session.userId, revokedAt: null, child: null });
    return token;
  }

  revokeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.revoked = true;
    for (const record of this.refreshTokens.values()) {
      if (record.sessionId === sessionId && record.revokedAt === null) record.revokedAt = Date.now();
    }
  }

  /**
   * Mints a magic link the way GoTrue's admin generate_link does: a random 6-digit OTP and
   * hashed_token = sha224(email + otp) in hex. GoTrue keeps ONE such token per user, so an older
   * unused link of the same user stops working.
   */
  newMagicLink(user: AuthUser, redirectTo: string | null): MagicLinkRecord {
    const now = Date.now();
    for (const link of this.magicLinks) {
      if (link.userId === user.id && link.usedAt === null && link.supersededAt === null) link.supersededAt = now;
    }
    let emailOtp = '';
    let tokenHash = '';
    do {
      emailOtp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      tokenHash = createHash('sha224').update(`${user.email}${emailOtp}`).digest('hex');
    } while (this.magicLinks.some((link) => link.tokenHash === tokenHash));
    const record: MagicLinkRecord = { userId: user.id, email: user.email, tokenHash, emailOtp, redirectTo, createdAt: now, usedAt: null, supersededAt: null };
    this.magicLinks.push(record);
    return record;
  }

  magicLinkExpired(link: MagicLinkRecord, now: number = Date.now()): boolean {
    return now - link.createdAt > this.magicLinkTtlSeconds * 1000;
  }

  // ---------------------------------------------------------------- schema cache

  /** PostgREST's `NOTIFY pgrst, 'reload schema'`: re-reads the catalog of the live database. */
  async reloadSchema(): Promise<SchemaCache> {
    this.schema = await this.asSuperuser((db) => loadSchemaCache(db));
    return this.schema;
  }

  // ---------------------------------------------------------------- request log / faults

  log(entry: Omit<RequestLogEntry, 'seq'>): void {
    this.requestSeq += 1;
    this.requestLog.push({ seq: this.requestSeq, ...entry });
    if (this.requestLog.length > REQUEST_LOG_LIMIT) this.requestLog.splice(0, this.requestLog.length - REQUEST_LOG_LIMIT);
  }

  addFaults(inputs: FaultRuleInput[]): FaultRule[] {
    const added = inputs.map((input) => {
      this.faultSeq += 1;
      const rule: FaultRule = {
        id: this.faultSeq,
        method: input.method ? input.method.toUpperCase() : null,
        path: new RegExp(input.path ?? '.*'),
        action: input.action,
        status: input.status ?? 503,
        body: input.body ?? { message: 'Injected fault (E2E)' },
        delayMs: input.delayMs ?? 0,
        remaining: input.times === undefined ? 1 : input.times,
        tag: input.tag ?? null
      };
      return rule;
    });
    this.faults.push(...added);
    return added;
  }

  /** The first matching fault rule (consumed). */
  takeFault(method: string, pathAndQuery: string): FaultRule | null {
    const rule = this.faults.find(
      (candidate) => candidate.remaining > 0 && (!candidate.method || candidate.method === method) && candidate.path.test(pathAndQuery)
    );
    if (!rule) return null;
    rule.remaining -= 1;
    return rule;
  }
}
