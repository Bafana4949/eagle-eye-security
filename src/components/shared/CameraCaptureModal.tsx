'use client';

/**
 * Camera capture dialog (clock-in/out selfies and evidence photos).
 *
 * - Live preview with getUserMedia({ video: { facingMode } }); a frame is drawn to a canvas and
 *   compressed with the foundation helpers (selfie → compressSelfie, otherwise
 *   compressEvidencePhoto), so sizes follow src/lib/config/media.ts.
 * - Every camera track is stopped when a photo is taken, on confirm, on close, when the page is
 *   hidden and on unmount. A camera that answers after the dialog closed is stopped at once.
 * - When the live camera cannot be used (permission blocked, no camera, busy, no https, old
 *   browser) the dialog says why and offers the phone's own camera through
 *   <input type="file" accept="image/*" capture="user|environment">.
 * - onCapture(blob, dataUrl) receives the compressed JPEG. The dialog does NOT call onClose
 *   after onCapture: the parent closes it (it knows whether the capture continues a flow).
 *   The in-dialog preview uses an object URL that is revoked on retake and unmount.
 * No face detection or recognition is performed.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, Check, ImageUp, Loader2, RefreshCw, X } from 'lucide-react';
import { compressEvidencePhoto, compressSelfie } from '@/lib/utils/media';
import { useTranslation } from '@/lib/i18n/context';

export interface CameraCaptureModalProps {
  isOpen: boolean;
  /** Cancel / close without a photo. */
  onClose: () => void;
  /** Compressed JPEG and its data: URL (for a preview in the parent). */
  onCapture: (compressedBlob: Blob, dataUrl: string) => void;
  /** 'user' = front camera (selfie), 'environment' = back camera. */
  facingMode?: 'user' | 'environment';
  title?: string;
  /** Selfie sizing (compressSelfie); otherwise evidence sizing (compressEvidencePhoto). */
  isSelfie?: boolean;
  /** Prefix for data-testid attributes (default "camera"). */
  testIdPrefix?: string;
}

type CameraProblem = 'permission_denied' | 'no_camera' | 'in_use' | 'insecure' | 'unsupported' | 'failed';
type Notice = 'compress_failed' | 'capture_failed';

interface PreviewPhoto {
  blob: Blob;
  dataUrl: string;
  objectUrl: string;
  /** The photo came from the live camera (retake restarts it) or from the phone's camera app. */
  fromLive: boolean;
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'fallback' }
  | { kind: 'processing' }
  | { kind: 'preview'; photo: PreviewPhoto };

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab / Shift+Tab inside a dialog. Call from the dialog's onKeyDown. */
export function trapFocusWithin(event: React.KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0
  );
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const current = document.activeElement;
  if (event.shiftKey && (current === first || current === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus();
  }
}

function classifyCameraError(error: unknown): CameraProblem {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'permission_denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'in_use';
  return 'failed';
}

function liveCameraProblem(): CameraProblem | null {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return 'unsupported';
  return null;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
    } catch {
      resolve(null);
    }
  });
}

export function CameraCaptureModal(props: CameraCaptureModalProps) {
  // Mounted only while open, so every opening starts from a clean state.
  if (!props.isOpen) return null;
  return <CameraCaptureDialog {...props} />;
}

