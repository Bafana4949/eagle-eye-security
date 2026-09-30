'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Car, Eye, Route } from 'lucide-react';
import { HeaderNav } from '@/components/shared/HeaderNav';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useTranslation } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import {
  aggregateCompliance,
  buildShiftReports,
  complianceTone,
  isOpenShift,
  sitesById,
  sortIncidents,
  toMs,
  uncoveredShiftWindows,
  vehiclePresence
} from '@/components/supervisor/data/derive';
import { DAY_MS, loadViewerSnapshot, VIEWER_REPORT_DAYS } from '@/components/supervisor/data/queries';
import type { OpsSnapshot } from '@/components/supervisor/data/types';
import { useNow, useOnline } from '@/components/supervisor/hooks/useNow';
import { usePolledSnapshot } from '@/components/supervisor/hooks/usePolledSnapshot';
import { IncidentList } from '@/components/supervisor/ui/IncidentList';
import { EmptyLine, Section, TabBar, Tile, type TabItem } from '@/components/supervisor/ui/Primitives';
import { ShiftComplianceList } from '@/components/supervisor/ui/ShiftComplianceList';
import { PartialNotice, SiteFilter, StatusBar } from '@/components/supervisor/ui/StatusBar';
import { GateLogList, VehiclesOnSiteList } from '@/components/supervisor/ui/VehicleLists';

type TabKey = 'patrols' | 'incidents' | 'vehicles';

/** Client reports change slowly and are not safety-critical: re-read every minute (and on focus). */
const VIEWER_POLL_MS = 60_000;

/**
 * Read-only report for a client (farm owner) of the sites assigned to them: patrol compliance
 * per shift, incidents and the vehicle log. There are no write controls. The database decides
 * what is visible: client viewers never receive SOS alerts or selfies, and guard names come
 * from the site_people() RPC (names only).
 */
