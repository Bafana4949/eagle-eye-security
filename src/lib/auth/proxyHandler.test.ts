import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import { handleProxyRequest, type ProxyClientFactory } from './proxyHandler';
import { isDefinitelySignedOut, isNetworkFailure } from './authErrors';

const USER = 'a1111111-2222-4333-8444-555555555555';

interface FakeOptions {
  claims?: { data: { claims: { sub: string } } | null; error: unknown };
  claimsThrows?: boolean;
  profile?: { data: unknown; error: unknown };
  roles?: { data: unknown; error: unknown };
}

function factory(options: FakeOptions, seen: { roleQueries: number; created: number }): ProxyClientFactory {
  return (request) => {
    seen.created += 1;
    const supabase = {
      auth: {
        getClaims: async () => {
          if (options.claimsThrows) throw new TypeError('fetch failed');
          return options.claims ?? { data: null, error: null };
        }
      },
      from: (table: string) => ({
        select: () => ({
          eq: () => {
            if (table === 'user_roles') {
              seen.roleQueries += 1;
              return Promise.resolve(options.roles ?? { data: [], error: null });
            }
            return { maybeSingle: () => Promise.resolve(options.profile ?? { data: null, error: null }) };
          }
        })
      })
    };
    const response = NextResponse.next({ request });
    response.cookies.set('sb-test-auth-token', 'refreshed', { path: '/' });
    return { supabase: supabase as unknown as SupabaseClient, response: () => response };
  };
}

function request(path: string): NextRequest {
  return new NextRequest(`https://eagle.example${path}`);
}

const signedIn = { data: { claims: { sub: USER } }, error: null };
const activeProfile = { data: { id: USER, is_active: true }, error: null };

describe('handleProxyRequest', () => {
  it('ignores public routes without touching Supabase', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const response = await handleProxyRequest(request('/login'), factory({}, seen));
    assert.equal(response.headers.get('location'), null);
    assert.equal(seen.created, 0);
  });

  it('redirects a request without a session to /login?next=…', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const response = await handleProxyRequest(request('/guard/patrol?cp=1'), factory({}, seen));
    assert.equal(response.status, 307);
    const location = new URL(response.headers.get('location') as string);
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('next'), '/guard/patrol?cp=1');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });

  it('redirects when the session is definitely invalid (revoked refresh token)', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const error = new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found');
    const response = await handleProxyRequest(request('/admin'), factory({ claims: { data: null, error } }, seen));
    assert.equal(new URL(response.headers.get('location') as string).pathname, '/login');
    // Cookie changes made while checking (e.g. clearing the dead session) survive the redirect.
    assert.equal(response.cookies.get('sb-test-auth-token')?.value, 'refreshed');
  });

  it('does NOT redirect when Supabase is unreachable', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const offline = await handleProxyRequest(
      request('/guard'),
      factory({ claims: { data: null, error: new AuthRetryableFetchError('fetch failed', 0) } }, seen)
    );
    assert.equal(offline.headers.get('location'), null);
    const thrown = await handleProxyRequest(request('/guard'), factory({ claimsThrows: true }, seen));
    assert.equal(thrown.headers.get('location'), null);
    const rolesDown = await handleProxyRequest(
      request('/guard'),
      factory({ claims: signedIn, profile: activeProfile, roles: { data: null, error: { message: 'upstream timeout' } } }, seen)
    );
    assert.equal(rolesDown.headers.get('location'), null);
  });

  it('lets a guard into /guard and keeps refreshed cookies', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const response = await handleProxyRequest(
      request('/guard'),
      factory({ claims: signedIn, profile: activeProfile, roles: { data: [{ role: 'guard' }], error: null } }, seen)
    );
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('x-middleware-next'), '1');
    assert.equal(response.cookies.get('sb-test-auth-token')?.value, 'refreshed');
    assert.equal(seen.roleQueries, 1);
  });

  it('sends a guard who opens /admin to the guard app', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const response = await handleProxyRequest(
      request('/admin'),
      factory({ claims: signedIn, profile: activeProfile, roles: { data: [{ role: 'guard' }], error: null } }, seen)
    );
    assert.equal(new URL(response.headers.get('location') as string).pathname, '/guard');
  });

  it('ignores unknown role strings (an "admin" substring in an e-mail grants nothing)', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const response = await handleProxyRequest(
      request('/admin'),
      factory({ claims: signedIn, profile: activeProfile, roles: { data: [{ role: 'administrator' }], error: null } }, seen)
    );
    assert.equal(new URL(response.headers.get('location') as string).pathname, '/');
  });

  it('sends disabled and profile-less accounts to /login with a reason', async () => {
    const seen = { roleQueries: 0, created: 0 };
    const disabled = await handleProxyRequest(
      request('/supervisor'),
      factory({ claims: signedIn, profile: { data: { id: USER, is_active: false }, error: null }, roles: { data: [{ role: 'supervisor' }], error: null } }, seen)
    );
    assert.equal(new URL(disabled.headers.get('location') as string).searchParams.get('reason'), 'disabled');
    const missing = await handleProxyRequest(
      request('/supervisor'),
      factory({ claims: signedIn, profile: { data: null, error: null }, roles: { data: [], error: null } }, seen)
    );
    assert.equal(new URL(missing.headers.get('location') as string).searchParams.get('reason'), 'no_profile');
  });
});

describe('auth error classification', () => {
  it('only proven-dead sessions count as signed out', () => {
    assert.equal(isDefinitelySignedOut(new AuthSessionMissingError()), true);
    assert.equal(isDefinitelySignedOut(new AuthApiError('bad jwt', 401, 'bad_jwt')), true);
    assert.equal(isDefinitelySignedOut(new AuthRetryableFetchError('fetch failed', 0)), false);
    assert.equal(isDefinitelySignedOut(new AuthApiError('server error', 500, 'unexpected_failure')), false);
    assert.equal(isDefinitelySignedOut(new Error('random')), false);
    assert.equal(isDefinitelySignedOut(null), false);
  });

  it('recognises network failures', () => {
    assert.equal(isNetworkFailure(0, { message: 'x' }), true);
    assert.equal(isNetworkFailure(503, null), true);
    assert.equal(isNetworkFailure(undefined, new TypeError('Failed to fetch')), true);
    assert.equal(isNetworkFailure(403, { message: 'new row violates row-level security policy' }), false);
  });
});
