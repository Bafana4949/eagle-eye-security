'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, Siren, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { useAuth } from '@/lib/auth/AuthProvider';
import { syncEngine } from '@/lib/offline/sync';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import { getActiveShift, type ActiveShiftRecord } from '@/lib/data/shiftStore';
import { STALE_FIX_MS, getLocationFix, startLocationWatch, type LocationWatchHandle } from '@/lib/gps/location';
import { sastTimeHM } from '@/lib/config/siteTime';
import type { EventContext, EventLocation } from '@/types/offline';
import type { Site } from '@/types/models';
import { SosHoldButton } from './incident/SosHoldButton';
import { SosPanicScreen, type RaisedPanic } from './incident/SosPanicScreen';
import { useModalFocus } from './incident/useModalFocus';
import { messageLocationFromFix, policeNumber, telHref } from './incident/incidentLogic';

type View = 'closed' | 'hold' | 'panic';

/** undefined while the running shift is still being read from this phone. */
type ShiftLookup = ActiveShiftRecord | null | undefined;

const NO_LOCATION: EventLocation = {
  latitude: null,
  longitude: null,
  accuracyMeters: null,
  locationTimestamp: null,
  gpsError: null
};

/**
 * Persistent SOS button of the guard app, the press-and-hold dialog and the panic screen.
 *
 * Identity comes only from useAuth() and the running shift from the shift store (no props).
 * On a completed 2 s hold the alert is queued IMMEDIATELY with the best position available at
 * that moment (the last fresh fix of the GPS watch, or none) — it never waits for GPS. The sync
 * engine sends panics first. A fresh fix is then requested for the WhatsApp text only.
 */
