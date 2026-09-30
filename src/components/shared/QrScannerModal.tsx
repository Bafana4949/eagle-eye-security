'use client';

/**
 * Full-screen QR scanner (live camera via html5-qrcode, with a "Scan from photo" fallback).
 *
 * - The camera starts once per opening and is NOT restarted when the parent re-renders: the
 *   callbacks are read from refs and the camera effect depends only on the scanner mode.
 * - The camera is stopped when a code is found, when the dialog closes and on unmount. Effect
 *   cleanup never calls onClose.
 * - "Scan from photo" stops the live camera (so the phone's camera app can use it) and decodes
 *   the photo with a separate decoder instance, trying several sizes like the reference app.
 * - It returns exactly the decoded text; the caller decides what the text means.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { Camera, Flashlight, FlashlightOff, ImageUp, Loader2, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';

export interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (decodedText: string) => void;
  title?: string;
  instructionText?: string;
}

type CameraProblem = 'denied' | 'missing' | 'busy' | 'insecure' | 'failed';
type CameraState = { status: 'starting' } | { status: 'running' } | { status: 'error'; problem: CameraProblem };
type PhotoState = 'idle' | 'decoding' | 'no_code' | 'failed';

/** Longest edge sizes tried when decoding a photo (reference app: 1200, 800, 1800 px). */
const PHOTO_DECODE_EDGES = [1200, 800, 1800];
const QR_ONLY = { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], useBarCodeDetectorIfSupported: true };

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const name = 'name' in error ? String((error as { name: unknown }).name) : '';
    const message = 'message' in error ? String((error as { message: unknown }).message) : '';
    return `${name} ${message}`;
  }
  return String(error);
}

function classifyCameraError(error: unknown): CameraProblem {
  const text = errorText(error);
  if (/NotAllowedError|PermissionDenied|Permission denied|SecurityError/i.test(text)) return 'denied';
  if (/NotFoundError|DevicesNotFound|OverconstrainedError|not found/i.test(text)) return 'missing';
  if (/NotReadableError|TrackStartError|Could not start video/i.test(text)) return 'busy';
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  return 'failed';
}

/** Copies of the photo scaled to the decode sizes (the original when it is already small). */
async function scaledCopies(file: File): Promise<File[]> {
  if (typeof createImageBitmap !== 'function') return [file];
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return [file];
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const copies: File[] = [];
    for (const edge of PHOTO_DECODE_EDGES) {
      if (edge >= longest) {
        if (!copies.includes(file)) copies.push(file);
        continue;
      }
      const scale = edge / longest;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (blob) copies.push(new File([blob], `qr-${edge}.jpg`, { type: 'image/jpeg' }));
    }
    return copies.length > 0 ? copies : [file];
  } finally {
    bitmap.close();
  }
}

/** Decoded QR text of a photo, or null when no QR code was found. */
async function decodeQrFromImageFile(file: File, elementId: string): Promise<string | null> {
  const decoder = new Html5Qrcode(elementId, QR_ONLY);
  try {
    for (const candidate of await scaledCopies(file)) {
      try {
        return await decoder.scanFile(candidate, false);
      } catch {
        // No code at this size: try the next one.
      }
    }
    return null;
  } finally {
    try {
      decoder.clear();
    } catch {
      // nothing to clear
    }
  }
}

export function QrScannerModal(props: QrScannerModalProps) {
  if (!props.isOpen) return null;
  // Mounted only while open: every opening starts with fresh state and one camera session.
  return <QrScannerDialog {...props} />;
}

