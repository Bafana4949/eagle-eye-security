'use client';

/**
 * Set a new password after following the e-mailed recovery link.
 *
 * The browser Supabase client uses the PKCE flow (@supabase/ssr): resetPasswordForEmail() stored
 * a code verifier in this browser's cookies, and the link comes back as /auth/reset?code=…. The
 * client exchanges that code by itself when it starts (detectSessionInUrl) and emits
 * PASSWORD_RECOVERY. Links built from a custom e-mail template (?token_hash=…&type=recovery) are
 * verified with verifyOtp(). The form only appears for a real recovery session — never for an
 * ordinary signed-in session that happens to be on this phone.
 */
import React, { useEffect, useId, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import type { AuthError, Session, SupabaseClient } from '@supabase/supabase-js';
import { useAuth } from '@/lib/auth/AuthProvider';
import { homeForRoles } from '@/lib/auth/routeAccess';
import { classifySignInError } from '@/lib/auth/signIn';
import { createClient } from '@/lib/supabase/client';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';

type InvalidReason = 'expired' | 'other_device' | 'no_link' | 'not_recovery' | 'offline' | 'config' | 'error';
type Phase =
  | { kind: 'checking' }
  | { kind: 'ready'; email: string | null }
  | { kind: 'invalid'; reason: InvalidReason; detail?: string }
  | { kind: 'done' };

/** Minimum length for a new password (same rule as accounts created by an administrator). */
const MIN_PASSWORD_LENGTH = 10;
/** A recovery session older than this no longer opens the form (request a new link). */
const RECOVERY_SESSION_MAX_AGE_S = 60 * 60;

// The URL as the page was loaded: the Supabase client removes ?code= after exchanging it, which
// can happen before this page's effect runs.
const LOADED_HREF = typeof window !== 'undefined' ? window.location.href : '';

function linkParams(href: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!href) return out;
  try {
    const url = new URL(href);
    url.searchParams.forEach((value, key) => {
      out[key] = value;
    });
    new URLSearchParams(url.hash.replace(/^#/, '')).forEach((value, key) => {
      out[key] = value;
    });
  } catch {
    // Malformed URL: no parameters.
  }
  return out;
}

/** True when the session was created by a password-recovery link within the last hour. */
function isRecentRecoverySession(session: Session | null): boolean {
  if (!session?.access_token) return false;
  try {
    const part = session.access_token.split('.')[1] ?? '';
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const claims = JSON.parse(atob(base64)) as { amr?: Array<{ method?: string; timestamp?: number }> };
    const nowS = Date.now() / 1000;
    return (claims.amr ?? []).some(
      (entry) =>
        entry.method === 'recovery' &&
        typeof entry.timestamp === 'number' &&
        nowS - entry.timestamp < RECOVERY_SESSION_MAX_AGE_S
    );
  } catch {
    return false;
  }
}

function classifyLinkError(error: Pick<AuthError, 'code' | 'name' | 'message'> | null | undefined): {
  reason: InvalidReason;
  detail?: string;
} {
  if (!error) return { reason: 'error' };
  const code = error.code ?? '';
  if (code === 'pkce_code_verifier_not_found' || error.name === 'AuthPKCECodeVerifierMissingError') {
    return { reason: 'other_device' };
  }
  if (['otp_expired', 'flow_state_expired', 'flow_state_not_found', 'bad_code_verifier', 'access_denied'].includes(code)) {
    return { reason: 'expired' };
  }
  const classified = classifySignInError(error);
  if (!classified.ok && classified.reason === 'network') return { reason: 'offline' };
  return { reason: 'error', detail: error.message };
}

// One code exchange per code, even when React runs the effect twice in development.
const exchanges = new Map<string, ReturnType<SupabaseClient['auth']['exchangeCodeForSession']>>();

