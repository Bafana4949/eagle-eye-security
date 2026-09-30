'use client';

import React, { useId, useRef } from 'react';
import { ArrowUpRight, Plus } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { useDialogFocus } from './useDialogFocus';
import { primaryButtonClass, secondaryButtonClass } from './styles';

interface DuplicateInDialogProps {
  plate: string;
  /** SAST time label of the open IN. */
  since: string;
  onRecordOut: () => void;
  onConfirmNewIn: () => void;
  onCancel: () => void;
}

/** Shown when a vehicle is booked IN while an open IN of the same plate exists on the site. */
export function DuplicateInDialog({ plate, since, onRecordOut, onConfirmNewIn, onCancel }: DuplicateInDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(dialogRef, true, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ee-bg/80 p-4 min-[480px]:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-testid="gate-dup-dialog"
        className="w-full max-w-md rounded-lg border border-ee-border bg-ee-surface p-4 text-ee-text focus:outline-none"
      >
        <h2 id={titleId} className="font-display text-xl font-bold uppercase tracking-wide text-ee-warning">
          {t('gateDupTitle')}
        </h2>
        <p id={bodyId} className="mt-2 text-base">
          {t('gateDupBody', plate, since)}
        </p>
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            data-autofocus
            onClick={onRecordOut}
            data-testid="gate-dup-record-out"
            className={primaryButtonClass}
          >
            <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
            <span>{t('gateDupRecordOut')}</span>
          </button>
          <button type="button" onClick={onConfirmNewIn} data-testid="gate-dup-confirm-in" className={secondaryButtonClass}>
            <Plus className="h-5 w-5" aria-hidden="true" />
            <span>{t('gateDupNewIn')}</span>
          </button>
          <button type="button" onClick={onCancel} data-testid="gate-dup-cancel" className={secondaryButtonClass}>
            {t('gateDupCancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
