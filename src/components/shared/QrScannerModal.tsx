'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Flashlight, Upload, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';

interface QrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onScanSuccess: (decodedText: string) => void;
  title?: string;
  instructionText?: string;
}

interface TorchConstraintTrack {
  applyConstraints: (constraints: { advanced: { torch: boolean }[] }) => Promise<void>;
}

export function QrScannerModal({
  isOpen,
  onClose,
  onScanSuccess,
  title,
  instructionText
}: QrScannerModalProps) {
  const { t } = useTranslation();
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const READER_ELEMENT_ID = 'eagle-eye-qr-reader';

  const handleStopAndClose = useCallback(async () => {
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        scannerRef.current.clear();
      } catch {
        // Ignored during cleanup
      }
      scannerRef.current = null;
    }
    setTorchOn(false);
    setErrorMsg(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;

    const startScanner = async () => {
      try {
        const scanner = new Html5Qrcode(READER_ELEMENT_ID);
        scannerRef.current = scanner;

        const config = {
          fps: 12,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1.0
        };

        await scanner.start(
          { facingMode: 'environment' },
          config,
          (decodedText) => {
            if (isMounted) {
              if (typeof navigator !== 'undefined' && navigator.vibrate) {
                navigator.vibrate(200);
              }
              onScanSuccess(decodedText);
              void handleStopAndClose();
            }
          },
          () => {
            // Ignore scan parse frame drops
          }
        );

        // Check if torch/flashlight is supported
        try {
          const track = scanner.getRunningTrackCameraCapabilities();
          // @ts-expect-error torch capability inspection
          if (track?.torch) {
            setHasTorch(true);
          }
        } catch {
          // Capability check unsupported
        }
      } catch {
        if (isMounted) {
          setErrorMsg(t('camBlocked') || 'Camera access blocked or unsupported');
        }
      }
    };

    const timer = setTimeout(() => {
      void startScanner();
    }, 200);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      void handleStopAndClose();
    };
  }, [isOpen, handleStopAndClose, onScanSuccess, t]);

  const handleToggleTorch = async () => {
    if (!scannerRef.current) return;
    try {
      const track = (scannerRef.current as unknown as { getRunningTrackCameraCapabilities?: () => unknown }) as unknown as TorchConstraintTrack;
      if (typeof track.applyConstraints === 'function') {
        await track.applyConstraints({
          advanced: [{ torch: !torchOn }]
        });
        setTorchOn(!torchOn);
      }
    } catch {
      // Torch not supported on this track
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !scannerRef.current) return;

    try {
      const result = await scannerRef.current.scanFile(file, true);
      onScanSuccess(result);
      void handleStopAndClose();
    } catch {
      setErrorMsg(t('noQR') || 'No QR code found in photo');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col justify-between p-4 animate-in fade-in duration-150">
      {/* Top Header */}
      <div className="flex items-center justify-between z-10 pt-2 px-2">
        <h3 className="text-lg font-bold text-white tracking-tight">
          {title || t('scanCheckpoint')}
        </h3>
        <button
          onClick={() => void handleStopAndClose()}
          className="p-2 rounded-full bg-slate-800/80 text-slate-300 hover:text-white"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Camera Viewport */}
      <div className="flex-1 flex flex-col items-center justify-center relative my-4">
        <div
          id={READER_ELEMENT_ID}
          className="w-full max-w-sm rounded-2xl overflow-hidden border-2 border-[#F0A53A] shadow-2xl relative bg-black aspect-square"
        />

        {errorMsg && (
          <div className="mt-4 p-3 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-300 text-xs font-semibold text-center max-w-xs">
            {errorMsg}
          </div>
        )}

        <p className="text-xs text-slate-300 mt-4 text-center max-w-xs font-medium">
          {instructionText || t('aim') || 'Point camera at the checkpoint QR code'}
        </p>
      </div>

      {/* Bottom Controls */}
      <div className="flex items-center justify-center gap-4 pb-6 z-10">
        {hasTorch && (
          <button
            onClick={() => void handleToggleTorch()}
            className={`p-4 rounded-full border transition-all ${
              torchOn
                ? 'bg-amber-500 text-slate-950 border-amber-400'
                : 'bg-slate-800 text-slate-200 border-slate-700'
            }`}
            title="Torch"
          >
            <Flashlight className="w-6 h-6" />
          </button>
        )}

        {/* Photo Upload Fallback */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 px-5 py-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold border border-slate-700 text-sm"
        >
          <Upload className="w-5 h-5 text-[#F0A53A]" />
          <span>{t('photoInstead') || 'Upload Photo'}</span>
        </button>

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
