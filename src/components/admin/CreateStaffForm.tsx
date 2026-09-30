'use client';

/**
 * New staff account → POST /api/admin/users. The server creates the Supabase Auth account and the
 * profile / role / site rows; the result shown here is the server's answer, and the staff list is
 * then re-read from the database to confirm the person exists.
 */
import React, { useState } from 'react';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { Site, SupportedLanguage } from '@/types/models';
import { createStaffAccount, type CreateStaffClientResult } from './adminApi';
import {
  MIN_PASSWORD_LENGTH,
  createStaffSchema,
  generateStaffPassword,
  type CreateStaffRequest,
  type CreatedStaffAccount,
  type StaffRole
} from './staffSchema';
import { ROLE_LABEL_KEYS } from './format';
import { CheckboxRow, Field, Notice, TextField, describedBy, inputClass } from './ui';

type FormField = 'firstName' | 'lastName' | 'username' | 'email' | 'password' | 'employeeNumber' | 'phoneNumber' | 'siteIds';

const ISSUE_KEYS: Record<FormField, TranslationKey> = {
  firstName: 'admErrFirstName',
  lastName: 'admErrLastName',
  username: 'admErrUsername',
  email: 'admErrEmail',
  password: 'admErrPassword',
  employeeNumber: 'admErrTooLong',
  phoneNumber: 'admErrTooLong',
  siteIds: 'admErrSites'
};

function fieldForPath(path: ReadonlyArray<PropertyKey>): FormField | null {
  const [first, second] = path;
  if (first === 'login') return second === 'email' ? 'email' : 'username';
  if (typeof first === 'string' && first in ISSUE_KEYS) return first as FormField;
  return null;
}

export function staffErrorKey(result: Extract<CreateStaffClientResult, { ok: false }>): TranslationKey {
  switch (result.error) {
    case 'invalid_input':
      return 'admStaffErrInvalid';
    case 'cross_origin':
      return 'admStaffErrCrossOrigin';
    case 'not_signed_in':
      return 'admStaffErrSignedOut';
    case 'account_disabled':
      return 'admStaffErrDisabled';
    case 'forbidden':
      return 'admStaffErrForbidden';
    case 'super_admin_required':
      return 'admStaffErrSuperAdmin';
    case 'invalid_sites':
      return 'admStaffErrSites';
    case 'login_taken':
      return 'admStaffErrLoginTaken';
    case 'weak_password':
      return 'admStaffErrWeakPassword';
    case 'server_misconfigured':
      return 'admStaffErrServerConfig';
    case 'auth_service_error':
      return 'admStaffErrAuthService';
    case 'provisioning_failed':
      return 'rolledBack' in result && result.rolledBack === false ? 'admStaffErrNotRolledBack' : 'admStaffErrRolledBack';
    case 'network':
      return 'admStaffErrNetwork';
    case 'bad_response':
      // Timeout pages, proxies…: the server may still have created the account.
      return 'admStaffErrBadResponse';
    default:
      return 'admStaffErrBadRequest';
  }
}

interface CreateStaffFormProps {
  sites: Site[];
  /** Shown instead of the site choices while the list is loading, failed or empty. */
  sitesNotice: string | null;
  callerIsSuperAdmin: boolean;
  onCreated: (account: CreatedStaffAccount, password: string | null) => void;
  onCancel: () => void;
}

