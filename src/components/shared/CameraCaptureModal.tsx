'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, RefreshCw, Check, X, Upload, AlertCircle, FlipHorizontal } from 'lucide-react';
import { compressImage } from '@/lib/utils/media';
import { useTranslation } from '@/lib/i18n/context';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (compressedBlob: Blob, dataUrl: string) => void;
  facingMode?: 'user' | 'environment';
  title?: string;
  isSelfie?: boolean;
}

export function CameraCaptureModal({
  isOpen,
  onClose,
  onCapture,
  facingMode = 'user',
  title,
  isSelfie = false
}: CameraCaptureModalProps) {
  const { t } = useTranslation();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [currentFacingMode, setCurrentFacingMode] = useState<'user' | 'environment'>(facingMode);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsStreaming(false);
  }, []);

  const startStream = useCallback(async () => {
    setCameraError(null);
    setIsProcessing(true);
    stopStream();

    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera stream not supported in this browser');
      }

      let stream: MediaStream | null = null;
      try {
        // Attempt 1: Standard mobile facingMode with flexible resolution
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: currentFacingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
      } catch (firstErr) {
        console.warn('Attempt 1 failed, retrying with facingMode only:', firstErr);
        try {
          // Attempt 2: Minimal facingMode constraint
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: currentFacingMode }
            }
          });
        } catch (secondErr) {
          console.warn('Attempt 2 failed, retrying with basic video constraint:', secondErr);
          // Attempt 3: Any video device available (desktop webcams, unusual devices)
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
          });
        }
      }

      if (!stream) {
        throw new Error('Failed to acquire camera stream');
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play().catch((e) => console.warn('Autoplay error:', e));
        };
        video.play().catch(() => {});
      }

      setIsStreaming(true);
      setIsProcessing(false);
    } catch (err: unknown) {
      console.warn('Camera stream error:', err);
      setIsStreaming(false);
      setIsProcessing(false);
      const isNotAllowed =
        (err instanceof DOMException && err.name === 'NotAllowedError') ||
        (err instanceof Error &&
          (err.name === 'NotAllowedError' ||
            err.message.toLowerCase().includes('permission') ||
            err.message.toLowerCase().includes('denied') ||
            err.message.toLowerCase().includes('not allowed')));

      setCameraError(
        isNotAllowed
          ? 'Camera permission was not granted. Please allow camera access in your browser settings (tap the lock/settings icon in your address bar), or choose a photo below.'
          : 'Camera device could not be opened automatically. Tap "Start Camera" or choose a photo below.'
      );
    }
  }, [currentFacingMode, stopStream]);

  // Callback ref guarantees videoRef is bound as soon as the DOM element mounts
  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node) {
      node.muted = true;
      node.playsInline = true;
      node.setAttribute('playsinline', 'true');
      node.setAttribute('webkit-playsinline', 'true');
      if (streamRef.current && node.srcObject !== streamRef.current) {
        node.srcObject = streamRef.current;
        node.onloadedmetadata = () => {
          node.play().catch(() => {});
        };
        node.play().catch(() => {});
      }
    }
  }, []);

  // Sync stream state when modal opens or closes
  useEffect(() => {
    if (isOpen && !previewUrl) {
      void startStream();
    } else {
      stopStream();
    }

    return () => {
      stopStream();
    };
  }, [isOpen, previewUrl, startStream, stopStream]);

  if (!isOpen) return null;

  // Snaps current video frame into a compact canvas (prevents OS low-memory kill)
  const handleSnap = () => {
    const video = videoRef.current;
    if (!video) return;

    setIsProcessing(true);
    try {
      const vWidth = video.videoWidth || 640;
      const vHeight = video.videoHeight || 480;
      const targetSize = isSelfie ? 400 : 720;

      let drawWidth = targetSize;
      let drawHeight = Math.round((vHeight / vWidth) * targetSize);

      if (vHeight > vWidth) {
        drawHeight = targetSize;
        drawWidth = Math.round((vWidth / vHeight) * targetSize);
      }

      const canvas = document.createElement('canvas');
      canvas.width = drawWidth;
      canvas.height = drawHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');

      // Mirror user-facing selfie so it appears naturally like a mirror
      if (currentFacingMode === 'user') {
        ctx.translate(drawWidth, 0);
        ctx.scale(-1, 1);
      }

      ctx.drawImage(video, 0, 0, drawWidth, drawHeight);

      const mimeType = 'image/jpeg';
      const quality = 0.8;
      const dataUrl = canvas.toDataURL(mimeType, quality);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            setCapturedBlob(blob);
            setPreviewUrl(dataUrl);
            stopStream(); // Free camera hardware immediately
          }
          setIsProcessing(false);
        },
        mimeType,
        quality
      );
    } catch (err) {
      console.error('Snapshot capture error:', err);
      setIsProcessing(false);
    }
  };

  // Safe file chooser fallback (WITHOUT capture attribute to avoid Android low memory crash)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    try {
      const maxDim = isSelfie ? 400 : 720;
      const quality = 0.8;
      const compressed = await compressImage(file, maxDim, quality);

      setPreviewUrl(compressed.dataUrl);
      setCapturedBlob(compressed.blob);
      stopStream();
    } catch (err) {
      console.error('File compression error:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleCamera = () => {
    setCurrentFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'));
  };

  const handleConfirm = () => {
    if (capturedBlob && previewUrl) {
      onCapture(capturedBlob, previewUrl);
      handleClose();
    }
  };

  const handleRetake = () => {
    setPreviewUrl(null);
    setCapturedBlob(null);
    void startStream();
  };

  const handleClose = () => {
    stopStream();
    setPreviewUrl(null);
    setCapturedBlob(null);
    setCameraError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#18212B]/95 backdrop-blur-md flex flex-col justify-between p-4 animate-in fade-in duration-150">
      {/* Top Header */}
      <div className="flex items-center justify-between z-10 pt-2 px-2 max-w-md mx-auto w-full">
        <div>
          <h3 className="text-lg font-bold text-[#E9E4D8] tracking-tight">
            {title || (isSelfie ? (t('selfieTitle') || 'Selfie Verification') : (t('photoTitle') || 'Photo Evidence'))}
          </h3>
          <p className="text-xs text-[#9AA5B1]">
            {isSelfie
              ? (t('cameraInstruction') || 'A selfie photo is required for GPS and duty verification.')
              : 'Captured photo is recorded with GPS coordinates & time.'}
          </p>
        </div>
        <button
          onClick={handleClose}
          className="p-2 rounded-xl bg-[#212C38] border border-[#324050] text-[#9AA5B1] hover:text-[#E9E4D8] active:scale-95 transition-all"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Main Viewport Container */}
      <div className="flex-1 flex flex-col items-center justify-center my-3 max-w-md mx-auto w-full relative">
        {previewUrl ? (
          /* Captured Preview */
          <div className="relative w-full max-w-sm rounded-3xl overflow-hidden border-2 border-[#F0A53A] shadow-2xl aspect-[3/4] bg-[#212C38]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Captured preview" className="w-full h-full object-cover" />
          </div>
        ) : (
          /* Live Camera Viewfinder with ALWAYS MOUNTED <video> to prevent ref null race conditions */
          <div className="relative w-full max-w-sm rounded-3xl overflow-hidden border-2 border-[#F0A53A] shadow-2xl aspect-[3/4] bg-black flex items-center justify-center">
            {/* The video element is ALWAYS rendered in DOM */}
            <video
              ref={videoCallbackRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${
                isStreaming ? 'block' : 'hidden'
              } ${currentFacingMode === 'user' ? 'scale-x-[-1]' : ''}`}
            />

            {/* Selfie Framing Guide Overlay */}
            {isStreaming && isSelfie && (
              <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-6">
                <div className="w-48 h-60 rounded-[45%] border-2 border-dashed border-[#F0A53A]/80 shadow-[0_0_20px_rgba(240,165,58,0.25)] flex items-center justify-center" />
                <span className="text-[11px] font-bold text-[#E9E4D8] bg-[#18212B]/85 px-3 py-1 rounded-full border border-[#F0A53A]/50 mt-3 backdrop-blur-sm">
                  {t('takeSelfie') || 'Align Face in Circle'}
                </span>
              </div>
            )}

            {/* Camera Switch Button */}
            {isStreaming && (
              <button
                type="button"
                onClick={handleToggleCamera}
                className="absolute top-3 right-3 p-2.5 rounded-full bg-[#18212B]/80 border border-[#F0A53A]/60 text-[#F0A53A] backdrop-blur-md active:scale-95 transition-all shadow-lg"
                title="Switch Camera (Front / Back)"
              >
                <FlipHorizontal className="w-4 h-4" />
              </button>
            )}

            {/* Loading / Error State Overlay when video is not streaming */}
            {!isStreaming && (
              <div className="flex flex-col items-center justify-center p-6 text-center max-w-xs space-y-4">
                <div className="w-16 h-16 rounded-2xl bg-[#212C38] border-2 border-[#F0A53A] flex items-center justify-center text-[#F0A53A] shadow-xl shadow-[#F0A53A]/20">
                  <Camera className="w-8 h-8" />
                </div>

                {cameraError ? (
                  <div className="p-3 rounded-xl bg-[#212C38] border border-[#E0685C] text-[#E0685C] text-xs font-medium space-y-1">
                    <div className="flex items-center justify-center gap-1.5 font-bold">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>Camera Access Notice</span>
                    </div>
                    <p className="text-[11px] text-[#9AA5B1]">
                      {cameraError}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-sm text-[#E9E4D8] font-bold">
                      {isSelfie ? (t('selfieTitle') || 'Guard Selfie') : (t('photoTitle') || 'Take Photo')}
                    </p>
                    <p className="text-xs text-[#9AA5B1] animate-pulse">
                      Initializing camera...
                    </p>
                  </div>
                )}

                <div className="w-full flex flex-col gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void startStream()}
                    disabled={isProcessing}
                    className="w-full py-3.5 px-4 rounded-xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] hover:brightness-105 active:scale-95 text-[#2A1A04] text-xs font-bold flex items-center justify-center gap-2 transition-all shadow-lg shadow-[#F0A53A]/25"
                  >
                    <Camera className="w-4 h-4 stroke-[2.5]" />
                    <span>{isProcessing ? 'Starting...' : 'Start Camera / Maak Oop'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isProcessing}
                    className="w-full py-3 px-4 rounded-xl bg-[#212C38] hover:bg-[#283644] text-[#E9E4D8] border border-[#324050] text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-all shadow-md"
                  >
                    <Upload className="w-4 h-4 text-[#F0A53A]" />
                    <span>Choose Photo / Kies Foto</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Hidden Fallback Input without capture attribute to prevent low memory OS crash */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Bottom Controls */}
      <div className="pb-4 z-10 max-w-md mx-auto w-full">
        {previewUrl ? (
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleRetake}
              className="flex-1 py-3.5 px-4 rounded-xl bg-[#212C38] hover:bg-[#283644] text-[#E9E4D8] font-bold border border-[#324050] text-sm flex items-center justify-center gap-2 active:scale-95 transition-all"
            >
              <RefreshCw className="w-4 h-4 text-[#F0A53A]" />
              <span>{t('retake') || 'Retake'}</span>
            </button>

            <button
              onClick={handleConfirm}
              className="flex-1 py-3.5 px-4 rounded-xl bg-[#76C08F] hover:bg-[#68B080] text-[#18212B] font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-[#76C08F]/25 active:scale-95 transition-all"
            >
              <Check className="w-5 h-5 stroke-[2.5]" />
              <span>{t('confirm') || 'Confirm'}</span>
            </button>
          </div>
        ) : isStreaming ? (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={handleSnap}
              disabled={isProcessing}
              className="w-full max-w-sm py-4 px-6 rounded-2xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] hover:brightness-105 active:scale-[0.98] text-[#2A1A04] font-bold text-base shadow-xl shadow-[#F0A53A]/30 border border-[#F0A53A] flex items-center justify-center gap-2 transition-all"
            >
              <Camera className="w-5 h-5 stroke-[2.5]" />
              <span>{isSelfie ? (t('takeSelfie') || 'Take Selfie') : (t('openCamera') || 'Snap Photo')}</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs text-[#9AA5B1] hover:text-[#E9E4D8] flex items-center gap-1.5 underline underline-offset-4"
            >
              <Upload className="w-3.5 h-3.5 text-[#F0A53A]" />
              <span>Upload from gallery instead</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => void startStream()}
              className="px-4 py-2 rounded-xl bg-[#212C38] text-xs font-semibold text-[#F0A53A] border border-[#324050] flex items-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry Camera Stream</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
