'use client';

/**
 * Device-test NFC reader: shows exactly what Web NFC reported for a tag (raw and normalised serial,
 * every NDEF record, time) and which checkpoint the tag is registered to (read-only fingerprint
 * lookup). Nothing is written.
 */
import React, { useState } from 'react';
import { Nfc } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import { getNfcSupport } from '@/lib/nfc/webNfc';
import type { Site } from '@/types/models';
import { formatSastDateTime } from './format';
import { NFC_FAILURE_KEYS, NFC_SUPPORT_KEYS } from './NfcDialog';
import { useNfcTagSession } from './useNfcTagSession';
import { ErrorNotice, Notice } from './ui';

const noop = () => undefined;

export function DeviceNfcTest({ sites }: { sites: Site[] }) {
  const { t, language } = useTranslation();
  const [support] = useState(() => getNfcSupport());
  const nfc = useNfcTagSession(noop);
  const state = nfc.state;
  const scanning = state.phase === 'scanning' || state.phase === 'saving';

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '';

  return (
    <div className="space-y-3" data-testid="admin-device-nfc">
      <p className="text-sm" data-testid="admin-device-nfc-support">
        <span className="text-ee-muted">{t('devNfcSupport')}: </span>
        <span className={support === 'supported' ? 'text-ee-success font-semibold' : 'text-ee-warning font-semibold'}>
          {support === 'supported' ? t('devNfcSupported') : t(NFC_SUPPORT_KEYS[support])}
        </span>
      </p>

      {!scanning ? (
        <Button
          type="button"
          variant="primary"
          className="min-h-14 w-full gap-2 text-base"
          onClick={() => nfc.start('test', undefined, { siteCheckpoints: [], allowLegacyQr: false })}
          data-testid="admin-device-nfc-start"
        >
          <Nfc className="h-5 w-5" aria-hidden />
          <span>{t('devNfcStart')}</span>
        </Button>
      ) : (
        <Button type="button" variant="secondary" className="min-h-14 w-full text-base" onClick={nfc.close} data-testid="admin-device-nfc-cancel">
          {t('admCancel')}
        </Button>
      )}

      <div aria-live="polite" className="space-y-3" data-testid="admin-device-nfc-status" data-phase={state.phase}>
        {state.phase === 'scanning' && (
          <div className="rounded-2xl border border-ee-primary/60 bg-ee-surface p-4 text-center">
            <p className="font-display text-2xl font-bold text-ee-text" data-testid="admin-device-nfc-prompt">
              {t('devNfcHold')}
            </p>
            <p className="text-sm text-ee-muted">{state.listening ? t('admNfcListening') : t('admNfcStarting')}</p>
            {state.readFailed && <p className="mt-1 text-sm text-ee-warning">{t('admNfcErrReadFailed')}</p>}
            <p className="mt-1 text-xs text-ee-muted">{t('admNfcTimeoutHint', 60)}</p>
          </div>
        )}
        {state.phase === 'saving' && <p className="text-sm text-ee-muted">{t('admNfcLookingUp')}</p>}
        {state.phase === 'unsupported' && <Notice tone="warning">{t(NFC_SUPPORT_KEYS[state.support])}</Notice>}
        {state.phase === 'failed' &&
          (state.error ? (
            <ErrorNotice error={state.error} title={t(NFC_FAILURE_KEYS[state.reason])} testId="admin-device-nfc-error" />
          ) : (
            <Notice tone="danger" testId="admin-device-nfc-error">
              {t(NFC_FAILURE_KEYS[state.reason])}
            </Notice>
          ))}
        {state.phase === 'tested' && (
          <div className="rounded-2xl border border-ee-border bg-ee-surface p-4 space-y-3" data-testid="admin-device-nfc-result">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ee-muted">{t('devNfcReadAt')}</dt>
              <dd data-testid="admin-device-nfc-time">{formatSastDateTime(state.reading.timestamp, language)}</dd>
              <dt className="text-ee-muted">{t('admNfcSerialRaw')}</dt>
              <dd className="font-mono break-all" data-testid="admin-device-nfc-serial-raw">
                {state.reading.serialRaw}
              </dd>
              <dt className="text-ee-muted">{t('admNfcSerial')}</dt>
              <dd className="font-mono break-all" data-testid="admin-device-nfc-serial">
                {state.reading.serial}
              </dd>
              <dt className="text-ee-muted">{t('devNfcRecordCount')}</dt>
              <dd>{state.reading.records.length}</dd>
            </dl>

            {state.reading.records.length === 0 ? (
              <p className="text-sm text-ee-muted">{t('devNfcNoRecords')}</p>
            ) : (
              <ol className="space-y-2" data-testid="admin-device-nfc-records">
                {state.reading.records.map((record, index) => (
                  <li key={index} className="rounded-xl border border-ee-border p-2 text-sm">
                    <p className="font-semibold">{t('devNfcRecord', index + 1)}</p>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      <dt className="text-ee-muted">{t('devNfcRecordType')}</dt>
                      <dd className="font-mono break-all">{record.recordType}</dd>
                      <dt className="text-ee-muted">{t('devNfcMediaType')}</dt>
                      <dd className="font-mono break-all">{record.mediaType ?? t('devNone')}</dd>
                      <dt className="text-ee-muted">{t('devNfcEncoding')}</dt>
                      <dd className="font-mono">{record.encoding ?? t('devNone')}</dd>
                      <dt className="text-ee-muted">{t('devNfcLang')}</dt>
                      <dd className="font-mono">{record.lang ?? t('devNone')}</dd>
                      <dt className="text-ee-muted">{t('devNfcRecordId')}</dt>
                      <dd className="font-mono break-all">{record.id ?? t('devNone')}</dd>
                      <dt className="text-ee-muted">{t('devNfcBytes')}</dt>
                      <dd>{record.byteLength}</dd>
                      <dt className="text-ee-muted">{t('devNfcText')}</dt>
                      <dd className="font-mono break-all">{record.text ?? t('devNfcNotText')}</dd>
                    </dl>
                  </li>
                ))}
              </ol>
            )}

            <div data-testid="admin-device-nfc-mapping">
              {state.lookupError ? (
                <ErrorNotice error={state.lookupError} title={t('admNfcLookupFailed')} />
              ) : state.holders && state.holders.length > 0 ? (
                <Notice tone="success" title={t('admNfcTestRegistered')}>
                  <ul className="list-disc pl-5">
                    {state.holders.map((holder) => (
                      <li key={holder.id}>
                        {holder.name}
                        {siteName(holder.siteId) ? ` (${siteName(holder.siteId)})` : ''} – {holder.isActive ? t('admActive') : t('admInactive')}
                      </li>
                    ))}
                  </ul>
                </Notice>
              ) : (
                <Notice tone="warning">{t('admNfcTestNotRegistered')}</Notice>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