async function resolveRecovery(supabase: SupabaseClient, sawRecoveryEvent: () => boolean): Promise<Phase> {
  const params = { ...linkParams(LOADED_HREF), ...linkParams(window.location.href) };

  if (params.error || params.error_code || params.error_description) {
    return {
      kind: 'invalid',
      ...classifyLinkError({
        code: params.error_code || params.error,
        name: 'AuthLinkError',
        message: params.error_description || params.error || ''
      } as Pick<AuthError, 'code' | 'name' | 'message'>)
    };
  }

  if (params.token_hash) {
    if (params.type && params.type !== 'recovery') return { kind: 'invalid', reason: 'not_recovery' };
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: params.token_hash, type: 'recovery' });
    if (error || !data.session) return { kind: 'invalid', ...classifyLinkError(error) };
    return { kind: 'ready', email: data.user?.email ?? null };
  }

  // The client's own start-up exchanges a ?code= whose verifier this browser holds. When that
  // exchange fails (expired or already-used link) auth-js has already deleted the verifier, so a
  // second exchange below would wrongly report "other device": use the start-up error instead.
  const started = await supabase.auth.initialize();
  if (params.code && started.error) return { kind: 'invalid', ...classifyLinkError(started.error) };

  const { data } = await supabase.auth.getSession();
  // PASSWORD_RECOVERY is announced on a timer right after start-up.
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  if (sawRecoveryEvent() || isRecentRecoverySession(data.session)) {
    return { kind: 'ready', email: data.session?.user.email ?? null };
  }

  if (params.code) {
    let exchange = exchanges.get(params.code);
    if (!exchange) {
      exchange = supabase.auth.exchangeCodeForSession(params.code);
      exchanges.set(params.code, exchange);
    }
    const result = await exchange;
    if (result.error || !result.data.session) return { kind: 'invalid', ...classifyLinkError(result.error) };
    // auth-js returns redirectType at runtime ('recovery' for a reset link) but does not type it.
    const redirectType = (result.data as { redirectType?: string | null }).redirectType ?? null;
    if (redirectType !== 'recovery' && !isRecentRecoverySession(result.data.session)) {
      return { kind: 'invalid', reason: 'not_recovery' };
    }
    return { kind: 'ready', email: result.data.user?.email ?? null };
  }

  return { kind: 'invalid', reason: 'no_link' };
}

const INVALID_TEXT: Record<InvalidReason, TranslationKey> = {
  expired: 'authResetLinkExpired',
  other_device: 'authResetLinkOtherDevice',
  no_link: 'authResetNoLink',
  not_recovery: 'authResetNotRecovery',
  offline: 'authResetLinkOffline',
  config: 'authConfigError',
  error: 'authResetLinkError'
};

const inputClass =
  'w-full min-h-12 rounded-xl border border-ee-border bg-ee-bg px-4 py-3 pr-14 text-base text-ee-text focus:border-ee-primary focus:outline-none focus:ring-1 focus:ring-ee-primary';

