'use client';

import React from 'react';
import { AlertTriangle, QrCode, Radio, Square } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { NfcErrorKind, NfcSupport } from '@/lib/nfc/webNfc';
import type { NfcPatrolControls, NfcReadIssue } from './useNfcPatrol';
import type { Translate } from './patrolText';

interface PatrolScanControlsProps {
  /** false while checkpoints are not available: scanning could only fail. */
  canScan: boolean;
  onOpenQr: () => void;
  /** Called synchronously from the Start NFC tap (Web NFC needs the user gesture). */
  onStartNfc: () => void;
  nfc: NfcPatrolControls;
}

function supportText(t: Translate, support: Exclude<NfcSupport, 'supported'>): string {
  switch (support) {
    case 'ios':
      return t('patrolNfcIos');
    case 'insecure_context':
      return t('patrolNfcInsecure');
    case 'iframe':
      return t('patrolNfcIframe');
    default:
      return t('patrolNfcBrowser');
  }
}

function errorText(t: Translate, kind: NfcErrorKind, message: string, support: NfcSupport | null): string {
  switch (kind) {
    case 'permission_denied':
      return t('patrolNfcDenied');
    case 'needs_user_gesture':
      return t('patrolNfcNeedsTap');
    case 'no_hardware':
      return t('patrolNfcNoHardware');
    case 'nfc_disabled':
      return t('patrolNfcDisabled');
    case 'insecure_context':
      return t('patrolNfcInsecure');
    case 'unsupported':
      return support && support !== 'supported' ? supportText(t, support) : t('patrolNfcBrowser');
    case 'read_failed':
      return t('patrolNfcReadFailed');
    case 'empty_serial':
      return t('patrolNfcEmptySerial');
    case 'invalid_serial':
      return t('patrolNfcInvalidSerial');
    default:
      return t('patrolNfcUnknownError', message);
  }
}

function readIssueText(t: Translate, issue: NfcReadIssue): string {
  if (issue.kind === 'empty_serial') return t('patrolNfcEmptySerial');
  if (issue.kind === 'invalid_serial') return t('patrolNfcInvalidSerial');
  return t('patrolNfcReadFailed');
}

const primaryButton =
  'flex min-h-16 w-full items-center justify-center gap-3 rounded-xl bg-ee-primary px-4 font-display text-xl font-bold text-ee-on-primary hover:bg-ee-primary-strong active:bg-ee-primary-strong disabled:opacity-50';
const secondaryButton =
  'flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border border-ee-border bg-ee-surface px-4 font-display text-lg font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50';

/** "Scan QR card" and the single NFC patrol session, with honest support / error explanations. */
export function PatrolScanControls({ canScan, onOpenQr, onStartNfc, nfc }: PatrolScanControlsProps) {
  const { t } = useTranslation();
  const { support, state, readIssue } = nfc;
  const listening = state.status === 'listening';

  let nfcStatus: React.ReactNode = null;
  if (support && support !== 'supported') {
    nfcStatus = (
      <p className="flex items-start gap-2 text-sm text-ee-muted" data-testid="patrol-nfc-unsupported" data-support={support}>
        <Radio className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{supportText(t, support)}</span>
      </p>
    );
  } else if (support === 'supported') {
    let tone = 'text-ee-muted';
    let text = t('patrolNfcOff');
    if (state.status === 'starting') text = t('patrolNfcStarting');
    else if (state.status === 'listening') {
      tone = 'text-ee-success';
      text = t('patrolNfcListening');
    } else if (state.status === 'paused') {
      tone = 'text-ee-warning';
      text = t('patrolNfcPaused');
    } else if (state.status === 'error') {
      tone = 'text-ee-danger';
      text = errorText(t, state.kind, state.message, support);
    }
    nfcStatus = (
      <div aria-live="polite" className="space-y-1 text-sm">
        <p
          className={`flex items-start gap-2 font-semibold ${tone}`}
          data-testid={state.status === 'error' ? 'patrol-nfc-error' : 'patrol-nfc-status'}
          data-state={state.status}
          data-kind={state.status === 'error' ? state.kind : undefined}
        >
          {state.status === 'error' ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <Radio className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span>{text}</span>
        </p>
        {listening && readIssue && (
          <p className="ml-6 font-semibold text-ee-warning" data-testid="patrol-nfc-read-issue" data-kind={readIssue.kind}>
            {readIssueText(t, readIssue)}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-3" aria-label={t('patrolHeading')}>
      <button type="button" onClick={onOpenQr} disabled={!canScan} className={primaryButton} data-testid="patrol-qr-open">
        <QrCode className="h-7 w-7 shrink-0" aria-hidden="true" />
        <span>{t('patrolScanQr')}</span>
      </button>

      {support === 'supported' &&
        (listening || state.status === 'starting' ? (
          <button
            type="button"
            onClick={nfc.stop}
            className={secondaryButton}
            data-testid="patrol-nfc-stop"
            aria-pressed="true"
          >
            <Square className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{t('patrolNfcStop')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onStartNfc}
            disabled={!canScan}
            className={secondaryButton}
            data-testid="patrol-nfc-start"
            aria-pressed="false"
          >
            <Radio className="h-6 w-6 shrink-0" aria-hidden="true" />
            <span>{t('patrolNfcStart')}</span>
          </button>
        ))}

      {nfcStatus}
    </section>
  );
}
