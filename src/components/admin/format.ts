import { SITE_TIME_ZONE } from '@/lib/config/siteTime';
import type { SupportedLanguage, UserRole } from '@/types/models';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { AdminError } from './adminData';

const LOCALES: Record<SupportedLanguage, string> = { en: 'en-ZA', af: 'af-ZA', zu: 'zu-ZA' };

/** Date and time in South African time (SAST), whatever the device's time zone is. */
export function formatSastDateTime(value: string | number | undefined | null, language: SupportedLanguage): string {
  if (value === undefined || value === null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(LOCALES[language] ?? 'en-ZA', {
      timeZone: SITE_TIME_ZONE,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatCoordinate(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6) : '';
}

export const ROLE_LABEL_KEYS: Record<UserRole, TranslationKey> = {
  super_admin: 'admRoleSuperAdmin',
  admin: 'admRoleAdmin',
  supervisor: 'admRoleSupervisor',
  guard: 'admRoleGuard',
  client_viewer: 'admRoleViewer'
};

const ERROR_KIND_KEYS: Record<AdminError['kind'], TranslationKey> = {
  not_allowed: 'admErrNotAllowed',
  not_found: 'admErrNotFound',
  conflict: 'admErrConflict',
  invalid: 'admErrInvalid',
  in_use: 'admErrInUse',
  network: 'admErrNetwork',
  not_confirmed: 'admErrNotConfirmed',
  error: 'admErrGeneric'
};

const CHECKPOINT_PROBLEM_KEYS: Partial<Record<NonNullable<AdminError['problem']>, TranslationKey>> = {
  duplicate_tag: 'admErrDuplicateTag',
  duplicate_legacy_code: 'admErrDuplicateLegacy',
  invalid_tag_serial: 'admErrInvalidSerial',
  invalid_token: 'admErrInvalidToken',
  in_use: 'admErrCheckpointInUse',
  not_allowed: 'admErrNotAllowed'
};

/** Translation key that summarises an admin error for the user. */
export function adminErrorKey(error: AdminError): TranslationKey {
  if (error.problem && CHECKPOINT_PROBLEM_KEYS[error.problem]) return CHECKPOINT_PROBLEM_KEYS[error.problem] as TranslationKey;
  return ERROR_KIND_KEYS[error.kind] ?? 'admErrGeneric';
}