function QrScannerDialog({ onClose, onScanSuccess, title, instructionText }: QrScannerModalProps) {
  const { t } = useTranslation();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const readerId = `ee-qr-reader-${uid}`;
  const decoderId = `ee-qr-file-${uid}`;
  const titleId = `ee-qr-title-${uid}`;

  const onCloseRef = useRef(onClose);
  const onScanRef = useRef(onScanSuccess);
  useEffect(() => {
    onCloseRef.current = onClose;
    onScanRef.current = onScanSuccess;
  });

  const [mode, setMode] = useState<'live' | 'photo'>('live');
  const [liveAttempt, setLiveAttempt] = useState(0);
  const [camera, setCamera] = useState<CameraState>({ status: 'starting' });
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const [photo, setPhoto] = useState<PhotoState>('idle');

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const deliveredRef = useRef(false);

  /** Hands one decoded text to the caller and closes (the camera stops on unmount). */
  const deliver = useCallback((text: string) => {
    if (deliveredRef.current) return;
    deliveredRef.current = true;
    onScanRef.current(text);
    onCloseRef.current();
  }, []);

  // Live camera: one session per (mode, attempt); cleanup always stops it.
  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;
    let scanner: Html5Qrcode | null = null;
    let starting: Promise<unknown> | null = null;

    // Short delay: a mount/unmount in the same tick (React dev double effects) never opens the camera.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setCamera({ status: 'error', problem: window.isSecureContext === false ? 'insecure' : 'missing' });
        return;
      }
      try {
        scanner = new Html5Qrcode(readerId, QR_ONLY);
      } catch {
        setCamera({ status: 'error', problem: 'failed' });
        return;
      }
      const active = scanner;
      scannerRef.current = active;
      starting = active
        .start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: (width: number, height: number) => {
              const size = Math.max(120, Math.floor(Math.min(width, height) * 0.7));
              return { width: size, height: size };
            },
            aspectRatio: 1
          },
          (decodedText) => {
            if (!cancelled) deliver(decodedText);
          },
          () => undefined
        )
        .then(() => {
          if (cancelled) return;
          setCamera({ status: 'running' });
          try {
            const feature = active.getRunningTrackCameraCapabilities().torchFeature();
            setTorch({ supported: feature.isSupported(), on: false });
          } catch {
            setTorch({ supported: false, on: false });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setCamera({ status: 'error', problem: classifyCameraError(error) });
        });
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      const active = scanner;
      if (!active) return;
      if (scannerRef.current === active) scannerRef.current = null;
      const stopCamera = async () => {
        try {
          if (active.isScanning) await active.stop();
        } catch {
          // already stopped
        }
        try {
          active.clear();
        } catch {
          // nothing to clear
        }
      };
      // If the camera is still starting, stop it as soon as the start settles.
      void (starting ?? Promise.resolve()).catch(() => undefined).then(stopCamera);
    };
  }, [mode, liveAttempt, readerId, deliver]);

  // Focus into the dialog, keep it there, Escape closes, focus returns afterwards.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  const toggleTorch = async () => {
    const active = scannerRef.current;
    if (!active) return;
    try {
      const feature = active.getRunningTrackCameraCapabilities().torchFeature();
      await feature.apply(!torch.on);
      setTorch({ supported: true, on: !torch.on });
    } catch {
      setTorch({ supported: false, on: false });
    }
  };

  const openPhotoPicker = () => {
    // The file picker must open inside the tap; switching mode stops the live camera so the
    // phone's camera app can use it.
    fileInputRef.current?.click();
    setPhoto('idle');
    setTorch({ supported: false, on: false });
    setMode('photo');
  };

  const switchToLiveCamera = () => {
    setPhoto('idle');
    setCamera({ status: 'starting' });
    setMode('live');
    setLiveAttempt((n) => n + 1);
  };

  const onFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // the same photo can be chosen again
    if (!file) return;
    setPhoto('decoding');
    let text: string | null;
    try {
      text = await decodeQrFromImageFile(file, decoderId);
    } catch {
      setPhoto('failed');
      return;
    }
    if (text !== null) deliver(text);
    else setPhoto('no_code');
  };

  const cameraProblemText: Record<CameraProblem, string> = {
    denied: t('patrolQrCamDenied'),
    missing: t('patrolQrCamMissing'),
    busy: t('patrolQrCamBusy'),
    insecure: t('patrolQrCamInsecure'),
    failed: t('patrolQrCamFailed')
  };
  const cameraFailed = mode === 'live' && camera.status === 'error';
  const actionButton =
    'flex min-h-14 w-full items-center justify-center gap-2 rounded-xl px-4 font-display text-lg font-semibold disabled:opacity-50';
  const primaryAction = `${actionButton} bg-ee-primary text-ee-on-primary hover:bg-ee-primary-strong`;
  const secondaryAction = `${actionButton} border border-ee-border bg-ee-bg text-ee-text hover:bg-ee-surface-raised`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex flex-col bg-ee-bg"
      data-testid="patrol-qr-dialog"
      data-mode={mode}
    >
      <div className="flex items-center justify-between gap-2 border-b border-ee-border bg-ee-surface px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <h2 id={titleId} className="min-w-0 font-display text-xl font-semibold text-ee-text">
          {title || t('patrolQrTitle')}
        </h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={() => onCloseRef.current()}
          aria-label={t('patrolQrClose')}
          data-testid="patrol-qr-close"
          className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-full text-ee-text hover:bg-ee-surface-raised"
        >
          <X className="h-6 w-6" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-4">
        {mode === 'live' ? (
          <>
            <div
              id={readerId}
              data-testid="patrol-qr-reader"
              className={`aspect-square w-full max-w-sm overflow-hidden rounded-xl border-2 border-ee-primary bg-ee-surface ${
                cameraFailed ? 'hidden' : ''
              }`}
            />
            <p
              aria-live="polite"
              data-testid="patrol-qr-status"
              data-state={camera.status}
              className={`max-w-sm text-center ${cameraFailed ? 'font-semibold text-ee-danger' : 'text-ee-muted'}`}
            >
              {camera.status === 'starting' && (
                <Loader2 className="mr-2 inline h-4 w-4 align-[-2px] motion-safe:animate-spin" aria-hidden="true" />
              )}
              {camera.status === 'error'
                ? cameraProblemText[camera.problem]
                : camera.status === 'starting'
                  ? t('patrolQrStarting')
                  : instructionText || t('patrolQrAim')}
            </p>
          </>
        ) : (
          <div className="w-full max-w-sm space-y-4 text-center">
            <p className="text-ee-muted">{t('patrolQrPhotoHint')}</p>
            <p
              aria-live="polite"
              data-testid="patrol-qr-photo-status"
              data-state={photo}
              className={photo === 'no_code' || photo === 'failed' ? 'font-semibold text-ee-danger' : 'text-ee-muted'}
            >
              {photo === 'decoding' && (
                <>
                  <Loader2 className="mr-2 inline h-4 w-4 align-[-2px] motion-safe:animate-spin" aria-hidden="true" />
                  {t('patrolQrDecoding')}
                </>
              )}
              {photo === 'no_code' && t('patrolQrNoCode')}
              {photo === 'failed' && t('patrolQrPhotoFailed')}
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={photo === 'decoding'}
              className={primaryAction}
              data-testid="patrol-qr-photo-take"
            >
              <Camera className="h-6 w-6 shrink-0" aria-hidden="true" />
              {t('patrolQrPhotoTake')}
            </button>
          </div>
        )}
        {/* Separate element for decoding photos (never shown). */}
        <div id={decoderId} className="hidden" aria-hidden="true" />
      </div>

      <div className="grid gap-2 border-t border-ee-border bg-ee-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {mode === 'live' && camera.status === 'running' && torch.supported && (
          <button
            type="button"
            onClick={() => void toggleTorch()}
            aria-pressed={torch.on}
            className={secondaryAction}
            data-testid="patrol-qr-torch"
          >
            {torch.on ? <FlashlightOff className="h-5 w-5" aria-hidden="true" /> : <Flashlight className="h-5 w-5" aria-hidden="true" />}
            {torch.on ? t('patrolQrTorchOff') : t('patrolQrTorchOn')}
          </button>
        )}
        {mode === 'live' ? (
          <button
            type="button"
            onClick={openPhotoPicker}
            className={cameraFailed ? primaryAction : secondaryAction}
            data-testid="patrol-qr-photo"
          >
            <ImageUp className="h-5 w-5 shrink-0" aria-hidden="true" />
            {t('patrolQrPhoto')}
          </button>
        ) : (
          <button type="button" onClick={switchToLiveCamera} className={secondaryAction} data-testid="patrol-qr-live">
            <Camera className="h-5 w-5 shrink-0" aria-hidden="true" />
            {t('patrolQrLive')}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          tabIndex={-1}
          aria-label={t('patrolQrPhoto')}
          onChange={(event) => void onFileChosen(event)}
          className="hidden"
          data-testid="patrol-qr-photo-input"
        />
      </div>
    </div>
  );
}
