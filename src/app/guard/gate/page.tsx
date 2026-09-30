'use client';

/**
 * Vehicle gate: IN / OUT register with South African licence-disc scanning.
 *
 * - Identity from useAuth(); the entry belongs to the guard's active shift (shiftStore) and its
 *   site. Without an open shift nothing can be recorded (reference app: "pick guard first").
 * - Entries are queued with syncEngine.enqueue (one Dexie transaction incl. the photo) and the
 *   screen reports the real upload state: saved on this phone → received by server, or the
 *   server's rejection. WhatsApp is only ever "opened".
 * - "Vehicles on site" = the site's gate_entries rows without an OUT + entries made on this
 *   phone (see components/guard/gate/gateLogic.ts). Nothing is invented; an empty list says so.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDownLeft, ArrowUpRight, Camera, ChevronDown, LogIn, MapPin, ScanLine, Trash2 } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { useAuth } from '@/lib/auth/AuthProvider';
import { getActiveShift, type ActiveShiftRecord } from '@/lib/data/shiftStore';
import { syncEngine } from '@/lib/offline/sync';
import { useLocationWatch } from '@/lib/gps/useLocationWatch';
import { MAX_PLATE_LENGTH, normalizePlate } from '@/lib/license-disc/parser';
import { formatDuration } from '@/features/shifts/shiftCalculator';
import type { LicenseDiscData, VehicleDirection } from '@/types/models';
import type { MediaAttachment } from '@/types/offline';
import { CameraCaptureModal } from '@/components/shared/CameraCaptureModal';
import { LicenceDiscScannerModal } from '@/components/guard/LicenceDiscScannerModal';
import { VehiclesOnSiteList, type OnSiteListStatus } from '@/components/guard/gate/VehiclesOnSiteList';
import { DiscDetails } from '@/components/guard/gate/DiscDetails';
import { DuplicateInDialog } from '@/components/guard/gate/DuplicateInDialog';
import { GateResultPanel, type SavedGateEntry } from '@/components/guard/gate/GateResultPanel';
import { captureGateLocation, loadOnSiteSnapshot, type OnSiteSnapshot } from '@/components/guard/gate/gateData';
import {
  EMPTY_GATE_FORM,
  buildGateEntryPayload,
  checkPlate,
  computeVehiclesOnSite,
  discMatchesPlate,
  findOnSiteByPlate,
  formFromDisc,
  formFromOnSiteVehicle,
  formatSastStamp,
  timeOnSiteMs,
  type GateEntryMethod,
  type GateFormValues,
  type GateRecord
} from '@/components/guard/gate/gateLogic';
import {
  inputClass,
  labelClass,
  noticeClass,
  primaryButtonClass,
  secondaryButtonClass
} from '@/components/guard/gate/styles';

type ShiftLoad = { status: 'loading' } | { status: 'none' } | { status: 'active'; shift: ActiveShiftRecord };

type FormMessage = { key: TranslationKey; args?: (string | number)[] };

interface PhotoAttachment {
  blob: Blob;
  previewUrl: string;
}

type FocusTarget = { target: 'plate' | 'scan'; seq: number };

const PLATE_INPUT_MAX = MAX_PLATE_LENGTH + 10;

/** <summary> rows: flex hides the native marker, so a chevron shows that they open. */
const summaryClass =
  'flex min-h-12 cursor-pointer list-none items-center gap-2 px-3 text-base font-semibold text-ee-text [&::-webkit-details-marker]:hidden';
const chevronClass = 'h-5 w-5 shrink-0 text-ee-muted group-open:rotate-180 motion-safe:transition-transform';

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    // Vibration is a courtesy only.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error ?? '');
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  testId: string;
  type?: 'text' | 'tel';
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  autoCapitalize?: string;
}

function TextField({ id, label, value, onChange, maxLength, testId, type = 'text', inputMode, autoCapitalize }: TextFieldProps) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        inputMode={inputMode}
        autoCapitalize={autoCapitalize}
        autoComplete="off"
        enterKeyHint="next"
        data-testid={testId}
        className={inputClass}
      />
    </div>
  );
}

