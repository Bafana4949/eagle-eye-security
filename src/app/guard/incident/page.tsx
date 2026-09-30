'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { CircleAlert, Crosshair, MapPin, MapPinOff, RotateCcw, TriangleAlert } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { useAuth } from '@/lib/auth/AuthProvider';
import { syncEngine } from '@/lib/offline/sync';
import { eventLocationFromFix } from '@/lib/offline/eventLocation';
import { getActiveShift, type ActiveShiftRecord } from '@/lib/data/shiftStore';
import { raceWithTimeout } from '@/lib/supabase/timeouts';
import type { LocationFixResult } from '@/lib/gps/location';
import type { EventContext, MediaAttachment } from '@/types/offline';
import type { IncidentSeverity, Site } from '@/types/models';
import { IncidentPhotoPicker, type IncidentPhoto } from '@/components/guard/incident/IncidentPhotoPicker';
import { IncidentTypePicker, SeverityPicker } from '@/components/guard/incident/IncidentPickers';
import { IncidentSavedPanel, type SavedIncident } from '@/components/guard/incident/IncidentSavedPanel';
import { RecentIncidents } from '@/components/guard/incident/RecentIncidents';
import { useIncidentLocation } from '@/components/guard/incident/useIncidentLocation';
import {
  DESCRIPTION_MAX_LENGTH,
  WEAK_ACCURACY_METERS,
  gpsErrorLabel,
  messageLocationFromFix,
  roundedAccuracy,
  type IncidentTypeId
} from '@/components/guard/incident/incidentLogic';

type SavePhase = 'idle' | 'locating' | 'saving';

const SHIFT_LOOKUP_TIMEOUT_MS = 3000;

