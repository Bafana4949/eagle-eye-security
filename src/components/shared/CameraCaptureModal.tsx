'use client';

import React, { useState, useRef } from 'react';
import { Camera, RefreshCw, Check, X } from 'lucide-react';
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
  facingMode = 'environment',
  title,
  isSelfie = false
}: CameraCaptureModalProps) {
  const { t } = useTranslation();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    try {
      const maxDim = isSelfie ? 320 : 800;
      const quality = isSelfie ? 0.65 : 0.75;
      const compressed = await compressImage(file, maxDim, quality);

      setPreviewUrl(compressed.dataUrl);
      setCapturedBlob(compressed.blob);
    } catch {
      // Compression error fallback
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
    fileInputRef.current?.click();
  };

  const handleClose = () => {
    setPreviewUrl(null);
    setCapturedBlob(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col justify-between p-4 animate-in fade-in duration-150">
      <div className="flex items-center justify-between z-10 pt-2 px-2">
        <h3 className="text-lg font-bold text-white tracking-tight">
          {title || (isSelfie ? t('startShift') : t('incidentPhoto'))}
        </h3>
        <button
          onClick={handleClose}
          className="p-2 rounded-full bg-slate-800/80 text-slate-300 hover:text-white"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center my-4">
        {previewUrl ? (
          <div className="relative max-w-sm w-full rounded-2xl overflow-hidden border-2 border-blue-500 shadow-2xl aspect-[3/4] bg-slate-900">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Capture preview" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-8 text-center max-w-xs">
            <div className="w-20 h-20 rounded-full bg-blue-950/60 border-2 border-blue-600 flex items-center justify-center text-blue-400 mb-4 animate-pulse">
              <Camera className="w-10 h-10" />
            </div>
            <p className="text-sm text-slate-300 font-medium mb-6">
              {isSelfie
                ? t('selfieRequired') || 'Front-facing selfie photo required for verification'
                : 'Take clear evidence photograph'}
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="px-6 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-base shadow-xl active:scale-95 flex items-center gap-2"
            >
              <Camera className="w-5 h-5" />
              <span>{isProcessing ? 'Processing...' : 'Open Camera'}</span>
            </button>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture={facingMode}
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {previewUrl && (
        <div className="flex items-center justify-center gap-4 pb-6 z-10 max-w-sm mx-auto w-full">
          <button
            onClick={handleRetake}
            className="flex-1 py-3.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold border border-slate-700 text-sm flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            <span>{t('retakeSelfie')}</span>
          </button>

          <button
            onClick={handleConfirm}
            className="flex-1 py-3.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50"
          >
            <Check className="w-5 h-5" />
            <span>{t('save')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
