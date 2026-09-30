'use client';

/**
 * Edits one site's configuration. Save = UPDATE … RETURNING (select().single()); the form is then
 * refilled from the row the database returned, so what is shown after "Saved" is what the server
 * holds (and what a reload shows).
 */
import React, { useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import { normalizeSouthAfricanMobile } from '@/lib/whatsapp/summary';
import type { Site } from '@/types/models';
import { updateSite, type AdminError } from './adminData';
import { withDb } from './withDb';
import {
  ROUND_INTERVAL_OPTIONS,
  siteToFormValues,
  validateSiteForm,
  type FieldErrors,
  type SiteFormField,
  type SiteFormValues
} from './validation';
import { formatSastDateTime } from './format';
import { GpsCapture } from './GpsCapture';
import { CheckboxRow, ErrorNotice, Field, Notice, TextField, describedBy, inputClass } from './ui';

interface SiteEditorProps {
  site: Site;
  onSaved: (site: Site) => void;
}

function sameValues(a: SiteFormValues, b: SiteFormValues): boolean {
  return (Object.keys(a) as SiteFormField[]).every((key) => a[key] === b[key]);
}

export function SiteEditor({ site, onSaved }: SiteEditorProps) {
  const { t, language } = useTranslation();
  const [baseline, setBaseline] = useState<SiteFormValues>(() => siteToFormValues(site));
  const [values, setValues] = useState<SiteFormValues>(() => siteToFormValues(site));
  const [errors, setErrors] = useState<FieldErrors<SiteFormField>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AdminError | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const dirty = !sameValues(values, baseline);
  const set = <K extends SiteFormField>(key: K, value: SiteFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedAt(null);
  };
  const err = (key: SiteFormField) => (errors[key] ? t(errors[key]) : undefined);
  const idp = `site-${site.id}`;

  const waPreview = (() => {
    if (values.whatsapp.trim() === '' || errors.whatsapp) return null;
    const normalised = normalizeSouthAfricanMobile(values.whatsapp);
    return normalised.ok ? normalised.display : null;
  })();

  const intervalOptions = [...new Set([...ROUND_INTERVAL_OPTIONS, Number(baseline.roundInterval)].filter((n) => Number.isFinite(n) && n > 0))].sort(
    (a, b) => a - b
  );

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSavedAt(null);
    const validated = validateSiteForm(values);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const result = await withDb((db) => updateSite(db, site.id, validated.value));
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    const stored = siteToFormValues(result.value);
    setBaseline(stored);
    setValues(stored);
    setSavedAt(new Date().toISOString());
    onSaved(result.value);
  };

  return (
    <form onSubmit={save} noValidate className="space-y-5" aria-labelledby={`${idp}-heading`} data-testid="admin-site-form">
      <h3 id={`${idp}-heading`} className="font-display text-xl font-bold text-ee-text">
        {t('admSiteSettingsFor', site.name)}
      </h3>

      <fieldset className="space-y-3">
        <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admSiteSectionGeneral')}</legend>
        <TextField id={`${idp}-name`} label={t('admSiteName')} value={values.name} onValueChange={(v) => set('name', v)} error={err('name')} maxLength={255} autoComplete="off" testId="admin-site-name" />
        <TextField id={`${idp}-code`} label={t('admSiteCode')} value={values.code} onValueChange={(v) => set('code', v)} error={err('code')} hint={t('admSiteCodeHint')} maxLength={50} autoComplete="off" testId="admin-site-code" />
        <TextField id={`${idp}-address`} label={t('admSiteAddress')} value={values.address} onValueChange={(v) => set('address', v)} autoComplete="off" testId="admin-site-address" />
        <CheckboxRow id={`${idp}-active`} label={t('admSiteActive')} description={t('admSiteActiveHint')} checked={values.isActive} onChange={(v) => set('isActive', v)} testId="admin-site-active" />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admSiteSectionLocation')}</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <TextField id={`${idp}-lat`} label={t('admLatitude')} value={values.latitude} onValueChange={(v) => set('latitude', v)} error={err('latitude')} inputMode="decimal" autoComplete="off" testId="admin-site-latitude" />
          <TextField id={`${idp}-lng`} label={t('admLongitude')} value={values.longitude} onValueChange={(v) => set('longitude', v)} error={err('longitude')} inputMode="decimal" autoComplete="off" testId="admin-site-longitude" />
        </div>
        <GpsCapture
          testIdPrefix="admin-site"
          onCapture={(fix) => {
            set('latitude', fix.latitude.toFixed(6));
            set('longitude', fix.longitude.toFixed(6));
          }}
        />
        <TextField id={`${idp}-radius`} label={t('admDefaultRadius')} value={values.defaultRadius} onValueChange={(v) => set('defaultRadius', v)} error={err('defaultRadius')} hint={t('admRadiusHint')} inputMode="numeric" testId="admin-site-radius" />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admSiteSectionShifts')}</legend>
        <div className="grid grid-cols-2 gap-3">
          <TextField id={`${idp}-day-start`} type="time" label={t('admDayStart')} value={values.dayStart} onValueChange={(v) => set('dayStart', v)} error={err('dayStart')} testId="admin-site-day-start" />
          <TextField id={`${idp}-day-end`} type="time" label={t('admDayEnd')} value={values.dayEnd} onValueChange={(v) => set('dayEnd', v)} error={err('dayEnd')} testId="admin-site-day-end" />
          <TextField id={`${idp}-night-start`} type="time" label={t('admNightStart')} value={values.nightStart} onValueChange={(v) => set('nightStart', v)} error={err('nightStart')} testId="admin-site-night-start" />
          <TextField id={`${idp}-night-end`} type="time" label={t('admNightEnd')} value={values.nightEnd} onValueChange={(v) => set('nightEnd', v)} error={err('nightEnd')} testId="admin-site-night-end" />
        </div>
        <p className="text-xs text-ee-muted">{t('admShiftTimesHint')}</p>
        <Field id={`${idp}-interval`} label={t('admRoundInterval')} error={err('roundInterval')}>
          <select
            id={`${idp}-interval`}
            value={values.roundInterval}
            onChange={(event) => set('roundInterval', event.target.value)}
            aria-describedby={describedBy(`${idp}-interval`, undefined, err('roundInterval'))}
            className={inputClass}
            data-testid="admin-site-interval"
          >
            {values.roundInterval === '' && <option value="">{t('admNotSet')}</option>}
            {intervalOptions.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {t('admEveryMinutes', minutes)}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admSiteSectionContacts')}</legend>
        <TextField id={`${idp}-wa`} type="tel" inputMode="tel" label={t('admWhatsAppNumber')} value={values.whatsapp} onValueChange={(v) => set('whatsapp', v)} error={err('whatsapp')} hint={waPreview ? t('admWhatsAppWillSave', waPreview) : t('admWhatsAppHint')} autoComplete="off" testId="admin-site-whatsapp" />
        <TextField id={`${idp}-emergency`} type="tel" inputMode="tel" label={t('admEmergencyPhone')} value={values.emergencyPhone} onValueChange={(v) => set('emergencyPhone', v)} error={err('emergencyPhone')} hint={t('admEmergencyHint')} autoComplete="off" testId="admin-site-emergency" />
        <TextField id={`${idp}-police`} type="tel" inputMode="tel" label={t('admPolicePhone')} value={values.policePhone} onValueChange={(v) => set('policePhone', v)} error={err('policePhone')} hint={t('admPoliceHint')} autoComplete="off" testId="admin-site-police" />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-bold uppercase tracking-wide text-ee-primary mb-1">{t('admSiteSectionCards')}</legend>
        <CheckboxRow id={`${idp}-legacy`} label={t('admAllowLegacyQr')} description={t('admAllowLegacyQrHint')} checked={values.allowLegacyQr} onChange={(v) => set('allowLegacyQr', v)} testId="admin-site-legacy-qr" />
      </fieldset>

      <div className="space-y-2" aria-live="polite">
        {Object.keys(errors).length > 0 && <Notice tone="danger">{t('admFixErrors')}</Notice>}
        {saveError && <ErrorNotice error={saveError} title={t('admSiteNotSaved')} testId="admin-site-save-error" write />}
        {savedAt && !dirty && (
          <Notice tone="success" title={t('admSiteSaved')} testId="admin-site-saved">
            {t('admSavedReadBack', formatSastDateTime(savedAt, language))}
          </Notice>
        )}
        {dirty && !saving && <p className="text-sm text-ee-warning">{t('admUnsavedChanges')}</p>}
      </div>

      <Button type="submit" variant="primary" className="min-h-14 w-full sm:w-auto gap-2 text-base" disabled={saving || !dirty} data-testid="admin-site-save">
        <Save className="h-5 w-5" aria-hidden />
        <span>{saving ? t('admSaving') : t('admSaveSite')}</span>
      </Button>
    </form>
  );
}