function GpsStatusLine({
  phase,
  result,
  onRetry,
  disabled
}: {
  phase: 'locating' | 'done';
  result: LocationFixResult | null;
  onRetry: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  let status: 'locating' | 'ok' | 'weak' | 'none';
  let text: string;
  if (phase === 'locating' || !result) {
    status = 'locating';
    text = t('incident.gps.locating');
  } else if (result.status === 'ok') {
    const accuracy = roundedAccuracy(result.accuracy);
    status = accuracy !== null && accuracy <= WEAK_ACCURACY_METERS ? 'ok' : 'weak';
    text = status === 'ok' ? t('incident.gps.ok', accuracy ?? 0) : t('incident.gps.weak', accuracy ?? '?');
  } else {
    status = 'none';
    text = t('incident.gps.none', gpsErrorLabel(result.status, t));
  }
  const tone = status === 'ok' ? 'text-ee-success' : status === 'locating' ? 'text-ee-muted' : 'text-ee-warning';
  const Icon = status === 'locating' ? Crosshair : status === 'none' ? MapPinOff : MapPin;

  return (
    <div className="space-y-2">
      <p
        role="status"
        aria-live="polite"
        data-testid="incident-gps-status"
        data-status={status}
        className={`flex items-start gap-2 text-base ${tone}`}
      >
        <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{text}</span>
      </p>
      {status === 'none' && (
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          data-testid="incident-gps-retry"
          className="flex min-h-12 items-center gap-2 rounded-xl border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50"
        >
          <RotateCcw className="h-5 w-5" aria-hidden="true" />
          {t('incident.gps.retry')}
        </button>
      )}
    </div>
  );
}

function siteById(sites: Site[], activeSite: Site | null, siteId: string): Site | null {
  return sites.find((site) => site.id === siteId) ?? (activeSite?.id === siteId ? activeSite : null);
}

/**
 * Guard incident report (reference app types). The report is stored on this phone first through
 * the sync engine and uploaded when possible; the confirmation shows its real upload state.
 */
export default function GuardIncidentPage() {
  const { t } = useTranslation();
  const { status: authStatus, user, profile, activeSite, sites } = useAuth();
  const location = useIncidentLocation();
  const typeLabelId = useId();
  const severityLabelId = useId();
  const descriptionId = useId();
  const descriptionHintId = useId();

  const [shift, setShift] = useState<ActiveShiftRecord | null>(null);
  const [shiftLoaded, setShiftLoaded] = useState(false);
  const [incidentType, setIncidentType] = useState<IncidentTypeId | null>(null);
  const [severity, setSeverity] = useState<IncidentSeverity>('medium');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState<IncidentPhoto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [typeMissing, setTypeMissing] = useState(false);
  const [phase, setPhase] = useState<SavePhase>('idle');
  const [saved, setSaved] = useState<SavedIncident | null>(null);

  const firstTypeRef = useRef<HTMLButtonElement>(null);
  const savedHeadingRef = useRef<HTMLHeadingElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const userId = user?.id ?? null;

  // The running shift (if any) decides which site the report belongs to, and is linked to it.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    // A blocked IndexedDB must not leave the form on "Loading…": after 3 s it opens without a shift link.
    raceWithTimeout(getActiveShift(userId), SHIFT_LOOKUP_TIMEOUT_MS)
      .then((outcome) => {
        if (!cancelled && !outcome.timedOut) setShift(outcome.value);
      })
      .catch(() => {
        if (!cancelled) setShift(null);
      })
      .finally(() => {
        if (!cancelled) setShiftLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Move focus to the confirmation when a report has been saved.
  useEffect(() => {
    if (saved) savedHeadingRef.current?.focus();
  }, [saved]);

  if (authStatus !== 'signed_in' || !user || !profile || !shiftLoaded) {
    return (
      <p className="py-8 text-center text-base text-ee-muted" role="status" data-testid="incident-loading">
        {t('incident.loading')}
      </p>
    );
  }

  const reportSite = shift ? siteById(sites, activeSite, shift.siteId) : activeSite;
  const context: EventContext | null = shift
    ? { userId: user.id, organisationId: shift.organisationId, siteId: shift.siteId }
    : activeSite
      ? { userId: user.id, organisationId: profile.organisationId, siteId: activeSite.id }
      : null;

  if (!context) {
    return (
      <section
        className="space-y-2 rounded-2xl border border-ee-border bg-ee-surface p-4"
        data-testid="incident-no-site"
        aria-labelledby="incident-no-site-title"
      >
        <h1 id="incident-no-site-title" className="flex items-center gap-2 font-display text-2xl font-bold text-ee-text">
          <TriangleAlert className="h-6 w-6 shrink-0 text-ee-warning" aria-hidden="true" />
          {t('incident.noSite.title')}
        </h1>
        <p className="text-base text-ee-muted">{t('incident.noSite.body')}</p>
      </section>
    );
  }

  const guardName = `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() || null;
  const busy = phase !== 'idle';

  const chooseType = (type: IncidentTypeId) => {
    setIncidentType(type);
    setTypeMissing(false);
    setFormError(null);
  };

  const resetForm = () => {
    setIncidentType(null);
    setSeverity('medium');
    setDescription('');
    setPhoto(null);
    setFormError(null);
    setTypeMissing(false);
  };

  const submit = async () => {
    if (busy) return;
    if (!incidentType) {
      setTypeMissing(true);
      setFormError(t('incident.pickType'));
      firstTypeRef.current?.focus();
      return;
    }
    const engine = syncEngine;
    if (!engine) {
      setFormError(t('incident.noStorage'));
      return;
    }
    setFormError(null);
    setPhase('locating');
    try {
      // Never blocks for long: a recent fix is reused, otherwise GPS gets at most a few seconds.
      const { result: fix, receivedAt } = await location.locationForSubmit();
      setPhase('saving');
      const eventLocation = eventLocationFromFix(fix);
      const media: MediaAttachment[] = photo
        ? [{ field: 'photo', blob: photo.blob, mimeType: photo.blob.type || 'image/jpeg' }]
        : [];
      const reportedAt = Date.now();
      const eventId = await engine.enqueue(
        'incident',
        context,
        {
          shiftId: shift?.shiftId ?? null,
          incidentType,
          severity,
          description: description.trim(),
          ...eventLocation
        },
        media
      );
      let canSharePhoto = false;
      if (photo && typeof navigator !== 'undefined' && typeof navigator.canShare === 'function') {
        try {
          canSharePhoto = navigator.canShare({ files: [new File([photo.blob], 'incident.jpg', { type: 'image/jpeg' })] });
        } catch {
          canSharePhoto = false;
        }
      }
      setSaved({
        eventId,
        incidentType,
        severity,
        description: description.trim(),
        reportedAt,
        location: eventLocation,
        messageLocation: fix.status === 'ok' ? messageLocationFromFix(fix, receivedAt) : null,
        photo,
        canSharePhoto,
        guardName,
        siteName: reportSite?.name ?? null,
        whatsappDispatchNumber: reportSite?.whatsappDispatchNumber ?? null
      });
      resetForm();
    } catch (error) {
      // Nothing was stored (enqueue is atomic): keep the form so the guard can try again.
      setFormError(t('incident.saveFailed', error instanceof Error ? error.message : String(error)));
    } finally {
      setPhase('idle');
    }
  };

  const reportAnother = () => {
    setSaved(null);
    location.retry();
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  return (
    <div className="space-y-4 pb-6" data-testid="incident-page">
      {saved ? (
        <IncidentSavedPanel ref={savedHeadingRef} saved={saved} onReportAnother={reportAnother} />
      ) : (
        <form
          className="rounded-2xl border border-ee-border bg-ee-surface"
          aria-labelledby="incident-title"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1 p-4">
            <h1
              id="incident-title"
              ref={titleRef}
              tabIndex={-1}
              className="font-display text-2xl font-bold text-ee-text focus:outline-none"
            >
              {t('incident.title')}
            </h1>
            {reportSite && (
              <p className="text-base text-ee-muted" data-testid="incident-site">
                {t('incident.siteLine', reportSite.name)}
              </p>
            )}
            <p className="text-sm text-ee-muted" data-testid="incident-shift">
              {shift ? t('incident.shiftLinked') : t('incident.noShift')}
            </p>
          </div>

          <div className="divide-y divide-ee-border border-t border-ee-border">
            <div className="space-y-3 p-4">
              <h2 id={typeLabelId} className="text-lg font-semibold text-ee-text">
                {t('incident.typeLabel')}
              </h2>
              <IncidentTypePicker
                ref={firstTypeRef}
                value={incidentType}
                onChange={chooseType}
                labelId={typeLabelId}
                disabled={busy}
                invalid={typeMissing}
              />
            </div>

            <div className="space-y-3 p-4">
              <h2 id={severityLabelId} className="text-lg font-semibold text-ee-text">
                {t('incident.severityLabel')}
              </h2>
              <SeverityPicker value={severity} onChange={setSeverity} labelId={severityLabelId} disabled={busy} />
            </div>

            <div className="space-y-2 p-4">
              <label htmlFor={descriptionId} className="block text-lg font-semibold text-ee-text">
                {t('incident.descriptionLabel')}
              </label>
              <p id={descriptionHintId} className="text-sm text-ee-muted">
                {t('incident.descriptionHint')}
              </p>
              <textarea
                id={descriptionId}
                aria-describedby={descriptionHintId}
                value={description}
                onChange={(event) => setDescription(event.target.value.slice(0, DESCRIPTION_MAX_LENGTH))}
                rows={4}
                maxLength={DESCRIPTION_MAX_LENGTH}
                disabled={busy}
                data-testid="incident-description"
                className="block w-full rounded-xl border border-ee-border bg-ee-bg p-3 text-base text-ee-text placeholder:text-ee-muted focus:border-ee-primary focus:outline-none disabled:opacity-50"
              />
              <p className="text-right text-sm text-ee-muted">
                {t('incident.charsLeft', DESCRIPTION_MAX_LENGTH - description.length)}
              </p>
            </div>

            <div className="p-4">
              <IncidentPhotoPicker photo={photo} onChange={setPhoto} disabled={busy} />
            </div>

            <div className="p-4">
              <GpsStatusLine phase={location.phase} result={location.result} onRetry={location.retry} disabled={busy} />
            </div>

            <div className="space-y-3 p-4">
              <div role="alert" className="text-base font-semibold text-ee-danger" data-testid="incident-form-error">
                {formError ? (
                  <p className="flex items-start gap-2">
                    <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">{formError}</span>
                  </p>
                ) : null}
              </div>
              <button
                type="submit"
                disabled={busy}
                aria-busy={busy}
                data-testid="incident-submit"
                className="flex min-h-14 w-full items-center justify-center rounded-xl bg-ee-primary px-4 text-lg font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-60"
              >
                {phase === 'locating'
                  ? t('incident.savingGps')
                  : phase === 'saving'
                    ? t('incident.saving')
                    : t('incident.submit')}
              </button>
            </div>
          </div>
        </form>
      )}

      <RecentIncidents userId={user.id} />
    </div>
  );
}
