import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { UserRole } from '@/types/models';
import { areaForPath, homeForRoles, isUserRole, resolveRouteAccess, safeNextPath } from './routeAccess';

const ROLES: UserRole[] = ['super_admin', 'admin', 'supervisor', 'guard', 'client_viewer'];

// Expected access matrix (contract section 2 / proxy): route prefix → roles allowed.
const MATRIX: Record<string, UserRole[]> = {
  '/admin': ['admin', 'super_admin'],
  '/admin/device-test': ['admin', 'super_admin'],
  '/supervisor': ['supervisor', 'admin', 'super_admin'],
  '/guard': ['guard'],
  '/guard/patrol': ['guard'],
  '/viewer': ['client_viewer', 'admin', 'super_admin']
};

describe('resolveRouteAccess', () => {
  for (const [path, allowed] of Object.entries(MATRIX)) {
    for (const role of ROLES) {
      const expected = allowed.includes(role);
      it(`${role} ${expected ? 'may' : 'may not'} open ${path}`, () => {
        const access = resolveRouteAccess(path, [role]);
        assert.equal(access.allowed, expected);
        if (!expected) {
          assert.equal(access.redirectTo, homeForRoles([role]));
          // The redirect target must itself be allowed for that role (no redirect loops).
          assert.equal(resolveRouteAccess(access.redirectTo as string, [role]).allowed, true);
        }
      });
    }
  }

  it('a user without roles may open no portal and is sent to /', () => {
    for (const path of Object.keys(MATRIX)) {
      assert.deepEqual(resolveRouteAccess(path, []), { allowed: false, redirectTo: '/' });
    }
  });

  it('public routes are always allowed', () => {
    for (const path of ['/', '/login', '/administrator', '/guards', '/viewerx', '/offline.html']) {
      assert.deepEqual(resolveRouteAccess(path, []), { allowed: true });
    }
  });

  it('combined roles use the most privileged home', () => {
    assert.equal(homeForRoles(['guard', 'supervisor']), '/supervisor');
    assert.equal(homeForRoles(['client_viewer', 'super_admin']), '/admin');
    assert.equal(homeForRoles(['client_viewer']), '/viewer');
    assert.equal(resolveRouteAccess('/guard', ['guard', 'supervisor']).allowed, true);
  });
});

describe('areaForPath / isUserRole / safeNextPath', () => {
  it('matches whole path segments only', () => {
    assert.equal(areaForPath('/admin'), 'admin');
    assert.equal(areaForPath('/admin/'), 'admin');
    assert.equal(areaForPath('/Admin/x'), 'admin');
    assert.equal(areaForPath('/administrator'), null);
    assert.equal(areaForPath(''), null);
  });

  it('recognises only real roles', () => {
    assert.equal(isUserRole('guard'), true);
    assert.equal(isUserRole('root'), false);
    assert.equal(isUserRole(undefined), false);
  });

  it('only honours same-origin paths after login', () => {
    assert.equal(safeNextPath('/guard/patrol?x=1'), '/guard/patrol?x=1');
    assert.equal(safeNextPath('//evil.example/phish'), '/');
    assert.equal(safeNextPath('https://evil.example'), '/');
    assert.equal(safeNextPath('/\\evil.example'), '/');
    assert.equal(safeNextPath(null, '/guard'), '/guard');
  });

  it('rejects control and whitespace characters the URL parser would strip into an off-site redirect', () => {
    const base = 'https://app.eagleeye.test/login';
    // What ?next=%2F%09%2Fevil.example decodes to.
    const fromQuery = new URLSearchParams('next=%2F%09%2Fevil.example%2Fphish').get('next');
    for (const probe of [fromQuery, '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/ /evil.example', '/ x', '/\u0000x']) {
      const out = safeNextPath(probe);
      assert.equal(out, '/', `rejected ${JSON.stringify(probe)}`);
      assert.equal(new URL(out, base).origin, 'https://app.eagleeye.test');
    }
  });

  it('normalises dot segments and still refuses anything that resolves off-site', () => {
    assert.equal(safeNextPath('/.//evil.example'), '/');
    assert.equal(safeNextPath('/..//evil.example/x'), '/');
    assert.equal(safeNextPath('/guard/../admin'), '/admin');
    // Encoded separators stay encoded: a same-origin path, not a host.
    assert.equal(safeNextPath('/%2F/evil.example'), '/%2F/evil.example');
    assert.equal(new URL(safeNextPath('/%2F/evil.example'), 'https://app.eagleeye.test').origin, 'https://app.eagleeye.test');
    assert.equal(safeNextPath('/guard/patrol?x=1#top'), '/guard/patrol?x=1#top');
  });
});
