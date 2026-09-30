'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, BellOff, CheckCheck, MapPin, PhoneCall, ShieldCheck, Siren } from 'lucide-react';
import type { Site } from '@/types/models';
import { useTranslation } from '@/lib/i18n/context';
import { formatSpan, formatWhen, personName, sosDeliveryDelayMs, toMs, type PanicGroups } from './data/derive';
import type { PanicRow, PersonInfo } from './data/types';
import type { PanicAlarm } from './hooks/usePanicAlarm';
import type { IncidentActionState } from './ui/IncidentList';
import { mapsUrl, telHref } from './ui/labels';

export interface PanicPanelProps {
  groups: PanicGroups;
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
  alarm: PanicAlarm;
  onAcknowledge: (alert: PanicRow) => void;
  onResolve: (alert: PanicRow) => void;
  state: Readonly<Record<string, IncidentActionState>>;
  disabledReason: string | null;
}

function AlertDetails({
  alert,
  people,
  sites,
  showSite,
  now,
  onDark
}: {
  alert: PanicRow;
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
  onDark: boolean;
}) {
  const { t } = useTranslation();
  const triggered = toMs(alert.triggered_at);
  const delay = sosDeliveryDelayMs(alert);
  const person = people[alert.guard_id];
  const site = sites.get(alert.site_id);
  const sub = onDark ? 'text-ee-on-danger' : 'text-ee-muted';
  // The global unlayered `a { color }` rule beats utilities: force the colour on the SOS panel.
  const link = onDark ? 'text-ee-on-danger! underline' : 'underline';
  return (
    <div className="min-w-0 space-y-1">
      <p className={`font-display text-2xl font-bold leading-tight ${onDark ? 'text-ee-on-danger' : 'text-ee-text'}`}>
        {personName(people, alert.guard_id) ?? t('supUnknownPerson')}
      </p>
      {(showSite || sites.size === 1) && site && <p className={`text-sm font-semibold ${sub}`}>{site.name}</p>}
      <p className={`text-sm ${sub}`}>
        {t('supSosTriggeredAt', formatWhen(triggered, now), formatSpan(triggered === null ? 0 : now - triggered))}
      </p>
      {delay !== null && <p className={`text-sm ${sub}`}>{t('supSosLate', formatSpan(delay))}</p>}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {alert.latitude !== null && alert.longitude !== null ? (
          <a
            href={mapsUrl(alert.latitude, alert.longitude)}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex min-h-11 items-center gap-1.5 font-semibold ${link}`}
            data-testid="supervisor-sos-map"
          >
            <MapPin className="h-4 w-4" aria-hidden="true" />
            {alert.accuracy_meters !== null ? t('supMapWithAccuracy', Math.round(alert.accuracy_meters)) : t('supMap')}
          </a>
        ) : (
          <span className={`inline-flex min-h-11 items-center ${sub}`}>{t('supSosNoLocation')}</span>
        )}
        {person?.phone && (
          <a href={telHref(person.phone)} className={`inline-flex min-h-11 items-center gap-1.5 font-semibold ${link}`}>
            <PhoneCall className="h-4 w-4" aria-hidden="true" />
            {t('supCallGuard', person.phone)}
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * While an ACTIVE SOS section is scrolled out of view (the supervisor is reading another tab),
 * a bar stays pinned to the bottom of the screen with a button that jumps back to it.
 */
function SosPinnedBar({ count, onShow }: { count: number; onShow: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-ee-sos bg-ee-sos-deep pb-[env(safe-area-inset-bottom)] text-ee-on-danger"
      data-testid="supervisor-sos-bar"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
        <p className="flex min-w-0 items-center gap-2 font-display text-xl font-bold">
          <Siren className="h-6 w-6 flex-none" aria-hidden="true" />
          <span className="min-w-0 break-words">{t('supSosActiveHeading', count)}</span>
        </p>
        <button
          type="button"
          onClick={onShow}
          className="inline-flex min-h-12 flex-none items-center gap-1.5 rounded-lg bg-ee-on-danger px-4 font-display text-lg font-bold text-ee-sos-deep"
          data-testid="supervisor-sos-bar-show"
        >
          <ArrowUp className="h-5 w-5" aria-hidden="true" />
          {t('supSosShow')}
        </button>
      </div>
    </div>
  );
}

/**
 * Open SOS alerts, pinned above everything else. ACTIVE alerts repeat a sound and vibration
 * until acknowledged in the database (or silenced on this screen); acknowledging writes only
 * the status, and the server records who acknowledged and when.
 */
export function PanicAlertsPanel({
  groups,
  people,
  sites,
  showSite,
  now,
  alarm,
  onAcknowledge,
  onResolve,
  state,
  disabledReason
}: PanicPanelProps) {
  const { t } = useTranslation();
  const activeCount = groups.active.length;
  const ackCount = groups.acknowledged.length;
  const hasActive = activeCount > 0;
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [sectionVisible, setSectionVisible] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!hasActive || !section || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      setSectionVisible(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, [hasActive]);

  const showSection = () => {
    sectionRef.current?.scrollIntoView({ block: 'start' });
    headingRef.current?.focus();
  };

  return (
    <div className="space-y-3">
      {hasActive && !sectionVisible && <SosPinnedBar count={activeCount} onShow={showSection} />}
      <p className="sr-only" aria-live="assertive" data-testid="supervisor-sos-announce">
        {activeCount > 0 ? t('supSosAnnounce', activeCount) : ''}
      </p>

      {activeCount > 0 && (
        <section
          ref={sectionRef}
          aria-labelledby="supervisor-sos-heading"
          className="scroll-mt-20 space-y-3 rounded-xl border-2 border-ee-sos bg-ee-sos-deep p-3 text-ee-on-danger"
          data-testid="supervisor-sos-active"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id="supervisor-sos-heading"
              ref={headingRef}
              tabIndex={-1}
              className="flex items-center gap-2 font-display text-2xl font-bold"
            >
              <Siren className="h-6 w-6" aria-hidden="true" />
              {t('supSosActiveHeading', activeCount)}
            </h2>
            {alarm.sounding && (
              <button
                type="button"
                onClick={alarm.silence}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-ee-on-danger px-3 text-sm font-semibold text-ee-on-danger hover:bg-ee-sos"
                data-testid="supervisor-sos-silence"
              >
                <BellOff className="h-4 w-4" aria-hidden="true" />
                {t('supSilenceAlarm')}
              </button>
            )}
          </div>
          {alarm.soundBlocked && <p className="text-sm">{t('supSoundBlocked')}</p>}
          <ul className="divide-y divide-ee-on-danger/30">
            {groups.active.map((alert) => {
              const s = state[alert.id];
              return (
                <li key={alert.id} className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid="supervisor-sos-row" data-alert-id={alert.id}>
                  <AlertDetails alert={alert} people={people} sites={sites} showSite={showSite} now={now} onDark />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onAcknowledge(alert)}
                      disabled={Boolean(disabledReason) || s?.busy}
                      className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-lg bg-ee-on-danger px-4 font-display text-xl font-bold text-ee-sos-deep disabled:opacity-60 sm:flex-none"
                      data-testid="supervisor-sos-acknowledge"
                    >
                      <CheckCheck className="h-5 w-5" aria-hidden="true" />
                      {s?.busy ? t('supSaving') : t('supAcknowledge')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolve(alert)}
                      disabled={Boolean(disabledReason) || s?.busy}
                      className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg border border-ee-on-danger px-4 font-semibold text-ee-on-danger hover:bg-ee-sos disabled:opacity-60"
                      data-testid="supervisor-sos-resolve"
                    >
                      <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                      {t('supResolve')}
                    </button>
                  </div>
                  <div aria-live="polite">
                    {s?.message && (
                      <p className="text-sm font-semibold" data-testid="supervisor-sos-result">
                        {s.message.text}
                      </p>
                    )}
                    {disabledReason && <p className="text-sm">{disabledReason}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {ackCount > 0 && (
        <section
          aria-labelledby="supervisor-sos-ack-heading"
          className="space-y-2 rounded-xl border border-ee-warning/50 bg-ee-surface p-3"
          data-testid="supervisor-sos-acknowledged"
        >
          <h2 id="supervisor-sos-ack-heading" className="font-display text-xl font-semibold text-ee-warning">
            {t('supSosAckHeading', ackCount)}
          </h2>
          <ul className="divide-y divide-ee-border">
            {groups.acknowledged.map((alert) => {
              const s = state[alert.id];
              return (
                <li key={alert.id} className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid="supervisor-sos-ack-row" data-alert-id={alert.id}>
                  <AlertDetails alert={alert} people={people} sites={sites} showSite={showSite} now={now} onDark={false} />
                  <p className="text-sm text-ee-warning" data-testid="supervisor-sos-ack-by">
                    {t(
                      'supAckBy',
                      personName(people, alert.acknowledged_by) ?? t('supUnknownPerson'),
                      formatWhen(toMs(alert.acknowledged_at), now)
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => onResolve(alert)}
                    disabled={Boolean(disabledReason) || s?.busy}
                    className="inline-flex min-h-12 items-center gap-2 rounded-lg border border-ee-primary bg-ee-primary px-4 font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-60"
                    data-testid="supervisor-sos-resolve"
                  >
                    <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                    {t('supResolve')}
                  </button>
                  <div aria-live="polite">
                    {s?.message && (
                      <p className={`text-sm font-semibold ${s.message.tone === 'success' ? 'text-ee-success' : 'text-ee-danger-text'}`} data-testid="supervisor-sos-result">
                        {s.message.text}
                      </p>
                    )}
                    {disabledReason && <p className="text-sm text-ee-warning">{disabledReason}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Resolved SOS alerts of the last days (history). */
export function ResolvedSosList({
  alerts,
  people,
  sites,
  showSite,
  now
}: {
  alerts: readonly PanicRow[];
  people: Readonly<Record<string, PersonInfo>>;
  sites: ReadonlyMap<string, Site>;
  showSite: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  if (alerts.length === 0) {
    return (
      <p className="rounded-lg border border-ee-border bg-ee-surface px-3 py-3 text-sm text-ee-muted" data-testid="supervisor-sos-history-empty">
        {t('supNoResolvedSos')}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ee-border overflow-hidden rounded-lg border border-ee-border bg-ee-surface" data-testid="supervisor-sos-history">
      {alerts.map((alert) => (
        <li key={alert.id} className="space-y-1 px-3 py-2.5 text-sm">
          <p className="font-semibold text-ee-text">
            {formatWhen(toMs(alert.triggered_at), now)} · {personName(people, alert.guard_id) ?? t('supUnknownPerson')}
            {showSite && sites.get(alert.site_id) ? ` · ${sites.get(alert.site_id)?.name}` : ''}
          </p>
          <p className="text-xs text-ee-muted">
            {t('supAckBy', personName(people, alert.acknowledged_by) ?? t('supUnknownPerson'), formatWhen(toMs(alert.acknowledged_at), now))}
          </p>
          {alert.resolution_notes && <p className="whitespace-pre-wrap break-words text-ee-text">{alert.resolution_notes}</p>}
        </li>
      ))}
    </ul>
  );
}
