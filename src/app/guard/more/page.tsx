'use client';

import React, { useId, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Download, History, Loader2, MapPin } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { guardLoginDomain } from '@/lib/auth/signIn';
import { AREA_ROLES, hasAnyRole } from '@/lib/auth/routeAccess';
import { useTranslation } from '@/lib/i18n/context';
import { offlineDB } from '@/lib/offline/db';
import { sastDateString } from '@/lib/config/siteTime';
import {
  LanguageSwitch,
  ModalDialog,
  SignOutControl,
  SyncDetails,
  toneForeground,
  useSyncSummary,
  type Tone
} from '@/components/shared/HeaderNav';
import { SiteChoiceList, useActiveShiftRecord } from '@/components/guard/HeaderBar';
import { buildGuardEventsCsv, loadGuardEvents } from '../history/guardEvents';

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mb-2 mt-6 font-display text-2xl font-semibold">
      {children}
    </h2>
  );
}

const listLinkClass =
  'flex min-h-14 items-center justify-between gap-3 px-1 py-2 text-base font-semibold text-ee-text no-underline hover:bg-ee-surface-raised';

export default function GuardMorePage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const { summary, ready } = useSyncSummary();
  const userId = auth.user?.id ?? null;
  const activeShift = useActiveShiftRecord(userId);
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ tone: Tone; text: string } | null>(null);
  const siteTitleId = useId();

  const email = auth.user?.email ?? '';
  const guardSuffix = `@${guardLoginDomain().toLowerCase()}`;
  const isGuardLogin = email.toLowerCase().endsWith(guardSuffix);
  const loginName = isGuardLogin ? email.slice(0, -guardSuffix.length) : email;
  const fullName = auth.profile ? `${auth.profile.firstName} ${auth.profile.lastName}`.trim() : '';

  const otherPortals = [
    hasAnyRole(auth.roles, AREA_ROLES.supervisor) && { href: '/supervisor', key: 'authPortalSupervisor' as const },
    hasAnyRole(auth.roles, AREA_ROLES.admin) && { href: '/admin', key: 'authPortalAdmin' as const }
  ].filter((entry): entry is { href: string; key: 'authPortalSupervisor' | 'authPortalAdmin' } => Boolean(entry));

  const exportCsv = async () => {
    if (exporting) return;
    const db = offlineDB;
    if (!db || !userId) {
      setExportStatus({ tone: 'danger', text: t('authHistNoStorage') });
      return;
    }
    setExporting(true);
    setExportStatus(null);
    try {
      // Every record of this guard on this phone (unbounded: read without an IndexedDB count).
      const rows = await loadGuardEvents(db, userId, { kind: 'all' }, Number.POSITIVE_INFINITY);
      if (rows.length === 0) {
        setExportStatus({ tone: 'muted', text: t('authExportEmpty') });
        return;
      }
      const siteNames = Object.fromEntries(auth.sites.map((site) => [site.id, site.name]));
      const csv = buildGuardEventsCsv(rows, t, siteNames);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `eagle-eye-records-${sastDateString(Date.now())}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setExportStatus({ tone: 'success', text: t('authExportPrepared', rows.length) });
    } catch (error) {
      setExportStatus({ tone: 'danger', text: t('authExportFailed', error instanceof Error ? error.message : String(error)) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pb-6">
      <h1 className="mb-4 font-display text-3xl font-semibold">{t('more')}</h1>

      <section aria-labelledby="more-account">
        <SectionTitle id="more-account">{t('authMoreAccount')}</SectionTitle>
        <dl className="divide-y divide-ee-border border-y border-ee-border">
          <div className="flex items-baseline justify-between gap-3 py-3">
            <dt className="text-sm text-ee-muted">{t('authMoreName')}</dt>
            <dd className="min-w-0 truncate text-right text-base font-semibold" data-testid="more-account-name">
              {fullName}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-3">
            <dt className="text-sm text-ee-muted">{isGuardLogin ? t('authMoreUsername') : t('authEmailLabel')}</dt>
            <dd className="min-w-0 truncate text-right text-base" data-testid="more-account-login">
              {loginName}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <dt className="text-sm text-ee-muted">{t('authMoreSite')}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="truncate text-right text-base font-semibold" data-testid="more-account-site">
                {auth.activeSite?.name ?? t('authNoSiteShort')}
              </span>
              {auth.sites.length > 1 && (
                <button
                  type="button"
                  onClick={() => setSiteDialogOpen(true)}
                  aria-haspopup="dialog"
                  className="inline-flex min-h-11 flex-none items-center gap-1 rounded-xl border border-ee-border px-3 text-sm font-semibold text-ee-primary hover:bg-ee-surface-raised"
                  data-testid="more-change-site"
                >
                  <MapPin className="h-4 w-4" aria-hidden="true" />
                  {t('authMoreChangeSite')}
                </button>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="more-language">
        <SectionTitle id="more-language">{t('authLanguageGroup')}</SectionTitle>
        <LanguageSwitch testIdPrefix="more-lang" />
      </section>

      <section aria-labelledby="more-uploads">
        <SectionTitle id="more-uploads">{t('authSyncTitle')}</SectionTitle>
        <SyncDetails summary={summary} ready={ready} />
      </section>

      <section aria-labelledby="more-records">
        <SectionTitle id="more-records">{t('authMoreRecords')}</SectionTitle>
        <ul className="divide-y divide-ee-border border-y border-ee-border">
          <li>
            <Link href="/guard/history" className={listLinkClass} data-testid="more-history-link">
              <span className="flex items-center gap-3">
                <History className="h-5 w-5 text-ee-muted" aria-hidden="true" />
                {t('history')}
              </span>
              <ChevronRight className="h-5 w-5 text-ee-muted" aria-hidden="true" />
            </Link>
          </li>
          <li>
            <button
              type="button"
              onClick={() => void exportCsv()}
              disabled={exporting}
              className={`${listLinkClass} w-full text-left disabled:opacity-60`}
              data-testid="more-export-csv"
            >
              <span className="flex items-center gap-3">
                {exporting ? (
                  <Loader2 className="h-5 w-5 animate-spin text-ee-muted motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <Download className="h-5 w-5 text-ee-muted" aria-hidden="true" />
                )}
                <span>
                  {t('authExportCsv')}
                  <span className="block text-sm font-normal text-ee-muted">{t('authExportHint')}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
        <p
          role="status"
          aria-live="polite"
          className={`mt-2 min-h-5 text-sm ${exportStatus ? toneForeground[exportStatus.tone] : ''}`}
          data-testid="more-export-status"
        >
          {exportStatus?.text ?? ''}
        </p>
      </section>

      {otherPortals.length > 0 && (
        <section aria-labelledby="more-portals">
          <SectionTitle id="more-portals">{t('authMoreOtherPortals')}</SectionTitle>
          <ul className="divide-y divide-ee-border border-y border-ee-border">
            {otherPortals.map((portal) => (
              <li key={portal.href}>
                <Link href={portal.href} className={listLinkClass} data-testid={`more-portal-${portal.href.slice(1)}`}>
                  {t(portal.key)}
                  <ChevronRight className="h-5 w-5 text-ee-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="more-signout" className="mt-8">
        <h2 id="more-signout" className="sr-only">
          {t('authSignOut')}
        </h2>
        <SignOutControl variant="full" testId="more-signout" />
        <p className="mt-2 text-sm text-ee-muted">{t('authSignOutHint')}</p>
      </section>

      {auth.sites.length > 1 && (
        <ModalDialog
          open={siteDialogOpen}
          onClose={() => setSiteDialogOpen(false)}
          labelledBy={siteTitleId}
          testId="more-site-dialog"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id={siteTitleId} className="font-display text-2xl font-semibold">
              {t('authSitePickTitle')}
            </h2>
            <button
              type="button"
              onClick={() => setSiteDialogOpen(false)}
              className="min-h-11 rounded-xl border border-ee-border px-4 text-sm font-semibold hover:bg-ee-surface-raised"
            >
              {t('authClose')}
            </button>
          </div>
          <SiteChoiceList locked={!!activeShift} onChosen={() => setSiteDialogOpen(false)} />
        </ModalDialog>
      )}
    </div>
  );
}