export function SosPanicModal() {
  const { t } = useTranslation();
  const { user, profile, activeSite, sites } = useAuth();
  const [view, setView] = useState<View>('closed');
  const [panic, setPanic] = useState<RaisedPanic | null>(null);
  const [shift, setShift] = useState<ShiftLookup>(undefined);
  const watchRef = useRef<LocationWatchHandle | null>(null);
  const shiftPromiseRef = useRef<Promise<ActiveShiftRecord | null> | null>(null);
  const holdDialogRef = useRef<HTMLDivElement>(null);
  const holdButtonRef = useRef<HTMLButtonElement>(null);
  const panicKeyRef = useRef(0);

  const userId = user?.id ?? null;
  const uiOpen = view !== 'closed';
  const canRecord = !!userId && (!!shift || (!!activeSite && !!profile));
  const guardName = profile ? `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() || null : null;

  // Keep GPS warm while the SOS UI is open (joins the shift's shared watch when one runs).
  // Only when the location permission is already answered: a permission prompt must never cover
  // the SOS button. Otherwise the prompt appears later, for the WhatsApp fix, after the alert is saved.
  useEffect(() => {
    if (!uiOpen) return;
    let cancelled = false;
    let handle: LocationWatchHandle | null = null;
    const start = () => {
      if (cancelled) return;
      handle = startLocationWatch();
      watchRef.current = handle;
    };
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      start(); // Fails at once with 'insecure' (no prompt); the alert records that reason.
    } else if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: 'geolocation' })
        .then((permission) => {
          if (permission.state !== 'prompt') start();
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
      if (handle) {
        handle.stop();
        if (watchRef.current === handle) watchRef.current = null;
      }
    };
  }, [uiOpen]);

  const closeHold = useCallback(() => setView('closed'), []);
  useModalFocus(view === 'hold', holdDialogRef, {
    initialFocusRef: canRecord ? holdButtonRef : undefined,
    onEscape: closeHold
  });

  const siteFor = (siteId: string): Site | null =>
    sites.find((site) => site.id === siteId) ?? (activeSite?.id === siteId ? activeSite : null);

  /** Where the alert is recorded: the running shift's site, else the active site. */
  const targetFor = (record: ActiveShiftRecord | null): { ctx: EventContext; site: Site | null } | null => {
    if (!userId) return null;
    if (record) {
      return {
        ctx: { userId, organisationId: record.organisationId, siteId: record.siteId },
        site: siteFor(record.siteId)
      };
    }
    if (activeSite && profile) {
      return { ctx: { userId, organisationId: profile.organisationId, siteId: activeSite.id }, site: activeSite };
    }
    return null;
  };

  const openHold = () => {
    // Read the running shift now, so it is ready (from IndexedDB) before the 2 s hold completes.
    if (userId) {
      const promise = getActiveShift(userId).catch(() => null);
      shiftPromiseRef.current = promise;
      setShift(undefined);
      void promise.then((record) => {
        if (shiftPromiseRef.current === promise) setShift(record);
      });
    }
    setView('hold');
  };

  const raise = async () => {
    const key = ++panicKeyRef.current;
    const triggeredAt = Date.now();
    const watch = watchRef.current;
    // Best position RIGHT NOW: the watch's last fix if it is fresh (≤ 120 s), else none.
    const lastFix = watch?.peek(STALE_FIX_MS) ?? null;
    const savedLocation: EventLocation = lastFix
      ? eventLocationFromFix(lastFix)
      : { ...NO_LOCATION, gpsError: watch?.lastError()?.status ?? null };
    const provisional = targetFor(shift ?? null);

    setPanic({
      key,
      triggeredAt,
      eventId: null,
      saveError: null,
      site: provisional?.site ?? activeSite ?? null,
      savedLocation,
      savedMessageLocation: messageLocationFromFix(lastFix, triggeredAt),
      fresh: { phase: 'finding', location: null, error: null }
    });
    setView('panic');

    const update = (patch: (current: RaisedPanic) => RaisedPanic) =>
      setPanic((current) => (current && current.key === key ? patch(current) : current));

    // A fresh fix for the WhatsApp text only, requested in parallel (the alert does not wait).
    void getLocationFix({ maxAgeMs: 30_000, timeoutMs: 10_000 }).then((fix) => {
      const location = messageLocationFromFix(fix, Date.now());
      const error = fix.status === 'ok' || fix.status === 'stale' ? null : fix.status;
      update((current) => ({ ...current, fresh: { phase: 'done', location, error } }));
    });

    try {
      const engine = syncEngine;
      if (!engine) throw new Error(t('incident.noStorage'));
      const record = shift !== undefined ? shift : await (shiftPromiseRef.current ?? Promise.resolve(null));
      const target = targetFor(record);
      if (!target) throw new Error(t('incident.sos.noSite'));
      const eventId = await engine.enqueue('panic', target.ctx, { shiftId: record?.shiftId ?? null, ...savedLocation });
      update((current) => ({ ...current, eventId, site: target.site ?? current.site }));
    } catch (error) {
      update((current) => ({ ...current, saveError: error instanceof Error ? error.message : String(error) }));
    }
  };

  const police = policeNumber(activeSite?.policePhone);
  const policeHref = telHref(police.number);

  return (
    <>
      <button
        type="button"
        onClick={openHold}
        aria-haspopup="dialog"
        aria-label={t('incident.sos.openLabel')}
        data-testid="sos-open"
        className="fixed right-4 z-40 flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-full border-2 border-ee-on-danger/40 bg-ee-sos px-5 font-display text-xl font-bold tracking-wide text-ee-on-danger shadow-lg hover:bg-ee-sos-deep"
        style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <Siren className="h-6 w-6" aria-hidden="true" />
        <span>{t('incident.sos.open')}</span>
      </button>

      {view === 'hold' && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ee-bg/90 sm:items-center"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeHold();
          }}
        >
          <div
            ref={holdDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sos-hold-title"
            aria-describedby="sos-hold-instructions"
            tabIndex={-1}
            data-testid="sos-hold-dialog"
            className="w-full max-w-md space-y-4 rounded-t-2xl border-t-4 border-ee-sos bg-ee-surface p-4 focus:outline-none sm:rounded-2xl sm:border-4"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id="sos-hold-title" className="font-display text-3xl font-bold text-ee-text">
                {t('incident.sos.title')}
              </h2>
              <button
                type="button"
                onClick={closeHold}
                aria-label={t('incident.sos.cancel')}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text"
              >
                <X className="h-6 w-6" aria-hidden="true" />
              </button>
            </div>

            <p id="sos-hold-instructions" className="text-base text-ee-text">
              {t('incident.sos.instructions')}
            </p>

            {!canRecord && (
              <div className="space-y-3" data-testid="sos-no-site">
                <p className="text-base font-semibold text-ee-warning">{t('incident.sos.noSite')}</p>
                {policeHref && (
                  <a
                    href={policeHref}
                    data-testid="sos-hold-call-police"
                    className="flex min-h-14 w-full items-center justify-center rounded-xl border border-ee-border bg-ee-bg px-4 no-underline hover:bg-ee-surface-raised"
                  >
                    {/* Colour on the span: globals.css styles bare <a> outside the utility layer. */}
                    <span className="flex items-center gap-2 text-lg font-semibold text-ee-text">
                      <Phone className="h-5 w-5" aria-hidden="true" />
                      {t('incident.sos.call.police', police.number)}
                    </span>
                  </a>
                )}
              </div>
            )}

            <SosHoldButton
              ref={holdButtonRef}
              onTrigger={() => void raise()}
              disabled={!canRecord}
              describedById="sos-hold-instructions sos-hold-keyboard"
            />
            <p id="sos-hold-keyboard" className="text-sm text-ee-muted">
              {t('incident.sos.keyboardHint')}
            </p>

            {panic && (
              <button
                type="button"
                onClick={() => setView('panic')}
                data-testid="sos-view-last"
                className="flex min-h-12 w-full items-center justify-center rounded-xl border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised"
              >
                {t('incident.sos.viewLast', sastTimeHM(panic.triggeredAt))}
              </button>
            )}

            <button
              type="button"
              onClick={closeHold}
              data-testid="sos-hold-cancel"
              className="flex min-h-12 w-full items-center justify-center rounded-xl border border-ee-border bg-ee-surface px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised"
            >
              {t('incident.sos.cancel')}
            </button>
          </div>
        </div>
      )}

      {view === 'panic' && panic && (
        <SosPanicScreen panic={panic} guardName={guardName} onClose={() => setView('closed')} />
      )}
    </>
  );
}
