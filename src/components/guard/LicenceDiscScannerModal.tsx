'use client';

/**
 * South African licence-disc (PDF417) scanner.
 *
 * - The camera starts once when the dialog opens and stops (all tracks) when it closes or
 *   unmounts. Parent re-renders never restart it: callbacks are read through refs and the
 *   camera effect only depends on this dialog's own "camera on / retry" state.
 * - ~1920x1080 environment camera (reference app), torch toggle when the track supports it,
 *   low-light hint from a tiny brightness probe.
 * - Decode loop every ~350 ms, never re-entrant (the next frame is scheduled only after the
 *   previous decode finished), using the foundation scanner (BarcodeDetector 'pdf417' →
 *   ZXing PDF_417-only fallback).
 * - Only barcodes the licence-disc parser accepts are returned; anything else shows
 *   "That is not a licence disc barcode" and scanning continues.
 * - "Scan from photo" (multi-scale decode) and "Type the number" are always available,
 *   including when the camera is blocked, missing or unsupported.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, Flashlight, FlashlightOff, ImageUp, Keyboard, RefreshCw, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { LicenseDiscData } from '@/types/models';
import { decodePdf417FromImageFile, scanPdf417 } from '@/lib/license-disc/scanner';
import { parseSouthAfricanLicenseDisc } from '@/lib/license-disc/parser';
import { useDialogFocus } from '@/components/guard/gate/useDialogFocus';

export interface LicenceDiscScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once with a disc the licence-disc parser accepted. The parent closes the dialog. */
  onDiscRead: (disc: LicenseDiscData) => void;
  /** "Type the number": the parent closes the dialog and focuses the registration field. */
  onManualEntry: () => void;
}

type CameraErrorReason = 'denied' | 'no_camera' | 'unsupported' | 'failed';

type CameraState =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  /** Camera switched off on purpose (e.g. so the phone's camera app can take a photo). */
  | { kind: 'paused' }
  | { kind: 'error'; reason: CameraErrorReason };

type ScanMessage = 'not_disc' | 'no_barcode' | 'photo_failed' | 'torch_failed';

const SCAN_INTERVAL_MS = 350;
/** Frames are scaled to this long edge before decoding (reference app). */
const FRAME_MAX_EDGE = 1400;
/** Average luminance (0–255) below which a frame counts as dark. */
const LOW_LIGHT_LUMA = 45;
const LOW_LIGHT_SAMPLES = 3;
const BRIGHTNESS_EVERY_N_FRAMES = 5;
const NOT_DISC_BUZZ_GAP_MS = 2000;

const CAMERA_ERROR_KEYS: Record<CameraErrorReason, TranslationKey> = {
  denied: 'gateScanDenied',
  no_camera: 'gateScanNoCamera',
  unsupported: 'gateScanUnsupported',
  failed: 'gateScanCameraFailed'
};

const MESSAGE_KEYS: Record<ScanMessage, TranslationKey> = {
  not_disc: 'gateDiscNotDisc',
  no_barcode: 'gateScanNoBarcode',
  photo_failed: 'gateScanPhotoFailed',
  torch_failed: 'gateScanTorchFailed'
};

function canUseLiveCamera(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return window.isSecureContext !== false && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

function cameraErrorReason(error: unknown): CameraErrorReason {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name?: unknown }).name)
    : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'no_camera';
  if (name === 'TypeError') return 'unsupported';
  return 'failed';
}

function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
  } catch {
    // Vibration is a courtesy only.
  }
}

function averageLuma(data: Uint8ClampedArray): number {
  let total = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) total += (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
  return pixels > 0 ? total / pixels : 255;
}

export function LicenceDiscScannerModal(props: LicenceDiscScannerModalProps) {
  if (!props.isOpen) return null;
  return <ScannerDialog {...props} />;
}

