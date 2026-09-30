'use client';

/**
 * Staff of the admin's organisation: roles, site assignments and activation, all written to
 * Supabase and re-read after every change. New accounts go through POST /api/admin/users.
 * The database enforces: no changes to one's own roles, super_admin only by a super_admin,
 * everything within the admin's own organisation.
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { Site, UserRole } from '@/types/models';
import { loadStaff, setStaffActive, setStaffRole, setStaffSite, type AdminError, type StaffMember } from './adminData';
import { withDb } from './withDb';
import { ROLE_LABEL_KEYS } from './format';
import { CreateStaffForm } from './CreateStaffForm';
import type { CreatedStaffAccount } from './staffSchema';
import { CheckboxRow, ConfirmDialog, ErrorNotice, Notice, SectionTitle, inputClass } from './ui';

/** Whether the organisation's site list (used for names and assignment choices) has loaded. */
export type SitesStatus = 'loading' | 'ready' | 'error';

interface StaffPanelProps {
  sites: Site[];
  sitesStatus: SitesStatus;
  currentUserId: string;
  callerIsSuperAdmin: boolean;
}

type LoadState = { token: number; members: StaffMember[] } | { token: number; error: AdminError };

const ALL_ROLES: readonly UserRole[] = ['guard', 'supervisor', 'client_viewer', 'admin', 'super_admin'];

interface Created {
  account: CreatedStaffAccount;
  password: string | null;
}