function CameraCaptureDialog({
  onClose,
  onCapture,
  facingMode = 'environment',
  title,
  isSelfie = false,
  testIdPrefix = 'camera'
}: CameraCaptureModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();

  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [videoReady, setVideoReady] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Incremented whenever a pending getUserMedia answer must be discarded. */
  const startSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const pausedByHideRef = useRef(false);

  const stopStream = useCallback(() => {
    startSeqRef.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  const startStream = useCallback(async () => {
    stopStream();
    const seq = startSeqRef.current;
    const unavailable = liveCameraProblem();
    setVideoReady(false);
    if (unavailable) {
      setProblem(unavailable);
      setPhase({ kind: 'fallback' });
      return;
    }
    setPhase({ kind: 'starting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 960 } }
      });
      if (seq !== startSeqRef.current || !mountedRef.current) {
        // The dialog was closed (or the camera restarted) while this request was pending.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setProblem(null);
      setPhase({ kind: 'live' });
    } catch (error) {
      if (seq !== startSeqRef.current || !mountedRef.current) return;
      setProblem(classifyCameraError(error));
      setPhase({ kind: 'fallback' });
    }
  }, [facingMode, stopStream]);

  // Start the camera when the dialog opens; always release it when the dialog goes away.
  useEffect(() => {
    mountedRef.current = true;
    // Started from a timer callback, not synchronously in the effect body.
    const timer = window.setTimeout(() => void startStream(), 0);
    return () => {
      window.clearTimeout(timer);
      mountedRef.current = false;
      stopStream();
    };
  }, [startStream, stopStream]);

  // Attach the live stream to the video element.
  useEffect(() => {
    if (phase.kind !== 'live') return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [phase.kind]);

  // Revoke the preview's object URL when it is replaced or the dialog unmounts.
  useEffect(() => {
    if (phase.kind !== 'preview') return;
    const url = phase.photo.objectUrl;
    return () => URL.revokeObjectURL(url);
  }, [phase]);

  // Release the camera while the app is in the background; restart it on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (streamRef.current) {
          pausedByHideRef.current = true;
          stopStream();
        }
      } else if (pausedByHideRef.current) {
        pausedByHideRef.current = false;
        void startStream();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [startStream, stopStream]);

  // Focus moves into the dialog; the page behind does not scroll; focus returns on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, []);

  const processPhoto = useCallback(
    async (source: Blob, fromLive: boolean) => {
      setPhase({ kind: 'processing' });
      try {
        const result = isSelfie ? await compressSelfie(source) : await compressEvidencePhoto(source);
        if (!mountedRef.current) return;
        const objectUrl = URL.createObjectURL(result.blob);
        setPhase({ kind: 'preview', photo: { blob: result.blob, dataUrl: result.dataUrl, objectUrl, fromLive } });
      } catch {
        if (!mountedRef.current) return;
        setNotice('compress_failed');
        if (fromLive) void startStream();
        else setPhase({ kind: 'fallback' });
      }
    },
    [isSelfie, startStream]
  );

  const handleTakePhoto = async () => {
    const video = videoRef.current;
    if (phase.kind !== 'live' || !video || !video.videoWidth || !video.videoHeight) return;
    setNotice(null);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      setNotice('capture_failed');
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // The frame is in the canvas: the camera is no longer needed.
    stopStream();
    setPhase({ kind: 'processing' });
    const raw = await canvasToJpeg(canvas);
    canvas.width = 0;
    canvas.height = 0;
    if (!mountedRef.current) return;
    if (!raw) {
      setNotice('capture_failed');
      void startStream();
      return;
    }
    await processPhoto(raw, true);
  };

  const openPhoneCamera = () => {
    setNotice(null);
    if (phase.kind === 'live' || phase.kind === 'starting') {
      // The phone's camera app needs the camera: release ours first. If the guard cancels the
      // picker, the fallback screen offers the live camera again.
      stopStream();
      pausedByHideRef.current = false;
      setPhase({ kind: 'fallback' });
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Reset so choosing the same file again still fires a change event.
    event.target.value = '';
    if (!file) return;
    stopStream();
    void processPhoto(file, false);
  };

  const handleRetake = () => {
    if (phase.kind !== 'preview') return;
    setNotice(null);
    if (phase.photo.fromLive && problem === null) {
      void startStream();
    } else {
      setPhase({ kind: 'fallback' });
      fileInputRef.current?.click();
    }
  };

  const handleConfirm = () => {
    if (phase.kind !== 'preview') return;
    stopStream();
    onCapture(phase.photo.blob, phase.photo.dataUrl);
  };

  const handleClose = () => {
    stopStream();
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      handleClose();
      return;
    }
    trapFocusWithin(event, dialogRef.current);
  };

  const heading = title || (isSelfie ? t('guardHome.camera.selfieTitle') : t('guardHome.camera.photoTitle'));
  const hint = isSelfie ? t('guardHome.camera.selfieHint') : t('guardHome.camera.photoHint');

  const problemText: Record<CameraProblem, string> = {
    permission_denied: t('guardHome.camera.problemPermission'),
    no_camera: t('guardHome.camera.problemNoCamera'),
    in_use: t('guardHome.camera.problemInUse'),
    insecure: t('guardHome.camera.problemInsecure'),
    unsupported: t('guardHome.camera.problemUnsupported'),
    failed: t('guardHome.camera.problemFailed')
  };
  const noticeText: Record<Notice, string> = {
    compress_failed: t('guardHome.camera.compressFailed'),
    capture_failed: t('guardHome.camera.captureFailed')
  };

  let liveStatus = '';
  if (phase.kind === 'starting') liveStatus = t('guardHome.camera.starting');
  else if (phase.kind === 'live') liveStatus = videoReady ? t('guardHome.camera.ready') : t('guardHome.camera.starting');
  else if (phase.kind === 'processing') liveStatus = t('guardHome.camera.processing');
  else if (phase.kind === 'preview') liveStatus = t('guardHome.camera.previewReady');
  else if (phase.kind === 'fallback' && problem) liveStatus = problemText[problem];

  const buttonBase =
    'inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50';
  const primaryButton = `${buttonBase} min-h-14 bg-ee-primary text-ee-on-primary text-lg hover:bg-ee-primary-strong`;
  const secondaryButton = `${buttonBase} min-h-12 border border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-[60] flex flex-col bg-ee-bg text-ee-text outline-none"
      data-testid={`${testIdPrefix}-dialog`}
      data-phase={phase.kind}
    >
      <div className="flex items-start justify-between gap-3 border-b border-ee-border px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))]">
        <div className="min-w-0">
          <h2 id={titleId} className="font-display text-2xl font-bold leading-tight">
            {heading}
          </h2>
          <p id={descriptionId} className="mt-0.5 text-sm text-ee-muted">
            {hint}
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('guardHome.camera.close')}
          className="inline-flex min-h-12 min-w-12 flex-none items-center justify-center rounded-xl border border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised"
          data-testid={`${testIdPrefix}-close`}
        >
          <X className="h-6 w-6" aria-hidden="true" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-ee-bg">
        {(phase.kind === 'live' || phase.kind === 'starting') && (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            aria-label={t('guardHome.camera.livePreview')}
            onLoadedMetadata={() => setVideoReady(true)}
            className={`h-full w-full object-cover ${facingMode === 'user' ? '-scale-x-100' : ''}`}
            data-testid={`${testIdPrefix}-video`}
          />
        )}

        {phase.kind === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-ee-muted">
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>{t('guardHome.camera.starting')}</span>
          </div>
        )}

        {phase.kind === 'processing' && (
          <div className="flex h-full items-center justify-center gap-2 text-ee-muted">
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>{t('guardHome.camera.processing')}</span>
          </div>
        )}

        {phase.kind === 'preview' && (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL of the compressed photo
          <img
            src={phase.photo.objectUrl}
            alt={t('guardHome.camera.previewAlt')}
            className="h-full w-full object-contain"
            data-testid={`${testIdPrefix}-preview`}
          />
        )}

        {phase.kind === 'fallback' && (
          <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-5 py-6 text-center">
            <Camera className="mb-3 h-12 w-12 text-ee-muted" aria-hidden="true" />
            {problem && (
              <p
                className="max-w-sm text-base font-semibold text-ee-warning"
                data-testid={`${testIdPrefix}-problem`}
                data-problem={problem}
              >
                {problemText[problem]}
              </p>
            )}
            <p className="mt-2 max-w-sm text-sm text-ee-muted">{t('guardHome.camera.fallbackHint')}</p>
          </div>
        )}
      </div>

      {notice && (
        <p
          role="alert"
          className="border-t border-ee-border bg-ee-danger/15 px-4 py-2 text-sm font-semibold text-ee-danger"
          data-testid={`${testIdPrefix}-notice`}
        >
          {noticeText[notice]}
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-ee-border bg-ee-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        {(phase.kind === 'live' || phase.kind === 'starting') && (
          <>
            <button
              type="button"
              onClick={() => void handleTakePhoto()}
              disabled={phase.kind !== 'live' || !videoReady}
              className={primaryButton}
              data-testid={`${testIdPrefix}-capture`}
            >
              <Camera className="h-6 w-6" aria-hidden="true" />
              <span>{t('guardHome.camera.takePhoto')}</span>
            </button>
            <button type="button" onClick={openPhoneCamera} className={secondaryButton} data-testid={`${testIdPrefix}-file-fallback`}>
              <ImageUp className="h-5 w-5" aria-hidden="true" />
              <span>{t('guardHome.camera.usePhoneCamera')}</span>
            </button>
          </>
        )}

        {phase.kind === 'fallback' && (
          <>
            <button type="button" onClick={openPhoneCamera} className={primaryButton} data-testid={`${testIdPrefix}-file-fallback`}>
              <ImageUp className="h-6 w-6" aria-hidden="true" />
              <span>{t('guardHome.camera.usePhoneCamera')}</span>
            </button>
            {problem !== 'insecure' && problem !== 'unsupported' && (
              <button type="button" onClick={() => void startStream()} className={secondaryButton} data-testid={`${testIdPrefix}-retry`}>
                <RefreshCw className="h-5 w-5" aria-hidden="true" />
                <span>{t('guardHome.camera.tryLiveAgain')}</span>
              </button>
            )}
          </>
        )}

        {phase.kind === 'preview' && (
          <div className="flex gap-2">
            <button type="button" onClick={handleRetake} className={`${secondaryButton} min-h-14 flex-1`} data-testid={`${testIdPrefix}-retake`}>
              <RefreshCw className="h-5 w-5" aria-hidden="true" />
              <span>{t('guardHome.camera.retake')}</span>
            </button>
            <button type="button" onClick={handleConfirm} className={`${primaryButton} flex-1`} data-testid={`${testIdPrefix}-confirm`}>
              <Check className="h-6 w-6" aria-hidden="true" />
              <span>{t('guardHome.camera.usePhoto')}</span>
            </button>
          </div>
        )}

        {phase.kind === 'processing' && (
          <button type="button" disabled className={primaryButton}>
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span>{t('guardHome.camera.processing')}</span>
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture={facingMode}
        onChange={handleFileChange}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid={`${testIdPrefix}-file-input`}
      />

      <p className="sr-only" role="status" aria-live="polite" data-testid={`${testIdPrefix}-status`}>
        {liveStatus}
      </p>
    </div>
  );
}
