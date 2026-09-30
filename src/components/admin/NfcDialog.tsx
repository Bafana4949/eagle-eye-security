'use client';

import React from 'react';
import { Nfc, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { Checkpoint, Site } from '@/types/models';
import type { NfcSupport } from '@/lib/nfc/webNfc';
import { formatSastDateTime } from './format';
import type { TagHolder } from './adminData';
import type { NfcFailureReason, NfcSessionState } from './useNfcTagSession';
import { Dialog, ErrorNotice, Notice } from './ui';

export const NFC_SUPPORT_KEYS: Record<Exclude<NfcSupport, 'supported'>, TranslationKey> = {
  ios: 'admNfcIos',
  insecure_context: 'admNfcInsecure',
  iframe: 'admNfcIframe',
  unsupported_browser: 'admNfcUnsupported'
};

export const NFC_FAILURE_KEYS: Record<NfcFailureReason, TranslationKey> = {
  permission_denied: 'admNfcErrPermission',
  needs_user_gesture: 'admNfcErrGesture',
  no_hardware: 'admNfcErrNoHardware',
  nfc_disabled: 'admNfcErrDisabled',
  cancelled: 'admNfcErrCancelled',
  read_failed: 'admNfcErrReadFailed',
  empty_serial: 'admNfcErrEmptySerial',
  invalid_serial: 'admNfcErrInvalidSerial',
  insecure_context: 'admNfcInsecure',
  unsupported: 'admNfcUnsupported',
  unknown: 'admNfcErrUnknown',
  timeout: 'admNfcErrTimeout',
  server: 'admNfcErrServer'
};

interface NfcDialogProps {
  state: NfcSessionState;
  sites: Site[];
  /** Name of the site whose checkpoint list the test result is resolved against. */
  selectedSiteName: string;
  onClose: () => void;
  /** Starts the same kind of session again (called from the click handler). */
  onRetry: (mode: 'enrol' | 'test', checkpoint?: Checkpoint) => void;
  onMoveHere: (checkpoint: Checkpoint, serial: string, holders: TagHolder[]) => void;
}

function holderLabel(holder: TagHolder, sites: Site[]): string {
  const site = sites.find((s) => s.id === holder.siteId);
  return site ? `${holder.name} (${site.name})` : holder.name;
}

export function NfcDialog({ state, sites, selectedSiteName, onClose, onRetry, onMoveHere }: NfcDialogProps) {
  const { t, language } = useTranslation();
  if (state.phase === 'idle') return null;

  const mode = 'mode' in state ? state.mode : state.phase === 'tested' ? 'test' : 'enrol';
  const checkpoint = 'checkpoint' in state ? state.checkpoint : undefined;
  const title = mode === 'test' ? t('admNfcTestTitle') : t('admNfcEnrolTitle', checkpoint?.name ?? '');
  const busy = state.phase === 'saving' || state.phase === 'moving';
  /** No usable answer from the server: the write may or may not have happened. */
  const unconfirmed = state.phase === 'failed' && (state.error?.kind === 'network' || state.error?.kind === 'not_confirmed');

  return (
    <Dialog open title={title} onClose={onClose} dismissible={!busy} testId="admin-nfc-dialog">
      <div className="space-y-4" aria-live="polite" data-testid="admin-nfc-status" data-phase={state.phase}>
        {state.phase === 'unsupported' && (
          <>
            <Notice tone="warning" title={t('admNfcNotAvailable')}>
              {t(NFC_SUPPORT_KEYS[state.support])}
            </Notice>
            <p className="flex items-start gap-2 text-sm text-ee-text">
              <QrCode className="h-5 w-5 flex-none text-ee-primary" aria-hidden />
              <span>{t('admNfcUseQrFallback')}</span>
            </p>
          </>
        )}

        {state.phase === 'scanning' && (
          <div className="flex flex-col items-center text-center gap-3 py-2">
            <Nfc className="h-14 w-14 text-ee-primary" aria-hidden />
            <p className="font-display text-2xl font-bold text-ee-text" data-testid="admin-nfc-prompt">
              {t('admNfcHoldPhone')}
            </p>
            <p className="text-sm text-ee-muted">{state.listening ? t('admNfcListening') : t('admNfcStarting')}</p>
            {state.readFailed && <Notice tone="warning">{t('admNfcErrReadFailed')}</Notice>}
            <p className="text-xs text-ee-muted">{t('admNfcTimeoutHint', 60)}</p>
          </div>
        )}

        {state.phase === 'saving' && (
          <Notice tone="info" title={state.mode === 'test' ? t('admNfcLookingUp') : t('admNfcSaving')}>
            <span className="font-mono">{state.serial}</span>
          </Notice>
        )}

        {state.phase === 'moving' && (
          <Notice tone="info" title={t('admNfcMoving')}>
            <span className="font-mono">{state.serial}</span>
          </Notice>
        )}

        {state.phase === 'enrolled' && (
          <Notice tone="success" title={t('admNfcEnrolled', state.checkpoint.name)} testId="admin-nfc-enrolled">
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ee-muted">{t('admNfcSerial')}</dt>
              <dd className="font-mono break-all" data-testid="admin-nfc-enrolled-serial">
                {state.serial}
              </dd>
              <dt className="text-ee-muted">{t('admNfcEnrolledAt')}</dt>
              <dd data-testid="admin-nfc-enrolled-at">{formatSastDateTime(state.enrolledAt, language)}</dd>
            </dl>
            {state.releasedFrom && <p className="mt-1 text-sm">{t('admNfcReleasedFrom', state.releasedFrom.name)}</p>}
            <p className="mt-1 text-xs text-ee-muted">{t('admNfcReadBackNote')}</p>
          </Notice>
        )}

        {state.phase === 'duplicate' && (
          <>
            <Notice tone="warning" title={t('admNfcDuplicateTitle')} testId="admin-nfc-duplicate">
              {state.holders && state.holders.length > 0 ? (
                <p>{t('admNfcDuplicateBody', state.holders.map((h) => holderLabel(h, sites)).join(', '))}</p>
              ) : (
                <p>{t('admNfcDuplicateUnknownHolder')}</p>
              )}
              <p className="mt-1 text-sm">
                {t('admNfcSerial')}: <span className="font-mono">{state.serial}</span>
              </p>
            </Notice>
            {state.lookupError && <ErrorNotice error={state.lookupError} />}
            {state.holders && state.holders.length > 0 && <p className="text-sm text-ee-muted">{t('admNfcMoveExplain', state.checkpoint.name)}</p>}
          </>
        )}

        {state.phase === 'tested' && (
          <div className="space-y-3" data-testid="admin-nfc-test-result">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-ee-muted">{t('admNfcSerial')}</dt>
              <dd className="font-mono break-all">{state.reading.serial}</dd>
              <dt className="text-ee-muted">{t('admNfcSerialRaw')}</dt>
              <dd className="font-mono break-all">{state.reading.serialRaw}</dd>
            </dl>
            {state.lookupError ? (
              <ErrorNotice error={state.lookupError} title={t('admNfcLookupFailed')} />
            ) : state.holders && state.holders.length > 0 ? (
              <Notice tone="success" title={t('admNfcTestRegistered')} testId="admin-nfc-test-holders">
                <ul className="list-disc pl-5">
                  {state.holders.map((holder) => (
                    <li key={holder.id}>
                      {holderLabel(holder, sites)} – {holder.isActive ? t('admActive') : t('admInactive')}
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : (
              <Notice tone="warning" testId="admin-nfc-test-unregistered">
                {t('admNfcTestNotRegistered')}
              </Notice>
            )}
            {state.resolution && (
              <p className="text-sm text-ee-text" data-testid="admin-nfc-test-resolution">
                {state.resolution.ok
                  ? t('admNfcResolvesTo', selectedSiteName, state.resolution.checkpoint.name)
                  : state.resolution.reason === 'inactive'
                    ? t('admNfcResolvesInactive', selectedSiteName, state.resolution.checkpoint.name)
                    : t('admNfcResolvesNone', selectedSiteName)}
              </p>
            )}
          </div>
        )}

        {state.phase === 'failed' && (
          <>
            {state.error ? (
              <ErrorNotice
                error={state.error}
                title={unconfirmed ? t('admErrNotConfirmed') : t(NFC_FAILURE_KEYS[state.reason])}
                testId="admin-nfc-error"
              />
            ) : (
              <Notice tone="danger" testId="admin-nfc-error">
                {t(NFC_FAILURE_KEYS[state.reason])}
              </Notice>
            )}
            {state.releasedFrom && (
              <Notice tone="warning">
                {unconfirmed ? t('admNfcReleasedFrom', state.releasedFrom.name) : t('admNfcPartialMove', state.releasedFrom.name)}
              </Notice>
            )}
            {state.mode === 'enrol' && (
              <p className="text-sm text-ee-muted" data-testid="admin-nfc-saved-state">
                {unconfirmed ? t('admNfcNotConfirmed') : state.releasedFrom ? null : t('admNfcNothingSaved')}
              </p>
            )}
            {(state.reason === 'empty_serial' || state.reason === 'invalid_serial') && (
              <p className="text-sm text-ee-text">{t('admNfcUseQrFallback')}</p>
            )}
          </>
        )}
      </div>

      <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        {state.phase === 'scanning' && (
          <Button type="button" variant="secondary" className="min-h-12" onClick={onClose} data-testid="admin-nfc-cancel">
            {t('admCancel')}
          </Button>
        )}
        {state.phase === 'duplicate' && (
          <>
            <Button type="button" variant="secondary" className="min-h-12" onClick={onClose} data-testid="admin-nfc-cancel">
              {t('admCancel')}
            </Button>
            {state.holders && state.holders.length > 0 && (
              <Button
                type="button"
                variant="warning"
                className="min-h-12"
                onClick={() => onMoveHere(state.checkpoint, state.serial, state.holders ?? [])}
                data-testid="admin-nfc-move-here"
              >
                {t('admNfcMoveHere', state.checkpoint.name)}
              </Button>
            )}
          </>
        )}
        {(state.phase === 'failed' || state.phase === 'tested') && (
          <Button
            type="button"
            variant="secondary"
            className="min-h-12"
            onClick={() => onRetry(state.phase === 'tested' ? 'test' : state.mode, state.phase === 'failed' ? state.checkpoint : undefined)}
            data-testid="admin-nfc-retry"
          >
            {state.phase === 'tested' ? t('admNfcTestAnother') : t('admTryAgain')}
          </Button>
        )}
        {(state.phase === 'enrolled' || state.phase === 'failed' || state.phase === 'tested' || state.phase === 'unsupported') && (
          <Button type="button" variant="primary" className="min-h-12" onClick={onClose} data-testid="admin-nfc-close">
            {t('admClose')}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
