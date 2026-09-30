'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Car, LayoutList, Route, X } from 'lucide-react';
import { HeaderNav } from '@/components/shared/HeaderNav';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useTranslation } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import {
  buildActivityFeed,
  buildShiftReports,
  formatWhen,
  isOpenShift,
  lastActivityByGuard,
  personName,
  sitesById,
  sortIncidents,
  splitPanicAlerts,
  toMs,
  uncoveredShiftWindows,
  vehiclePresence
} from './data/derive';
import {
  loadSupervisorSnapshot,
  SUPERVISOR_RECENT_SHIFTS_MS,
  updateIncident,
  updatePanicAlert,
  type IncidentUpdate,
  type PanicUpdate,
  type WriteResult
} from './data/queries';
import type { IncidentRow, OpsSnapshot, PanicRow } from './data/types';
import { useNow, useOnline } from './hooks/useNow';
import { usePanicAlarm } from './hooks/usePanicAlarm';
import { usePolledSnapshot } from './hooks/usePolledSnapshot';
import { useRealtimeChannel, type RealtimeChange, type RealtimeTable } from './hooks/useRealtimeChannel';
import { ActivityFeed } from './ActivityFeed';
import { GuardsOnDutyPanel } from './GuardsOnDutyPanel';
import { PanicAlertsPanel, ResolvedSosList } from './PanicAlertsPanel';
import { IncidentList, type IncidentAction, type IncidentActionState } from './ui/IncidentList';
import { incidentStatusLabel, writeProblemMessage } from './ui/labels';
import { NoteDialog } from './ui/NoteDialog';
import { EmptyLine, Section, TabBar, Tile, type TabItem } from './ui/Primitives';
import { ScanList } from './ui/ScanList';
import { ShiftComplianceList } from './ui/ShiftComplianceList';
import { PartialNotice, SiteFilter, StatusBar } from './ui/StatusBar';
import { GateLogList, VehiclesOnSiteList } from './ui/VehicleLists';

type TabKey = 'overview' | 'patrols' | 'incidents' | 'vehicles';

const REALTIME_TABLES: readonly RealtimeTable[] = ['panic_alerts', 'incidents', 'patrol_scans', 'gate_entries', 'shifts'];
/** Poll period while realtime is SUBSCRIBED (safety net) and while it is not. */
const POLL_LIVE_MS = 30_000;
const POLL_FALLBACK_MS = 15_000;
/** Realtime bursts (a phone syncing a backlog) are coalesced into one reload. */
const REALTIME_DEBOUNCE_MS = 800;

type DialogState =
  | { kind: 'incident_resolve'; incident: IncidentRow }
  | { kind: 'incident_note'; incident: IncidentRow }
  | { kind: 'panic_resolve'; alert: PanicRow }
  | null;

interface Saved<T> {
  row: T;
  savedAt: number;
}

/** A row saved by this screen replaces the loaded one until a load that started later arrives. */
function withSaved<T extends { id: string }>(rows: readonly T[], saved: Readonly<Record<string, Saved<T>>>, fetchedAt: number): T[] {
  return rows.map((row) => {
    const entry = saved[row.id];
    return entry && entry.savedAt >= fetchedAt ? entry.row : row;
  });
}

