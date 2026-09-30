import { describe, it } from 'node:test';
import assert from 'node:assert';
import { UserRole } from '@/types/models';

interface UserContext {
  userId: string;
  organisationId: string;
  role: UserRole;
  assignedSiteIds: string[];
}

function canAccessSite(user: UserContext, targetSiteOrgId: string, targetSiteId: string): boolean {
  // Cross-organisation isolation
  if (user.organisationId !== targetSiteOrgId) {
    return false;
  }

  // Super admin and admin can access all sites in org
  if (user.role === 'super_admin' || user.role === 'admin' || user.role === 'supervisor') {
    return true;
  }

  // Guards and client viewers must be specifically assigned to site
  return user.assignedSiteIds.includes(targetSiteId);
}

function canModifyConfiguration(user: UserContext): boolean {
  return user.role === 'super_admin' || user.role === 'admin';
}

function canAcknowledgeAlerts(user: UserContext): boolean {
  return user.role === 'super_admin' || user.role === 'admin' || user.role === 'supervisor';
}

function isReadOnlyViewer(user: UserContext): boolean {
  return user.role === 'client_viewer';
}

describe('Security & Multi-Tenant Role Authorization', () => {
  const orgA = 'org-aaaa-1111';
  const orgB = 'org-bbbb-2222';
  const site1 = 'site-1111';
  const site2 = 'site-2222';

  const guardOrgA: UserContext = {
    userId: 'guard-1',
    organisationId: orgA,
    role: 'guard',
    assignedSiteIds: [site1]
  };

  const supervisorOrgA: UserContext = {
    userId: 'super-1',
    organisationId: orgA,
    role: 'supervisor',
    assignedSiteIds: []
  };

  const clientViewerOrgA: UserContext = {
    userId: 'client-1',
    organisationId: orgA,
    role: 'client_viewer',
    assignedSiteIds: [site1]
  };

  it('blocks cross-tenant access between different organisations', () => {
    // Guard from Org A attempts to access Site in Org B
    const allowed = canAccessSite(guardOrgA, orgB, site1);
    assert.strictEqual(allowed, false, 'Guard must be blocked from foreign organisation site');

    // Supervisor from Org A attempts to access Site in Org B
    const superAllowed = canAccessSite(supervisorOrgA, orgB, site1);
    assert.strictEqual(superAllowed, false, 'Supervisor must be blocked from foreign organisation');
  });

  it('allows guards access only to their specifically assigned sites', () => {
    assert.strictEqual(canAccessSite(guardOrgA, orgA, site1), true);
    assert.strictEqual(canAccessSite(guardOrgA, orgA, site2), false, 'Guard cannot access unassigned site in same org');
  });

  it('permits supervisors to monitor all sites within their organisation', () => {
    assert.strictEqual(canAccessSite(supervisorOrgA, orgA, site1), true);
    assert.strictEqual(canAccessSite(supervisorOrgA, orgA, site2), true);
  });

  it('enforces client viewer read-only role restrictions', () => {
    assert.strictEqual(isReadOnlyViewer(clientViewerOrgA), true);
    assert.strictEqual(canModifyConfiguration(clientViewerOrgA), false);
    assert.strictEqual(canAcknowledgeAlerts(clientViewerOrgA), false);
    assert.strictEqual(canAccessSite(clientViewerOrgA, orgA, site1), true);
    assert.strictEqual(canAccessSite(clientViewerOrgA, orgA, site2), false);
  });

  it('verifies only admins can modify sensitive configurations', () => {
    assert.strictEqual(canModifyConfiguration(guardOrgA), false);
    assert.strictEqual(canModifyConfiguration(supervisorOrgA), false);
    assert.strictEqual(canModifyConfiguration({ ...supervisorOrgA, role: 'admin' }), true);
  });
});
