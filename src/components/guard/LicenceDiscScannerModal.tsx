'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, Flashlight, Upload, X, AlertTriangle, Edit3 } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { scanPdf417, decodePdf417FromImageFile } from '@/lib/license-disc/scanner';

interface LicenceDiscScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (rawBarcodeText: string) => void;
  onManualEntryFallback: () => void;
}

export function LicenceDiscScannerModal({
  isOpen,
  onClose,
  onScanSuccess,
  onManualEntryFallback
}: LicenceDiscScannerModalProps) {
  const { t } = useTranslation();
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const stopStream = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setTorchOn(false);
    setIsProcessing(false);
  }, []);

  const handleClose = useCallback(() => {
    stopStream();
    setErrorMsg(null);
    onClose();
  }, [stopStream, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;

    const startCamera = async () => {
      try {
        setErrorMsg(null);
        if (!navigator.mediaDevices?.getUserMedia) {
          setErrorMsg('Camera access is not supported on this device/browser');
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          }
        });

        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // Check torch capability
        try {
          const track = stream.getVideoTracks()[0];
          const caps = (track.getCapabilities ? track.getCapabilities() : {}) as { torch?: boolean };
          if (caps.torch) {
            setHasTorch(true);
          }
        } catch {
          setHasTorch(false);
        }

        // Start scanning loop
        const canvas = canvasRef.current || document.createElement('canvas');
        canvasRef.current = canvas;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        let scanBusy = false;

        intervalRef.current = setInterval(async () => {
          if (!videoRef.current || scanBusy || !isMounted) return;
          const video = videoRef.current;
          if (!video.videoWidth || !video.videoHeight) return;

          scanBusy = true;
          try {
            // Downscale to ~1280px max for fast frame parsing
            const scale = Math.min(1.0, 1280 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.floor(video.videoWidth * scale);
            canvas.height = Math.floor(video.videoHeight * scale);

            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const barcodeText = await scanPdf417(video, canvas);

              if (barcodeText && isMounted) {
                if (typeof navigator !== 'undefined' && navigator.vibrate) {
                  navigator.vibrate(250);
                }
                stopStream();
                onScanSuccess(barcodeText);
              }
            }
          } catch {
            // Drop error on busy frame
          } finally {
            scanBusy = false;
          }
        }, 320);

      } catch (err: unknown) {
        if (!isMounted) return;
        const error = err as Error;
        if (error.name === 'NotAllowedError') {
          setErrorMsg('Camera access was blocked. Please grant camera permission in your browser settings.');
        } else {
          setErrorMsg('Could not open camera. You can upload a photo or enter vehicle details manually.');
        }
      }
    };

    void startCamera();

    return () => {
      isMounted = false;
      stopStream();
    };
  }, [isOpen, stopStream, onScanSuccess]);

  const toggleTorch = async () => {
    if (!streamRef.current) return;
    try {
      const track = streamRef.current.getVideoTracks()[0];
      const nextTorch = !torchOn;
      // @ts-expect-error torch advanced constraint
      await track.applyConstraints({ advanced: [{ torch: nextTorch }] });
      setTorchOn(nextTorch);
    } catch {
      // Ignored
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setErrorMsg(null);

    try {
      const barcodeText = await decodePdf417FromImageFile(file);
      if (barcodeText) {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(250);
        }
        stopStream();
        onScanSuccess(barcodeText);
      } else {
        setErrorMsg('No vehicle licence disc barcode found in the photo. Hold camera close, keep steady and ensure good lighting.');
      }
    } catch {
      setErrorMsg('Failed to process image. Please try again or enter details manually.');
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md flex flex-col justify-between p-4 animate-in fade-in duration-150">
      {/* Top Header */}
      <div className="flex items-center justify-between z-10 pt-2 px-2">
        <div>
          <h3 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
            <Camera className="w-5 h-5 text-amber-400" />
            <span>{t('scanLicenceDisc')}</span>
          </h3>
          <p className="text-[11px] text-slate-400 font-medium">South African MVL PDF417 Barcode</p>
        </div>

        <button
          onClick={handleClose}
          className="p-2.5 rounded-full bg-slate-800/80 text-slate-300 hover:text-white"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Viewfinder Viewport */}
      <div className="flex-1 flex flex-col items-center justify-center relative my-2">
        <div className="w-full max-w-sm rounded-3xl overflow-hidden border-2 border-amber-500 shadow-2xl relative bg-black aspect-[4/3] flex items-center justify-center">
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />

          {/* Barcode Targeting Reticle (Rectangular for MVL disc) */}
          <div className="absolute inset-0 border-2 border-amber-400/40 m-6 rounded-2xl pointer-events-none flex flex-col items-center justify-between p-3">
            <div className="w-full flex justify-between">
              <div className="w-6 h-6 border-t-4 border-l-4 border-amber-400 rounded-tl-lg" />
              <div className="w-6 h-6 border-t-4 border-r-4 border-amber-400 rounded-tr-lg" />
            </div>

            <div className="text-center px-2 py-1 rounded bg-black/60 backdrop-blur-sm">
              <span className="text-[11px] font-bold text-amber-300 tracking-wider uppercase">
                {isProcessing ? 'Analyzing Disc...' : 'Align Barcode in Box'}
              </span>
            </div>

            <div className="w-full flex justify-between">
              <div className="w-6 h-6 border-b-4 border-l-4 border-amber-400 rounded-bl-lg" />
              <div className="w-6 h-6 border-b-4 border-r-4 border-amber-400 rounded-br-lg" />
            </div>
          </div>
        </div>

        {errorMsg && (
          <div className="mt-3 p-3 rounded-xl bg-rose-950/90 border border-rose-800 text-rose-300 text-xs font-semibold text-center max-w-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <p className="text-xs text-slate-300 mt-3 text-center max-w-xs font-medium">
          {t('aimDisc')}
        </p>
      </div>

      {/* Bottom Controls */}
      <div className="flex flex-col gap-3 pb-6 z-10 max-w-sm mx-auto w-full">
        <div className="flex items-center justify-center gap-3">
          {hasTorch && (
            <button
              onClick={() => void toggleTorch()}
              className={`p-3.5 rounded-2xl border transition-all ${
                torchOn
                  ? 'bg-amber-500 text-slate-950 border-amber-400'
                  : 'bg-slate-800 text-slate-200 border-slate-700'
              }`}
              title="Torch"
            >
              <Flashlight className="w-5 h-5" />
            </button>
          )}

          {/* Photo File Fallback */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold border border-slate-700 text-xs"
          >
            <Upload className="w-4 h-4 text-amber-400" />
            <span>{t('photoInstead')}</span>
          </button>

          {/* Manual Entry Fallback */}
          <button
            onClick={() => {
              handleClose();
              onManualEntryFallback();
            }}
            className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold border border-slate-700 text-xs"
          >
            <Edit3 className="w-4 h-4 text-emerald-400" />
            <span>{t('enterManually')}</span>
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => void handleFileUpload(e)}
          className="hidden"
        />
      </div>
    </div>
  );
}
