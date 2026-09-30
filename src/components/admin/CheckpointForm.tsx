'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { Checkpoint } from '@/types/models';
import type { AdminError, AdminResult, CheckpointInput } from './adminData';
import {
  RADIUS_MAX_M,
  RADIUS_MIN_M,
  validateCheckpointForm,
  type CheckpointFormField,
  type CheckpointFormValues,
  type FieldErrors
} from './validation';
import { GpsCapture } from './GpsCapture';
import { ErrorNotice, Field, Notice, TextField, describedBy, inputClass } from './ui';

interface CheckpointFormProps {
  idPrefix: string;
  initial: CheckpointFormValues;
  submitLabel: string;
  /** Performs the write; the form shows the error, or calls onStored with the stored row. */
  onSubmit: (input: CheckpointInput) => Promise<AdminResult<Checkpoint>>;
  onStored: (checkpoint: Checkpoint) => void;
  onCancel: () => void;
  testIdPrefix: string;
}

export function CheckpointForm({ idPrefix, initial, submitLabel, onSubmit, onStored, onCancel, testIdPrefix }: CheckpointFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<CheckpointFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors<CheckpointFormField>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AdminError | null>(null);
  const [fixAccuracy, setFixAccuracy] = useState<number | null>(null);

  const set = (key: CheckpointFormField, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === 'latitude' || key === 'longitude') setFixAccuracy(null);
  };
  const err = (key: CheckpointFormField) => (errors[key] ? t(errors[key]) : undefined);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    const validated = validateCheckpointForm(values);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const result = await onSubmit(validated.value);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    onStored(result.value);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3" data-testid={`${testIdPrefix}-form`}>
      <TextField id={`${idPrefix}-name`} label={t('admCheckpointName')} value={values.name} onValueChange={(v) => set('name', v)} error={err('name')} maxLength={255} autoComplete="off" testId={`${testIdPrefix}-name`} />
      <Field id={`${idPrefix}-desc`} label={t('admCheckpointDescription')} error={err('description')}>
        <textarea
          id={`${idPrefix}-desc`}
          value={values.description}
          onChange={(event) => set('description', event.target.value)}
          rows={2}
          maxLength={2000}
          aria-describedby={describedBy(`${idPrefix}-desc`, undefined, err('description'))}
          className={inputClass}
          data-testid={`${testIdPrefix}-description`}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <TextField id={`${idPrefix}-radius`} label={t('admCheckpointRadius')} value={values.radius} onValueChange={(v) => set('radius', v)} error={err('radius')} hint={t('admRadiusRange', RADIUS_MIN_M, RADIUS_MAX_M)} inputMode="numeric" testId={`${testIdPrefix}-radius`} />
        <TextField id={`${idPrefix}-order`} label={t('admCheckpointOrder')} value={values.order} onValueChange={(v) => set('order', v)} error={err('order')} inputMode="numeric" testId={`${testIdPrefix}-order`} />
      </div>
      <TextField id={`${idPrefix}-legacy`} label={t('admLegacyCode')} value={values.legacyCode} onValueChange={(v) => set('legacyCode', v)} error={err('legacyCode')} hint={t('admLegacyCodeHint')} autoComplete="off" autoCapitalize="characters" maxLength={80} testId={`${testIdPrefix}-legacy`} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField id={`${idPrefix}-lat`} label={t('admLatitude')} value={values.latitude} onValueChange={(v) => set('latitude', v)} error={err('latitude')} inputMode="decimal" autoComplete="off" testId={`${testIdPrefix}-latitude`} />
        <TextField id={`${idPrefix}-lng`} label={t('admLongitude')} value={values.longitude} onValueChange={(v) => set('longitude', v)} error={err('longitude')} inputMode="decimal" autoComplete="off" testId={`${testIdPrefix}-longitude`} />
      </div>
      <p className="text-xs text-ee-muted">{t('admCheckpointLocationHint')}</p>
      <GpsCapture
        testIdPrefix={testIdPrefix}
        onCapture={(fix) => {
          setValues((current) => ({ ...current, latitude: fix.latitude.toFixed(6), longitude: fix.longitude.toFixed(6) }));
          setFixAccuracy(fix.accuracy);
        }}
      />
      {fixAccuracy !== null && <p className="text-xs text-ee-muted">{t('admFixAccuracyNote', fixAccuracy)}</p>}

      {Object.keys(errors).length > 0 && <Notice tone="danger">{t('admFixErrors')}</Notice>}
      {saveError && <ErrorNotice error={saveError} title={t('admCheckpointNotSaved')} testId={`${testIdPrefix}-error`} write />}

      <div className="flex flex-col-reverse sm:flex-row gap-2">
        <Button type="button" variant="secondary" className="min-h-12" onClick={onCancel} disabled={saving}>
          {t('admCancel')}
        </Button>
        <Button type="submit" variant="primary" className="min-h-12" disabled={saving} data-testid={`${testIdPrefix}-submit`}>
          {saving ? t('admSaving') : submitLabel}
        </Button>
      </div>
    </form>
  );
}
