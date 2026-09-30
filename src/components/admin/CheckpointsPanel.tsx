'use client';

/**
 * Checkpoints of one site: create / edit, QR card display and printing (tokens read through the
 * audited get_checkpoint_secrets RPC only when asked), QR token rotation, NFC tag registration /
 * removal / test, activation and deletion. Every change is written to Supabase and the list is
 * updated from the row the database returned.
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Nfc, Plus, Printer, QrCode, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import { getNfcSupport } from '@/lib/nfc/webNfc';
import type { Checkpoint, Site } from '@/types/models';
import {
  createCheckpoint,
  deleteCheckpoint,
  loadCheckpointSecrets,
  loadSiteCheckpoints,
  removeNfcTag,
  rotateCheckpointToken,
  setCheckpointActive,
  updateCheckpoint,
  type AdminError
} from './adminData';
import { withDb } from './withDb';
import { cardReference, checkpointToFormValues, newCheckpointFormValues } from './validation';
import { formatCoordinate, formatSastDateTime } from './format';
import { CheckpointForm } from './CheckpointForm';
import { NfcDialog, NFC_SUPPORT_KEYS } from './NfcDialog';
import { makeQrDataUrl, type PrintCard } from './QrPrintSheet';
import { useNfcTagSession } from './useNfcTagSession';
import { ConfirmDialog, Dialog, ErrorNotice, Notice, SectionTitle } from './ui';

interface CheckpointsPanelProps {
  site: Site | null;
  sites: Site[];
  onPrint: (cards: PrintCard[]) => void;
}

type LoadState = { key: string; items: Checkpoint[] } | { key: string; error: AdminError };

type ConfirmKind = 'delete' | 'rotate' | 'removeTag' | 'deactivate' | 'activate';

interface RowMessage {
  checkpointId: string;
  tone: 'success' | 'warning' | 'danger';
  text: string;
  error?: AdminError;
  offer?: 'deactivate' | 'print';
}

type QrDialogState =
  | { status: 'loading'; checkpoint: Checkpoint }
  | { status: 'ready'; checkpoint: Checkpoint; dataUrl: string; cardRef: string; nfcUid: string | null }
  | { status: 'error'; checkpoint: Checkpoint; error: AdminError | null };

function sortCheckpoints(items: Checkpoint[]): Checkpoint[] {
  return [...items].sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name));
}

export function CheckpointsPanel({ site, sites, onPrint }: CheckpointsPanelProps) {
  const { t, language } = useTranslation();
  const siteId = site?.id ?? null;
  const [reloadToken, setReloadToken] = useState(0);
  const [data, setData] = useState<LoadState | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<RowMessage | null>(null);
  const [panelMessage, setPanelMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string; error?: AdminError } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; checkpoint: Checkpoint } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [qrDialog, setQrDialog] = useState<QrDialogState | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [nfcSupport] = useState(() => getNfcSupport());

  const loadKey = siteId ? `${siteId}:${reloadToken}` : null;

  useEffect(() => {
    if (!siteId) return;
    const key = `${siteId}:${reloadToken}`;
    let cancelled = false;
    void withDb((db) => loadSiteCheckpoints(db, siteId)).then((result) => {
      if (cancelled) return;
      setData(result.ok ? { key, items: sortCheckpoints(result.value) } : { key, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [siteId, reloadToken]);

  const current = data && data.key === loadKey ? data : null;
  const items = current && 'items' in current ? current.items : [];

  const storeCheckpoint = (checkpoint: Checkpoint) => {
    setData((state) => {
      if (!state || !('items' in state)) return state;
      const others = state.items.filter((item) => item.id !== checkpoint.id);
      return checkpoint.siteId === siteId ? { ...state, items: sortCheckpoints([...others, checkpoint]) } : { ...state, items: others };
    });
  };

  const nfc = useNfcTagSession(storeCheckpoint);
  const testContext = { siteCheckpoints: items, allowLegacyQr: site?.allowLegacyQr ?? false };

  if (!site) {
    return <Notice tone="info">{t('admSelectSiteFirst')}</Notice>;
  }

  const reload = () => {
    setRowMessage(null);
    setPanelMessage(null);
    setReloadToken((n) => n + 1);
  };

  const openQr = async (checkpoint: Checkpoint) => {
    setQrDialog({ status: 'loading', checkpoint });
    const secrets = await withDb((db) => loadCheckpointSecrets(db, site.id));
    if (!secrets.ok) {
      setQrDialog({ status: 'error', checkpoint, error: secrets.error });
      return;
    }
    const secret = secrets.value.find((s) => s.checkpointId === checkpoint.id);
    if (!secret) {
      setQrDialog({ status: 'error', checkpoint, error: null });
      return;
    }
    try {
      const dataUrl = await makeQrDataUrl(secret.qrToken);
      setQrDialog({ status: 'ready', checkpoint, dataUrl, cardRef: cardReference(secret.qrToken), nfcUid: secret.nfcUid });
    } catch (error) {
      setQrDialog({ status: 'error', checkpoint, error: { kind: 'error', message: error instanceof Error ? error.message : String(error) } });
    }
  };

  const printCheckpoints = async (targets: Checkpoint[]) => {
    setPanelMessage(null);
    if (targets.length === 0) {
      setPanelMessage({ tone: 'warning', text: t('admPrintNothing') });
      return;
    }
    setPrintBusy(true);
    const secrets = await withDb((db) => loadCheckpointSecrets(db, site.id));
    if (!secrets.ok) {
      setPrintBusy(false);
      setPanelMessage({ tone: 'danger', text: t('admPrintFailed'), error: secrets.error });
      return;
    }
    const cards: PrintCard[] = [];
    try {
      for (const checkpoint of targets) {
        const secret = secrets.value.find((s) => s.checkpointId === checkpoint.id);
        if (!secret) continue;
        cards.push({
          checkpointId: checkpoint.id,
          name: checkpoint.name,
          siteName: site.name,
          orderIndex: checkpoint.orderIndex,
          cardRef: cardReference(secret.qrToken),
          dataUrl: await makeQrDataUrl(secret.qrToken)
        });
      }
    } catch (error) {
      setPrintBusy(false);
      setPanelMessage({ tone: 'danger', text: t('admPrintFailed'), error: { kind: 'error', message: error instanceof Error ? error.message : String(error) } });
      return;
    }
    setPrintBusy(false);
    if (cards.length === 0) {
      setPanelMessage({ tone: 'warning', text: t('admPrintNothing') });
      return;
    }
    setPanelMessage({ tone: 'success', text: t('admPrintOpened', cards.length) });
    onPrint(cards);
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, checkpoint } = confirm;
    setConfirmBusy(true);
    setRowMessage(null);
    setPanelMessage(null);
    if (kind === 'delete') {
      const result = await withDb((db) => deleteCheckpoint(db, checkpoint.id));
      setConfirmBusy(false);
      setConfirm(null);
      if (result.ok) {
        setData((state) => (state && 'items' in state ? { ...state, items: state.items.filter((i) => i.id !== checkpoint.id) } : state));
        setExpanded(null);
        setPanelMessage({ tone: 'success', text: t('admCheckpointDeleted', checkpoint.name) });
      } else if (result.error.problem === 'in_use' || result.error.kind === 'in_use') {
        setRowMessage({ checkpointId: checkpoint.id, tone: 'warning', text: t('admCheckpointInUseOffer'), offer: checkpoint.isActive ? 'deactivate' : undefined });
      } else {
        setRowMessage({ checkpointId: checkpoint.id, tone: 'danger', text: t('admCheckpointNotDeleted'), error: result.error });
      }
      return;
    }
    const result =
      kind === 'rotate'
        ? await withDb((db) => rotateCheckpointToken(db, checkpoint.id))
        : kind === 'removeTag'
          ? await withDb((db) => removeNfcTag(db, checkpoint.id))
          : await withDb((db) => setCheckpointActive(db, checkpoint.id, kind === 'activate'));
    setConfirmBusy(false);
    setConfirm(null);
    if (!result.ok) {
      setRowMessage({ checkpointId: checkpoint.id, tone: 'danger', text: t('admCheckpointNotSaved'), error: result.error });
      return;
    }
    storeCheckpoint(result.value);
    const successText: Record<Exclude<ConfirmKind, 'delete'>, TranslationKey> = {
      rotate: 'admTokenRotated',
      removeTag: 'admTagRemoved',
      deactivate: 'admCheckpointDeactivated',
      activate: 'admCheckpointActivated'
    };
    setRowMessage({
      checkpointId: checkpoint.id,
      tone: kind === 'rotate' ? 'warning' : 'success',
      text: t(successText[kind], result.value.name),
      offer: kind === 'rotate' && result.value.isActive ? 'print' : undefined
    });
  };

  const confirmTexts: Record<ConfirmKind, { title: TranslationKey; body: TranslationKey; action: TranslationKey; tone: 'danger' | 'primary' }> = {
    delete: { title: 'admConfirmDeleteTitle', body: 'admConfirmDeleteBody', action: 'admDelete', tone: 'danger' },
    rotate: { title: 'admConfirmRotateTitle', body: 'admConfirmRotateBody', action: 'admRotateToken', tone: 'danger' },
    removeTag: { title: 'admConfirmRemoveTagTitle', body: 'admConfirmRemoveTagBody', action: 'admRemoveTag', tone: 'danger' },
    deactivate: { title: 'admConfirmDeactivateTitle', body: 'admConfirmDeactivateBody', action: 'admDeactivate', tone: 'danger' },
    activate: { title: 'admConfirmActivateTitle', body: 'admConfirmActivateBody', action: 'admActivate', tone: 'primary' }
  };

  const activeCount = items.filter((cp) => cp.isActive).length;

  return (
    <section className="space-y-4" aria-labelledby="admin-checkpoints-heading" data-testid="admin-checkpoints-panel">
      <SectionTitle id="admin-checkpoints-heading">{t('admCheckpointsTitle', site.name)}</SectionTitle>

      {nfcSupport !== 'supported' && (
        <Notice tone="info" testId="admin-nfc-support">
          {t(NFC_SUPPORT_KEYS[nfcSupport])} {t('admNfcUseQrFallback')}
        </Notice>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Button type="button" variant="primary" className="min-h-12 gap-2" onClick={() => setAdding((v) => !v)} aria-expanded={adding} data-testid="admin-checkpoint-add-toggle">
          <Plus className="h-4 w-4" aria-hidden />
          <span>{t('admAddCheckpoint')}</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-12 gap-2"
          disabled={printBusy || !current || !('items' in current)}
          onClick={() => void printCheckpoints(items.filter((cp) => cp.isActive))}
          data-testid="admin-checkpoints-print"
        >
          <Printer className="h-4 w-4" aria-hidden />
          <span>{printBusy ? t('admPreparingPrint') : t('admPrintAllCards', activeCount)}</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-12 gap-2"
          onClick={() => nfc.start('test', undefined, testContext)}
          data-testid="admin-nfc-test"
        >
          <Nfc className="h-4 w-4" aria-hidden />
          <span>{t('admTestTag')}</span>
        </Button>
      </div>
      <p className="text-xs text-ee-muted">{t('admSecretsAuditedHint')}</p>

      <div aria-live="polite">
        {panelMessage &&
          (panelMessage.error ? (
            <ErrorNotice error={panelMessage.error} title={panelMessage.text} testId="admin-checkpoints-message" />
          ) : (
            <Notice tone={panelMessage.tone} testId="admin-checkpoints-message">
              {panelMessage.text}
            </Notice>
          ))}
      </div>

      {adding && (
        <div className="rounded-2xl border border-ee-border bg-ee-surface p-4">
          <h3 className="font-display text-xl font-bold mb-3">{t('admNewCheckpoint')}</h3>
          <CheckpointForm
            idPrefix="admin-new-cp"
            testIdPrefix="admin-checkpoint-new"
            initial={newCheckpointFormValues(site.defaultRadiusMeters, items)}
            submitLabel={t('admCreateCheckpoint')}
            onSubmit={(input) => withDb((db) => createCheckpoint(db, site.id, input))}
            onStored={(checkpoint) => {
              storeCheckpoint(checkpoint);
              setAdding(false);
              setPanelMessage({ tone: 'success', text: t('admCheckpointCreated', checkpoint.name) });
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {!current ? (
        <p className="text-sm text-ee-muted" role="status" data-testid="admin-checkpoints-loading">
          {t('admLoading')}
        </p>
      ) : 'error' in current ? (
        <div className="space-y-2">
          <ErrorNotice error={current.error} title={t('admCheckpointsLoadFailed')} testId="admin-checkpoints-error" />
          <Button type="button" variant="secondary" className="min-h-12 gap-2" onClick={reload} data-testid="admin-checkpoints-reload">
            <RefreshCw className="h-4 w-4" aria-hidden />
            <span>{t('admTryAgain')}</span>
          </Button>
        </div>
      ) : items.length === 0 ? (
        <Notice tone="info" testId="admin-checkpoints-empty">
          {t('admNoCheckpoints')}
        </Notice>
      ) : (
        <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="admin-checkpoint-list">
          {items.map((checkpoint) => {
            const isOpen = expanded === checkpoint.id;
            const message = rowMessage && rowMessage.checkpointId === checkpoint.id ? rowMessage : null;
            const hasTag = Boolean(checkpoint.nfcUidSha256);
            return (
              <li key={checkpoint.id} className="py-3 space-y-2" data-testid={`admin-checkpoint-row-${checkpoint.id}`}>
                <div className="flex items-start gap-3">
                  <span className="font-display text-2xl font-bold text-ee-muted w-10 flex-none text-right" aria-hidden>
                    {checkpoint.orderIndex}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ee-text break-words">
                      {checkpoint.name}{' '}
                      <span className={`text-xs font-semibold ${checkpoint.isActive ? 'text-ee-success' : 'text-ee-muted'}`}>
                        {checkpoint.isActive ? t('admActive') : t('admInactive')}
                      </span>
                    </p>
                    {checkpoint.description && <p className="text-sm text-ee-muted break-words">{checkpoint.description}</p>}
                    <ul className="mt-1 space-y-0.5 text-xs text-ee-muted">
                      <li>{t('admOrderRadius', checkpoint.orderIndex, checkpoint.permittedRadiusMeters)}</li>
                      <li>
                        {checkpoint.latitude !== undefined && checkpoint.longitude !== undefined
                          ? t('admLocationValue', formatCoordinate(checkpoint.latitude), formatCoordinate(checkpoint.longitude))
                          : t('admNoLocation')}
                      </li>
                      <li className={hasTag ? 'text-ee-success' : undefined} data-testid={`admin-checkpoint-nfc-state-${checkpoint.id}`}>
                        {hasTag
                          ? checkpoint.nfcEnrolledAt
                            ? t('admTagRegisteredAt', formatSastDateTime(checkpoint.nfcEnrolledAt, language))
                            : t('admTagRegistered')
                          : t('admNoTag')}
                      </li>
                      {checkpoint.legacyCode && <li>{t('admLegacyCodeValue', checkpoint.legacyCode)}</li>}
                      {checkpoint.qrTokenStrong === false && (
                        <li className="text-ee-warning font-semibold" data-testid={`admin-checkpoint-weak-${checkpoint.id}`}>
                          {t('admWeakToken')}
                        </li>
                      )}
                    </ul>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 sm:pl-13">
                  <Button type="button" variant="secondary" className="min-h-12 gap-2" onClick={() => void openQr(checkpoint)} data-testid={`admin-checkpoint-qr-${checkpoint.id}`}>
                    <QrCode className="h-4 w-4" aria-hidden />
                    <span>{t('admQrCard')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-12 gap-2"
                    onClick={() => nfc.start('enrol', checkpoint)}
                    disabled={!checkpoint.isActive}
                    data-testid={`admin-checkpoint-nfc-${checkpoint.id}`}
                  >
                    <Nfc className="h-4 w-4" aria-hidden />
                    <span>{hasTag ? t('admReplaceTag') : t('admRegisterTag')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-12 gap-2"
                    onClick={() => setExpanded(isOpen ? null : checkpoint.id)}
                    aria-expanded={isOpen}
                    aria-controls={`admin-cp-manage-${checkpoint.id}`}
                    data-testid={`admin-checkpoint-manage-${checkpoint.id}`}
                  >
                    {isOpen ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                    <span>{t('admManage')}</span>
                  </Button>
                </div>

                <div aria-live="polite">
                  {message && (
                    <div className="space-y-2" data-testid="admin-checkpoint-message">
                      {message.error ? (
                        <ErrorNotice error={message.error} title={message.text} write />
                      ) : (
                        <Notice tone={message.tone}>{message.text}</Notice>
                      )}
                      {message.offer === 'deactivate' && (
                        <Button type="button" variant="secondary" className="min-h-12" onClick={() => setConfirm({ kind: 'deactivate', checkpoint })} data-testid={`admin-checkpoint-offer-deactivate-${checkpoint.id}`}>
                          {t('admDeactivateInstead')}
                        </Button>
                      )}
                      {message.offer === 'print' && (
                        <Button type="button" variant="primary" className="min-h-12 gap-2" onClick={() => void printCheckpoints([checkpoint])} data-testid={`admin-checkpoint-offer-print-${checkpoint.id}`}>
                          <Printer className="h-4 w-4" aria-hidden />
                          <span>{t('admPrintNewCard')}</span>
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {isOpen && (
                  <div id={`admin-cp-manage-${checkpoint.id}`} className="rounded-2xl border border-ee-border bg-ee-surface p-4 space-y-4">
                    <CheckpointForm
                      key={`${checkpoint.id}:${checkpoint.name}:${checkpoint.orderIndex}:${checkpoint.permittedRadiusMeters}:${checkpoint.latitude}:${checkpoint.longitude}:${checkpoint.legacyCode}`}
                      idPrefix={`admin-cp-${checkpoint.id}`}
                      testIdPrefix="admin-checkpoint-edit"
                      initial={checkpointToFormValues(checkpoint)}
                      submitLabel={t('admSaveCheckpoint')}
                      onSubmit={(input) => withDb((db) => updateCheckpoint(db, checkpoint.id, input))}
                      onStored={(stored) => {
                        storeCheckpoint(stored);
                        setRowMessage({ checkpointId: stored.id, tone: 'success', text: t('admCheckpointSaved', stored.name) });
                      }}
                      onCancel={() => setExpanded(null)}
                    />
                    <div className="border-t border-ee-border pt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {hasTag && (
                        <Button type="button" variant="outline" className="min-h-12" onClick={() => setConfirm({ kind: 'removeTag', checkpoint })} data-testid={`admin-checkpoint-remove-tag-${checkpoint.id}`}>
                          {t('admRemoveTag')}
                        </Button>
                      )}
                      <Button type="button" variant="outline" className="min-h-12" onClick={() => setConfirm({ kind: 'rotate', checkpoint })} data-testid={`admin-checkpoint-rotate-${checkpoint.id}`}>
                        {t('admRotateToken')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-12"
                        onClick={() => setConfirm({ kind: checkpoint.isActive ? 'deactivate' : 'activate', checkpoint })}
                        data-testid={`admin-checkpoint-toggle-active-${checkpoint.id}`}
                      >
                        {checkpoint.isActive ? t('admDeactivate') : t('admActivate')}
                      </Button>
                      <Button type="button" variant="danger" className="min-h-12" onClick={() => setConfirm({ kind: 'delete', checkpoint })} data-testid={`admin-checkpoint-delete-${checkpoint.id}`}>
                        {t('admDelete')}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {current && 'items' in current && (
        <Button type="button" variant="ghost" className="min-h-12 gap-2" onClick={reload} data-testid="admin-checkpoints-reload">
          <RefreshCw className="h-4 w-4" aria-hidden />
          <span>{t('admReloadFromServer')}</span>
        </Button>
      )}

      {confirm && (
        <ConfirmDialog
          open
          title={t(confirmTexts[confirm.kind].title, confirm.checkpoint.name)}
          confirmLabel={t(confirmTexts[confirm.kind].action)}
          tone={confirmTexts[confirm.kind].tone}
          busy={confirmBusy}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
          testId="admin-confirm-dialog"
        >
          <p>{t(confirmTexts[confirm.kind].body, confirm.checkpoint.name)}</p>
        </ConfirmDialog>
      )}

      {qrDialog && (
        <Dialog open title={t('admQrCardTitle', qrDialog.checkpoint.name)} onClose={() => setQrDialog(null)} testId="admin-qr-dialog">
          <div aria-live="polite" className="space-y-3">
            {qrDialog.status === 'loading' && <p className="text-sm text-ee-muted">{t('admLoading')}</p>}
            {qrDialog.status === 'error' &&
              (qrDialog.error ? (
                <ErrorNotice error={qrDialog.error} title={t('admQrLoadFailed')} testId="admin-qr-error" />
              ) : (
                <Notice tone="danger" testId="admin-qr-error">
                  {t('admQrMissing')}
                </Notice>
              ))}
            {qrDialog.status === 'ready' && (
              <>
                <div className="mx-auto w-full max-w-xs rounded-xl bg-ee-text p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URL generated on this device */}
                  <img src={qrDialog.dataUrl} alt={t('admQrAlt', qrDialog.checkpoint.name)} className="w-full h-auto" data-testid="admin-qr-image" />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-ee-muted">{t('admCardRef')}</dt>
                  <dd className="font-mono" data-testid="admin-qr-card-ref">
                    …{qrDialog.cardRef}
                  </dd>
                  <dt className="text-ee-muted">{t('admNfcSerial')}</dt>
                  <dd className="font-mono break-all" data-testid="admin-qr-nfc-serial">
                    {qrDialog.nfcUid ?? t('admNoTag')}
                  </dd>
                </dl>
                <p className="text-xs text-ee-muted">{t('admSecretsViewedNote')}</p>
                {!qrDialog.checkpoint.isActive && <Notice tone="warning">{t('admPrintInactiveWarning')}</Notice>}
                <Button
                  type="button"
                  variant="primary"
                  className="min-h-12 w-full gap-2"
                  onClick={() => {
                    const ready = qrDialog;
                    setQrDialog(null);
                    onPrint([
                      {
                        checkpointId: ready.checkpoint.id,
                        name: ready.checkpoint.name,
                        siteName: site.name,
                        orderIndex: ready.checkpoint.orderIndex,
                        cardRef: ready.cardRef,
                        dataUrl: ready.dataUrl
                      }
                    ]);
                  }}
                  data-testid="admin-qr-print"
                >
                  <Printer className="h-4 w-4" aria-hidden />
                  <span>{t('admPrintThisCard')}</span>
                </Button>
              </>
            )}
          </div>
        </Dialog>
      )}

      <NfcDialog
        state={nfc.state}
        sites={sites}
        selectedSiteName={site.name}
        onClose={() => {
          // A write without a usable answer may or may not have landed: show what the server holds.
          const unconfirmed = nfc.state.phase === 'failed' && (nfc.state.error?.kind === 'network' || nfc.state.error?.kind === 'not_confirmed');
          nfc.close();
          if (unconfirmed) reload();
        }}
        onRetry={(mode, checkpoint) => nfc.start(mode, checkpoint, mode === 'test' ? testContext : undefined)}
        onMoveHere={(checkpoint, serial, holders) => void nfc.moveHere(checkpoint, serial, holders)}
      />
    </section>
  );
}