export function ViewerPortal() {
  const { t } = useTranslation();
  const auth = useAuth();
  const now = useNow(60_000);
  const online = useOnline();
  const [tab, setTab] = useState<TabKey>('patrols');
  const [siteFilter, setSiteFilter] = useState('all');

  const sites = auth.sites;
  const siteMap = useMemo(() => sitesById(sites), [sites]);
  const siteKey = useMemo(() => sites.map((s) => s.id).sort().join(','), [sites]);
  const userId = auth.user?.id ?? null;
  const dataKey = auth.status === 'signed_in' && userId && siteKey ? `${userId}|${siteKey}` : null;
  const multiSite = sites.length > 1;

  const docTitle = t('vwDocTitle');
  useEffect(() => {
    const original = document.title;
    document.title = docTitle;
    return () => {
      document.title = original;
    };
  }, [docTitle]);

  const load = useCallback(() => loadViewerSnapshot(createClient(), siteKey ? siteKey.split(',') : [], Date.now()), [siteKey]);
  const snapshot = usePolledSnapshot<OpsSnapshot>({ key: dataKey, load, intervalMs: VIEWER_POLL_MS });
  const data = snapshot.data;

  const derived = useMemo(() => {
    if (!data) return null;
    const scope = new Set(siteFilter === 'all' || !siteMap.has(siteFilter) ? data.siteIds : [siteFilter]);
    const reportStart = now - VIEWER_REPORT_DAYS * DAY_MS;
    const shifts = data.shifts.filter(
      (s) => scope.has(s.site_id) && (isOpenShift(s) || (toMs(s.scheduled_start) ?? 0) >= reportStart)
    );
    const shiftSite = new Map(data.shifts.map((s) => [s.id, s.site_id]));
    const scans = data.scans.filter((s) => scope.has(s.site_id ?? shiftSite.get(s.shift_id) ?? ''));
    const checkpoints = data.checkpoints.filter((c) => scope.has(c.site_id));
    const reports = buildShiftReports({ shifts, scans, checkpoints }, siteMap, now);
    const uncovered = [...scope].flatMap((siteId) => {
      const site = siteMap.get(siteId);
      return site ? uncoveredShiftWindows(site, shifts, reportStart, now) : [];
    });
    const incidents = sortIncidents(data.incidents.filter((i) => scope.has(i.site_id)));
    const gate = data.gateEntries.filter((g) => scope.has(g.site_id));
    return {
      reports,
      uncovered,
      compliance: aggregateCompliance(reports),
      onDuty: reports.filter((r) => isOpenShift(r.shift)).length,
      incidents,
      openIncidents: incidents.filter((i) => i.status !== 'resolved').length,
      presence: vehiclePresence(gate, now),
      gate
    };
  }, [data, siteFilter, siteMap, now]);

  const tabs: ReadonlyArray<TabItem<TabKey>> = [
    { key: 'patrols', label: t('vwTabPatrols'), icon: <Route className="h-4 w-4" aria-hidden="true" /> },
    {
      key: 'incidents',
      label: t('vwTabIncidents'),
      icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
      count: derived?.incidents.length
    },
    {
      key: 'vehicles',
      label: t('vwTabVehicles'),
      icon: <Car className="h-4 w-4" aria-hidden="true" />,
      count: derived?.presence.onSite.length
    }
  ];

  const people = data?.people ?? {};
  const subtitle = sites.length === 1 ? sites[0].name : t('supSitesCount', sites.length);

  return (
    <div className="flex min-h-screen flex-col bg-ee-bg font-sans text-ee-text">
      <HeaderNav title={t('vwTitle')} subtitle={subtitle} />
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-4 px-4 pb-12 pt-4" data-testid="viewer-portal">
        <p className="flex items-center gap-2 text-sm text-ee-muted" data-testid="viewer-read-only">
          <Eye className="h-4 w-4 flex-none" aria-hidden="true" />
          {t('vwReadOnly')}
        </p>

        {sites.length === 0 ? (
          <EmptyLine testId="viewer-no-sites">{t('vwNoSites')}</EmptyLine>
        ) : (
          <>
            <StatusBar
              mode="poll"
              online={online}
              loading={snapshot.loading}
              lastSuccessAt={snapshot.lastSuccessAt}
              error={snapshot.error}
              pollSeconds={VIEWER_POLL_MS / 1000}
              onRefresh={snapshot.refresh}
              now={now}
              testIdPrefix="viewer"
            >
              <SiteFilter sites={sites} value={siteFilter} onChange={setSiteFilter} testId="viewer-site-filter" />
            </StatusBar>

            {data && <PartialNotice sections={data.partial} testId="viewer-partial" />}

            {derived && (
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ee-border bg-ee-border sm:grid-cols-4">
                <Tile
                  label={t('vwTileCompliance', VIEWER_REPORT_DAYS)}
                  value={derived.compliance.percent === null ? '–' : `${derived.compliance.percent}%`}
                  sub={
                    derived.compliance.percent === null
                      ? t('supNothingDue')
                      : t('supVisitsOf', derived.compliance.visits, derived.compliance.expected)
                  }
                  tone={complianceTone(derived.compliance.percent)}
                  onClick={() => setTab('patrols')}
                  testId="viewer-tile-compliance"
                />
                <Tile
                  label={t('vwTileOnDuty')}
                  value={String(derived.onDuty)}
                  tone={derived.onDuty > 0 ? 'success' : 'muted'}
                  onClick={() => setTab('patrols')}
                  testId="viewer-tile-on-duty"
                />
                <Tile
                  label={t('vwTileOpenIncidents')}
                  value={String(derived.openIncidents)}
                  tone={derived.openIncidents > 0 ? 'warning' : 'muted'}
                  onClick={() => setTab('incidents')}
                  testId="viewer-tile-incidents"
                />
                <Tile
                  label={t('supTileVehicles')}
                  value={String(derived.presence.onSite.length)}
                  tone="muted"
                  onClick={() => setTab('vehicles')}
                  testId="viewer-tile-vehicles"
                />
              </div>
            )}

            <TabBar tabs={tabs} active={tab} onChange={setTab} idPrefix="viewer" label={t('supTabsLabel')} testIdPrefix="viewer" />

            <div role="tabpanel" id={`viewer-panel-${tab}`} aria-labelledby={`viewer-tab-${tab}`} className="space-y-6">
              {!derived ? (
                <EmptyLine testId="viewer-loading">{snapshot.loading ? t('supLoadingData') : t('supNoDataYet')}</EmptyLine>
              ) : tab === 'patrols' ? (
                <Section id="viewer-shifts-heading" title={t('vwComplianceHeading', VIEWER_REPORT_DAYS)} testId="viewer-shifts-section">
                  <p className="text-xs text-ee-muted">{t('supComplianceNote')}</p>
                  {derived.uncovered.length > 0 && (
                    <p className="text-sm text-ee-danger-text" data-testid="viewer-uncovered-count">
                      {t('vwUncoveredCount', derived.uncovered.length)}
                    </p>
                  )}
                  <ShiftComplianceList
                    reports={derived.reports}
                    uncovered={derived.uncovered}
                    people={people}
                    sites={siteMap}
                    showSite={multiSite}
                    now={now}
                    testId="viewer-shifts"
                  />
                </Section>
              ) : tab === 'incidents' ? (
                <Section id="viewer-incidents-heading" title={t('vwIncidentsHeading')}>
                  <IncidentList
                    incidents={derived.incidents}
                    media={data?.incidentMedia ?? []}
                    people={people}
                    sites={siteMap}
                    showSite={multiSite}
                    showLocation={false}
                    now={now}
                    testId="viewer-incidents"
                  />
                </Section>
              ) : (
                <>
                  <Section id="viewer-on-site-heading" title={t('supVehiclesOnSite')}>
                    <p className="text-xs text-ee-muted">{t('supVehiclesNote')}</p>
                    <VehiclesOnSiteList
                      presence={derived.presence}
                      people={people}
                      sites={siteMap}
                      showSite={multiSite}
                      now={now}
                      testId="viewer-vehicles"
                    />
                  </Section>
                  <Section id="viewer-gate-heading" title={t('supGateLog')}>
                    <GateLogList rows={derived.gate} people={people} sites={siteMap} showSite={multiSite} now={now} limit={100} testId="viewer-gate" />
                  </Section>
                </>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
