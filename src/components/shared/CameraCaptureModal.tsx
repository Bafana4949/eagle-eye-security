'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, RefreshCw, Check, X, Upload, AlertCircle } from 'lucide-react';
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

  const videoRef = useRef<HTMLVideoElement>(null);
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
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('WebRTC Camera API not supported in this browser');
      }

      // Constraints optimized for low memory usage and high responsiveness
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          facingMode: facingMode,
          width: { ideal: isSelfie ? 480 : 800 },
          height: { ideal: isSelfie ? 480 : 800 }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(() => {});
          setIsStreaming(true);
          setIsProcessing(false);
        };
      } else {
        setIsStreaming(true);
        setIsProcessing(false);
      }
    } catch (err: unknown) {
      console.warn('In-app live stream unavailable, using fallback file chooser:', err);
      setIsStreaming(false);
      setIsProcessing(false);
      setCameraError(
        err instanceof Error ? err.message : 'Camera stream unavailable. Please use upload fallback.'
      );
    }
  }, [facingMode, isSelfie, stopStream]);

  // Manage camera lifecycle based on isOpen and preview state
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

  // Snaps the current video frame into a compact canvas (prevents external app memory pressure)
  const handleSnap = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    setIsProcessing(true);
    try {
      const vWidth = video.videoWidth;
      const vHeight = video.videoHeight;
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
      if (!ctx) throw new Error('2D context failed');

      // Mirror selfie for natural appearance if facing user
      if (facingMode === 'user') {
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
            stopStream(); // Free camera stream immediately
          }
          setIsProcessing(false);
        },
        mimeType,
        quality
      );
    } catch (err) {
      console.error('Frame snapshot error:', err);
      setIsProcessing(false);
    }
  };

  // Fallback file input handler (safe without capture attribute to avoid Android low memory crash)
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

      {/* Main Viewport */}
      <div className="flex-1 flex flex-col items-center justify-center my-3 max-w-md mx-auto w-full relative">
        {previewUrl ? (
          /* Captured Preview */
          <div className="relative w-full max-w-sm rounded-3xl overflow-hidden border-2 border-[#F0A53A] shadow-2xl aspect-[3/4] bg-[#212C38]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Captured preview" className="w-full h-full object-cover" />
          </div>
        ) : isStreaming ? (
          /* In-App Live Video Feed (Zero backgrounding, Zero memory crash) */
          <div className="relative w-full max-w-sm rounded-3xl overflow-hidden border-2 border-[#F0A53A] shadow-2xl aspect-[3/4] bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`w-full h-full object-cover ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
            />

            {/* Selfie Guide Overlay */}
            {isSelfie && (
              <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-6">
                <div className="w-48 h-60 rounded-[45%] border-2 border-dashed border-[#F0A53A]/80 shadow-[0_0_20px_rgba(240,165,58,0.25)] flex items-center justify-center" />
                <span className="text-[11px] font-bold text-[#E9E4D8] bg-[#18212B]/80 px-3 py-1 rounded-full border border-[#F0A53A]/50 mt-3 backdrop-blur-sm">
                  {t('takeSelfie') || 'Align Face in Circle'}
                </span>
              </div>
            )}
          </div>
        ) : (
          /* Fallback when stream is loading or unavailable */
          <div className="flex flex-col items-center justify-center p-6 text-center max-w-xs space-y-4">
            <div className="w-20 h-20 rounded-2xl bg-[#212C38] border-2 border-[#F0A53A] flex items-center justify-center text-[#F0A53A] shadow-xl shadow-[#F0A53A]/20">
              <Camera className="w-10 h-10" />
            </div>

            {cameraError ? (
              <div className="p-3 rounded-xl bg-[#212C38] border border-[#E0685C] text-[#E0685C] text-xs font-medium space-y-1">
                <div className="flex items-center justify-center gap-1.5 font-bold">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Camera Stream Notice</span>
                </div>
                <p className="text-[11px] text-[#9AA5B1]">
                  Live video stream could not start. Please select photo using standard upload below.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm text-[#E9E4D8] font-bold">
                  {isSelfie ? (t('selfieTitle') || 'Guard Selfie') : (t('photoTitle') || 'Take Photo')}
                </p>
                <p className="text-xs text-[#9AA5B1]">
                  Starting camera viewfinder...
                </p>
              </div>
            )}

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="w-full py-3 px-5 rounded-xl bg-[#212C38] hover:bg-[#283644] text-[#E9E4D8] border border-[#324050] text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-all shadow-md"
            >
              <Upload className="w-4 h-4 text-[#F0A53A]" />
              <span>Choose Photo / Kies Foto</span>
            </button>
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
              <Upload className="w-3.5 h-3.5" />
              <span>Upload from gallery instead</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
