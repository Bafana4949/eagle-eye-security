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
      const maxDim = isSelfie ? 400 : 800;
      const quality = isSelfie ? 0.75 : 0.8;
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
    <div className="fixed inset-0 z-50 bg-[#18212B]/95 backdrop-blur-md flex flex-col justify-between p-4 animate-in fade-in duration-150">
      <div className="flex items-center justify-between z-10 pt-2 px-2 max-w-md mx-auto w-full">
        <div>
          <h3 className="text-lg font-bold text-[#E9E4D8] tracking-tight">
            {title || (isSelfie ? 'Selfie Verifikasie' : 'Foto Bewys')}
          </h3>
          <p className="text-xs text-[#9AA5B1]">
            {isSelfie ? 'Neem asseblief n duidelike selfie / Please take a clear selfie' : 'Neem n duidelike foto / Take a clear picture'}
          </p>
        </div>
        <button
          onClick={handleClose}
          className="p-2 rounded-xl bg-[#212C38] border border-[#324050] text-[#9AA5B1] hover:text-[#E9E4D8]"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center my-4 max-w-md mx-auto w-full">
        {previewUrl ? (
          <div className="relative w-full rounded-2xl overflow-hidden border-2 border-[#F0A53A] shadow-2xl aspect-[3/4] bg-[#212C38]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Capture preview" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-8 text-center max-w-xs">
            <div className="w-24 h-24 rounded-2xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] flex items-center justify-center text-[#2A1A04] shadow-xl shadow-[#F0A53A]/20 border border-[#F0A53A] mb-4 animate-pulse">
              <Camera className="w-12 h-12" />
            </div>
            <p className="text-sm text-[#E9E4D8] font-semibold mb-2">
              {isSelfie
                ? 'Wag Selfie Benodig'
                : 'Duidelike Bewysfoto'}
            </p>
            <p className="text-xs text-[#9AA5B1] mb-6">
              {isSelfie
                ? 'Voorwaartse kamera selfie word vereis vir GPS en diens verifikasie.'
                : 'Foto word permanent aangeteken met GPS koördinate en tyd.'}
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessing}
              className="w-full py-3.5 px-6 rounded-xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] hover:brightness-105 active:scale-95 text-[#2A1A04] font-bold text-base shadow-xl shadow-[#F0A53A]/25 border border-[#F0A53A] flex items-center justify-center gap-2"
            >
              <Camera className="w-5 h-5" />
              <span>{isProcessing ? 'Verwerk...' : 'Maak Kamera Oop / Open Camera'}</span>
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
        <div className="flex items-center justify-center gap-3 pb-6 z-10 max-w-md mx-auto w-full">
          <button
            onClick={handleRetake}
            className="flex-1 py-3 px-4 rounded-xl bg-[#212C38] hover:bg-[#283644] text-[#E9E4D8] font-semibold border border-[#324050] text-sm flex items-center justify-center gap-2 active:scale-95 transition-all"
          >
            <RefreshCw className="w-4 h-4 text-[#F0A53A]" />
            <span>Neem Weer / Retake</span>
          </button>

          <button
            onClick={handleConfirm}
            className="flex-1 py-3 px-4 rounded-xl bg-[#76C08F] hover:bg-[#68B080] text-[#18212B] font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-[#76C08F]/20 active:scale-95 transition-all"
          >
            <Check className="w-5 h-5 stroke-[2.5]" />
            <span>Bevestig / Confirm</span>
          </button>
        </div>
      )}
    </div>
  );
}