export function CreateStaffForm({ sites, sitesNotice, callerIsSuperAdmin, onCreated, onCancel }: CreateStaffFormProps) {
  const { t, language } = useTranslation();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [role, setRole] = useState<StaffRole>('guard');
  const [loginKind, setLoginKind] = useState<'username' | 'email'>('username');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [generated, setGenerated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState<SupportedLanguage>(language);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<FormField, TranslationKey>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<Extract<CreateStaffClientResult, { ok: false }> | null>(null);

  const roles: StaffRole[] = callerIsSuperAdmin ? ['guard', 'supervisor', 'client_viewer', 'admin', 'super_admin'] : ['guard', 'supervisor', 'client_viewer', 'admin'];
  const err = (field: FormField) => (errors[field] ? t(errors[field] as TranslationKey, MIN_PASSWORD_LENGTH) : undefined);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const request: CreateStaffRequest = {
      firstName,
      lastName,
      role,
      login: loginKind === 'username' ? { kind: 'username', username } : { kind: 'email', email },
      password,
      employeeNumber,
      phoneNumber,
      preferredLanguage,
      siteIds
    };
    const parsed = createStaffSchema.safeParse(request);
    if (!parsed.success) {
      const next: Partial<Record<FormField, TranslationKey>> = {};
      for (const issue of parsed.error.issues) {
        const field = fieldForPath(issue.path);
        if (field && !next[field]) next[field] = ISSUE_KEYS[field];
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    const result = await createStaffAccount(request);
    setSubmitting(false);
    if (!result.ok) {
      setServerError(result);
      return;
    }
    onCreated(result.user, generated ? password : null);
  };

  const toggleSite = (id: string, checked: boolean) => {
    setSiteIds((current) => (checked ? [...new Set([...current, id])] : current.filter((s) => s !== id)));
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid="admin-staff-create-form">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField id="admin-staff-first" label={t('admFirstName')} value={firstName} onValueChange={setFirstName} error={err('firstName')} autoComplete="off" maxLength={100} testId="admin-staff-first-name" />
        <TextField id="admin-staff-last" label={t('admLastName')} value={lastName} onValueChange={setLastName} error={err('lastName')} autoComplete="off" maxLength={100} testId="admin-staff-last-name" />
      </div>

      <Field id="admin-staff-role" label={t('admRole')}>
        <select id="admin-staff-role" value={role} onChange={(event) => setRole(event.target.value as StaffRole)} className={inputClass} data-testid="admin-staff-role">
          {roles.map((r) => (
            <option key={r} value={r}>
              {t(ROLE_LABEL_KEYS[r])}
            </option>
          ))}
        </select>
      </Field>

      <fieldset className="space-y-2">
        <legend className="block text-sm font-semibold text-ee-muted mb-1">{t('admSignInWith')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['username', 'email'] as const).map((kind) => (
            <label
              key={kind}
              className={`min-h-12 flex items-center gap-2 rounded-xl border px-3 cursor-pointer ${loginKind === kind ? 'border-ee-primary text-ee-text' : 'border-ee-border text-ee-muted'}`}
            >
              <input type="radio" name="admin-staff-login-kind" value={kind} checked={loginKind === kind} onChange={() => setLoginKind(kind)} className="h-5 w-5 accent-ee-primary" data-testid={`admin-staff-login-${kind}`} />
              <span>{kind === 'username' ? t('admLoginUsername') : t('admLoginEmail')}</span>
            </label>
          ))}
        </div>
        {loginKind === 'username' ? (
          <TextField id="admin-staff-username" label={t('admUsername')} value={username} onValueChange={(v) => setUsername(v.toLowerCase())} error={err('username')} hint={t('admUsernameHint')} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={64} testId="admin-staff-username" />
        ) : (
          <TextField id="admin-staff-email" type="email" label={t('admEmail')} value={email} onValueChange={setEmail} error={err('email')} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} testId="admin-staff-email" />
        )}
      </fieldset>

      <Field id="admin-staff-password" label={t('admPassword')} hint={t('admPasswordHint', MIN_PASSWORD_LENGTH)} error={err('password')}>
        <div className="flex gap-2">
          <input
            id="admin-staff-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setGenerated(false);
            }}
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={describedBy('admin-staff-password', t('admPasswordHint', MIN_PASSWORD_LENGTH), err('password'))}
            className={`${inputClass} font-mono`}
            data-testid="admin-staff-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="min-h-12 min-w-12 flex-none rounded-xl border border-ee-border text-ee-muted hover:text-ee-text hover:bg-ee-surface-raised flex items-center justify-center"
            aria-label={showPassword ? t('admHidePassword') : t('admShowPassword')}
            aria-pressed={showPassword}
            data-testid="admin-staff-password-toggle"
          >
            {showPassword ? <EyeOff className="h-5 w-5" aria-hidden /> : <Eye className="h-5 w-5" aria-hidden />}
          </button>
        </div>
      </Field>
      <Button
        type="button"
        variant="secondary"
        className="min-h-12 gap-2"
        onClick={() => {
          setPassword(generateStaffPassword());
          setGenerated(true);
          setShowPassword(true);
        }}
        data-testid="admin-staff-password-generate"
      >
        <KeyRound className="h-4 w-4" aria-hidden />
        <span>{t('admGeneratePassword')}</span>
      </Button>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField id="admin-staff-employee" label={t('admEmployeeNumber')} value={employeeNumber} onValueChange={setEmployeeNumber} error={err('employeeNumber')} autoComplete="off" maxLength={50} testId="admin-staff-employee-number" />
        <TextField id="admin-staff-phone" type="tel" inputMode="tel" label={t('admPhoneNumber')} value={phoneNumber} onValueChange={setPhoneNumber} error={err('phoneNumber')} autoComplete="off" maxLength={50} testId="admin-staff-phone" />
      </div>

      <Field id="admin-staff-language" label={t('admPreferredLanguage')}>
        <select id="admin-staff-language" value={preferredLanguage} onChange={(event) => setPreferredLanguage(event.target.value as SupportedLanguage)} className={inputClass} data-testid="admin-staff-language">
          <option value="af">{t('admLangAf')}</option>
          <option value="en">{t('admLangEn')}</option>
          <option value="zu">{t('admLangZu')}</option>
        </select>
      </Field>

      <fieldset>
        <legend className="block text-sm font-semibold text-ee-muted mb-1">{t('admAssignedSites')}</legend>
        {sitesNotice ? (
          <p className="text-sm text-ee-muted">{sitesNotice}</p>
        ) : (
          <div className="divide-y divide-ee-border border-y border-ee-border">
            {sites.map((site) => (
              <CheckboxRow key={site.id} id={`admin-staff-new-site-${site.id}`} label={site.name} description={site.code} checked={siteIds.includes(site.id)} onChange={(checked) => toggleSite(site.id, checked)} testId={`admin-staff-new-site-${site.id}`} />
            ))}
          </div>
        )}
        {err('siteIds') && <p className="mt-1 text-sm text-ee-danger-text">{err('siteIds')}</p>}
        {(role === 'guard' || role === 'supervisor' || role === 'client_viewer') && siteIds.length === 0 && (
          <p className="mt-1 text-sm text-ee-warning">{t('admNoSiteWarning')}</p>
        )}
      </fieldset>

      <div aria-live="polite" className="space-y-2">
        {Object.keys(errors).length > 0 && <Notice tone="danger">{t('admFixErrors')}</Notice>}
        {serverError && (
          <Notice
            tone="danger"
            title={serverError.error === 'network' || serverError.error === 'bad_response' ? t('admWriteNotConfirmed') : t('admStaffNotCreated')}
            testId="admin-staff-create-error"
          >
            <p>{t(staffErrorKey(serverError))}</p>
            {'fields' in serverError && serverError.fields && serverError.fields.length > 0 && (
              <p className="text-xs text-ee-muted">{serverError.fields.join(', ')}</p>
            )}
          </Notice>
        )}
      </div>

      <div className="flex flex-col-reverse sm:flex-row gap-2">
        <Button type="button" variant="secondary" className="min-h-12" onClick={onCancel} disabled={submitting}>
          {t('admCancel')}
        </Button>
        <Button type="submit" variant="primary" className="min-h-12" disabled={submitting} data-testid="admin-staff-create-submit">
          {submitting ? t('admCreatingAccount') : t('admCreateAccount')}
        </Button>
      </div>
    </form>
  );
}