export default function GuardGatePage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const userId = auth.status === 'signed_in' ? auth.user?.id ?? null : null;

  const [shiftLoad, setShiftLoad] = useState<ShiftLoad>({ status: 'loading' });
  const [direction, setDirection] = useState<VehicleDirection>('in');
  const [form, setForm] = useState<GateFormValues>(EMPTY_GATE_FORM);
  const [disc, setDisc] = useState<LicenseDiscData | null>(null);
  const [selectedIn, setSelectedIn] = useState<GateRecord | null>(null);
  const [photo, setPhoto] = useState<PhotoAttachment | null>(null);
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState<FormMessage | null>(null);
  const [duplicate, setDuplicate] = useState<GateRecord | null>(null);
  const [saved, setSaved] = useState<SavedGateEntry | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<OnSiteSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(0);
  const [focusRequest, setFocusRequest] = useState<FocusTarget | null>(null);
  const [moreDetailsOpen, setMoreDetailsOpen] = useState(false);

  const savingRef = useRef(false);
  const loadSeqRef = useRef(0);
  const plateInputRef = useRef<HTMLInputElement | null>(null);
  const scanButtonRef = useRef<HTMLButtonElement | null>(null);

  const shift = shiftLoad.status === 'active' ? shiftLoad.shift : null;
  // Entries belong to the shift's site; without a shift the active site's list is shown read-only.
  const siteId = shift?.siteId ?? auth.activeSite?.id ?? null;
  const site = useMemo(() => {
    if (!siteId) return null;
    return auth.sites.find((candidate) => candidate.id === siteId) ?? (auth.activeSite?.id === siteId ? auth.activeSite : null);
  }, [siteId, auth.sites, auth.activeSite]);
  const guardName = [auth.profile?.firstName, auth.profile?.lastName].filter(Boolean).join(' ');

  const gps = useLocationWatch(!!shift);

  // Clock for "time on site" (SAST labels); 0 until mounted so render stays pure.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);

  // The guard's open shift on this phone (the only source of shiftId).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const active = await getActiveShift(userId);
        if (!cancelled) setShiftLoad(active ? { status: 'active', shift: active } : { status: 'none' });
      } catch {
        if (!cancelled) setShiftLoad({ status: 'none' });
      }
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = syncEngine?.subscribe(() => void check());
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe?.();
    };
  }, [userId]);

  const loadVehicles = useCallback(async (targetSiteId: string) => {
    const seq = ++loadSeqRef.current;
    try {
      const next = await loadOnSiteSnapshot(targetSiteId);
      if (seq === loadSeqRef.current) setSnapshot(next);
    } catch {
      if (seq === loadSeqRef.current) {
        setSnapshot({ siteId: targetSiteId, records: [], source: 'device', serverFailed: true, serverListAt: null });
      }
    } finally {
      if (seq === loadSeqRef.current) setRefreshing(false);
    }
  }, []);

  // Vehicles on site: on open, when back online / visible, and after this phone uploaded something.
  useEffect(() => {
    if (!siteId) return;
    const reload = () => void loadVehicles(siteId);
    reload();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    window.addEventListener('online', reload);
    document.addEventListener('visibilitychange', onVisible);
    let first = true;
    let lastSync: string | undefined;
    const unsubscribe = syncEngine?.subscribe((summary) => {
      const at = summary.lastSyncTimestamp;
      if (first) {
        first = false;
        lastSync = at;
        return;
      }
      if (at && at !== lastSync) {
        lastSync = at;
        reload();
      }
    });
    return () => {
      window.removeEventListener('online', reload);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe?.();
    };
  }, [siteId, loadVehicles]);

  // Focus moves requested by handlers (runs after a closing dialog handed focus back).
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.target === 'plate') plateInputRef.current?.focus();
    else scanButtonRef.current?.focus();
  }, [focusRequest]);

  const requestFocus = (target: FocusTarget['target']) => setFocusRequest((prev) => ({ target, seq: (prev?.seq ?? 0) + 1 }));

  const currentSnapshot = snapshot && snapshot.siteId === siteId ? snapshot : null;
  const vehicles = useMemo(
    () => (currentSnapshot && now > 0 ? computeVehiclesOnSite(currentSnapshot.records, { now }) : []),
    [currentSnapshot, now]
  );
  const listStatus: OnSiteListStatus = {
    loading: !currentSnapshot || refreshing || now === 0,
    source: currentSnapshot?.source ?? null,
    serverFailed: currentSnapshot?.serverFailed ?? false,
    serverListAt: currentSnapshot?.serverListAt ?? null
  };
  const refreshList = () => {
    if (!siteId) return;
    setRefreshing(true);
    void loadVehicles(siteId);
  };

  const plate = normalizePlate(form.plate);
  const plateProblem = checkPlate(form.plate);
  const onSiteMatch = findOnSiteByPlate(vehicles, form.plate);
  const linkedIn =
    direction === 'out' ? (selectedIn && selectedIn.plate === plate ? selectedIn : onSiteMatch) : null;

  const setField = (field: keyof GateFormValues) => (value: string) => {
    setForm((prev) => ({ ...prev, [field]: field === 'plate' ? value.toUpperCase() : value }));
    if (field === 'plate') setFormMessage(null);
  };

  const changeDirection = (next: VehicleDirection) => {
    setDirection(next);
    setSelectedIn(null);
    setFormMessage(null);
  };

  const pickVehicle = (vehicle: GateRecord) => {
    setSelectedIn(vehicle);
    setFormMessage(null);
    setForm((prev) =>
      formFromOnSiteVehicle(
        normalizePlate(prev.plate) === vehicle.plate ? prev : { ...prev, makeModel: '', colour: '', driverName: '' },
        vehicle
      )
    );
    if (disc && !discMatchesPlate(disc, vehicle.plate)) setDisc(null);
  };

  const handleDiscRead = (read: LicenseDiscData) => {
    setScannerOpen(false);
    setDisc(read);
    setFormMessage(null);
    const match = direction === 'out' ? findOnSiteByPlate(vehicles, read.plate) : null;
    setSelectedIn(match);
    setForm((prev) => {
      const base = normalizePlate(prev.plate) === read.plate ? prev : { ...prev, makeModel: '', colour: '' };
      const fromDisc = formFromDisc(base, read);
      return match ? formFromOnSiteVehicle(fromDisc, match) : fromDisc;
    });
  };

  const handleManualEntry = () => {
    setScannerOpen(false);
    requestFocus('plate');
  };

  const save = async (options: { confirmNewIn?: boolean } = {}) => {
    if (savingRef.current || !userId || !shift) return;
    if (plateProblem?.level === 'error') {
      setFormMessage(
        plateProblem.code === 'empty' ? { key: 'gatePlateNeeded' } : { key: 'gatePlateTooLong', args: [MAX_PLATE_LENGTH] }
      );
      vibrate([90, 60, 90]);
      requestFocus('plate');
      return;
    }
    if (direction === 'in' && onSiteMatch && !options.confirmNewIn) {
      setDuplicate(onSiteMatch);
      return;
    }
    if (!syncEngine) {
      setFormMessage({ key: 'gateSaveFailedGeneric' });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setFormMessage(null);
    const snapshotForm = form;
    const snapshotDisc = disc;
    const snapshotLinked = linkedIn;
    const snapshotPhoto = photo;
    const snapshotDirection = direction;
    const pickedFromList = !!(snapshotLinked && selectedIn && snapshotLinked.id === selectedIn.id);
    try {
      const location = await captureGateLocation();
      const recordedAt = Date.now();
      const payload = buildGateEntryPayload({
        direction: snapshotDirection,
        form: snapshotForm,
        disc: snapshotDisc,
        shiftId: shift.shiftId,
        location,
        now: recordedAt,
        linkedIn: snapshotLinked
      });
      const media: MediaAttachment[] = snapshotPhoto
        ? [{ field: 'photo', blob: snapshotPhoto.blob, mimeType: snapshotPhoto.blob.type || 'image/jpeg' }]
        : [];
      const eventId = await syncEngine.enqueue(
        'gate_entry',
        { userId, organisationId: shift.organisationId, siteId: shift.siteId },
        payload,
        media
      );
      const method: GateEntryMethod = payload.isDiscScanned ? 'disc' : pickedFromList ? 'list' : 'manual';
      setSaved({ eventId, payload, method, recordedAt, photo: snapshotPhoto?.blob ?? null });
      vibrate(250);
      void loadVehicles(shift.siteId);
    } catch (error) {
      const message = errorText(error);
      setFormMessage(message ? { key: 'gateSaveFailed', args: [message] } : { key: 'gateSaveFailedGeneric' });
      vibrate([90, 60, 90]);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const startNewEntry = () => {
    setSaved(null);
    setForm(EMPTY_GATE_FORM);
    setDisc(null);
    setPhoto(null);
    setSelectedIn(null);
    setFormMessage(null);
    setMoreDetailsOpen(false);
    requestFocus('scan');
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const heading = (
    <header>
      <h1 className="font-display text-2xl font-bold uppercase tracking-wide text-ee-text">{t('gateTitle')}</h1>
      {site && (
        <p data-testid="gate-site" className="text-sm text-ee-muted">
          {t('gateShiftSite', site.name)}
        </p>
      )}
    </header>
  );

  if (auth.status === 'loading' || (userId && shiftLoad.status === 'loading')) {
    return (
      <div className="space-y-4">
        {heading}
        <p role="status" data-testid="gate-loading" className="text-ee-muted">
          {t('gateLoading')}
        </p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="space-y-4">
        {heading}
        <p data-testid="gate-signed-out" className={noticeClass.warning}>
          {t('gateSignedOut')}
        </p>
      </div>
    );
  }

  const gpsFix = gps.fix && gps.fix.status === 'ok' && Number.isFinite(gps.fix.accuracy) ? gps.fix : null;
  const gpsLine: { key: TranslationKey; args: (string | number)[]; tone: string } = gpsFix
    ? { key: 'gateGpsReady', args: [Math.round(gpsFix.accuracy)], tone: 'text-ee-muted' }
    : gps.error || gps.fix
      ? { key: 'gateGpsNone', args: [], tone: 'text-ee-warning' }
      : { key: 'gateGpsWaiting', args: [], tone: 'text-ee-muted' };

  const plateNotes: Array<{ key: TranslationKey; args: (string | number)[]; tone: keyof typeof noticeClass; testId: string }> = [];
  if (plate !== '' && plateProblem) {
    if (plateProblem.code === 'too_long') {
      plateNotes.push({ key: 'gatePlateTooLong', args: [MAX_PLATE_LENGTH], tone: 'danger', testId: 'gate-plate-problem' });
    } else if (plateProblem.code === 'unusual_chars') {
      plateNotes.push({ key: 'gatePlateUnusualChars', args: [], tone: 'warning', testId: 'gate-plate-problem' });
    } else if (plateProblem.code === 'unusual_length') {
      plateNotes.push({ key: 'gatePlateUnusualLength', args: [], tone: 'warning', testId: 'gate-plate-problem' });
    }
  }
  if (plate !== '' && direction === 'in' && onSiteMatch) {
    plateNotes.push({
      key: 'gateAlreadyOnSite',
      args: [onSiteMatch.displayPlate, formatSastStamp(onSiteMatch.entryTime, now)],
      tone: 'warning',
      testId: 'gate-already-on-site'
    });
  }
  if (plate !== '' && direction === 'out' && plateProblem?.level !== 'error') {
    if (linkedIn) {
      plateNotes.push({
        key: 'gateOutLinked',
        args: [formatSastStamp(linkedIn.entryTime, now), formatDuration(timeOnSiteMs(linkedIn.entryTime, now))],
        tone: 'info',
        testId: 'gate-out-linked'
      });
    } else if (currentSnapshot) {
      plateNotes.push({ key: 'gateOutNoInRecord', args: [plate], tone: 'warning', testId: 'gate-out-no-in' });
    }
  }

  return (
    <div className="space-y-4 pb-6" data-testid="gate-page">
      {heading}

      {!siteId && (
        <p data-testid="gate-no-site" className={noticeClass.warning}>
          {t('gateNoSite')}
        </p>
      )}

      {shift && site && auth.activeSite && auth.activeSite.id !== shift.siteId && (
        <p data-testid="gate-site-mismatch" className={noticeClass.info}>
          {t('gateShiftSiteMismatch', site.name)}
        </p>
      )}

      {!shift && (
        <>
          <section
            aria-labelledby="gate-need-shift-heading"
            data-testid="gate-need-shift"
            className="rounded-lg border border-ee-warning/40 bg-ee-surface p-4"
          >
            <h2 id="gate-need-shift-heading" className="font-display text-xl font-bold uppercase tracking-wide text-ee-warning">
              {t('gateNeedShiftTitle')}
            </h2>
            <p className="mt-1 text-base text-ee-text">{t('gateNeedShiftBody')}</p>
            {/* text colour needs `!`: the unlayered global `a { color }` in globals.css beats utilities */}
            <Link href="/guard" data-testid="gate-go-home" className={`mt-3 ${primaryButtonClass} text-ee-on-primary!`}>
              <LogIn className="h-5 w-5" aria-hidden="true" />
              <span>{t('gateGoHome')}</span>
            </Link>
          </section>
          {siteId && (
            <section aria-labelledby="gate-onsite-heading">
              <h2 id="gate-onsite-heading" className="mb-2 text-base font-semibold text-ee-text">
                {t('gateOnSiteTitle')}
              </h2>
              <VehiclesOnSiteList vehicles={vehicles} now={now} status={listStatus} onRefresh={refreshList} />
            </section>
          )}
        </>
      )}

      {shift && saved && (
        <GateResultPanel
          saved={saved}
          guardName={guardName}
          siteName={site?.name ?? null}
          whatsappNumber={site?.whatsappDispatchNumber}
          onNewEntry={startNewEntry}
        />
      )}

      {shift && !saved && (
        <>
          <div
            role="group"
            aria-label={t('gateDirectionLabel')}
            className="grid grid-cols-2 gap-1 rounded-lg border border-ee-border bg-ee-surface p-1"
          >
            {(['in', 'out'] as const).map((value) => {
              const active = direction === value;
              const Icon = value === 'in' ? ArrowDownLeft : ArrowUpRight;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => changeDirection(value)}
                  aria-pressed={active}
                  data-testid={`gate-direction-${value}`}
                  className={`flex min-h-14 min-w-0 items-center justify-center gap-1.5 rounded-md px-1 font-display text-xl font-bold uppercase tracking-wide ${
                    active ? 'bg-ee-primary text-ee-on-primary' : 'text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text'
                  }`}
                >
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>{t(value === 'in' ? 'gateIn' : 'gateOut')}</span>
                </button>
              );
            })}
          </div>

          {direction === 'out' ? (
            <section aria-labelledby="gate-onsite-heading">
              <h2 id="gate-onsite-heading" className="mb-2 text-base font-semibold text-ee-text">
                {t('gateOnSitePick')}
              </h2>
              <VehiclesOnSiteList
                vehicles={vehicles}
                now={now}
                status={listStatus}
                onRefresh={refreshList}
                onPick={pickVehicle}
                selectedId={linkedIn?.id ?? null}
              />
              <p className="mt-3 text-sm text-ee-muted">{t('gateOrScan')}</p>
            </section>
          ) : (
            <details data-testid="gate-onsite-summary" className="group rounded-lg border border-ee-border bg-ee-surface">
              <summary className={summaryClass}>
                <span className="flex-1">
                  {listStatus.loading && vehicles.length === 0
                    ? t('gateOnSiteLoading')
                    : t('gateOnSiteCount', vehicles.length)}
                </span>
                <ChevronDown className={chevronClass} aria-hidden="true" />
              </summary>
              <div className="border-t border-ee-border p-3">
                <VehiclesOnSiteList vehicles={vehicles} now={now} status={listStatus} onRefresh={refreshList} />
              </div>
            </details>
          )}

          <button
            ref={scanButtonRef}
            type="button"
            onClick={() => setScannerOpen(true)}
            data-testid="gate-scan-disc"
            className={primaryButtonClass}
          >
            <ScanLine className="h-6 w-6" aria-hidden="true" />
            <span>{t('gateScanDisc')}</span>
          </button>

          {disc && <DiscDetails disc={disc} plate={form.plate} onDiscard={() => setDisc(null)} />}

          <div className="space-y-3">
            <div>
              <label htmlFor="gate-plate" className={labelClass}>
                {t('gatePlateLabel')}
              </label>
              <input
                id="gate-plate"
                ref={plateInputRef}
                type="text"
                value={form.plate}
                onChange={(event) => setField('plate')(event.target.value)}
                maxLength={PLATE_INPUT_MAX}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                required
                aria-required="true"
                aria-invalid={formMessage?.key === 'gatePlateNeeded' || plateProblem?.code === 'too_long'}
                aria-describedby="gate-plate-notes"
                data-testid="gate-plate"
                className={`${inputClass} min-h-14 font-display text-2xl font-bold uppercase tracking-wider`}
              />
              <div id="gate-plate-notes" aria-live="polite" className="mt-2 space-y-2 empty:mt-0">
                {plateNotes.map((note) => (
                  <p key={note.key} data-testid={note.testId} className={noticeClass[note.tone]}>
                    {t(note.key, ...note.args)}
                  </p>
                ))}
              </div>
            </div>

            <TextField
              id="gate-make-model"
              label={t('gateMakeModel')}
              value={form.makeModel}
              onChange={setField('makeModel')}
              maxLength={100}
              testId="gate-make-model"
            />
            <TextField
              id="gate-colour"
              label={t('gateColour')}
              value={form.colour}
              onChange={setField('colour')}
              maxLength={50}
              testId="gate-colour"
            />
            <TextField
              id="gate-driver-name"
              label={t('gateDriverName')}
              value={form.driverName}
              onChange={setField('driverName')}
              maxLength={255}
              autoCapitalize="words"
              testId="gate-driver-name"
            />
            {direction === 'in' && (
              <>
                <TextField
                  id="gate-visit-reason"
                  label={t('gateVisitReason')}
                  value={form.visitReason}
                  onChange={setField('visitReason')}
                  maxLength={500}
                  autoCapitalize="sentences"
                  testId="gate-visit-reason"
                />
                {/* Less-used fields stay one tap away so the everyday form stays as short as Dawie's. */}
                <details
                  data-testid="gate-more-details"
                  open={moreDetailsOpen}
                  onToggle={(event) => setMoreDetailsOpen(event.currentTarget.open)}
                  className="group rounded-lg border border-ee-border bg-ee-surface"
                >
                  <summary className={summaryClass}>
                    <span className="flex-1">{t('gateMoreDetails')}</span>
                    <ChevronDown className={chevronClass} aria-hidden="true" />
                  </summary>
                  <div className="space-y-3 border-t border-ee-border p-3">
                    <TextField
                      id="gate-driver-phone"
                      label={t('gateDriverPhone')}
                      value={form.driverPhone}
                      onChange={setField('driverPhone')}
                      maxLength={50}
                      type="tel"
                      inputMode="tel"
                      testId="gate-driver-phone"
                    />
                    <TextField
                      id="gate-company"
                      label={t('gateCompany')}
                      value={form.company}
                      onChange={setField('company')}
                      maxLength={255}
                      autoCapitalize="words"
                      testId="gate-company"
                    />
                    <TextField
                      id="gate-person-visited"
                      label={t('gatePersonVisited')}
                      value={form.personVisited}
                      onChange={setField('personVisited')}
                      maxLength={255}
                      autoCapitalize="words"
                      testId="gate-person-visited"
                    />
                  </div>
                </details>
              </>
            )}

            {photo ? (
              <div data-testid="gate-photo-preview" className="flex items-center gap-3 rounded-lg border border-ee-border bg-ee-surface p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
                <img src={photo.previewUrl} alt={t('gatePhotoAlt')} className="h-16 w-16 shrink-0 rounded object-cover" />
                <span className="flex-1 text-sm font-semibold text-ee-success">{t('gatePhotoAttached')}</span>
                <button
                  type="button"
                  onClick={() => setPhoto(null)}
                  aria-label={t('gatePhotoRemove')}
                  data-testid="gate-photo-remove"
                  className="grid min-h-12 min-w-12 place-items-center rounded-lg text-ee-danger hover:bg-ee-surface-raised"
                >
                  <Trash2 className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setPhotoOpen(true)} data-testid="gate-photo-add" className={secondaryButtonClass}>
                <Camera className="h-5 w-5" aria-hidden="true" />
                <span>{t('gatePhotoAdd')}</span>
              </button>
            )}

            <p data-testid="gate-gps-status" className={`flex items-center gap-2 text-sm ${gpsLine.tone}`}>
              <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t(gpsLine.key, ...gpsLine.args)}</span>
            </p>

            {formMessage && (
              <p role="alert" data-testid="gate-form-error" className={`break-words ${noticeClass.danger}`}>
                {t(formMessage.key, ...(formMessage.args ?? []))}
              </p>
            )}

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              aria-busy={saving}
              data-testid="gate-save"
              className={primaryButtonClass}
            >
              {saving ? t('gateSaving') : t(direction === 'in' ? 'gateSaveIn' : 'gateSaveOut')}
            </button>
          </div>
        </>
      )}

      {duplicate && (
        <DuplicateInDialog
          plate={duplicate.displayPlate}
          since={formatSastStamp(duplicate.entryTime, now)}
          onCancel={() => setDuplicate(null)}
          onRecordOut={() => {
            const vehicle = duplicate;
            setDuplicate(null);
            setDirection('out');
            pickVehicle(vehicle);
          }}
          onConfirmNewIn={() => {
            setDuplicate(null);
            void save({ confirmNewIn: true });
          }}
        />
      )}

      <LicenceDiscScannerModal
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDiscRead={handleDiscRead}
        onManualEntry={handleManualEntry}
      />

      <CameraCaptureModal
        isOpen={photoOpen}
        onClose={() => setPhotoOpen(false)}
        onCapture={(blob, previewUrl) => {
          setPhoto({ blob, previewUrl });
          setPhotoOpen(false);
        }}
        facingMode="environment"
        title={t('gatePhotoTitle')}
        testIdPrefix="gate-camera"
      />
    </div>
  );
}
