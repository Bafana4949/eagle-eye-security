'use client';

/**
 * Guard patrol screen: scan checkpoints (QR card or NFC tag) during the active shift.
 *
 * Identity comes only from useAuth(); the shift only from shiftStore; the checkpoints from the
 * site's list (network or this phone's copy); site settings (round interval, legacy cards) from
 * the site row. Every scan is stored on the phone first and shown as such until the sync
 * engine reports it uploaded. The GPS verdict shown is the phone's estimate; the server
 * re-checks it.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ClipboardList, MapPin } from 'lucide-react';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useTranslation } from '@/lib/i18n/context';
import { QrScannerModal } from '@/components/shared/QrScannerModal';
import { useLocationWatch } from '@/lib/gps/useLocationWatch';
import { usePatrolAlarm } from '@/lib/patrol/usePatrolAlarm';
import { triggerAlarmBeep, unlockAudioContext } from '@/lib/patrol/alarm';
import { syncEngine } from '@/lib/offline/sync';
import type { ActiveShiftRecord } from '@/lib/data/shiftStore';
import type { Site } from '@/types/models';
import { computeRoundProgress, patrolCheckpoints } from '@/components/guard/patrol/patrolLogic';
import { useActiveShift, useClock, useShiftScans, useSiteCheckpoints } from '@/components/guard/patrol/usePatrolData';
import { usePatrolScanner } from '@/components/guard/patrol/usePatrolScanner';
import { useNfcPatrol } from '@/components/guard/patrol/useNfcPatrol';
import { PatrolAlarmBanner } from '@/components/guard/patrol/PatrolAlarmBanner';
import { PatrolScanControls } from '@/components/guard/patrol/PatrolScanControls';
import { ScanResultPanel } from '@/components/guard/patrol/ScanResultPanel';
import { PatrolStatusStrip } from '@/components/guard/patrol/PatrolStatusStrip';
import { RoundProgressList } from '@/components/guard/patrol/RoundProgressList';
import { RecentScansList } from '@/components/guard/patrol/RecentScansList';

export default function GuardPatrolPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const userId = auth.status === 'signed_in' ? auth.user?.id ?? null : null;
  const { state: shiftState, refresh: refreshShift } = useActiveShift(userId);

  let content: React.ReactNode;
  if (!userId || shiftState.status === 'loading') {
    content = (
      <p className="py-10 text-center text-ee-muted" role="status" data-testid="patrol-loading">
        {t('patrolLoading')}
      </p>
    );
  } else if (shiftState.status === 'error') {
    content = (
      <p role="alert" className="rounded-xl border border-ee-danger/50 bg-ee-danger/10 p-4 text-ee-danger" data-testid="patrol-shift-error">
        {shiftState.message}
      </p>
    );
  } else if (shiftState.status === 'none') {
    content = <NoShift hasSite={auth.activeSite !== null || auth.sites.length > 0} />;
  } else {
    const shift = shiftState.shift;
    const site = auth.sites.find((s) => s.id === shift.siteId) ?? (auth.activeSite?.id === shift.siteId ? auth.activeSite : null);
    content = (
      <ActivePatrol
        key={shift.shiftId}
        userId={userId}
        shift={shift}
        site={site}
        activeSiteId={auth.activeSite?.id ?? null}
        onShiftMissing={refreshShift}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg space-y-4 pb-6" data-testid="patrol-page">
      {content}
    </div>
  );
}

function NoShift({ hasSite }: { hasSite: boolean }) {
  const { t } = useTranslation();
  if (!hasSite) {
    return (
      <p role="alert" className="rounded-xl border border-ee-warning/50 bg-ee-warning/10 p-4 text-ee-warning" data-testid="patrol-no-site">
        {t('patrolNoSite')}
      </p>
    );
  }
  return (
    <section className="space-y-4 rounded-xl border border-ee-border bg-ee-surface p-5 text-center" data-testid="patrol-no-shift">
      <ClipboardList className="mx-auto h-10 w-10 text-ee-muted" aria-hidden="true" />
      <h1 className="font-display text-2xl font-semibold text-ee-text">{t('patrolNoShiftTitle')}</h1>
      <p className="text-ee-muted">{t('patrolNoShiftBody')}</p>
      <Link
        href="/guard"
        data-testid="patrol-go-home"
        className="flex min-h-14 w-full items-center justify-center rounded-xl bg-ee-primary px-4 font-display text-lg font-bold text-ee-on-primary no-underline hover:bg-ee-primary-strong"
      >
        {t('patrolGoHome')}
      </Link>
    </section>
  );
}

interface ActivePatrolProps {
  userId: string;
  shift: ActiveShiftRecord;
  /** The shift's site as the guard may see it; null when it is no longer in the guard's list. */
  site: Site | null;
  activeSiteId: string | null;
  onShiftMissing: () => Promise<unknown>;
}