export function StaffPanel({ sites, sitesStatus, currentUserId, callerIsSuperAdmin }: StaffPanelProps) {
  const { t } = useTranslation();
  const [reloadToken, setReloadToken] = useState(0);
  const [data, setData] = useState<LoadState | null>(null);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ userId: string; tone: 'success' | 'danger'; text: string; error?: AdminError } | null>(null);
  const [confirmActive, setConfirmActive] = useState<{ member: StaffMember; active: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    const token = reloadToken;
    let cancelled = false;
    void withDb((db) => loadStaff(db)).then((result) => {
      if (!cancelled) setData(result.ok ? { token, members: result.value } : { token, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const current = data && data.token === reloadToken ? data : null;
  const members = current && 'members' in current ? current.members : [];
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? (sitesStatus === 'ready' ? t('admUnknownSite') : '…');
  const sitesNotice =
    sitesStatus === 'loading' ? t('admLoading') : sitesStatus === 'error' ? t('admSitesLoadFailed') : sites.length === 0 ? t('admNoSites') : null;

  const replaceMember = (member: StaffMember) => {
    setData((state) => (state && 'members' in state ? { ...state, members: state.members.map((m) => (m.id === member.id ? member : m)) } : state));
  };

  const applyChange = async (userId: string, key: string, change: () => Promise<{ ok: true; value: StaffMember } | { ok: false; error: AdminError }>, successText: string) => {
    setPending(key);
    setRowMessage(null);
    const result = await change();
    setPending(null);
    if (result.ok) {
      replaceMember(result.value);
      setRowMessage({ userId, tone: 'success', text: successText });
    } else {
      setRowMessage({ userId, tone: 'danger', text: t('admChangeNotSaved'), error: result.error });
    }
  };

  const filtered = members.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return `${m.firstName} ${m.lastName} ${m.employeeNumber ?? ''}`.toLowerCase().includes(q);
  });

  const createdConfirmed = created && current && 'members' in current ? members.some((m) => m.id === created.account.id) : null;

  return (
    <section className="space-y-4" aria-labelledby="admin-staff-heading" data-testid="admin-staff-panel">
      <SectionTitle
        id="admin-staff-heading"
        action={
          <Button type="button" variant="primary" className="min-h-12 gap-2" onClick={() => setCreating((v) => !v)} aria-expanded={creating} data-testid="admin-staff-add-toggle">
            <UserPlus className="h-4 w-4" aria-hidden />
            <span>{t('admAddStaff')}</span>
          </Button>
        }
      >
        {t('admStaffTitle')}
      </SectionTitle>

      {creating && (
        <div className="rounded-2xl border border-ee-border bg-ee-surface p-4">
          <h3 className="font-display text-xl font-bold mb-3">{t('admNewStaffTitle')}</h3>
          <CreateStaffForm
            sites={sites}
            sitesNotice={sitesNotice}
            callerIsSuperAdmin={callerIsSuperAdmin}
            onCancel={() => setCreating(false)}
            onCreated={(account, password) => {
              setCreated({ account, password });
              setCreating(false);
              setReloadToken((n) => n + 1);
            }}
          />
        </div>
      )}

      {created && (
        <Notice tone={createdConfirmed === false ? 'warning' : 'success'} title={t('admStaffCreated')} testId="admin-staff-created">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-ee-muted">{t('admSignInName')}</dt>
            <dd className="font-mono break-all" data-testid="admin-staff-created-login">
              {created.account.login}
            </dd>
            {created.account.login !== created.account.email && (
              <>
                <dt className="text-ee-muted">{t('admAccountEmail')}</dt>
                <dd className="font-mono break-all">{created.account.email}</dd>
              </>
            )}
            {created.password && (
              <>
                <dt className="text-ee-muted">{t('admPassword')}</dt>
                <dd className="font-mono break-all" data-testid="admin-staff-created-password">
                  {created.password}
                </dd>
              </>
            )}
          </dl>
          <p className="mt-1 text-sm">
            {createdConfirmed === null ? t('admStaffCheckingList') : createdConfirmed ? t('admStaffInList') : t('admStaffNotInList')}
          </p>
          {created.password && <p className="mt-1 text-xs text-ee-muted">{t('admPasswordShownOnce')}</p>}
          <Button type="button" variant="secondary" className="mt-2 min-h-12" onClick={() => setCreated(null)} data-testid="admin-staff-created-done">
            {t('admDone')}
          </Button>
        </Notice>
      )}

      <div>
        <label htmlFor="admin-staff-filter" className="block text-sm font-semibold text-ee-muted mb-1">
          {t('admFilterStaff')}
        </label>
        <input id="admin-staff-filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} className={inputClass} autoComplete="off" data-testid="admin-staff-filter" />
      </div>

      {!current ? (
        <p className="text-sm text-ee-muted" role="status" data-testid="admin-staff-loading">
          {t('admLoading')}
        </p>
      ) : 'error' in current ? (
        <div className="space-y-2">
          <ErrorNotice error={current.error} title={t('admStaffLoadFailed')} testId="admin-staff-error" />
          <Button type="button" variant="secondary" className="min-h-12 gap-2" onClick={() => setReloadToken((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            <span>{t('admTryAgain')}</span>
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <Notice tone="info" testId="admin-staff-empty">
          {members.length === 0 ? t('admNoStaff') : t('admNoStaffMatch')}
        </Notice>
      ) : (
        <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="admin-staff-list">
          {filtered.map((member) => {
            const isSelf = member.id === currentUserId;
            const isOpen = expanded === member.id;
            const targetIsSuper = member.roles.includes('super_admin');
            const canChangeActive = !isSelf && (!targetIsSuper || callerIsSuperAdmin);
            const message = rowMessage && rowMessage.userId === member.id ? rowMessage : null;
            return (
              <li key={member.id} className="py-3 space-y-2" data-testid={`admin-staff-row-${member.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ee-text break-words">
                      {member.firstName} {member.lastName}
                      {isSelf && <span className="ml-2 text-xs text-ee-primary">{t('admYou')}</span>}
                    </p>
                    <p className="text-xs text-ee-muted">
                      {member.employeeNumber ? `${t('admEmployeeNumberShort')} ${member.employeeNumber} · ` : ''}
                      {member.roles.length > 0 ? member.roles.map((r) => t(ROLE_LABEL_KEYS[r])).join(', ') : t('admNoRoles')}
                    </p>
                    <p className="text-xs text-ee-muted">
                      {member.siteIds.length > 0 ? member.siteIds.map(siteName).join(', ') : t('admNoSitesAssigned')}
                    </p>
                  </div>
                  <span className={`text-xs font-semibold flex-none ${member.isActive ? 'text-ee-success' : 'text-ee-danger-text'}`} data-testid={`admin-staff-status-${member.id}`}>
                    {member.isActive ? t('admActive') : t('admDeactivated')}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-12 gap-2"
                  onClick={() => setExpanded(isOpen ? null : member.id)}
                  aria-expanded={isOpen}
                  aria-controls={`admin-staff-manage-${member.id}`}
                  data-testid={`admin-staff-manage-${member.id}`}
                >
                  {isOpen ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                  <span>{t('admManage')}</span>
                </Button>

                <div aria-live="polite">
                  {message &&
                    (message.error ? (
                      <ErrorNotice error={message.error} title={message.text} testId="admin-staff-message" write />
                    ) : (
                      <Notice tone="success" testId="admin-staff-message">
                        {message.text}
                      </Notice>
                    ))}
                </div>

                {isOpen && (
                  <div id={`admin-staff-manage-${member.id}`} className="rounded-2xl border border-ee-border bg-ee-surface p-4 space-y-4">
                    <fieldset disabled={isSelf}>
                      <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admRoles')}</legend>
                      {isSelf && <p className="text-sm text-ee-muted mb-1">{t('admOwnRolesLocked')}</p>}
                      {ALL_ROLES.filter((role) => role !== 'super_admin' || callerIsSuperAdmin || member.roles.includes('super_admin')).map((role) => {
                        const key = `${member.id}:role:${role}`;
                        const locked = isSelf || (role === 'super_admin' && !callerIsSuperAdmin) || (pending !== null && pending !== key);
                        return (
                          <CheckboxRow
                            key={role}
                            id={`admin-staff-${member.id}-role-${role}`}
                            label={t(ROLE_LABEL_KEYS[role])}
                            checked={member.roles.includes(role)}
                            disabled={locked || pending === key}
                            onChange={(checked) =>
                              void applyChange(
                                member.id,
                                key,
                                () => withDb((db) => setStaffRole(db, member.id, role, checked)),
                                t(checked ? 'admRoleGranted' : 'admRoleRevoked', t(ROLE_LABEL_KEYS[role]))
                              )
                            }
                            testId={`admin-staff-role-${member.id}-${role}`}
                          />
                        );
                      })}
                    </fieldset>

                    <fieldset>
                      <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admAssignedSites')}</legend>
                      {sitesNotice && <p className="text-sm text-ee-muted">{sitesNotice}</p>}
                      {sites.map((site) => {
                        const key = `${member.id}:site:${site.id}`;
                        return (
                          <CheckboxRow
                            key={site.id}
                            id={`admin-staff-${member.id}-site-${site.id}`}
                            label={site.name}
                            description={site.code}
                            checked={member.siteIds.includes(site.id)}
                            disabled={pending !== null}
                            onChange={(checked) =>
                              void applyChange(
                                member.id,
                                key,
                                () => withDb((db) => setStaffSite(db, member.id, site.id, checked)),
                                t(checked ? 'admSiteAssigned' : 'admSiteUnassigned', site.name)
                              )
                            }
                            testId={`admin-staff-site-${member.id}-${site.id}`}
                          />
                        );
                      })}
                    </fieldset>

                    <div className="border-t border-ee-border pt-3">
                      {canChangeActive ? (
                        <Button
                          type="button"
                          variant={member.isActive ? 'danger' : 'primary'}
                          className="min-h-12 w-full sm:w-auto"
                          disabled={pending !== null}
                          onClick={() => setConfirmActive({ member, active: !member.isActive })}
                          data-testid={`admin-staff-toggle-active-${member.id}`}
                        >
                          {member.isActive ? t('admDeactivateAccount') : t('admReactivateAccount')}
                        </Button>
                      ) : (
                        <p className="text-sm text-ee-muted">{isSelf ? t('admOwnAccountLocked') : t('admSuperAdminLocked')}</p>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {current && 'members' in current && (
        <Button type="button" variant="ghost" className="min-h-12 gap-2" onClick={() => setReloadToken((n) => n + 1)} data-testid="admin-staff-reload">
          <RefreshCw className="h-4 w-4" aria-hidden />
          <span>{t('admReloadFromServer')}</span>
        </Button>
      )}

      {confirmActive && (
        <ConfirmDialog
          open
          title={confirmActive.active ? t('admConfirmReactivateTitle', confirmActive.member.firstName) : t('admConfirmDeactivateAccountTitle', confirmActive.member.firstName)}
          confirmLabel={confirmActive.active ? t('admReactivateAccount') : t('admDeactivateAccount')}
          tone={confirmActive.active ? 'primary' : 'danger'}
          busy={pending !== null}
          onCancel={() => setConfirmActive(null)}
          onConfirm={() => {
            const { member, active } = confirmActive;
            void applyChange(
              member.id,
              `${member.id}:active`,
              () => withDb((db) => setStaffActive(db, member.id, active)),
              active ? t('admAccountReactivated') : t('admAccountDeactivated')
            ).then(() => setConfirmActive(null));
          }}
          testId="admin-staff-confirm"
        >
          <p>{confirmActive.active ? t('admConfirmReactivateBody') : t('admConfirmDeactivateAccountBody')}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
