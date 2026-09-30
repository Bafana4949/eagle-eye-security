'use client';

import React, { useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { Site } from '@/types/models';
import { createSite, type AdminError } from './adminData';
import { withDb } from './withDb';
import { validateNewSite, type FieldErrors } from './validation';
import { SiteEditor } from './SiteEditor';
import { ErrorNotice, Notice, SectionTitle, TextField } from './ui';

interface SitesPanelProps {
  sites: Site[];
  selectedSiteId: string | null;
  organisationId: string;
  onSelectSite: (siteId: string) => void;
  /** A site row as returned by the database after an update or insert. */
  onSiteStored: (site: Site) => void;
}

export function SitesPanel({ sites, selectedSiteId, organisationId, onSelectSite, onSiteStored }: SitesPanelProps) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newErrors, setNewErrors] = useState<FieldErrors<'name' | 'code'>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<AdminError | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  const selected = sites.find((site) => site.id === selectedSiteId) ?? null;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreateError(null);
    setCreatedName(null);
    const validated = validateNewSite({ name: newName, code: newCode });
    if (!validated.ok) {
      setNewErrors(validated.errors);
      return;
    }
    setNewErrors({});
    setCreating(true);
    const result = await withDb((db) => createSite(db, organisationId, validated.value));
    setCreating(false);
    if (!result.ok) {
      setCreateError(result.error);
      return;
    }
    setCreatedName(result.value.name);
    setNewName('');
    setNewCode('');
    setAdding(false);
    onSiteStored(result.value);
    onSelectSite(result.value.id);
  };

  return (
    <section className="space-y-4" aria-labelledby="admin-sites-heading">
      <SectionTitle
        id="admin-sites-heading"
        action={
          <Button
            type="button"
            variant="secondary"
            className="min-h-12 gap-2"
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
            aria-controls="admin-site-add-form"
            data-testid="admin-site-add-toggle"
          >
            <Plus className="h-4 w-4" aria-hidden />
            <span>{t('admAddSite')}</span>
          </Button>
        }
      >
        {t('admSitesTitle')}
      </SectionTitle>

      {adding && (
        <form id="admin-site-add-form" onSubmit={create} noValidate className="rounded-2xl border border-ee-border bg-ee-surface p-4 space-y-3" data-testid="admin-site-add-form">
          <TextField id="admin-new-site-name" label={t('admSiteName')} value={newName} onValueChange={setNewName} error={newErrors.name ? t(newErrors.name) : undefined} maxLength={255} autoComplete="off" testId="admin-new-site-name" />
          <TextField id="admin-new-site-code" label={t('admSiteCode')} value={newCode} onValueChange={setNewCode} error={newErrors.code ? t(newErrors.code) : undefined} hint={t('admSiteCodeHint')} maxLength={50} autoComplete="off" testId="admin-new-site-code" />
          <p className="text-xs text-ee-muted">{t('admNewSiteDefaultsHint')}</p>
          {createError && <ErrorNotice error={createError} title={t('admSiteNotCreated')} testId="admin-site-create-error" write />}
          <Button type="submit" variant="primary" className="min-h-12 w-full sm:w-auto" disabled={creating} data-testid="admin-site-create">
            {creating ? t('admSaving') : t('admCreateSite')}
          </Button>
        </form>
      )}
      {createdName && <Notice tone="success" testId="admin-site-created">{t('admSiteCreated', createdName)}</Notice>}

      {sites.length === 0 ? (
        <Notice tone="info" testId="admin-sites-empty">{t('admNoSites')}</Notice>
      ) : (
        <ul className="divide-y divide-ee-border border-y border-ee-border" data-testid="admin-site-list">
          {sites.map((site) => {
            const isSelected = site.id === selectedSiteId;
            return (
              <li key={site.id}>
                <button
                  type="button"
                  onClick={() => onSelectSite(site.id)}
                  aria-pressed={isSelected}
                  className={`w-full min-h-14 flex items-center gap-3 px-2 py-2 text-left ${isSelected ? 'bg-ee-surface-raised' : 'hover:bg-ee-surface'}`}
                  data-testid={`admin-site-item-${site.id}`}
                >
                  <Building2 className={`h-5 w-5 flex-none ${isSelected ? 'text-ee-primary' : 'text-ee-muted'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ee-text truncate">{site.name}</span>
                    <span className="block text-xs text-ee-muted">{site.code}</span>
                  </span>
                  <span className={`text-xs font-semibold ${site.isActive ? 'text-ee-success' : 'text-ee-muted'}`}>
                    {site.isActive ? t('admActive') : t('admInactive')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <div className="rounded-2xl border border-ee-border bg-ee-surface p-4">
          <SiteEditor key={selected.id} site={selected} onSaved={onSiteStored} />
        </div>
      )}
    </section>
  );
}
