'use client';

/**
 * Admin console: sites, checkpoints (QR / NFC), staff and the audit log of the admin's own
 * organisation. All data comes from Supabase (RLS scopes it to the organisation); nothing here is
 * sample data. See src/components/admin/* for the panels.
 */
import React, { useEffect, useState } from 'react';
import { Building2, QrCode, ScrollText, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { Site } from '@/types/models';
import { AdminFooter, AdminHeader } from '@/components/admin/AdminHeader';
import { AuditPanel } from '@/components/admin/AuditPanel';
import { CheckpointsPanel } from '@/components/admin/CheckpointsPanel';
import { QrPrintSheet, type PrintCard, type PrintJob } from '@/components/admin/QrPrintSheet';
import { SitesPanel } from '@/components/admin/SitesPanel';
import { StaffPanel, type SitesStatus } from '@/components/admin/StaffPanel';
import { loadOrgSites, type AdminError } from '@/components/admin/adminData';
import { withDb } from '@/components/admin/withDb';
import { ErrorNotice, Notice, inputClass } from '@/components/admin/ui';

type Tab = 'sites' | 'checkpoints' | 'staff' | 'audit';

const TABS: ReadonlyArray<{ id: Tab; label: TranslationKey; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }> }> = [
  { id: 'sites', label: 'admTabSites', icon: Building2 },
  { id: 'checkpoints', label: 'admTabCheckpoints', icon: QrCode },
  { id: 'staff', label: 'admTabStaff', icon: Users },
  { id: 'audit', label: 'admTabAudit', icon: ScrollText }
];

type SitesState = { token: number; sites: Site[] } | { token: number; error: AdminError };

function initialTab(): Tab {
  if (typeof window === 'undefined') return 'checkpoints';
  const hash = window.location.hash.replace('#', '');
  return TABS.some((tab) => tab.id === hash) ? (hash as Tab) : 'checkpoints';
}

function sortSites(sites: Site[]): Site[] {
  return [...sites].sort((a, b) => a.name.localeCompare(b.name));
}

export default function AdminConsolePage() {
  const auth = useAuth();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sitesToken, setSitesToken] = useState(0);
  const [sitesState, setSitesState] = useState<SitesState | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [printJob, setPrintJob] = useState<PrintJob | null>(null);

  useEffect(() => {
    const token = sitesToken;
    let cancelled = false;
    void withDb((db) => loadOrgSites(db)).then((result) => {
      if (!cancelled) setSitesState(result.ok ? { token, sites: result.value } : { token, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [sitesToken]);

  const current = sitesState && sitesState.token === sitesToken ? sitesState : null;
  const sites = current && 'sites' in current ? current.sites : [];
  const sitesStatus: SitesStatus = !current ? 'loading' : 'error' in current ? 'error' : 'ready';
  const siteId =
    selectedSiteId && sites.some((s) => s.id === selectedSiteId)
      ? selectedSiteId
      : (sites.find((s) => s.id === auth.activeSite?.id)?.id ?? sites[0]?.id ?? null);
  const selectedSite = sites.find((s) => s.id === siteId) ?? null;
  const organisationId = auth.profile?.organisationId ?? null;
  const userId = auth.user?.id ?? null;
  const isSuperAdmin = auth.roles.includes('super_admin');

  const selectTab = (next: Tab) => {
    setTab(next);
    try {
      window.history.replaceState(null, '', `#${next}`);
    } catch {
      // History API unavailable: the tab simply is not remembered.
    }
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    selectTab(next.id);
    document.getElementById(`admin-tab-${next.id}`)?.focus();
    event.preventDefault();
  };

  const onSiteStored = (site: Site) => {
    setSitesState((state) => {
      if (!state || !('sites' in state)) return state;
      const others = state.sites.filter((s) => s.id !== site.id);
      return { ...state, sites: sortSites([...others, site]) };
    });
    // Keep this device's cached identity (sites / active site) in step with the database.
    void auth.refresh();
  };

  const onPrint = (cards: PrintCard[]) => {
    setPrintJob({ id: Date.now(), cards });
  };

  return (
    <>
      <div className="print:hidden">
        <AdminHeader title={t('admConsoleTitle')} />
        <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-4 pb-16">
          {auth.isOfflineSession && (
            <Notice tone="warning" testId="admin-offline">
              {t('admOfflineSession')}
            </Notice>
          )}

          <div role="tablist" aria-label={t('admConsoleTitle')} className="grid grid-cols-4 gap-1 rounded-2xl border border-ee-border bg-ee-surface p-1" onKeyDown={onTabKeyDown}>
            {TABS.map((item) => {
              const Icon = item.icon;
              const selected = tab === item.id;
              return (
                <button
                  key={item.id}
                  id={`admin-tab-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={selected ? `admin-tabpanel-${item.id}` : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(item.id)}
                  className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-center text-xs font-semibold leading-tight sm:flex-row sm:gap-2 sm:text-sm ${
                    selected ? 'bg-ee-primary text-ee-on-primary' : 'text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text'
                  }`}
                  data-testid={`admin-tab-${item.id}`}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  <span className="break-words">{t(item.label)}</span>
                </button>
              );
            })}
          </div>

          <div id={`admin-tabpanel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`} className="space-y-4">
            {!organisationId || !userId ? (
              <Notice tone="danger">{t('admNoProfile')}</Notice>
            ) : tab === 'staff' || tab === 'audit' ? null : !current ? (
              <p className="text-sm text-ee-muted" role="status" data-testid="admin-sites-loading">
                {t('admLoading')}
              </p>
            ) : 'error' in current ? (
              <div className="space-y-2">
                <ErrorNotice error={current.error} title={t('admSitesLoadFailed')} testId="admin-sites-error" />
                <Button type="button" variant="secondary" className="min-h-12" onClick={() => setSitesToken((n) => n + 1)}>
                  {t('admTryAgain')}
                </Button>
              </div>
            ) : tab === 'sites' ? (
              <SitesPanel sites={sites} selectedSiteId={siteId} organisationId={organisationId} onSelectSite={setSelectedSiteId} onSiteStored={onSiteStored} />
            ) : (
              <>
                {sites.length > 1 && (
                  <div>
                    <label htmlFor="admin-site-select" className="mb-1 block text-sm font-semibold text-ee-muted">
                      {t('admSite')}
                    </label>
                    <select id="admin-site-select" value={siteId ?? ''} onChange={(event) => setSelectedSiteId(event.target.value)} className={inputClass} data-testid="admin-site-select">
                      {sites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name} ({site.code})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {sites.length === 0 ? (
                  <Notice tone="info" testId="admin-checkpoints-no-sites">
                    {t('admNoSitesForCheckpoints')}
                  </Notice>
                ) : (
                  <CheckpointsPanel key={siteId ?? 'none'} site={selectedSite} sites={sites} onPrint={onPrint} />
                )}
              </>
            )}

            {organisationId && userId && tab === 'staff' && <StaffPanel sites={sites} sitesStatus={sitesStatus} currentUserId={userId} callerIsSuperAdmin={isSuperAdmin} />}
            {organisationId && userId && tab === 'audit' && <AuditPanel sites={sites} />}
          </div>

          <AdminFooter page="console" />
        </main>
      </div>
      <QrPrintSheet job={printJob} />
    </>
  );
}
