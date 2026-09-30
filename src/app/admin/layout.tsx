'use client';

import React from 'react';
import { RequireRole } from '@/components/auth/RequireRole';
import { I18nProvider } from '@/lib/i18n/context';

/**
 * /admin and /admin/device-test: organisation admins only. This gate is UX; the database (RLS,
 * column privileges, triggers) is what enforces admin-only access to the data.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <RequireRole roles={['admin', 'super_admin']}>
        <div className="min-h-screen bg-ee-bg text-ee-text font-sans print:min-h-0 print:bg-transparent">{children}</div>
      </RequireRole>
    </I18nProvider>
  );
}