export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const passwordId = useId();
  const confirmId = useId();
  const ruleId = useId();

  useEffect(() => {
    let cancelled = false;
    let recoveryEvent = false;
    let unsubscribe: (() => void) | undefined;

    const run = async () => {
      await Promise.resolve();
      let supabase: SupabaseClient;
      try {
        supabase = createClient();
      } catch (err) {
        if (!cancelled) setPhase({ kind: 'invalid', reason: 'config', detail: err instanceof Error ? err.message : String(err) });
        return;
      }
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event !== 'PASSWORD_RECOVERY') return;
        recoveryEvent = true;
        if (!cancelled && session) setPhase({ kind: 'ready', email: session.user.email ?? null });
      });
      unsubscribe = () => data.subscription.unsubscribe();
      try {
        const next = await resolveRecovery(supabase, () => recoveryEvent);
        if (!cancelled) setPhase((current) => (current.kind === 'ready' && next.kind === 'invalid' ? current : next));
      } catch (err) {
        if (!cancelled) setPhase({ kind: 'invalid', reason: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    };
    void run();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('authNewPasswordTooShort', MIN_PASSWORD_LENGTH));
      return;
    }
    if (password !== confirm) {
      setError(t('authNewPasswordMismatch'));
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError(t('authResetOffline'));
      return;
    }
    setSaving(true);
    try {
      const { error: updateError } = await createClient().auth.updateUser({ password });
      if (!updateError) {
        setPassword('');
        setConfirm('');
        setPhase({ kind: 'done' });
        return;
      }
      const code = updateError.code ?? '';
      if (code === 'same_password') setError(t('authNewPasswordSame'));
      else if (code === 'weak_password') setError(t('authNewPasswordWeak', updateError.message));
      else if (code === 'reauthentication_needed' || code === 'session_not_found' || code === 'session_expired') {
        setError(t('authResetLinkExpired'));
      } else {
        const classified = classifySignInError(updateError);
        setError(!classified.ok && classified.reason === 'network' ? t('authResetOffline') : t('authNewPasswordFailed', updateError.message));
      }
    } catch (err) {
      setError(t('authNewPasswordFailed', err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const continueToApp = async () => {
    if (continuing) return;
    setContinuing(true);
    // A refresh superseded by the provider's own USER_UPDATED refresh resolves with an older
    // state; ask once more before sending the user to sign in again.
    let state = await auth.refresh();
    if (state.status !== 'signed_in') state = await auth.refresh();
    router.replace(state.status === 'signed_in' ? homeForRoles(state.roles) : '/login');
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-ee-bg px-4 py-8 text-ee-text">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Image
            src="/eagle_eye_enhanced_emblem.jpg"
            alt={t('authLogoAlt')}
            width={72}
            height={72}
            className="mx-auto h-18 w-18 rounded-2xl border-2 border-ee-primary/80 object-cover"
            loading="eager"
          />
          <h1 className="mt-3 font-display text-3xl font-bold">{t('authResetTitle')}</h1>
        </div>

        <div className="rounded-2xl border border-ee-border bg-ee-surface p-5" data-testid="auth-reset-panel" data-phase={phase.kind}>
          {phase.kind === 'checking' && (
            <p role="status" aria-live="polite" className="flex items-center gap-2 text-base text-ee-muted">
              <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t('authResetChecking')}
            </p>
          )}

          {phase.kind === 'invalid' && (
            <div role="alert" className="space-y-3" data-testid="auth-reset-invalid" data-reason={phase.reason}>
              <p className="flex items-start gap-2 text-base font-semibold text-ee-danger-text">
                <AlertCircle className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" />
                <span>{t(INVALID_TEXT[phase.reason])}</span>
              </p>
              {phase.detail && <p className="break-words text-sm text-ee-muted">{phase.detail}</p>}
              <Link
                href="/login"
                className="flex min-h-12 items-center justify-center rounded-xl border border-ee-border bg-ee-bg px-4 text-base font-semibold text-ee-text no-underline hover:bg-ee-surface-raised"
                data-testid="auth-reset-back-to-login"
              >
                {t('authBackToSignIn')}
              </Link>
            </div>
          )}

          {phase.kind === 'ready' && (
            <form onSubmit={save} className="space-y-4" noValidate data-testid="auth-reset-form">
              {phase.email && (
                <p className="text-sm text-ee-muted" data-testid="auth-reset-account">
                  {t('authResetForAccount', phase.email)}
                </p>
              )}
              <div>
                <label htmlFor={passwordId} className="mb-1.5 block text-sm font-semibold text-ee-muted">
                  {t('authNewPasswordLabel')}
                </label>
                <div className="relative">
                  <input
                    id={passwordId}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-describedby={ruleId}
                    className={inputClass}
                    data-testid="auth-reset-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? t('authHidePassword') : t('authShowPassword')}
                    aria-pressed={showPassword}
                    className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-ee-muted hover:text-ee-text"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                  </button>
                </div>
                <p id={ruleId} className="mt-1 text-xs text-ee-muted">
                  {t('authNewPasswordRule', MIN_PASSWORD_LENGTH)}
                </p>
              </div>
              <div>
                <label htmlFor={confirmId} className="mb-1.5 block text-sm font-semibold text-ee-muted">
                  {t('authConfirmPasswordLabel')}
                </label>
                <input
                  id={confirmId}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  className={inputClass}
                  data-testid="auth-reset-confirm"
                />
              </div>
              <div role="alert" aria-live="assertive" data-testid="auth-reset-error">
                {error && (
                  <p className="flex items-start gap-2 rounded-xl border border-ee-danger/70 bg-ee-danger/15 p-3 text-sm font-semibold text-ee-danger-text">
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                    <span>{error}</span>
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-ee-primary bg-ee-primary px-6 text-lg font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-60"
                data-testid="auth-reset-save"
              >
                {saving ? (
                  <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-5 w-5" aria-hidden="true" />
                )}
                <span>{saving ? t('authNewPasswordSaving') : t('authNewPasswordSave')}</span>
              </button>
            </form>
          )}

          {phase.kind === 'done' && (
            <div role="status" aria-live="polite" className="space-y-4" data-testid="auth-reset-done">
              <p className="flex items-start gap-2 text-base font-semibold text-ee-success">
                <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none" aria-hidden="true" />
                <span>{t('authNewPasswordSaved')}</span>
              </p>
              <button
                type="button"
                onClick={() => void continueToApp()}
                disabled={continuing}
                className="inline-flex min-h-14 w-full items-center justify-center rounded-xl border border-ee-primary bg-ee-primary px-6 text-lg font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-60"
                data-testid="auth-reset-continue"
              >
                {t('authContinue')}
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