export function SupervisorDashboard() {
  const { t } = useTranslation();
  const auth = useAuth();
  const now = useNow(30_000);
  const online = useOnline();
  const [tab, setTab] = useState<TabKey>('overview');
  const [siteFilter, setSiteFilter] = useState('all');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [actionState, setActionState] = useState<Record<string, IncidentActionState>>({});
  const [savedIncidents, setSavedIncidents] = useState<Record<string, Saved<IncidentRow>>>({});
  const [savedPanics, setSavedPanics] = useState<Record<string, Saved<PanicRow>>>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const sites = auth.sites;
  const siteMap = useMemo(() => sitesById(sites), [sites]);
  const siteKey = useMemo(() => sites.map((s) => s.id).sort().join(','), [sites]);
  const userId = auth.user?.id ?? null;
  const dataKey = auth.status === 'signed_in' && userId && siteKey ? `${userId}|${siteKey}` : null;
  const multiSite = sites.length > 1;

  // Realtime first: its state decides how often the page polls.
  const refreshRef = useRef<() => void>(() => undefined);
  const debounceRef = useRef<number | null>(null);
  const onRealtimeChange = useCallback((change: RealtimeChange) => {
    if (change.table === 'panic_alerts') {
      refreshRef.current();
      return;
    }
    if (debounceRef.current !== null) return;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      refreshRef.current();
    }, REALTIME_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    []
  );
  const siteIdList = useMemo(() => (siteKey ? siteKey.split(',') : []), [siteKey]);
  const realtime = useRealtimeChannel({
    enabled: dataKey !== null && online && !auth.isOfflineSession,
    name: 'supervisor-ops',
    siteIds: siteIdList,
    tables: REALTIME_TABLES,
    onChange: onRealtimeChange
  });
  const pollMs = realtime === 'live' ? POLL_LIVE_MS : POLL_FALLBACK_MS;

  const load = useCallback(
    () => loadSupervisorSnapshot(createClient(), siteKey ? siteKey.split(',') : [], Date.now()),
    [siteKey]
  );
  const snapshot = usePolledSnapshot<OpsSnapshot>({ key: dataKey, load, intervalMs: pollMs });
  useEffect(() => {
    refreshRef.current = snapshot.refresh;
  }, [snapshot.refresh]);

  // Changes made while the channel was connecting or down are not replayed by realtime:
  // re-read once every time it (re)reaches SUBSCRIBED.
  const wasLiveRef = useRef(false);
  const refreshSnapshot = snapshot.refresh;
  useEffect(() => {
    const live = realtime === 'live';
    if (live && !wasLiveRef.current) refreshSnapshot();
    wasLiveRef.current = live;
  }, [realtime, refreshSnapshot]);

  const data = snapshot.data;

  // ---- derived views -------------------------------------------------------
  const derived = useMemo(() => {
    if (!data) return null;
    const incidents = withSaved(data.incidents, savedIncidents, data.fetchedAt);
    const panics = withSaved(data.panicAlerts, savedPanics, data.fetchedAt);
    const scope = new Set(siteFilter === 'all' || !siteMap.has(siteFilter) ? data.siteIds : [siteFilter]);
    const shifts = data.shifts.filter((s) => scope.has(s.site_id));
    const shiftSite = new Map(data.shifts.map((s) => [s.id, s.site_id]));
    const scans = data.scans.filter((s) => scope.has(s.site_id ?? shiftSite.get(s.shift_id) ?? ''));
    const checkpoints = data.checkpoints.filter((c) => scope.has(c.site_id));
    const scopedIncidents = incidents.filter((i) => scope.has(i.site_id));
    const gate = data.gateEntries.filter((g) => scope.has(g.site_id));
    const scopedPanics = panics.filter((p) => scope.has(p.site_id));
    const scoped = { shifts, scans, checkpoints, incidents: scopedIncidents, panicAlerts: scopedPanics, gateEntries: gate };

    const reports = buildShiftReports({ shifts, scans, checkpoints }, siteMap, now);
    const uncovered = [...scope].flatMap((siteId) => {
      const site = siteMap.get(siteId);
      return site ? uncoveredShiftWindows(site, shifts, now - SUPERVISOR_RECENT_SHIFTS_MS, now) : [];
    });
    const sorted = sortIncidents(scopedIncidents);
    return {
      // SOS alerts are never filtered by the site selector: an alert on any site must show.
      panicGroups: splitPanicAlerts(panics),
      resolvedSos: splitPanicAlerts(scopedPanics).resolved,
      openReports: reports.filter((r) => isOpenShift(r.shift)),
      reports,
      uncovered,
      scans,
      openIncidents: sorted.filter((i) => i.status !== 'resolved'),
      resolvedIncidents: sorted.filter((i) => i.status === 'resolved'),
      presence: vehiclePresence(gate, now),
      gate,
      feed: buildActivityFeed(scoped, 30),
      lastActivity: lastActivityByGuard(scoped),
      checkpointNames: new Map(data.checkpoints.map((c) => [c.id, c.name]))
    };
  }, [data, savedIncidents, savedPanics, siteFilter, siteMap, now]);

  const activeAlertIds = useMemo(() => derived?.panicGroups.active.map((a) => a.id) ?? [], [derived]);
  const alarm = usePanicAlarm(activeAlertIds, {
    base: t('supDocTitle'),
    withAlerts: (count) => t('supDocTitleSos', count)
  });

  // ---- writes (status / notes only; the server stamps who acknowledged and when) ---------
  const disabledReason = !online
    ? t('supWritesOffline')
    : auth.isOfflineSession
      ? t('supWritesSessionOffline')
      : null;

  async function runWrite<T>(id: string, write: () => Promise<WriteResult<T>>): Promise<WriteResult<T>> {
    setActionState((s) => ({ ...s, [id]: { busy: true } }));
    let result: WriteResult<T>;
    try {
      result = await write();
    } catch (error) {
      result = { ok: false, problem: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    return result;
  }

  const writeIncident = async (incident: IncidentRow, update: IncidentUpdate): Promise<string | null> => {
    const result = await runWrite(incident.id, () => updateIncident(createClient(), incident.id, update));
    if (!result.ok) {
      const text = writeProblemMessage(t, result.problem, result.message);
      setActionState((s) => ({ ...s, [incident.id]: { message: { tone: 'danger', text } } }));
      return text;
    }
    const row = result.row;
    setSavedIncidents((s) => ({ ...s, [row.id]: { row, savedAt: Date.now() } }));
    const text =
      update.status === 'acknowledged'
        ? t('supSavedAck', formatWhen(toMs(row.acknowledged_at), Date.now()))
        : update.status
          ? t('supSavedStatus', incidentStatusLabel(t, row.status))
          : t('supSavedNote');
    setActionState((s) => ({ ...s, [row.id]: { message: { tone: 'success', text } } }));
    snapshot.refresh();
    return null;
  };

  const writePanic = async (alert: PanicRow, update: PanicUpdate): Promise<string | null> => {
    const result = await runWrite(alert.id, () => updatePanicAlert(createClient(), alert.id, update));
    const who = personName(data?.people ?? {}, alert.guard_id) ?? t('supUnknownPerson');
    if (!result.ok) {
      const text = writeProblemMessage(t, result.problem, result.message);
      setActionState((s) => ({ ...s, [alert.id]: { message: { tone: 'danger', text } } }));
      setNotice({ tone: 'danger', text: `${t('supSosFrom', who)}: ${text}` });
      return text;
    }
    const row = result.row;
    setSavedPanics((s) => ({ ...s, [row.id]: { row, savedAt: Date.now() } }));
    const text =
      row.status === 'resolved'
        ? t('supSavedStatus', t('supStatusResolved'))
        : t('supSavedAck', formatWhen(toMs(row.acknowledged_at), Date.now()));
    setActionState((s) => ({ ...s, [row.id]: { message: { tone: 'success', text } } }));
    setNotice({ tone: 'success', text: `${t('supSosFrom', who)}: ${text}` });
    snapshot.refresh();
    return null;
  };

  const onIncidentAction = (incident: IncidentRow, action: IncidentAction) => {
    if (action === 'acknowledge') void writeIncident(incident, { status: 'acknowledged' });
    else if (action === 'investigating') void writeIncident(incident, { status: 'investigating' });
    else if (action === 'resolve') setDialog({ kind: 'incident_resolve', incident });
    else setDialog({ kind: 'incident_note', incident });
  };

  // ---- rendering -----------------------------------------------------------
  const isAdmin = auth.roles.includes('admin') || auth.roles.includes('super_admin');
  const subtitle = sites.length === 1 ? sites[0].name : t('supSitesCount', sites.length);

  const tabs: ReadonlyArray<TabItem<TabKey>> = [
    { key: 'overview', label: t('supTabOverview'), icon: <LayoutList className="h-4 w-4" aria-hidden="true" /> },
    {
      key: 'patrols',
      label: t('supTabPatrols'),
      icon: <Route className="h-4 w-4" aria-hidden="true" />,
      count: derived ? derived.openReports.filter((r) => r.alarm?.type === 'late').length : undefined,
      countTone: 'danger'
    },
    {
      key: 'incidents',
      label: t('supTabIncidents'),
      icon: <AlertTriangle className="h-4 w-4" aria-hidden="true" />,
      count: derived?.openIncidents.length,
      countTone: 'warning'
    },
    {
      key: 'vehicles',
      label: t('supTabVehicles'),
      icon: <Car className="h-4 w-4" aria-hidden="true" />,
      count: derived?.presence.onSite.length
    }
  ];

  const people = data?.people ?? {};
  const overdue = derived ? derived.openReports.filter((r) => r.alarm?.type === 'late').length : null;

  return (
    <div className="flex min-h-screen flex-col bg-ee-bg font-sans text-ee-text">
      <HeaderNav title={t('supTitle')} subtitle={subtitle} />
      <main
        className={`mx-auto w-full max-w-5xl flex-1 space-y-4 px-4 pt-4 ${activeAlertIds.length > 0 ? 'pb-28' : 'pb-12'}`}
        data-testid="supervisor-dashboard"
      >
        {auth.isOfflineSession && (
          <p className="rounded-lg border border-ee-warning/40 bg-ee-warning/10 px-3 py-2 text-sm text-ee-warning" role="status">
            {t('supOfflineSession')}
          </p>
        )}

        {sites.length === 0 ? (
          <EmptyLine testId="supervisor-no-sites">{t('supNoSites')}</EmptyLine>
        ) : (
          <>
            {/* Open SOS alerts come first, above everything else. */}
            {derived && (
              <PanicAlertsPanel
                groups={derived.panicGroups}
                people={people}
                sites={siteMap}
                showSite={multiSite}
                now={now}
                alarm={alarm}
                onAcknowledge={(alert) => void writePanic(alert, { status: 'acknowledged' })}
                onResolve={(alert) => setDialog({ kind: 'panic_resolve', alert })}
                state={actionState}
                disabledReason={disabledReason}
              />
            )}
            {notice && (
              <div
                className={`flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-semibold ${
                  notice.tone === 'success' ? 'border-ee-success/40 bg-ee-success/10 text-ee-success' : 'border-ee-danger/40 bg-ee-danger/10 text-ee-danger-text'
                }`}
                role="status"
                data-testid="supervisor-notice"
              >
                <span>{notice.text}</span>
                <button
                  type="button"
                  onClick={() => setNotice(null)}
                  aria-label={t('supDismiss')}
                  className="-my-1 inline-flex h-11 w-11 flex-none items-center justify-center rounded-lg hover:bg-ee-surface-raised"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )}

            <StatusBar
              mode="realtime"
              realtime={realtime}
              online={online}
              loading={snapshot.loading}
              lastSuccessAt={snapshot.lastSuccessAt}
              error={snapshot.error}
              pollSeconds={pollMs / 1000}
              onRefresh={snapshot.refresh}
              now={now}
              testIdPrefix="supervisor"
            >
              <SiteFilter sites={sites} value={siteFilter} onChange={setSiteFilter} testId="supervisor-site-filter" />
            </StatusBar>

            {isAdmin && (
              <p className="flex flex-wrap gap-x-4 text-sm">
                <Link href="/admin" className="inline-flex min-h-11 items-center underline">
                  {t('supLinkAdmin')}
                </Link>
                <Link href="/viewer" className="inline-flex min-h-11 items-center underline">
                  {t('supLinkViewer')}
                </Link>
              </p>
            )}

            {data && <PartialNotice sections={data.partial} testId="supervisor-partial" />}

            {derived && derived.panicGroups.active.length === 0 && derived.panicGroups.acknowledged.length === 0 && (
              <p className="text-sm text-ee-success" data-testid="supervisor-sos-none">
                {t('supNoOpenSos')}
              </p>
            )}

            {!data && snapshot.loading && (
              <p className="text-sm text-ee-muted" role="status" data-testid="supervisor-loading">
                {t('supLoadingData')}
              </p>
            )}

            <TabBar tabs={tabs} active={tab} onChange={setTab} idPrefix="supervisor" label={t('supTabsLabel')} testIdPrefix="supervisor" />

            <div role="tabpanel" id={`supervisor-panel-${tab}`} aria-labelledby={`supervisor-tab-${tab}`} className="space-y-6">
              {!derived ? (
                <EmptyLine>{snapshot.loading ? t('supLoadingData') : t('supNoDataYet')}</EmptyLine>
              ) : tab === 'overview' ? (
                <>
                  <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-ee-border bg-ee-border sm:grid-cols-4">
                    <Tile
                      label={t('supTileOnDuty')}
                      value={String(derived.openReports.length)}
                      tone={derived.openReports.length > 0 ? 'success' : 'muted'}
                      onClick={() => document.getElementById('supervisor-guards-heading')?.scrollIntoView()}
                      testId="supervisor-tile-on-duty"
                    />
                    <Tile
                      label={t('supTileOverdue')}
                      value={String(overdue ?? 0)}
                      tone={overdue ? 'danger' : 'muted'}
                      onClick={() => setTab('patrols')}
                      testId="supervisor-tile-overdue"
                    />
                    <Tile
                      label={t('supTileOpenIncidents')}
                      value={String(derived.openIncidents.length)}
                      tone={derived.openIncidents.some((i) => i.status === 'reported') ? 'danger' : derived.openIncidents.length ? 'warning' : 'muted'}
                      onClick={() => setTab('incidents')}
                      testId="supervisor-tile-incidents"
                    />
                    <Tile
                      label={t('supTileVehicles')}
                      value={String(derived.presence.onSite.length)}
                      tone="muted"
                      onClick={() => setTab('vehicles')}
                      testId="supervisor-tile-vehicles"
                    />
                  </div>
                  <Section id="supervisor-guards-heading" title={t('supGuardsOnDuty')} testId="supervisor-guards-section">
                    <p className="text-xs text-ee-muted">{t('supServerDataNote')}</p>
                    <GuardsOnDutyPanel
                      reports={derived.openReports}
                      lastActivity={derived.lastActivity}
                      people={people}
                      showSite={multiSite}
                      now={now}
                    />
                  </Section>
                  <Section id="supervisor-activity-heading" title={t('supLatestActivity')}>
                    <ActivityFeed items={derived.feed} people={people} sites={siteMap} showSite={multiSite} now={now} />
                  </Section>
                </>
              ) : tab === 'patrols' ? (
                <>
                  <Section id="supervisor-shifts-heading" title={t('supRecentShifts')} testId="supervisor-shifts-section">
                    <p className="text-xs text-ee-muted">{t('supComplianceNote')}</p>
                    <ShiftComplianceList
                      reports={derived.reports}
                      uncovered={derived.uncovered}
                      people={people}
                      sites={siteMap}
                      showSite={multiSite}
                      showSelfies
                      now={now}
                      testId="supervisor-shifts"
                    />
                  </Section>
                  <Section id="supervisor-scans-heading" title={t('supRecentScans')}>
                    <p className="text-xs text-ee-muted">{t('supGpsNote')}</p>
                    <ScanList
                      scans={derived.scans}
                      checkpointNames={derived.checkpointNames}
                      people={people}
                      sites={siteMap}
                      showSite={multiSite}
                      now={now}
                      limit={60}
                      testId="supervisor-scans"
                    />
                  </Section>
                </>
              ) : tab === 'incidents' ? (
                <>
                  <Section id="supervisor-open-incidents-heading" title={t('supOpenIncidents')}>
                    <IncidentList
                      incidents={derived.openIncidents}
                      media={data?.incidentMedia ?? []}
                      people={people}
                      sites={siteMap}
                      showSite={multiSite}
                      showLocation
                      now={now}
                      actions={{ onAction: onIncidentAction, disabledReason, state: actionState }}
                      testId="supervisor-incidents"
                    />
                  </Section>
                  <Section id="supervisor-resolved-incidents-heading" title={t('supResolvedIncidents')}>
                    <IncidentList
                      incidents={derived.resolvedIncidents}
                      media={data?.incidentMedia ?? []}
                      people={people}
                      sites={siteMap}
                      showSite={multiSite}
                      showLocation
                      now={now}
                      actions={{ onAction: onIncidentAction, disabledReason, state: actionState }}
                      testId="supervisor-resolved-incidents"
                    />
                  </Section>
                  <Section id="supervisor-sos-history-heading" title={t('supSosHistory')}>
                    <ResolvedSosList alerts={derived.resolvedSos} people={people} sites={siteMap} showSite={multiSite} now={now} />
                  </Section>
                </>
              ) : (
                <>
                  <Section id="supervisor-on-site-heading" title={t('supVehiclesOnSite')} testId="supervisor-vehicles-section">
                    <p className="text-xs text-ee-muted">{t('supVehiclesNote')}</p>
                    <VehiclesOnSiteList
                      presence={derived.presence}
                      people={people}
                      sites={siteMap}
                      showSite={multiSite}
                      now={now}
                      testId="supervisor-vehicles"
                    />
                  </Section>
                  <Section id="supervisor-gate-heading" title={t('supGateLog')}>
                    <GateLogList rows={derived.gate} people={people} sites={siteMap} showSite={multiSite} now={now} limit={50} testId="supervisor-gate" />
                  </Section>
                </>
              )}
            </div>
          </>
        )}
      </main>

      {dialog?.kind === 'incident_resolve' && (
        <NoteDialog
          title={t('supResolveIncidentTitle')}
          description={t('supResolveIncidentDesc')}
          noteLabel={t('supSupervisorNotes')}
          initialNote={dialog.incident.supervisor_notes ?? ''}
          noteRequired
          confirmLabel={t('supResolve')}
          onConfirm={(note) => writeIncident(dialog.incident, { status: 'resolved', supervisorNotes: note })}
          onClose={() => setDialog(null)}
          testId="supervisor-incident-dialog"
        />
      )}
      {dialog?.kind === 'incident_note' && (
        <NoteDialog
          title={t('supNoteTitle')}
          noteLabel={t('supSupervisorNotes')}
          initialNote={dialog.incident.supervisor_notes ?? ''}
          noteRequired
          confirmLabel={t('supSaveNote')}
          onConfirm={(note) => writeIncident(dialog.incident, { supervisorNotes: note })}
          onClose={() => setDialog(null)}
          testId="supervisor-note-dialog"
        />
      )}
      {dialog?.kind === 'panic_resolve' && (
        <NoteDialog
          title={t('supResolveSosTitle')}
          description={t('supResolveSosDesc', personName(people, dialog.alert.guard_id) ?? t('supUnknownPerson'))}
          noteLabel={t('supResolutionNotes')}
          initialNote={dialog.alert.resolution_notes ?? ''}
          noteRequired
          confirmLabel={t('supResolve')}
          onConfirm={(note) => writePanic(dialog.alert, { status: 'resolved', resolutionNotes: note })}
          onClose={() => setDialog(null)}
          testId="supervisor-sos-dialog"
        />
      )}
    </div>
  );
}
