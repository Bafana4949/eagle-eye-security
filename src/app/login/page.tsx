'use client';

import React, { Suspense, useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Info, Loader2, LogIn } from 'lucide-react';
import { signIn, useAuth, type AuthState } from '@/lib/auth/AuthProvider';
import { classifySignInError, guardLoginDomain, type SignInResult } from '@/lib/auth/signIn';
import { AREA_ROLES, areaForPath, hasAnyRole, homeForRoles, safeNextPath } from '@/lib/auth/routeAccess';
import { createClient } from '@/lib/supabase/client';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { UserRole } from '@/types/models';
import { LanguageSwitch, SIGN_OUT_NOTICE_KEY } from '@/components/shared/HeaderNav';

type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;
type Notice = { tone: 'info' | 'warning' | 'danger' | 'success'; text: string };

const noticeClass: Record<Notice['tone'], string> = {
  info: 'border-ee-border bg-ee-bg text-ee-text',
  success: 'border-ee-success/60 bg-ee-success/10 text-ee-success',
  warning: 'border-ee-warning/60 bg-ee-warning/10 text-ee-warning',
  danger: 'border-ee-danger/70 bg-ee-danger/15 text-ee-danger-text'
};

const inputClass =
  'w-full min-h-12 rounded-xl border border-ee-border bg-ee-bg px-4 py-3 text-base text-ee-text placeholder:text-ee-muted/70 focus:border-ee-primary focus:outline-none focus:ring-1 focus:ring-ee-primary';

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function signInErrorText(result: Extract<SignInResult, { ok: false }>, t: Translate): string {
  switch (result.reason) {
    case 'invalid_input':
      return t('authErrInvalidInput');
    case 'invalid_credentials':
      return t('authErrInvalidCredentials');
    case 'rate_limited':
      return t('authErrRateLimited');
    case 'not_activated':
      return t('authErrNotActivated');
    case 'account_blocked':
      return t('authErrBlocked');
    case 'network':
      return t('authErrOffline');
    default:
      return t('authErrGeneric', result.message);
  }
}

