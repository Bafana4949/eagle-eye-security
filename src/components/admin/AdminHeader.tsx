'use client';

/**
 * Admin console chrome. The header is the shared manager header (HeaderNav: Eagle Eye logo, title,
 * truthful upload status, name / role and the sign-out flow that refuses to hide unsynced records);
 * identity comes from useAuth() inside it. Nothing extra is put in the header so it still fits a
 * 320 px screen when the upload status pill is showing. The foot of each admin page carries the
 * language choice and the link between the console and the device test.
 */
import React from 'react';
import Link from 'next/link';
import { ArrowLeft, Smartphone } from 'lucide-react';
import { buttonClassName } from '@/components/ui/button';
import { HeaderNav, LanguageSwitch } from '@/components/shared/HeaderNav';
import { useTranslation } from '@/lib/i18n/context';

/**
 * The logo in HeaderNav links to the admin's home (/admin), so sub-pages need no extra back arrow
 * in the header (the footer has an explicit link back).
 */
export function AdminHeader({ title }: { title: string }) {
  return <HeaderNav title={title} />;
}

/** Foot of the admin pages: device test / back link and the language choice (Dawie's three buttons). */
export function AdminFooter({ page }: { page: 'console' | 'device-test' }) {
  const { t } = useTranslation();
  return (
    <footer className="space-y-4 border-t border-ee-border pt-4 print:hidden">
      {page === 'console' ? (
        <Link
          href="/admin/device-test"
          className={buttonClassName({ variant: 'secondary', size: 'md', className: 'w-full sm:w-auto' })}
          data-testid="admin-device-test-link"
        >
          <Smartphone className="h-5 w-5" aria-hidden />
          <span>{t('admDeviceTestLink')}</span>
        </Link>
      ) : (
        <Link
          href="/admin"
          className={buttonClassName({ variant: 'secondary', size: 'md', className: 'w-full sm:w-auto' })}
          data-testid="admin-back-to-console"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
          <span>{t('admBackToConsole')}</span>
        </Link>
      )}
      <section aria-labelledby={`admin-language-heading-${page}`} className="space-y-2">
        <h2 id={`admin-language-heading-${page}`} className="text-sm font-semibold text-ee-muted">
          {t('admLanguage')}
        </h2>
        <LanguageSwitch testIdPrefix="admin-lang" />
      </section>
    </footer>
  );
}
