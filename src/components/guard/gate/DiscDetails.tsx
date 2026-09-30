'use client';

import React from 'react';
import { CircleCheck, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { LicenseDiscData } from '@/types/models';
import { discExpiryStatus, normalizePlate } from '@/lib/license-disc/parser';
import { discMatchesPlate } from './gateLogic';
import { noticeClass } from './styles';

interface DiscDetailsProps {
  disc: LicenseDiscData;
  /** The registration number currently in the form. */
  plate: string;
  onDiscard: () => void;
}

/**
 * What was read from the licence disc. Only fields present on the disc are shown; the result is
 * "read", never "verified" (the barcode is not proof of authenticity). Expiry is the SAST date.
 */
export function DiscDetails({ disc, plate, onDiscard }: DiscDetailsProps) {
  const { t } = useTranslation();
  const expiry = discExpiryStatus(disc);
  const mismatch = normalizePlate(plate) !== '' && !discMatchesPlate(disc, plate);

  const rows: Array<{ key: TranslationKey; value: string | undefined; testId: string }> = [
    { key: 'gateDiscRegister', value: disc.regNumber, testId: 'gate-disc-register' },
    { key: 'gateDiscVin', value: disc.vin, testId: 'gate-disc-vin' },
    { key: 'gateDiscEngine', value: disc.engineNumber, testId: 'gate-disc-engine' },
    { key: 'gateDiscDescription', value: disc.description, testId: 'gate-disc-description' }
  ];

  return (
    <section
      data-testid="gate-disc-details"
      aria-labelledby="gate-disc-heading"
      className="rounded-lg border border-ee-border bg-ee-surface px-3 py-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="gate-disc-heading" className="flex items-center gap-2 font-semibold text-ee-success">
            <CircleCheck className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t('gateDiscRead')}</span>
          </h3>
          <p className="mt-1 text-sm text-ee-muted">{t('gateDiscCheck')}</p>
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label={t('gateDiscDiscard')}
          data-testid="gate-disc-discard"
          className="grid min-h-12 min-w-12 shrink-0 place-items-center rounded-lg text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <dl className="mt-2 divide-y divide-ee-border text-sm">
        {rows
          .filter((row) => !!row.value)
          .map((row) => (
            <div key={row.key} className="flex flex-wrap justify-between gap-x-3 py-2">
              <dt className="text-ee-muted">{t(row.key)}</dt>
              <dd data-testid={row.testId} className="font-mono break-all text-ee-text">
                {row.value}
              </dd>
            </div>
          ))}
        <div className="flex flex-wrap justify-between gap-x-3 py-2">
          <dt className="text-ee-muted">{t('gateDiscExpiry')}</dt>
          <dd
            data-testid="gate-disc-expiry"
            data-expiry-status={expiry}
            className={expiry === 'expired' ? 'font-bold text-ee-danger' : 'text-ee-text'}
          >
            {expiry === 'unknown' ? t('gateDiscNoExpiry') : disc.expiryDate}
            {expiry === 'expired' && ` – ${t('gateDiscExpired')}`}
          </dd>
        </div>
      </dl>

      {expiry === 'expired' && disc.expiryDate && (
        <p role="alert" data-testid="gate-disc-expired" className={`mt-2 flex items-start gap-2 ${noticeClass.danger}`}>
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('gateDiscExpiredWarning', disc.expiryDate)}</span>
        </p>
      )}

      {mismatch && (
        <p role="status" data-testid="gate-disc-mismatch" className={`mt-2 ${noticeClass.warning}`}>
          {t('gateDiscPlateMismatch', disc.plate)}
        </p>
      )}
    </section>
  );
}
