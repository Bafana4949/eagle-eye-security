'use client';

/**
 * The organisation's audit_logs rows, newest first, one page at a time. The rows are written by
 * database triggers only (nobody can edit or delete them through the app). No integrity claim is
 * made here beyond that: the table is not hash-chained.
 */
import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { Site } from '@/types/models';
import { isUserRole } from '@/lib/auth/routeAccess';
import { AUDIT_PAGE_SIZE, loadAuditPage, loadStaff, redactAuditDetails, type AdminError, type AuditEntry } from './adminData';
import { withDb } from './withDb';
import { ROLE_LABEL_KEYS, formatSastDateTime } from './format';
import { ErrorNotice, Notice, SectionTitle } from './ui';

const ACTION_KEYS: Record<string, TranslationKey> = {
  'checkpoint.created': 'admAuditCheckpointCreated',
  'checkpoint.deleted': 'admAuditCheckpointDeleted',
  'checkpoint.updated': 'admAuditCheckpointUpdated',
  'checkpoint.nfc_enrolled': 'admAuditNfcEnrolled',
  'checkpoint.nfc_removed': 'admAuditNfcRemoved',
  'checkpoint.qr_rotated': 'admAuditQrRotated',
  'checkpoint.secrets_viewed': 'admAuditSecretsViewed',
  'role.granted': 'admAuditRoleGranted',
  'role.revoked': 'admAuditRoleRevoked',
  'role.changed': 'admAuditRoleChanged',
  'site_assignment.added': 'admAuditSiteAssigned',
  'site_assignment.removed': 'admAuditSiteUnassigned',
  'site.created': 'admAuditSiteCreated',
  'site.updated': 'admAuditSiteUpdated',
  'site.deleted': 'admAuditSiteDeleted',
  'profile.deactivated': 'admAuditProfileDeactivated',
  'profile.reactivated': 'admAuditProfileReactivated',
  'profile.deleted': 'admAuditProfileDeleted',
  'profile.admin_fields_changed': 'admAuditProfileChanged',
  'profile.organisation_changed': 'admAuditProfileOrgChanged',
  'shift.status_changed': 'admAuditShiftStatus',
  'shift.updated': 'admAuditShiftUpdated',
  'shift.schedule_corrected': 'admAuditShiftCorrected'
};

/** incident.* / panic_alert.* verbs written by the audit trigger. */
const ALERT_VERB_KEYS: Record<string, TranslationKey> = {
  status_changed: 'admAuditVerbStatus',
  acknowledged: 'admAuditVerbAcknowledged',
  notes_changed: 'admAuditVerbNotes'
};

type PageState = { key: string; entries: AuditEntry[]; hasMore: boolean } | { key: string; error: AdminError };

