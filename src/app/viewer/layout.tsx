import React from 'react';
import { RequireRole } from '@/components/auth/RequireRole';
import { AREA_ROLES } from '@/lib/auth/routeAccess';
import { I18nProvider } from '@/lib/i18n/context';

/**
 * Client viewer portal (read-only): client viewers of their assigned sites, and org admins.
 * RequireRole is navigation UX only; Row Level Security hides SOS alerts and selfies from
 * client viewers and limits every read to their assigned sites.
 */
export default function ViewerLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <RequireRole roles={AREA_ROLES.viewer}>{children}</RequireRole>
    </I18nProvider>
  );
}