/** Where to go after sign-in: a safe same-origin `next` the roles may open, else the role's home. */
function destinationFor(nextParam: string | null, roles: readonly UserRole[]): string {
  const home = homeForRoles(roles);
  const next = safeNextPath(nextParam, home);
  const pathname = next.split(/[?#]/)[0] ?? '/';
  if (pathname === '/login' || pathname.startsWith('/auth/')) return home;
  const area = areaForPath(pathname);
  if (area && !hasAnyRole(roles, AREA_ROLES[area])) return home;
  return next;
}

function reasonNotice(reason: string | null, t: Translate): Notice | null {
  if (reason === 'disabled') return { tone: 'danger', text: t('authReasonDisabled') };
  if (reason === 'no_profile') return { tone: 'danger', text: t('authReasonNoProfile') };
  return null;
}

function LoginHeader() {
  const { t } = useTranslation();
  return (
    <div className="text-center">
      <Image
        src="/Eagle_Eye_Logo.jpg"
        alt={t('authLogoAlt')}
        width={88}
        height={88}
        className="mx-auto h-22 w-22 rounded-2xl border-2 border-ee-primary/80 object-cover"
        loading="eager"
      />
      <h1 className="mt-3 font-display text-3xl font-bold uppercase tracking-wide">{t('authBrandName')}</h1>
      <p className="mt-1 text-sm font-semibold uppercase tracking-wider text-ee-muted">{t('authBrandOrgFull')}</p>
    </div>
  );
}

function ForgotPassword({ initialEmail }: { initialEmail: string }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Notice | null>(null);
  const emailId = useId();

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const value = email.trim().toLowerCase();
    setResult(null);
    if (!value.includes('@') || value.endsWith(`@${guardLoginDomain().toLowerCase()}`)) {
      setResult({ tone: 'warning', text: t('authResetGuardsAskAdmin') });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setResult({ tone: 'danger', text: t('authResetInvalidEmail') });
      return;
    }
    if (isOffline()) {
      setResult({ tone: 'warning', text: t('authResetOffline') });
      return;
    }
    setBusy(true);
    try {
      const { error } = await createClient().auth.resetPasswordForEmail(value, {
        redirectTo: `${window.location.origin}/auth/reset`
      });
      if (error) {
        const classified = classifySignInError(error);
        if (!classified.ok && classified.reason === 'rate_limited') setResult({ tone: 'warning', text: t('authResetRateLimited') });
        else if (!classified.ok && classified.reason === 'network') setResult({ tone: 'warning', text: t('authResetOffline') });
        else setResult({ tone: 'danger', text: t('authResetFailed', error.message) });
      } else {
        setResult({ tone: 'success', text: t('authResetRequested', value) });
      }
    } catch (error) {
      setResult({ tone: 'danger', text: t('authResetFailed', error instanceof Error ? error.message : String(error)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={request} className="mt-4 space-y-3 border-t border-ee-border pt-4" noValidate data-testid="auth-reset-request-form">
      <p className="text-sm text-ee-muted">{t('authResetIntro')}</p>
      <div>
        <label htmlFor={emailId} className="mb-1.5 block text-sm font-semibold text-ee-muted">
          {t('authEmailLabel')}
        </label>
        <input
          id={emailId}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClass}
          data-testid="auth-reset-email"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-ee-border bg-ee-surface px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-50"
        data-testid="auth-reset-submit"
      >
        {busy && <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        {busy ? t('authResetSending') : t('authResetSend')}
      </button>
      <p role="status" aria-live="polite" data-testid="auth-reset-status">
        {result && <span className={`block rounded-xl border p-3 text-sm ${noticeClass[result.tone]}`}>{result.text}</span>}
      </p>
    </form>
  );
}

function LoginScreen() {
  const { t } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get('next');
  const reasonParam = searchParams.get('reason');

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signOutKind, setSignOutKind] = useState<'local' | 'server' | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const submittingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const loginId = useId();
  const passwordId = useId();
  const forgotId = useId();

  // How the last sign-out on this phone went (written by the sign-out flow). Read once.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let value: string | null = null;
      try {
        value = window.sessionStorage.getItem(SIGN_OUT_NOTICE_KEY);
        if (value) window.sessionStorage.removeItem(SIGN_OUT_NOTICE_KEY);
      } catch {
        value = null;
      }
      if (value !== 'local' && value !== 'server') return;
      setSignOutKind(value);
      // A deliberate sign-out starts fresh: drop the ?next= left behind by the page that was open.
      if (new URLSearchParams(window.location.search).has('next')) router.replace('/login');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [router]);

  // Already signed in (e.g. opened /login from a bookmark): go straight on.
  useEffect(() => {
    if (auth.status === 'signed_in' && !submittingRef.current) {
      router.replace(destinationFor(nextParam, auth.roles));
    }
  }, [auth.status, auth.roles, nextParam, router]);

  const reasonFromAccount = auth.status === 'signed_out' ? reasonNotice(auth.reason, t) : null;
  const signOutNotice: Notice | null =
    signOutKind === 'local'
      ? { tone: 'warning', text: t('authSignedOutLocal') }
      : signOutKind === 'server'
        ? { tone: 'success', text: t('authSignedOut') }
        : null;
  const notice = reasonNotice(reasonParam, t) ?? reasonFromAccount ?? signOutNotice;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    setError(null);
    if (!login.trim() || !password) {
      setError(t('authErrMissing'));
      return;
    }
    if (isOffline()) {
      setError(t('authErrOffline'));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await signIn(login, password);
      if (!result.ok) {
        setError(signInErrorText(result, t));
        setPassword('');
        passwordRef.current?.focus();
        return;
      }
      // AuthProvider also refreshes on its own SIGNED_IN event. A refresh that this newer one
      // supersedes resolves with the state from BEFORE the sign-in (e.g. "signed out", or the reason
      // of an earlier attempt), which must never decide what the user is told. Unless the first
      // answer already belongs to this account, ask once more: that last refresh is authoritative.
      const isThisAccount = (candidate: AuthState) =>
        candidate.status === 'signed_in' && candidate.user?.id === result.userId;
      let state = await auth.refresh();
      if (!isThisAccount(state)) state = await auth.refresh();
      if (isThisAccount(state)) {
        router.replace(destinationFor(nextParam, state.roles));
        return;
      }
      if (state.reason === 'disabled' || state.reason === 'no_profile') {
        // The password was right but there is no usable Eagle Eye account: end that session here.
        await auth.signOut();
        setError(state.reason === 'disabled' ? t('authReasonDisabled') : t('authReasonNoProfile'));
      } else if (state.reason === 'config_error') {
        setError(t('authConfigError'));
      } else {
        setError(t('authErrProfileUnavailable', state.error ?? ''));
      }
    } catch (err) {
      setError(t('authErrGeneric', err instanceof Error ? err.message : String(err)));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const redirecting = auth.status === 'signed_in' && !submitting;

  return (
    <div className="w-full max-w-sm space-y-6">
      <LoginHeader />

      <div className="rounded-2xl border border-ee-border bg-ee-surface p-5">
        <h2 className="mb-4 font-display text-2xl font-semibold">{t('authSignInTitle')}</h2>

        {notice && (
          <p
            role={notice.tone === 'danger' ? 'alert' : 'status'}
            className={`mb-4 flex items-start gap-2 rounded-xl border p-3 text-sm ${noticeClass[notice.tone]}`}
            data-testid="auth-login-notice"
          >
            <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{notice.text}</span>
          </p>
        )}

        <div role="alert" aria-live="assertive" data-testid="auth-login-error">
          {error && (
            <p className="mb-4 flex items-start gap-2 rounded-xl border border-ee-danger/70 bg-ee-danger/15 p-3 text-sm font-semibold text-ee-danger-text">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
        </div>

        {redirecting ? (
          <p role="status" className="text-base text-ee-muted" data-testid="auth-login-redirecting">
            {t('authOpeningYourArea')}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate data-testid="auth-login-form">
            <div>
              <label htmlFor={loginId} className="mb-1.5 block text-sm font-semibold text-ee-muted">
                {t('authLoginLabel')}
              </label>
              <input
                id={loginId}
                name="username"
                type="text"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby={`${loginId}-hint`}
                className={inputClass}
                data-testid="auth-login-username"
              />
              <p id={`${loginId}-hint`} className="mt-1 text-xs text-ee-muted">
                {t('authLoginHint')}
              </p>
            </div>

            <div>
              <label htmlFor={passwordId} className="mb-1.5 block text-sm font-semibold text-ee-muted">
                {t('authPasswordLabel')}
              </label>
              <div className="relative">
                <input
                  id={passwordId}
                  ref={passwordRef}
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  className={`${inputClass} pr-14`}
                  data-testid="auth-login-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? t('authHidePassword') : t('authShowPassword')}
                  aria-pressed={showPassword}
                  aria-controls={passwordId}
                  className="absolute right-1 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-ee-muted hover:text-ee-text"
                  data-testid="auth-login-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-ee-primary bg-ee-primary px-6 text-lg font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-60"
              data-testid="auth-login-submit"
            >
              {submitting ? (
                <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <LogIn className="h-5 w-5" aria-hidden="true" />
              )}
              <span>{submitting ? t('authSigningIn') : t('authSignIn')}</span>
            </button>
          </form>
        )}

        {!redirecting && (
          <>
            <button
              type="button"
              onClick={() => setForgotOpen((open) => !open)}
              aria-expanded={forgotOpen}
              aria-controls={forgotId}
              className="mt-3 min-h-12 w-full rounded-xl text-base font-semibold text-ee-primary underline-offset-4 hover:underline"
              data-testid="auth-login-forgot"
            >
              {t('authForgotPassword')}
            </button>
            <div id={forgotId} hidden={!forgotOpen}>
              {forgotOpen && <ForgotPassword initialEmail={login.includes('@') ? login.trim() : ''} />}
            </div>
          </>
        )}
      </div>

      <LanguageSwitch testIdPrefix="auth-login-lang" />
    </div>
  );
}

function LoginFallback() {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-sm space-y-6">
      <LoginHeader />
      <p role="status" className="text-center text-base text-ee-muted">
        {t('authLoading')}
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-ee-bg px-4 py-8 text-ee-text">
      <Suspense fallback={<LoginFallback />}>
        <LoginScreen />
      </Suspense>
    </main>
  );
}