function ScannerDialog({ onClose, onDiscRead, onManualEntry }: LicenceDiscScannerModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();

  const [liveSupported] = useState(canUseLiveCamera);
  const [camera, setCamera] = useState<CameraState>(() =>
    liveSupported ? { kind: 'starting' } : { kind: 'error', reason: 'unsupported' }
  );
  /** false after the guard switched to "Scan from photo" (the live stream is released). */
  const [cameraWanted, setCameraWanted] = useState(true);
  /** Bumped by "Try camera again" to start the camera deliberately once more. */
  const [cameraRun, setCameraRun] = useState(0);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [lowLight, setLowLight] = useState(false);
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);
  const lastNotDiscBuzzRef = useRef(0);
  const onDiscReadRef = useRef(onDiscRead);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onDiscReadRef.current = onDiscRead;
    onCloseRef.current = onClose;
  });

  useDialogFocus(dialogRef, true, () => onCloseRef.current());

  /**
   * Accepts a decoded barcode only when the licence-disc parser recognises it and it carries a
   * registration number. Returns true when the disc was handed to the parent.
   */
  const acceptBarcodeRef = useRef<(text: string) => boolean>(() => false);
  useEffect(() => {
    acceptBarcodeRef.current = (text: string) => {
      if (doneRef.current) return true;
      const disc = parseSouthAfricanLicenseDisc(text);
      if (!disc || !disc.plate) {
        setMessage('not_disc');
        const now = Date.now();
        if (now - lastNotDiscBuzzRef.current > NOT_DISC_BUZZ_GAP_MS) {
          lastNotDiscBuzzRef.current = now;
          vibrate([90, 60, 90]);
        }
        return false;
      }
      doneRef.current = true;
      vibrate(250);
      onDiscReadRef.current(disc);
      return true;
    };
  });

  // Camera lifecycle: one getUserMedia per (open, "try again"); stopped on close/unmount.
  useEffect(() => {
    if (!liveSupported || !cameraWanted) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const frameCanvas = document.createElement('canvas');
    const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = 32;
    probeCanvas.height = 18;
    const probeContext = probeCanvas.getContext('2d', { willReadFrequently: true });
    let frameCount = 0;
    let darkFrames = 0;

    const stopCamera = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
      stream = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };

    const scheduleNext = () => {
      if (!cancelled && !doneRef.current) timer = setTimeout(() => void scanFrame(), SCAN_INTERVAL_MS);
    };

    const scanFrame = async () => {
      timer = null;
      if (cancelled || doneRef.current) return;
      const video = videoRef.current;
      if (video && video.videoWidth > 0 && video.videoHeight > 0 && frameContext) {
        const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
        frameCanvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
        frameCanvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
        frameContext.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);

        frameCount += 1;
        if (probeContext && frameCount % BRIGHTNESS_EVERY_N_FRAMES === 0) {
          try {
            probeContext.drawImage(video, 0, 0, probeCanvas.width, probeCanvas.height);
            const luma = averageLuma(probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data);
            darkFrames = luma < LOW_LIGHT_LUMA ? darkFrames + 1 : 0;
            setLowLight(darkFrames >= LOW_LIGHT_SAMPLES);
          } catch {
            // Brightness is only a hint.
          }
        }

        let text: string | null = null;
        try {
          text = await scanPdf417(video, frameCanvas);
        } catch {
          text = null;
        }
        if (cancelled) return;
        if (text && acceptBarcodeRef.current(text)) {
          stopCamera();
          return;
        }
      }
      scheduleNext();
    };

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
      } catch (error) {
        if (!cancelled) setCamera({ kind: 'error', reason: cameraErrorReason(error) });
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          // Autoplay of a muted inline stream can still reject on some WebViews; frames may still arrive.
        }
      }
      if (cancelled) {
        stopCamera();
        return;
      }
      let hasTorch = false;
      try {
        const track = stream.getVideoTracks()[0];
        const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        hasTorch = capabilities.torch === true;
      } catch {
        hasTorch = false;
      }
      setTorchSupported(hasTorch);
      setTorchOn(false);
      setCamera({ kind: 'scanning' });
      scheduleNext();
    };

    void start();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [liveSupported, cameraWanted, cameraRun]);

  const releaseCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraWanted(false);
    setTorchOn(false);
    setLowLight(false);
    if (liveSupported) setCamera({ kind: 'paused' });
  };

  const retryCamera = () => {
    setMessage(null);
    setCamera({ kind: 'starting' });
    setCameraWanted(true);
    setCameraRun((run) => run + 1);
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as unknown as MediaTrackConstraintSet] });
      setTorchOn(next);
      setMessage((current) => (current === 'torch_failed' ? null : current));
    } catch {
      setMessage('torch_failed');
    }
  };

  const chooseFromPhoto = () => {
    // Release the live camera first: on many Android phones the camera app cannot open while
    // this page still holds the camera (reference app does the same).
    releaseCamera();
    fileInputRef.current?.click();
  };

  const onPhotoChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPhotoBusy(true);
    setMessage(null);
    try {
      const text = await decodePdf417FromImageFile(file);
      if (!text) {
        setMessage('no_barcode');
        vibrate([90, 60, 90]);
      } else {
        acceptBarcodeRef.current(text);
      }
    } catch {
      setMessage('photo_failed');
    } finally {
      setPhotoBusy(false);
    }
  };

  const cameraActive = camera.kind === 'starting' || camera.kind === 'scanning';
  const statusKey: TranslationKey | null = photoBusy
    ? 'gateScanReadingPhoto'
    : camera.kind === 'starting'
      ? 'gateScanStarting'
      : camera.kind === 'scanning'
        ? 'gateScanScanning'
        : camera.kind === 'paused'
          ? 'gateScanPaused'
          : null;
  const canRetryCamera =
    liveSupported && (camera.kind === 'paused' || (camera.kind === 'error' && camera.reason !== 'unsupported'));

  const secondaryButton =
    'flex min-h-14 w-full items-center justify-center gap-2 rounded-lg border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised active:bg-ee-surface-raised disabled:opacity-50';

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      data-testid="gate-scanner"
      className="fixed inset-0 z-50 flex flex-col bg-ee-bg text-ee-text focus:outline-none"
    >
      <header className="flex items-center justify-between gap-3 border-b border-ee-border bg-ee-surface px-4 py-2">
        <h2 id={titleId} className="font-display text-xl font-bold uppercase tracking-wide">
          {t('gateScanTitle')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('gateScanClose')}
          data-testid="gate-scanner-close"
          className="grid min-h-12 min-w-12 place-items-center rounded-lg text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text"
        >
          <X className="h-6 w-6" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-md">
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-ee-border bg-ee-surface">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-hidden="true"
              className={`h-full w-full object-cover ${cameraActive ? '' : 'invisible'}`}
            />
            {cameraActive ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-[8%] top-1/2 h-[38%] -translate-y-1/2 rounded-md border-2 border-ee-primary"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center p-4 text-center text-ee-muted" aria-hidden="true">
                <Camera className="h-10 w-10" />
              </div>
            )}
          </div>

          <p id={descriptionId} className="mt-3 text-base font-semibold">
            {t('gateScanAim')}
          </p>
          <p className="mt-1 text-sm text-ee-muted">{t('gateScanHint')}</p>

          <p role="status" aria-live="polite" data-testid="gate-scanner-status" className="mt-3 min-h-6 text-sm text-ee-muted">
            {statusKey ? t(statusKey) : ''}
          </p>

          {lowLight && camera.kind === 'scanning' && (
            <p data-testid="gate-scanner-lowlight" className="mt-2 rounded-lg border border-ee-warning/40 bg-ee-warning/10 px-3 py-2 text-sm text-ee-warning">
              {t('gateScanLowLight')}
            </p>
          )}

          {camera.kind === 'error' && (
            <p role="alert" data-testid="gate-scanner-error" className="mt-2 rounded-lg border border-ee-danger/40 bg-ee-danger/10 px-3 py-2 text-sm text-ee-danger">
              {t(CAMERA_ERROR_KEYS[camera.reason])}
            </p>
          )}

          {message && (
            <p role="alert" data-testid="gate-scanner-message" className="mt-2 rounded-lg border border-ee-danger/40 bg-ee-danger/10 px-3 py-2 text-sm text-ee-danger">
              {t(MESSAGE_KEYS[message])}
            </p>
          )}
        </div>
      </div>

      <footer className="border-t border-ee-border bg-ee-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto grid w-full max-w-md gap-2">
          {torchSupported && camera.kind === 'scanning' && (
            <button
              type="button"
              onClick={() => void toggleTorch()}
              aria-pressed={torchOn}
              data-testid="gate-scanner-torch"
              className={
                torchOn
                  ? 'flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-ee-primary px-4 text-base font-bold text-ee-on-primary'
                  : secondaryButton
              }
            >
              {torchOn ? <FlashlightOff className="h-5 w-5" aria-hidden="true" /> : <Flashlight className="h-5 w-5" aria-hidden="true" />}
              <span>{torchOn ? t('gateScanTorchOff') : t('gateScanTorchOn')}</span>
            </button>
          )}
          {canRetryCamera && (
            <button type="button" onClick={retryCamera} data-testid="gate-scanner-retry-camera" className={secondaryButton}>
              <RefreshCw className="h-5 w-5" aria-hidden="true" />
              <span>{t('gateScanRetryCamera')}</span>
            </button>
          )}
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            <button
              type="button"
              onClick={chooseFromPhoto}
              disabled={photoBusy}
              data-testid="gate-scanner-photo"
              className={secondaryButton}
            >
              <ImageUp className="h-5 w-5" aria-hidden="true" />
              <span>{t('gateScanFromPhoto')}</span>
            </button>
            <button type="button" onClick={onManualEntry} data-testid="gate-scanner-manual" className={secondaryButton}>
              <Keyboard className="h-5 w-5" aria-hidden="true" />
              <span>{t('gateScanManual')}</span>
            </button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(event) => void onPhotoChosen(event)}
          data-testid="gate-scanner-file"
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
      </footer>
    </div>
  );
}
