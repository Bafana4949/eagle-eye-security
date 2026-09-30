'use client';

import React, { useRef, useState } from 'react';
import { Camera, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { compressEvidencePhoto } from '@/lib/utils/media';

export interface IncidentPhoto {
  blob: Blob;
  /** In-memory preview only; never stored (the Blob is what the queue keeps). */
  dataUrl: string;
}

interface IncidentPhotoPickerProps {
  photo: IncidentPhoto | null;
  onChange: (photo: IncidentPhoto | null) => void;
  disabled?: boolean;
}

/**
 * Optional evidence photo. Opens the phone's rear camera through a file input
 * (capture="environment"); browsers without camera capture show their file picker instead, so
 * this works on every phone. The photo is resized/compressed with compressEvidencePhoto
 * (1600 px, ~900 KB target). Formats the browser cannot decode (e.g. some HEIC files) are
 * reported instead of being silently dropped.
 */
export function IncidentPhotoPicker({ photo, onChange, disabled = false }: IncidentPhotoPickerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [processing, setProcessing] = useState(false);
  const [failed, setFailed] = useState(false);

  const openCamera = () => {
    setFailed(false);
    inputRef.current?.click();
  };

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Allow choosing the same file again later.
    event.target.value = '';
    if (!file) return;
    setProcessing(true);
    setFailed(false);
    try {
      const compressed = await compressEvidencePhoto(file);
      onChange({ blob: compressed.blob, dataUrl: compressed.dataUrl });
    } catch {
      setFailed(true);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="incident-photo-input"
        onChange={(event) => void onFile(event)}
      />

      {photo ? (
        <div className="flex items-center gap-3" data-testid="incident-photo-preview">
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
          <img
            src={photo.dataUrl}
            alt={t('incident.photo.previewAlt')}
            className="h-20 w-20 shrink-0 rounded-lg border border-ee-border object-cover"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-base font-semibold text-ee-success">{t('incident.photo.attached')}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openCamera}
                disabled={disabled || processing}
                data-testid="incident-photo-retake"
                className="flex min-h-12 items-center gap-2 rounded-xl border border-ee-border bg-ee-bg px-3 text-sm font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                {t('incident.photo.retake')}
              </button>
              <button
                type="button"
                onClick={() => onChange(null)}
                disabled={disabled || processing}
                data-testid="incident-photo-remove"
                className="flex min-h-12 items-center gap-2 rounded-xl border border-ee-border bg-ee-bg px-3 text-sm font-semibold text-ee-danger hover:bg-ee-surface-raised disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {t('incident.photo.remove')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openCamera}
          disabled={disabled || processing}
          data-testid="incident-photo-add"
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50"
        >
          <Camera className="h-5 w-5 text-ee-primary" aria-hidden="true" />
          {processing ? t('incident.photo.processing') : t('incident.photo.add')}
        </button>
      )}

      <p role="status" aria-live="polite" className="text-sm">
        {processing && photo ? <span className="text-ee-muted">{t('incident.photo.processing')}</span> : null}
        {failed ? (
          <span className="text-ee-danger" data-testid="incident-photo-error">
            {t('incident.photo.failed')}
          </span>
        ) : null}
      </p>
    </div>
  );
}
