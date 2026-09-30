import React from 'react';
import { RequireRole } from '@/components/auth/RequireRole';
import { AREA_ROLES } from '@/lib/auth/routeAccess';
import { I18nProvider } from '@/lib/i18n/context';

/**
 * Supervisor operations area: supervisors (their assigned sites) and organisation admins.
 * RequireRole is navigation UX only; Row Level Security decides which rows are returned.
 */
export default function SupervisorLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <RequireRole roles={AREA_ROLES.supervisor}>{children}</RequireRole>
    </I18nProvider>
  );
}