function ActivePatrol({ userId, shift, site, activeSiteId, onShiftMissing }: ActivePatrolProps) {
  const { t } = useTranslation();
  const { state: checkpointsState, reload: reloadCheckpoints } = useSiteCheckpoints(shift.siteId);
  const { scans, loaded: scansLoaded, error: scansError, refresh: refreshScans } = useShiftScans(userId, shift.shiftId);
  // Warm GPS for the whole time the patrol screen is open during the shift: scans get an
  // instant, fresh fix instead of cold-starting GNSS at every checkpoint.
  const watch = useLocationWatch(true);
  const now = useClock(15000);

  const checkpointList = checkpointsState.status === 'ready' ? checkpointsState.result.checkpoints : null;
  const activeCheckpoints = useMemo(() => (checkpointList ? patrolCheckpoints(checkpointList) : []), [checkpointList]);
  const checkpointIds = useMemo(() => activeCheckpoints.map((cp) => cp.id), [activeCheckpoints]);
  const checkpointNames = useMemo(
    () => new Map((checkpointList ?? []).map((cp) => [cp.id, cp.name] as const)),
    [checkpointList]
  );
  const alarmScans = useMemo(() => scans.map((scan) => ({ checkpointId: scan.checkpointId, timestampMs: scan.atMs })), [scans]);

  const scheduledStartMs = Date.parse(shift.scheduledStart);
  const scheduledEndMs = Date.parse(shift.scheduledEnd);
  const scheduleKnown = Number.isFinite(scheduledStartMs) && Number.isFinite(scheduledEndMs);

  const { alarm, acknowledge, configError, screenAwake } = usePatrolAlarm({
    enabled: site !== null && scheduleKnown && activeCheckpoints.length > 0,
    keepScreenAwake: true,
    scheduledStartMs: scheduleKnown ? scheduledStartMs : null,
    scheduledEndMs: scheduleKnown ? scheduledEndMs : null,
    roundIntervalMinutes: site?.roundIntervalMinutes ?? 0,
    checkpointIds,
    scans: alarmScans
  });

  const onRecorded = useCallback(() => void refreshScans(), [refreshScans]);
  const onMissing = useCallback(() => void onShiftMissing(), [onShiftMissing]);
  const { outcome, outcomeSeq, processScan } = usePatrolScanner({
    userId,
    checkpointsSiteId: checkpointsState.status === 'ready' ? shift.siteId : null,
    checkpoints: checkpointList,
    allowLegacyQr: site?.allowLegacyQr ?? false,
    scans,
    onRecorded,
    onShiftMissing: onMissing
  });

  const nfc = useNfcPatrol((reading) => {
    // Identify by the normalised serial; send exactly what the browser reported.
    void processScan('nfc', reading.serial, reading.serialRaw);
  });

  const [qrOpen, setQrOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Browsers only play sound after a tap: unlock the alarm audio on the first one.
  useEffect(() => {
    const unlock = () => unlockAudioContext();
    document.addEventListener('pointerdown', unlock, { once: true });
    return () => document.removeEventListener('pointerdown', unlock);
  }, []);

  const closeQr = useCallback(() => setQrOpen(false), []);
  const onQrText = useCallback(
    (text: string) => {
      void processScan('qr', text);
    },
    [processScan]
  );

  const openQr = () => {
    unlockAudioContext();
    setQrOpen(true);
  };
  const startNfc = () => {
    unlockAudioContext();
    nfc.start(); // synchronously inside the tap: Web NFC needs the user gesture
  };
  const soundTest = () => {
    unlockAudioContext();
    triggerAlarmBeep(false, true);
  };
  const retryUpload = async () => {
    if (!syncEngine) return;
    setRetrying(true);
    try {
      await syncEngine.retryFailed(userId);
      await syncEngine.triggerSync({ force: true });
    } catch {
      // The item keeps its failed state and error; the list below shows it.
    } finally {
      setRetrying(false);
      void refreshScans();
    }
  };

  const progress = useMemo(() => {
    if (now === null || !site || !scheduleKnown || checkpointsState.status !== 'ready') return null;
    return computeRoundProgress({
      scheduledStartMs,
      scheduledEndMs,
      roundIntervalMinutes: site.roundIntervalMinutes,
      checkpoints: activeCheckpoints,
      scans,
      nowMs: now
    });
  }, [now, site, scheduleKnown, checkpointsState.status, scheduledStartMs, scheduledEndMs, activeCheckpoints, scans]);

  const checkpointsEmpty = checkpointsState.status === 'ready' && activeCheckpoints.length === 0;
  const canScan = checkpointsState.status === 'ready' && activeCheckpoints.length > 0;

  return (
    <>
      <PatrolAlarmBanner alarm={alarm} onAcknowledge={acknowledge} configError={configError} checkpointNames={checkpointNames} />

      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ee-text">{t('patrolHeading')}</h1>
        {site && (
          <p className="flex items-center gap-1.5 text-sm text-ee-muted" data-testid="patrol-site-name">
            <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{site.name}</span>
          </p>
        )}
        {site && activeSiteId !== null && activeSiteId !== shift.siteId && (
          <p className="text-sm text-ee-warning" data-testid="patrol-shift-other-site">
            {t('patrolShiftOtherSite', site.name)}
          </p>
        )}
      </header>

      {!site && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-ee-warning/50 bg-ee-warning/10 p-3 text-sm text-ee-warning" data-testid="patrol-site-unknown">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('patrolSiteUnknown')}</span>
        </p>
      )}

      {checkpointsEmpty && (
        <p role="status" className="rounded-xl border border-ee-warning/50 bg-ee-warning/10 p-3 text-sm text-ee-warning" data-testid="patrol-checkpoints-empty">
          {t('patrolCpEmpty')}
        </p>
      )}

      <PatrolScanControls canScan={canScan} onOpenQr={openQr} onStartNfc={startNfc} nfc={nfc} />

      <ScanResultPanel
        outcome={outcome}
        outcomeSeq={outcomeSeq}
        scans={scans}
        onRetryUpload={() => void retryUpload()}
        retrying={retrying}
      />

      <PatrolStatusStrip
        watch={watch}
        screenAwake={screenAwake}
        checkpoints={checkpointsState}
        now={now}
        onRetryCheckpoints={reloadCheckpoints}
        onSoundTest={soundTest}
      />

      <RoundProgressList progress={progress} />

      <RecentScansList scans={scans} checkpointNames={checkpointNames} loaded={scansLoaded} error={scansError} />

      <QrScannerModal isOpen={qrOpen} onClose={closeQr} onScanSuccess={onQrText} />
    </>
  );
}