function detailText(details: Record<string, unknown> | null, key: string): string | null {
  const value = details ? details[key] : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

export function AuditPanel({ sites }: { sites: Site[] }) {
  const { t, language } = useTranslation();
  const [offset, setOffset] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const [page, setPage] = useState<PageState | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);

  const key = `${offset}:${reloadToken}`;

  useEffect(() => {
    const requestKey = `${offset}:${reloadToken}`;
    let cancelled = false;
    void withDb((db) => loadAuditPage(db, offset)).then((result) => {
      if (cancelled) return;
      setPage(result.ok ? { key: requestKey, entries: result.value.entries, hasMore: result.value.hasMore } : { key: requestKey, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [offset, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    void withDb((db) => loadStaff(db)).then((result) => {
      if (cancelled || !result.ok) return;
      setNames(Object.fromEntries(result.value.map((m) => [m.id, `${m.firstName} ${m.lastName}`])));
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const current = page && page.key === key ? page : null;

  const actorName = (entry: AuditEntry): string => {
    if (!entry.actorId) return t('admAuditSystem');
    return names[entry.actorId] ?? t('admAuditUnknownUser');
  };
  const actionLabel = (action: string): string => {
    const known = ACTION_KEYS[action];
    if (known) return t(known);
    const [table, verb] = action.split('.');
    if ((table === 'incident' || table === 'panic_alert') && verb) {
      const verbKey = ALERT_VERB_KEYS[verb];
      return t(table === 'incident' ? 'admAuditIncident' : 'admAuditPanic', verbKey ? t(verbKey) : verb);
    }
    // An action this screen does not know yet: shown as the database wrote it.
    return action;
  };
  const siteLabel = (entry: AuditEntry): string | null => {
    const siteId = detailText(entry.details, 'site_id') ?? (entry.resourceType === 'sites' ? entry.resourceId : null);
    if (!siteId) return null;
    return sites.find((s) => s.id === siteId)?.name ?? null;
  };
  /** What the entry is about: checkpoint / site name, the person and role concerned. */
  const subjectLabel = (entry: AuditEntry): string | null => {
    const parts: string[] = [];
    const name = detailText(entry.details, 'name');
    if (name) parts.push(name);
    const userId = detailText(entry.details, 'user_id') ?? detailText(entry.details, 'guard_id');
    if (userId) parts.push(names[userId] ?? t('admAuditUnknownUser'));
    const role = detailText(entry.details, 'role');
    if (role && isUserRole(role)) parts.push(t(ROLE_LABEL_KEYS[role]));
    return parts.length > 0 ? parts.join(' · ') : null;
  };

  return (
    <section className="space-y-4" aria-labelledby="admin-audit-heading" data-testid="admin-audit-panel">
      <SectionTitle
        id="admin-audit-heading"
        action={
          <Button type="button" variant="secondary" className="min-h-12 gap-2" onClick={() => setReloadToken((n) => n + 1)} data-testid="admin-audit-reload">
            <RefreshCw className="h-4 w-4" aria-hidden />
            <span>{t('admRefresh')}</span>
          </Button>
        }
      >
        {t('admAuditTitle')}
      </SectionTitle>
      <p className="text-sm text-ee-muted">{t('admAuditExplain')}</p>

      {!current ? (
        <p className="text-sm text-ee-muted" role="status" data-testid="admin-audit-loading">
          {t('admLoading')}
        </p>
      ) : 'error' in current ? (
        <ErrorNotice error={current.error} title={t('admAuditLoadFailed')} testId="admin-audit-error" />
      ) : current.entries.length === 0 ? (
        <Notice tone="info" testId="admin-audit-empty">
          {offset === 0 ? t('admAuditEmpty') : t('admAuditNoOlder')}
        </Notice>
      ) : (
        <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="admin-audit-list">
          {current.entries.map((entry) => {
            const isOpen = open === entry.id;
            const summary = subjectLabel(entry);
            const siteName = siteLabel(entry);
            // Site rows already carry the site's name in the summary.
            const site = siteName && entry.resourceType !== 'sites' && siteName !== detailText(entry.details, 'name') ? siteName : null;
            return (
              <li key={entry.id} className="py-3" data-testid="admin-audit-entry" data-action={entry.action}>
                <p className="text-xs text-ee-muted">{formatSastDateTime(entry.createdAt, language)}</p>
                <p className="font-semibold text-ee-text break-words">{actionLabel(entry.action)}</p>
                <p className="text-sm text-ee-muted break-words">
                  {t('admAuditBy', actorName(entry))}
                  {summary ? ` · ${summary}` : ''}
                  {site ? ` · ${site}` : ''}
                </p>
                {entry.details && (
                  <>
                    <button
                      type="button"
                      className="mt-1 min-h-12 px-2 -ml-2 rounded-lg text-sm text-ee-primary hover:bg-ee-surface-raised"
                      onClick={() => setOpen(isOpen ? null : entry.id)}
                      aria-expanded={isOpen}
                      aria-controls={`admin-audit-details-${entry.id}`}
                    >
                      {isOpen ? t('admHideDetails') : t('admShowDetails')}
                    </button>
                    {isOpen && (
                      <pre
                        id={`admin-audit-details-${entry.id}`}
                        className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-ee-border bg-ee-bg p-2 text-xs text-ee-text"
                      >
                        {JSON.stringify(redactAuditDetails(entry.details, t('admAuditHidden')), null, 2)}
                      </pre>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="secondary"
          className="min-h-12"
          disabled={offset === 0 || !current}
          onClick={() => setOffset((o) => Math.max(0, o - AUDIT_PAGE_SIZE))}
          data-testid="admin-audit-newer"
        >
          {t('admNewer')}
        </Button>
        <span className="text-sm text-ee-muted" aria-live="polite">
          {current && 'entries' in current && current.entries.length > 0 ? t('admAuditRange', offset + 1, offset + current.entries.length) : ''}
        </span>
        <Button
          type="button"
          variant="secondary"
          className="min-h-12"
          disabled={!current || !('hasMore' in current) || !current.hasMore}
          onClick={() => setOffset((o) => o + AUDIT_PAGE_SIZE)}
          data-testid="admin-audit-older"
        >
          {t('admOlder')}
        </Button>
      </div>
    </section>
  );
}
