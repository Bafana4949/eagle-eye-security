'use client';

/**
 * Device diagnostics for admins / technicians. Shows only what this browser actually reports:
 * Web NFC (with a live tag read), camera, GPS, PDF417 barcode support, offline storage, service
 * worker, installed mode and connectivity. Nothing is saved to the database; the only server
 * access is a read-only lookup of which checkpoint a tested tag is registered to.
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Camera, Navigation, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { getLocationFix, type LocationFixResult } from '@/lib/gps/location';
import { isNativePdf417Supported } from '@/lib/license-disc/scanner';
import { checkDeviceStorage, offlineDB } from '@/lib/offline/db';
import { releaseScreenWakeLock, requestScreenWakeLock, triggerAlarmBeep, unlockAudioContext } from '@/lib/patrol/alarm';
import type { DeviceStorageStatus } from '@/types/offline';
import type { Site } from '@/types/models';
import { AdminFooter, AdminHeader } from '@/components/admin/AdminHeader';
import { DeviceNfcTest } from '@/components/admin/DeviceNfcTest';
import { loadOrgSites } from '@/components/admin/adminData';
import { withDb } from '@/components/admin/withDb';
import { formatSastDateTime } from '@/components/admin/format';
import { GPS_ACCEPTABLE_ACCURACY_M } from '@/components/admin/validation';
import { Notice } from '@/components/admin/ui';

type Tone = 'success' | 'warning' | 'danger' | 'muted';

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-ee-success',
  warning: 'text-ee-warning',
  danger: 'text-ee-danger-text',
  muted: 'text-ee-muted'
};

function CheckRow({ label, value, tone, testId }: { label: string; value: string; tone: Tone; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <dt className="text-sm text-ee-muted">{label}</dt>
      <dd className={`text-sm font-semibold break-words sm:text-right ${TONE_TEXT[tone]}`} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '?';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type ServiceWorkerInfo = { kind: 'unsupported' } | { kind: 'none' } | { kind: 'registered'; scope: string; state: string; controlling: boolean } | { kind: 'error'; message: string };
type IdbInfo = { kind: 'unsupported' } | { kind: 'ok' } | { kind: 'error'; message: string };

type CameraResult =
  | { kind: 'ok'; label: string; width?: number; height?: number; facing?: string; cameras: number }
  | { kind: 'error'; name: string; message: string }
  | { kind: 'unsupported' };

const CAMERA_ERROR_KEYS: Record<string, TranslationKey> = {
  NotAllowedError: 'devCameraDenied',
  SecurityError: 'devCameraDenied',
  NotFoundError: 'devCameraNotFound',
  OverconstrainedError: 'devCameraNotFound',
  NotReadableError: 'devCameraBusy',
  AbortError: 'devCameraBusy'
};

const GPS_FAILURE_KEYS: Record<string, TranslationKey> = {
  permission_denied: 'admGpsDenied',
  timeout: 'admGpsTimeout',
  unavailable: 'admGpsUnavailable',
  unsupported: 'admGpsUnsupported',
  insecure: 'admGpsInsecure'
};

export default function DeviceTestPage() {
  const { t, language } = useTranslation();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [secure] = useState(() => (typeof window !== 'undefined' ? window.isSecureContext === true : false));
  const [standalone] = useState(() => {
    if (typeof window === 'undefined') return false;
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return iosStandalone || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  });
  const [cameraApi] = useState(() => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function');
  const [sites, setSites] = useState<Site[]>([]);
  const [pdf417, setPdf417] = useState<boolean | null>(null);
  const [sw, setSw] = useState<ServiceWorkerInfo | null>(null);
  const [idb, setIdb] = useState<IdbInfo | null>(null);
  const [storage, setStorage] = useState<DeviceStorageStatus | null>(null);
  const [camera, setCamera] = useState<CameraResult | null>(null);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [gps, setGps] = useState<LocationFixResult | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [toneStarted, setToneStarted] = useState<boolean | null>(null);
  const [wakeLock, setWakeLock] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void isNativePdf417Supported().then((value) => {
      if (!cancelled) setPdf417(value);
    });
    void checkDeviceStorage().then((value) => {
      if (!cancelled) setStorage(value);
    });
    const swPromise: Promise<ServiceWorkerInfo> =
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? navigator.serviceWorker.getRegistration().then(
            (registration): ServiceWorkerInfo =>
              registration
                ? {
                    kind: 'registered',
                    scope: registration.scope,
                    state: registration.active?.state ?? registration.waiting?.state ?? registration.installing?.state ?? 'unknown',
                    controlling: navigator.serviceWorker.controller !== null
                  }
                : { kind: 'none' },
            (error: unknown): ServiceWorkerInfo => ({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          )
        : Promise.resolve({ kind: 'unsupported' });
    void swPromise.then((value) => {
      if (!cancelled) setSw(value);
    });
    const idbPromise: Promise<IdbInfo> =
      typeof indexedDB === 'undefined' || !offlineDB
        ? Promise.resolve({ kind: 'unsupported' })
        : offlineDB.open().then(
            (): IdbInfo => ({ kind: 'ok' }),
            (error: unknown): IdbInfo => ({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          );
    void idbPromise.then((value) => {
      if (!cancelled) setIdb(value);
    });
    void withDb((db) => loadOrgSites(db)).then((result) => {
      if (!cancelled && result.ok) setSites(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const testCamera = async () => {
    if (!cameraApi) {
      setCamera({ kind: 'unsupported' });
      return;
    }
    setCameraBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      stream.getTracks().forEach((tr) => tr.stop());
      let cameras = 0;
      try {
        cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
      } catch {
        cameras = 0;
      }
      setCamera({ kind: 'ok', label: track?.label ?? '', width: settings.width, height: settings.height, facing: settings.facingMode, cameras });
    } catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : 'Error';
      setCamera({ kind: 'error', name, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setCameraBusy(false);
    }
  };

  const testGps = async () => {
    setGpsBusy(true);
    setGps(await getLocationFix({ maxAgeMs: 0, timeoutMs: 20000, highAccuracy: true, coarseRetry: true, watch: null }));
    setGpsBusy(false);
  };

  const playTone = () => {
    unlockAudioContext();
    setToneStarted(triggerAlarmBeep(true, true));
  };

  const toggleWakeLock = async () => {
    if (wakeLock) {
      releaseScreenWakeLock();
      setWakeLock(false);
      return;
    }
    setWakeLock(await requestScreenWakeLock());
  };

  const yesNo = (value: boolean) => (value ? t('devYes') : t('devNo'));

  return (
    <>
      <AdminHeader title={t('devTitle')} />
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-4 pb-16">
        <p className="text-sm text-ee-muted">{t('devIntro')}</p>

        <section aria-labelledby="dev-nfc-heading" className="space-y-2">
          <h2 id="dev-nfc-heading" className="font-display text-2xl font-bold">
            {t('devNfcTitle')}
          </h2>
          <DeviceNfcTest sites={sites} />
        </section>

        <section aria-labelledby="dev-checks-heading">
          <h2 id="dev-checks-heading" className="font-display text-2xl font-bold">
            {t('devChecksTitle')}
          </h2>
          <dl className="divide-y divide-ee-border border-y border-ee-border">
            <CheckRow label={t('devSecure')} value={yesNo(secure)} tone={secure ? 'success' : 'danger'} testId="admin-device-secure" />
            <CheckRow label={t('devOnline')} value={online ? t('devOnlineYes') : t('devOnlineNo')} tone={online ? 'success' : 'warning'} testId="admin-device-online" />
            <CheckRow label={t('devStandalone')} value={standalone ? t('devStandaloneYes') : t('devStandaloneNo')} tone={standalone ? 'success' : 'warning'} testId="admin-device-standalone" />
            <CheckRow
              label={t('devServiceWorker')}
              value={
                !sw
                  ? t('devChecking')
                  : sw.kind === 'registered'
                    ? t('devSwRegistered', sw.state, sw.controlling ? t('devYes') : t('devNo'))
                    : sw.kind === 'none'
                      ? t('devSwNone')
                      : sw.kind === 'unsupported'
                        ? t('devNotSupported')
                        : `${t('devError')}: ${sw.message}`
              }
              tone={!sw ? 'muted' : sw.kind === 'registered' ? 'success' : sw.kind === 'none' ? 'warning' : 'danger'}
              testId="admin-device-service-worker"
            />
            <CheckRow
              label={t('devIndexedDb')}
              value={!idb ? t('devChecking') : idb.kind === 'ok' ? t('devIdbOk') : idb.kind === 'unsupported' ? t('devNotSupported') : `${t('devError')}: ${idb.message}`}
              tone={!idb ? 'muted' : idb.kind === 'ok' ? 'success' : 'danger'}
              testId="admin-device-indexeddb"
            />
            <CheckRow
              label={t('devPersistentStorage')}
              value={!storage ? t('devChecking') : storage.persisted === true ? t('devYes') : storage.persisted === false ? t('devPersistNo') : t('devUnknown')}
              tone={!storage ? 'muted' : storage.persisted === true ? 'success' : 'warning'}
              testId="admin-device-storage-persisted"
            />
            <CheckRow
              label={t('devStorageUse')}
              value={!storage ? t('devChecking') : storage.usageBytes === null && storage.quotaBytes === null ? t('devUnknown') : t('devStorageUseValue', formatBytes(storage.usageBytes), formatBytes(storage.quotaBytes))}
              tone={!storage ? 'muted' : storage.nearlyFull ? 'danger' : 'muted'}
              testId="admin-device-storage-usage"
            />
            <CheckRow
              label={t('devPdf417')}
              value={pdf417 === null ? t('devChecking') : pdf417 ? t('devPdf417Native') : t('devPdf417Software')}
              tone={pdf417 === null ? 'muted' : pdf417 ? 'success' : 'warning'}
              testId="admin-device-pdf417"
            />
            <CheckRow label={t('devCameraApi')} value={yesNo(cameraApi)} tone={cameraApi ? 'success' : 'danger'} testId="admin-device-camera-api" />
          </dl>
        </section>

        <section aria-labelledby="dev-camera-heading" className="space-y-2">
          <h2 id="dev-camera-heading" className="font-display text-2xl font-bold">
            {t('devCameraTitle')}
          </h2>
          <Button type="button" variant="secondary" className="min-h-12 w-full gap-2 sm:w-auto" onClick={() => void testCamera()} disabled={cameraBusy} data-testid="admin-device-camera-test">
            <Camera className="h-4 w-4" aria-hidden />
            <span>{cameraBusy ? t('devTesting') : t('devCameraTest')}</span>
          </Button>
          <div aria-live="polite" data-testid="admin-device-camera-result">
            {camera?.kind === 'ok' && (
              <Notice tone="success" title={t('devCameraOk')}>
                <p>{t('devCameraDetails', camera.label || t('devUnknown'), camera.width && camera.height ? `${camera.width}×${camera.height}` : t('devUnknown'), camera.facing ?? t('devUnknown'), camera.cameras)}</p>
              </Notice>
            )}
            {camera?.kind === 'error' && (
              <Notice tone="danger" title={t(CAMERA_ERROR_KEYS[camera.name] ?? 'devCameraFailed')}>
                <p className="text-xs text-ee-muted break-words">
                  {camera.name}: {camera.message}
                </p>
                <p>{t('devCameraFallback')}</p>
              </Notice>
            )}
            {camera?.kind === 'unsupported' && <Notice tone="danger">{t('devCameraUnsupported')}</Notice>}
          </div>
        </section>

        <section aria-labelledby="dev-gps-heading" className="space-y-2">
          <h2 id="dev-gps-heading" className="font-display text-2xl font-bold">
            {t('devGpsTitle')}
          </h2>
          <Button type="button" variant="secondary" className="min-h-12 w-full gap-2 sm:w-auto" onClick={() => void testGps()} disabled={gpsBusy} data-testid="admin-device-gps-test">
            <Navigation className="h-4 w-4" aria-hidden />
            <span>{gpsBusy ? t('admGpsLocating') : t('devGpsTest')}</span>
          </Button>
          <div aria-live="polite" data-testid="admin-device-gps-result">
            {gps && (gps.status === 'ok' || gps.status === 'stale') && (
              <Notice tone={gps.status === 'stale' ? 'warning' : Number.isFinite(gps.accuracy) && gps.accuracy <= GPS_ACCEPTABLE_ACCURACY_M ? 'success' : 'warning'} title={gps.status === 'stale' ? t('admGpsStale') : t('devGpsFix')}>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                  <dt className="text-ee-muted">{t('admLatitude')}</dt>
                  <dd className="font-mono">{gps.latitude.toFixed(6)}</dd>
                  <dt className="text-ee-muted">{t('admLongitude')}</dt>
                  <dd className="font-mono">{gps.longitude.toFixed(6)}</dd>
                  <dt className="text-ee-muted">{t('devGpsAccuracy')}</dt>
                  <dd data-testid="admin-device-gps-accuracy">{Number.isFinite(gps.accuracy) ? `±${Math.round(gps.accuracy)} m` : t('devUnknown')}</dd>
                  <dt className="text-ee-muted">{t('devGpsAge')}</dt>
                  <dd>{t('devSeconds', Math.round(gps.ageMs / 1000))}</dd>
                  <dt className="text-ee-muted">{t('devGpsTime')}</dt>
                  <dd>{formatSastDateTime(gps.timestamp, language)}</dd>
                  <dt className="text-ee-muted">{t('devGpsSource')}</dt>
                  <dd>{gps.source === 'coarse_retry' ? t('devGpsSourceCoarse') : t('devGpsSourceCurrent')}</dd>
                </dl>
              </Notice>
            )}
            {gps && gps.status !== 'ok' && gps.status !== 'stale' && (
              <Notice tone="danger" title={t(GPS_FAILURE_KEYS[gps.status] ?? 'admGpsUnavailable')}>
                {gps.message && (
                  <p className="text-xs text-ee-muted break-words">
                    {gps.status}: {gps.message}
                  </p>
                )}
              </Notice>
            )}
          </div>
        </section>

        <section aria-labelledby="dev-alarm-heading" className="space-y-2">
          <h2 id="dev-alarm-heading" className="font-display text-2xl font-bold">
            {t('devAlarmTitle')}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" className="min-h-12 gap-2" onClick={playTone} data-testid="admin-device-tone-test">
              <Volume2 className="h-4 w-4" aria-hidden />
              <span>{toneStarted === null ? t('devToneTest') : t('devToneAgain')}</span>
            </Button>
            <Button type="button" variant={wakeLock ? 'primary' : 'secondary'} className="min-h-12" onClick={() => void toggleWakeLock()} aria-pressed={wakeLock === true} data-testid="admin-device-wakelock-test">
              {wakeLock ? t('devWakeLockRelease') : t('devWakeLockTest')}
            </Button>
          </div>
          <div aria-live="polite" className="space-y-2">
            {toneStarted !== null && <Notice tone="info" testId="admin-device-tone-result">{t('devToneStarted')}</Notice>}
            {wakeLock !== null && (
              <Notice tone={wakeLock ? 'success' : 'warning'} testId="admin-device-wakelock-result">
                {wakeLock ? t('devWakeLockHeld') : t('devWakeLockNotHeld')}
              </Notice>
            )}
          </div>
        </section>

        <AdminFooter page="device-test" />
      </main>
    </>
  );
}
