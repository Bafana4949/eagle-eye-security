'use client';

/**
 * "Patrol phones" for admins (admin console tab) and supervisors (supervisor dashboard section).
 *
 * - This phone: enrol it for one site the caller manages (RPC enrol_patrol_device; the secret is
 *   stored only on this phone), or remove the enrolment from this phone (revokes its server entry
 *   too). The enrol form is collapsed behind a button and asks for confirmation that says what an
 *   enrolled phone is: a shared key to every guard account of the site - never a personal phone.
 *   After enrolling, the manager is signed out on this phone at once and lands on /login (Guard
 *   duty): a manager session must never be left on a patrol phone.
 * - What is waiting on this phone: records of the people who used it that have not uploaded yet.
 * - Enrolled phones of the caller's sites (RLS-scoped list): label, site, who enrolled it and
 *   when, last guard sign-in, revoked or active, with "Revoke" (RPC revoke_patrol_device).
 * Every enrolment, revocation and guard sign-in is audited by the database. Nothing here is shown
 * as done before the server confirmed it.
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CloudUpload, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, ErrorNotice, Field, Notice, TextField, inputClass, type NoticeTone } from '@/components/admin/ui';
import { formatSastDateTime } from '@/components/admin/format';
import { withDb } from '@/components/admin/withDb';
import { useAuth } from '@/lib/auth/AuthProvider';
import {
  PATROL_DEVICE_LABEL_MAX,
  enrolThisPhone,
  removeThisPhoneEnrolment,
  revokePatrolDevice,
  saveEnrolledNote,
  type EnrolResult,
  type RevokeResult
} from '@/lib/auth/patrolDevice';
import { useTranslation } from '@/lib/i18n/context';
import type { AdminResult } from '@/components/admin/adminData';
import { createClient } from '@/lib/supabase/client';
import { loadPatrolDevices, type PatrolDeviceList, type PatrolDeviceRow } from './devicesData';
import { useBrowserOnline, usePatrolDevice } from './usePatrolDevice';
import { useQueuedRecords } from './usePhoneRecords';

type Message = { tone: NoticeTone; text: string; testId: string };

const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold leading-5';
const CHIP_ACTIVE = `${CHIP} border-ee-success/50 bg-ee-success/10 text-ee-success`;
const CHIP_REVOKED = `${CHIP} border-ee-border bg-ee-bg text-ee-muted`;
const CHIP_THIS_PHONE = `${CHIP} border-ee-primary/60 bg-ee-primary/15 text-ee-text`;

export function PatrolDevicesPanel({ className }: { className?: string }) {
  const { t, language } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const thisPhone = usePatrolDevice();
  const queued = useQueuedRecords();
  const online = useBrowserOnline();
  const canWrite = online && !auth.isOfflineSession;
  const headingId = useId();
  const siteFieldId = useId();
  const labelFieldId = useId();

  const manageableSites = useMemo(() => auth.sites.filter((site) => site.isActive), [auth.sites]);
  const siteNames = useMemo(() => new Map(auth.sites.map((site) => [site.id, site.name])), [auth.sites]);

  const [listToken, setListToken] = useState(0);
  const [list, setList] = useState<{ token: number; result: AdminResult<PatrolDeviceList> } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [siteId, setSiteId] = useState('');
  const [label, setLabel] = useState('');
  const [labelError, setLabelError] = useState<string | null>(null);
  const [enrolBusy, setEnrolBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PatrolDeviceRow | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [removeLocalOpen, setRemoveLocalOpen] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [confirmEnrolOpen, setConfirmEnrolOpen] = useState(false);

  useEffect(() => {
    const token = listToken;
    let cancelled = false;
    void withDb((db) => loadPatrolDevices(db)).then((result) => {
      if (!cancelled) setList({ token, result });
    });
    return () => {
      cancelled = true;
    };
  }, [listToken]);

  const current = list && list.token === listToken ? list.result : null;
  const shownList = current ?? list?.result ?? null;
  const reloadList = () => setListToken((n) => n + 1);
  const effectiveSiteId = manageableSites.some((site) => site.id === siteId) ? siteId : (manageableSites[0]?.id ?? '');
  const effectiveSiteName = manageableSites.find((site) => site.id === effectiveSiteId)?.name ?? '';
  // The enrol form stays closed until asked for (most phones a manager uses must NOT be enrolled).
  const showForm = formOpen;
  const queuedPeople = Object.keys(queued.byUser).length;

  const personName = (id: string | null, names: Record<string, string>): string => {
    if (!id) return t('pdevUnknownPerson');
    if (id === auth.user?.id) return t('pdevYou');
    return names[id] ?? t('pdevUnknownPerson');
  };

  const enrolErrorText = (result: Extract<EnrolResult, { ok: false }>): string => {
    switch (result.error) {
      case 'not_allowed':
        return t('pdevErrEnrolNotAllowed');
      case 'invalid_label':
        return t('pdevLabelInvalid');
      case 'offline':
        return t('pdevErrEnrolOffline');
      case 'storage_unavailable':
        return t('pdevErrEnrolStorage');
      default:
        return t('pdevErrEnrolFailed', result.message ?? '');
    }
  };

  const revokeErrorText = (result: Extract<RevokeResult, { ok: false }>): string => {
    if (result.error === 'not_allowed') return t('pdevErrRevokeNotAllowed');
    if (result.error === 'offline') return t('pdevErrRevokeOffline');
    return t('pdevErrRevokeFailed', result.message ?? '');
  };

  const openForm = () => {
    setMessage(null);
    setLabelError(null);
    setFormOpen(true);
  };

  /** Form submit: check the label, then ask for confirmation (what an enrolled phone is). */
  const submitEnrol = (event: React.FormEvent) => {
    event.preventDefault();
    if (enrolBusy) return;
    const trimmed = label.trim();
    if (!trimmed || trimmed.length > PATROL_DEVICE_LABEL_MAX) {
      setLabelError(t('pdevLabelInvalid'));
      return;
    }
    setLabelError(null);
    setMessage(null);
    if (!canWrite || !effectiveSiteId) return;
    setConfirmEnrolOpen(true);
  };

  const confirmEnrol = async () => {
    if (enrolBusy) return;
    const trimmed = label.trim();
    if (!canWrite || !effectiveSiteId || !trimmed) return;
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch (error) {
      setMessage({ tone: 'danger', text: t('pdevErrEnrolFailed', error instanceof Error ? error.message : String(error)), testId: 'device-enrol-error' });
      return;
    }
    const previous = thisPhone;
    setEnrolBusy(true);
    let signingOut = false;
    try {
      const result = await enrolThisPhone(supabase, effectiveSiteId, trimmed);
      if (!result.ok) {
        setConfirmEnrolOpen(false);
        if (result.error === 'invalid_label') setLabelError(enrolErrorText(result));
        else setMessage({ tone: 'danger', text: enrolErrorText(result), testId: 'device-enrol-error' });
        if (result.error === 'storage_unavailable') reloadList();
        return;
      }
      // The old secret is gone from this phone: close its server entry too.
      let oldRevokeFailed = false;
      if (previous && previous.deviceId !== result.device.deviceId) {
        const revoked = await revokePatrolDevice(supabase, previous.deviceId);
        oldRevokeFailed = !revoked.ok;
      }
      // A manager session must never stay on a patrol phone: sign out at once (force - nothing is
      // deleted; a manager's queued records, if any, upload when they sign in here again) and
      // open the Guard duty tab, which confirms the enrolment.
      saveEnrolledNote({ siteName: result.device.siteName, oldRevokeFailed });
      signingOut = true;
      setMessage({ tone: 'success', text: t('pdevEnrolledSignedOut', result.device.siteName), testId: 'device-enrol-message' });
      await auth.signOut({ force: true });
      router.replace('/login');
    } finally {
      if (!signingOut) setEnrolBusy(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget || revokeBusy) return;
    setRevokeError(null);
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch (error) {
      setRevokeError(t('pdevErrRevokeFailed', error instanceof Error ? error.message : String(error)));
      return;
    }
    setRevokeBusy(true);
    try {
      const result = await revokePatrolDevice(supabase, revokeTarget.id);
      if (!result.ok) {
        setRevokeError(revokeErrorText(result));
        return;
      }
      setMessage({ tone: 'success', text: t('pdevRevoked', revokeTarget.label), testId: 'device-revoke-success' });
      setRevokeTarget(null);
      reloadList();
    } finally {
      setRevokeBusy(false);
    }
  };

  /** Removes the enrolment from this phone AND revokes its server entry (when possible). */
  const removeLocal = async () => {
    if (removeBusy) return;
    setRemoveBusy(true);
    try {
      let supabase: ReturnType<typeof createClient> | null = null;
      if (canWrite) {
        try {
          supabase = createClient();
        } catch {
          supabase = null;
        }
      }
      const result = await removeThisPhoneEnrolment(supabase);
      setRemoveLocalOpen(false);
      setMessage(
        result.revoked
          ? { tone: 'success', text: t('pdevRemovedAndRevoked'), testId: 'device-removed-local' }
          : { tone: 'warning', text: t('pdevRemovedLocal'), testId: 'device-removed-local' }
      );
      reloadList();
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className={`space-y-4 ${className ?? ''}`} data-testid="device-panel">
      <div className="space-y-1">
        <h2 id={headingId} className="font-display text-2xl font-bold text-ee-text">
          {t('pdevPanelTitle')}
        </h2>
        <p className="text-sm text-ee-muted">{t('pdevPanelIntro')}</p>
        <p className="text-xs text-ee-muted">{t('pdevEvidencePanelNote')}</p>
      </div>

      {!canWrite && (
        <Notice tone="warning" testId="device-offline">
          {t('pdevNeedsConnection')}
        </Notice>
      )}

      {message && (
        <Notice tone={message.tone} testId={message.testId}>
          {message.text}
        </Notice>
      )}

      {/* This phone */}
      <div className="space-y-3 rounded-2xl border border-ee-border bg-ee-surface p-4" data-testid="device-this-phone-card">
        <h3 className="flex items-center gap-2 text-base font-semibold text-ee-text">
          <Smartphone className="h-5 w-5 flex-none" aria-hidden="true" />
          {t('pdevThisPhoneTitle')}
        </h3>
        <p className="text-base text-ee-text break-words" data-testid="device-this-phone-status">
          {thisPhone ? t('pdevThisPhoneEnrolled', thisPhone.siteName, thisPhone.label) : t('pdevThisPhoneNotEnrolled')}
        </p>

        {queued.ready && (
          <p
            className={`flex items-start gap-2 text-sm ${queued.total > 0 ? 'font-semibold text-ee-warning' : 'text-ee-muted'}`}
            data-testid="device-this-phone-queued"
            data-count={queued.total}
          >
            <CloudUpload className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{queued.total > 0 ? t('pdevPhoneQueued', queued.total, queuedPeople) : t('pdevPhoneQueuedNone')}</span>
          </p>
        )}

        {!thisPhone && !formOpen && manageableSites.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            className="min-h-12 w-full sm:w-auto"
            onClick={openForm}
            disabled={!canWrite}
            data-testid="device-enrol-open"
          >
            {t('pdevEnrolOpen')}
          </Button>
        )}

        {thisPhone && !formOpen && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              className="min-h-12 w-full sm:w-auto"
              onClick={openForm}
              disabled={!canWrite || manageableSites.length === 0}
              data-testid="device-enrol-open"
            >
              {t('pdevEnrolAgain')}
            </Button>
            <Button
              type="button"
              variant="danger"
              className="min-h-12 w-full sm:w-auto"
              onClick={() => setRemoveLocalOpen(true)}
              data-testid="device-remove-local"
            >
              {t('pdevRemoveLocal')}
            </Button>
          </div>
        )}

        {manageableSites.length === 0 && (
          <p className="text-sm text-ee-muted" data-testid="device-no-sites">
            {t('pdevNoManagedSites')}
          </p>
        )}

        {showForm && manageableSites.length > 0 && (
          <form onSubmit={submitEnrol} noValidate className="space-y-3" data-testid="device-enrol-form">
            <Notice tone="warning" testId="device-enrol-warning">
              {t('pdevEnrolWarning')}
            </Notice>
            {thisPhone && (
              <Notice tone="warning" testId="device-enrol-replace">
                {t('pdevEnrolReplaceWarning', thisPhone.siteName)}
              </Notice>
            )}
            <Field id={siteFieldId} label={t('pdevSiteLabel')}>
              <select
                id={siteFieldId}
                value={effectiveSiteId}
                onChange={(event) => setSiteId(event.target.value)}
                disabled={enrolBusy}
                className={inputClass}
                data-testid="device-enrol-site"
              >
                {manageableSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name} ({site.code})
                  </option>
                ))}
              </select>
            </Field>
            <TextField
              id={labelFieldId}
              label={t('pdevLabelLabel')}
              value={label}
              onValueChange={setLabel}
              hint={t('pdevLabelHint')}
              error={labelError ?? undefined}
              maxLength={PATROL_DEVICE_LABEL_MAX}
              autoComplete="off"
              disabled={enrolBusy}
              testId="device-enrol-label"
            />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                className="min-h-12"
                onClick={() => setFormOpen(false)}
                disabled={enrolBusy}
                data-testid="device-enrol-cancel"
              >
                {t('pdevCancel')}
              </Button>
              <Button type="submit" variant="primary" className="min-h-12" isLoading={enrolBusy} disabled={!canWrite} data-testid="device-enrol-submit">
                {enrolBusy ? t('pdevEnrolling') : t('pdevEnrolThisPhone')}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Enrolled phones of the caller's sites */}
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-ee-text">{t('pdevListTitle')}</h3>
        {!shownList ? (
          <p role="status" className="text-sm text-ee-muted" data-testid="device-list-loading">
            {t('pdevListLoading')}
          </p>
        ) : !shownList.ok ? (
          <div className="space-y-2">
            <ErrorNotice error={shownList.error} title={t('pdevListFailed')} testId="device-list-error" />
            <Button type="button" variant="secondary" className="min-h-12" onClick={reloadList} disabled={!current} data-testid="device-list-retry">
              {t('pdevTryAgain')}
            </Button>
          </div>
        ) : shownList.value.devices.length === 0 ? (
          <p className="rounded-xl border border-ee-border bg-ee-surface px-3 py-3 text-sm text-ee-muted" data-testid="device-list-empty">
            {t('pdevListEmpty')}
          </p>
        ) : (
          <ul className="divide-y divide-ee-border overflow-hidden rounded-xl border border-ee-border bg-ee-surface" data-testid="device-list">
            {shownList.value.devices.map((device) => {
              const revoked = device.revoked_at !== null;
              const isThisPhone = thisPhone?.deviceId === device.id;
              const names = shownList.value.names;
              return (
                <li key={device.id} className="space-y-2 p-3" data-testid="device-row" data-device-id={device.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-ee-text">
                        <span className="break-words" data-testid="device-row-label">
                          {device.label}
                        </span>
                        {isThisPhone && (
                          <span className={CHIP_THIS_PHONE} data-testid="device-this-phone">
                            {t('pdevThisPhoneBadge')}
                          </span>
                        )}
                      </p>
                      <p className="break-words text-sm text-ee-muted" data-testid="device-row-site">
                        {siteNames.get(device.site_id) ?? t('pdevUnknownSite')}
                      </p>
                    </div>
                    <span className={revoked ? CHIP_REVOKED : CHIP_ACTIVE} data-testid="device-row-status">
                      {revoked ? t('pdevStatusRevoked') : t('pdevStatusActive')}
                    </span>
                  </div>
                  <p className="text-xs text-ee-muted">
                    {t('pdevEnrolledBy', personName(device.enrolled_by, names), formatSastDateTime(device.enrolled_at, language))}
                  </p>
                  <p className="text-xs text-ee-muted" data-testid="device-row-last-used">
                    {device.last_used_at
                      ? t('pdevLastUsed', formatSastDateTime(device.last_used_at, language), personName(device.last_guard_id, names))
                      : t('pdevNeverUsed')}
                  </p>
                  {revoked && device.revoked_at && (
                    <p className="text-xs text-ee-muted">{t('pdevRevokedAt', formatSastDateTime(device.revoked_at, language))}</p>
                  )}
                  {!revoked && (
                    <Button
                      type="button"
                      variant="danger"
                      className="min-h-12 w-full sm:w-auto"
                      onClick={() => {
                        setRevokeError(null);
                        setRevokeTarget(device);
                      }}
                      disabled={!canWrite}
                      data-testid="device-revoke"
                    >
                      {t('pdevRevoke')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={t('pdevRevokeTitle')}
        confirmLabel={t('pdevRevokeConfirm')}
        tone="danger"
        busy={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => {
          if (!revokeBusy) setRevokeTarget(null);
        }}
        testId="device-revoke-dialog"
      >
        <p>{revokeTarget ? t('pdevRevokeBody', revokeTarget.label, siteNames.get(revokeTarget.site_id) ?? t('pdevUnknownSite')) : ''}</p>
        {revokeError && (
          <Notice tone="danger" testId="device-revoke-error">
            {revokeError}
          </Notice>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmEnrolOpen}
        title={t('pdevEnrolConfirmTitle', effectiveSiteName)}
        confirmLabel={t('pdevEnrolConfirm')}
        tone="danger"
        busy={enrolBusy}
        onConfirm={() => void confirmEnrol()}
        onCancel={() => {
          if (!enrolBusy) setConfirmEnrolOpen(false);
        }}
        testId="device-enrol-confirm-dialog"
      >
        <p>{t('pdevEnrolConfirmBody', effectiveSiteName)}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={removeLocalOpen}
        title={t('pdevRemoveLocalTitle')}
        confirmLabel={t('pdevRemoveLocal')}
        tone="danger"
        busy={removeBusy}
        onConfirm={() => void removeLocal()}
        onCancel={() => {
          if (!removeBusy) setRemoveLocalOpen(false);
        }}
        testId="device-remove-local-dialog"
      >
        <p>{t('pdevRemoveLocalBody')}</p>
      </ConfirmDialog>
    </section>
  );
}
