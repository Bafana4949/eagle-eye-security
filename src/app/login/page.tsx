'use client';

/**
 * Sign-in. Two tabs:
 * - "Guard duty": on a patrol phone (enrolled by a supervisor / admin for one site, see
 *   src/lib/auth/patrolDevice.ts) guards tap their name — no e-mail, no password. The phone's
 *   device secret is the only credential; the server decides who may sign in. On any other phone
 *   the tab explains that it must be enrolled first.
 * - "Admin & supervisor": username / e-mail + password (+ forgot password). Guards who have their
 *   own login may use it too.
 * The guard tab is the default on an enrolled phone. On a shared patrol phone somebody may still be
 * signed in. Hand-over rule (src/lib/auth/handOver.ts): the NEXT person's session is created first
 * (password checked / guard tap accepted); only then is the previous person forgotten on this phone
 * and their old session ended on the server. A wrong password or a refused tap leaves whoever was
 * signed in untouched. Their queued records stay on the phone and upload when they sign in on this
 * phone again (within 7 days) - the roster shows how many are waiting per guard.
 * A supervisor / admin left signed in on a patrol phone is never offered "Continue as": only
 * "Sign out" (guards must never reach /admin or /supervisor through a patrol phone).
 */
import React, { Suspense, useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Clock, Eye, EyeOff, Info, KeyRound, Loader2, LogIn, UsersRound, WifiOff } from 'lucide-react';
import { signIn, useAuth, type AuthState } from '@/lib/auth/AuthProvider';
import { classifySignInError, guardLoginDomain, type SignInResult } from '@/lib/auth/signIn';
import { AREA_ROLES, areaForPath, hasAnyRole, homeForRoles, safeNextPath } from '@/lib/auth/routeAccess';
import {
  isManagerAccount,
  markDeviceSignIn,
  signInGuardOnDevice,
  takeEnrolledNote,
  type EnrolledNote,
  type RosterGuard
} from '@/lib/auth/patrolDevice';
import { captureSessionAccessToken, forgetReplacedUser, revokeReplacedSession } from '@/lib/auth/handOver';
import { browserStorage } from '@/lib/auth/identity';
import { sastTimeHM } from '@/lib/config/siteTime';
import { createClient } from '@/lib/supabase/client';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { UserRole } from '@/types/models';
import { LanguageSwitch, SIGN_OUT_NOTICE_KEY, SignOutControl } from '@/components/shared/HeaderNav';
import { GUARD_DEVICE_ERROR_KEYS, GuardDutyPanel } from '@/components/devices/GuardDutyPanel';
import { useBrowserOnline, usePatrolDevice } from '@/components/devices/usePatrolDevice';
import { useOpenShift, useQueuedRecords } from '@/components/devices/usePhoneRecords';

type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;
type Notice = { tone: 'info' | 'warning' | 'danger' | 'success'; text: string };
type LoginTab = 'guard' | 'staff';

const LOGIN_TABS: ReadonlyArray<{ id: LoginTab; label: TranslationKey; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }> }> = [
  { id: 'guard', label: 'pdevTabGuard', icon: UsersRound },
  { id: 'staff', label: 'pdevTabStaff', icon: KeyRound }
];

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

function LoginHeader({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  if (compact) {
    // Patrol phone, Guard duty tab: keep the guards' names in the first screen (320 x 640).
    return (
      <div className="flex items-center justify-center gap-3" data-testid="auth-login-header-compact">
        <Image
          src="/eagle_eye_enhanced_emblem.jpg"
          alt={t('authLogoAlt')}
          width={44}
          height={44}
          className="h-11 w-11 flex-none rounded-xl border-2 border-ee-primary/80 object-cover"
          loading="eager"
        />
        <h1 className="font-display text-2xl font-bold uppercase tracking-wide">{t('authBrandName')}</h1>
      </div>
    );
  }
  return (
    <div className="text-center">
      <Image
        src="/eagle_eye_enhanced_emblem.jpg"
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

type SettleResult = { ok: true; state: AuthState } | { ok: false; message: string };

function LoginScreen() {
  const { t } = useTranslation();
  const auth = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextParam = searchParams.get('next');
  const reasonParam = searchParams.get('reason');
  const device = usePatrolDevice();
  const enrolled = device !== null;

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signOutKind, setSignOutKind] = useState<'local' | 'server' | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [chosenTab, setChosenTab] = useState<LoginTab | null>(null);
  const [knownDeviceId, setKnownDeviceId] = useState<string | null>(null);
  const [guardBusyId, setGuardBusyId] = useState<string | null>(null);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [rosterReload, setRosterReload] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [enrolledNote, setEnrolledNote] = useState<EnrolledNote | null>(null);
  const online = useBrowserOnline();
  const queued = useQueuedRecords();
  const signedInUserId = auth.status === 'signed_in' ? (auth.user?.id ?? null) : null;
  const openShift = useOpenShift(enrolled ? signedInUserId : null);
  const submittingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const loginId = useId();
  const passwordId = useId();
  const forgotId = useId();
  const tabsId = useId();

  // Remember that this phone was a patrol phone during this visit. When the server says it is not
  // enrolled any more (revoked), the local enrolment is cleared and the guard tab stays open to
  // explain that — decided in the same render, so the tab never flips to the password form first.
  if (device && device.deviceId !== knownDeviceId) setKnownDeviceId(device.deviceId);
  const enrolmentLost = !device && knownDeviceId !== null;

  // The guard tab is the default on a patrol phone.
  const tab: LoginTab = chosenTab ?? (enrolled || enrolmentLost ? 'guard' : 'staff');

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
      // Just enrolled this phone (the manager was signed out on the way here).
      const note = takeEnrolledNote();
      if (note) setEnrolledNote(note);
      if (value !== 'local' && value !== 'server') return;
      setSignOutKind(value);
      // A deliberate sign-out starts fresh: drop the ?next= left behind by the page that was open.
      if (new URLSearchParams(window.location.search).has('next')) router.replace('/login');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [router]);

  // Already signed in (e.g. opened /login from a bookmark): go straight on. On a shared patrol
  // phone the page stays, so the next guard can take over (see the "signed in" box below).
  useEffect(() => {
    if (auth.status === 'signed_in' && !submittingRef.current && !enrolled) {
      router.replace(destinationFor(nextParam, auth.roles));
    }
  }, [auth.status, auth.roles, nextParam, router, enrolled]);

  const reasonFromAccount = auth.status === 'signed_out' ? reasonNotice(auth.reason, t) : null;
  const signOutNotice: Notice | null =
    signOutKind === 'local'
      ? { tone: 'warning', text: t('authSignedOutLocal') }
      : signOutKind === 'server'
        ? { tone: 'success', text: t('authSignedOut') }
        : null;
  const enrolledNotice: Notice | null = enrolledNote
    ? {
        tone: enrolledNote.oldRevokeFailed ? 'warning' : 'success',
        text: [t('pdevEnrolledSignedOut', enrolledNote.siteName), enrolledNote.oldRevokeFailed ? t('pdevEnrolledOldRevokeFailed') : '']
          .filter(Boolean)
          .join(' ')
      }
    : null;
  const notice = reasonNotice(reasonParam, t) ?? reasonFromAccount ?? enrolledNotice ?? signOutNotice;

  /**
   * After a new session exists: load that account. AuthProvider also refreshes on its own
   * SIGNED_IN event. A refresh that this newer one supersedes resolves with the state from BEFORE
   * the sign-in (e.g. "signed out", or the reason of an earlier attempt), which must never decide
   * what the user is told. Unless the first answer already belongs to this account, ask once more:
   * that last refresh is authoritative.
   */
  const settleSession = async (userId: string): Promise<SettleResult> => {
    const isThisAccount = (candidate: AuthState) => candidate.status === 'signed_in' && candidate.user?.id === userId;
    let state = await auth.refresh();
    if (!isThisAccount(state)) state = await auth.refresh();
    if (isThisAccount(state)) return { ok: true, state };
    if (state.reason === 'disabled' || state.reason === 'no_profile') {
      // The credentials were right but there is no usable Eagle Eye account: end that session here.
      await auth.signOut();
      return { ok: false, message: state.reason === 'disabled' ? t('authReasonDisabled') : t('authReasonNoProfile') };
    }
    if (state.reason === 'config_error') return { ok: false, message: t('authConfigError') };
    return { ok: false, message: t('authErrProfileUnavailable', state.error ?? '') };
  };

  /**
   * Shared phone, AFTER the next person's session exists: forget the previous person on this
   * phone (cached identity; their queued records stay) and end their old session on the server
   * in the background. Never before - see src/lib/auth/handOver.ts.
   */
  const finishHandOver = (previousUserId: string | null, newUserId: string, replacedToken: string | null) => {
    if (!previousUserId || previousUserId === newUserId) return;
    forgetReplacedUser(browserStorage(), previousUserId, newUserId);
    try {
      void revokeReplacedSession(createClient(), replacedToken);
    } catch {
      // Not configured: nothing to end on a server.
    }
  };

  /** Before a new session is stored: wait for an earlier sign-out still running, note the current session. */
  const prepareHandOver = async (previousUserId: string | null): Promise<string | null> => {
    await auth.settlePendingSignOut();
    if (!previousUserId) return null;
    try {
      return await captureSessionAccessToken(createClient(), previousUserId);
    } catch {
      return null;
    }
  };

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
      // Whoever is signed in stays signed in unless the password is right (hand-over rule).
      const previousUserId = signedInUserId;
      const replacedToken = await prepareHandOver(previousUserId);
      const result = await signIn(login, password);
      if (!result.ok) {
        setError(signInErrorText(result, t));
        setPassword('');
        passwordRef.current?.focus();
        return;
      }
      finishHandOver(previousUserId, result.userId, replacedToken);
      const settled = await settleSession(result.userId);
      if (settled.ok) {
        const canUseStaffTab = settled.state.roles.some((r) =>
          ['super_admin', 'admin', 'supervisor', 'client_viewer'].includes(r)
        );
        if (!canUseStaffTab) {
          await auth.signOut();
          setError(t('pdevErrGuardNoPassword'));
          setPassword('');
          return;
        }
        setLeaving(true);
        router.replace(destinationFor(nextParam, settled.state.roles));
        return;
      }
      setError(settled.message);
    } catch (err) {
      setError(t('authErrGeneric', err instanceof Error ? err.message : String(err)));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleGuardSelect = async (guard: RosterGuard) => {
    if (submittingRef.current) return;
    setGuardError(null);
    if (auth.status === 'signed_in' && auth.user?.id === guard.id) {
      // This guard already holds the phone's session.
      setLeaving(true);
      router.replace('/guard');
      return;
    }
    if (isOffline()) {
      setGuardError(t('pdevErrOffline'));
      return;
    }
    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch {
      setGuardError(t('authConfigError'));
      return;
    }
    submittingRef.current = true;
    setGuardBusyId(guard.id);
    try {
      // The previous person is forgotten only once the server agreed AND the new session exists.
      const previousUserId = signedInUserId;
      let replacedToken: string | null = null;
      const result = await signInGuardOnDevice(supabase, guard.id, {
        beforeSession: async () => {
          replacedToken = await prepareHandOver(previousUserId);
        }
      });
      if (!result.ok) {
        // The roster may have changed (guard removed from the site, account disabled).
        if (result.error === 'not_allowed') setRosterReload((n) => n + 1);
        setGuardError(t(GUARD_DEVICE_ERROR_KEYS[result.error]));
        return;
      }
      finishHandOver(previousUserId, result.userId, replacedToken);
      const settled = await settleSession(result.userId);
      if (!settled.ok) {
        setGuardError(settled.message);
        return;
      }
      // The guard home asks "Signed in as <name> – not you?" for a minute (gloved mis-taps).
      markDeviceSignIn(result.userId);
      setLeaving(true);
      router.replace('/guard');
    } catch {
      setGuardError(t('pdevErrFailed'));
    } finally {
      submittingRef.current = false;
      setGuardBusyId(null);
    }
  };

  const selectTab = (next: LoginTab) => {
    setChosenTab(next);
    setGuardError(null);
  };

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = LOGIN_TABS.findIndex((item) => item.id === tab);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % LOGIN_TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + LOGIN_TABS.length) % LOGIN_TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = LOGIN_TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = LOGIN_TABS[next];
    selectTab(target.id);
    document.getElementById(`${tabsId}-tab-${target.id}`)?.focus();
  };

  const busy = submitting || guardBusyId !== null;
  const redirecting = leaving || (auth.status === 'signed_in' && !busy && !enrolled);
  const currentName =
    auth.status === 'signed_in'
      ? (auth.profile ? `${auth.profile.firstName} ${auth.profile.lastName}`.trim() : '') || auth.user?.email || ''
      : '';
  const showHandOver = enrolled && auth.status === 'signed_in' && !busy && !redirecting;
  const managerOnPhone = showHandOver && isManagerAccount(auth.roles);
  const clockedInSince = showHandOver && !managerOnPhone && openShift ? sastTimeHM(openShift.startedAt) : null;
  const compactHeader = enrolled && tab === 'guard' && !redirecting;

  const staffPanel = (
    <>
      <h2 className="font-display text-2xl font-semibold">{t('authSignInTitle')}</h2>
      <p className="mb-4 mt-1 text-sm text-ee-muted">{t('pdevStaffHint')}</p>

      <div role="alert" aria-live="assertive" data-testid="auth-login-error">
        {error && (
          <p className="mb-4 flex items-start gap-2 rounded-xl border border-ee-danger/70 bg-ee-danger/15 p-3 text-sm font-semibold text-ee-danger-text">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>

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
            // A shared patrol phone must not offer to remember a manager's login.
            autoComplete={enrolled ? 'off' : 'username'}
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
              autoComplete={enrolled ? 'off' : 'current-password'}
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
          disabled={busy}
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
  );

  return (
    <div className={`w-full max-w-sm ${compactHeader ? 'space-y-3' : 'space-y-6'}`}>
      <LoginHeader compact={compactHeader} />

      <div className="rounded-2xl border border-ee-border bg-ee-surface p-4 sm:p-5">
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

        {redirecting ? (
          <>
            <h2 className="mb-4 font-display text-2xl font-semibold">{t('authSignInTitle')}</h2>
            <div role="alert" aria-live="assertive" data-testid="auth-login-error" />
            <p role="status" className="text-base text-ee-muted" data-testid="auth-login-redirecting">
              {t('authOpeningYourArea')}
            </p>
          </>
        ) : (
          <>
            {showHandOver && (
              <div
                className={`mb-4 space-y-3 rounded-xl border p-3 ${
                  managerOnPhone ? 'border-ee-danger/70 bg-ee-danger/15' : 'border-ee-primary/60 bg-ee-primary/10'
                }`}
                data-testid="device-signed-in"
                data-manager={managerOnPhone ? 'true' : undefined}
              >
                <p className="text-base font-semibold text-ee-text">{t('pdevSignedInOnPhone', currentName)}</p>
                {managerOnPhone ? (
                  <>
                    <p className="text-sm text-ee-text" data-testid="device-manager-on-phone">
                      {t('pdevManagerOnPhone', currentName)}
                    </p>
                    <SignOutControl variant="full" testId="device-manager-signout" />
                  </>
                ) : (
                  <>
                    <p className="text-sm text-ee-text">{t('pdevSwitchNote', currentName)}</p>
                    {!online && (
                      <p className="flex items-start gap-2 text-sm font-semibold text-ee-warning" data-testid="device-handover-offline">
                        <WifiOff className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                        <span>{t('pdevOfflineHandOver', currentName)}</span>
                      </p>
                    )}
                    {clockedInSince && (
                      <p className="flex items-start gap-2 text-sm font-semibold text-ee-warning" data-testid="device-handover-clocked-in">
                        <Clock className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
                        <span>{t('pdevClockedInWarning', currentName, clockedInSince)}</span>
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setLeaving(true);
                        router.replace(destinationFor(nextParam, auth.roles));
                      }}
                      className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-ee-border bg-ee-surface px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised"
                      data-testid="device-continue"
                    >
                      {clockedInSince ? t('pdevBackToClockOut') : t('pdevContinueAs', currentName)}
                    </button>
                  </>
                )}
              </div>
            )}

            <div
              role="tablist"
              aria-label={t('pdevTabsLabel')}
              className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-ee-border bg-ee-bg p-1"
              onKeyDown={onTabKeyDown}
            >
              {LOGIN_TABS.map((item) => {
                const Icon = item.icon;
                const selected = tab === item.id;
                return (
                  <button
                    key={item.id}
                    id={`${tabsId}-tab-${item.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={selected ? `${tabsId}-panel-${item.id}` : undefined}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => selectTab(item.id)}
                    disabled={busy && !selected}
                    className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-sm font-semibold leading-tight focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ee-primary disabled:opacity-50 min-[360px]:flex-row min-[360px]:gap-2 ${
                      selected ? 'bg-ee-primary text-ee-on-primary' : 'text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text'
                    }`}
                    data-testid={`device-tab-${item.id}`}
                  >
                    <Icon className="h-5 w-5 flex-none" aria-hidden="true" />
                    <span className="break-words">{t(item.label)}</span>
                  </button>
                );
              })}
            </div>

            <div id={`${tabsId}-panel-${tab}`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${tab}`}>
              {tab === 'guard' ? (
                <GuardDutyPanel
                  device={device}
                  enrolmentLost={enrolmentLost}
                  busyGuardId={guardBusyId}
                  disabled={submitting}
                  error={guardError}
                  reloadSignal={rosterReload}
                  queued={queued.ready ? queued : null}
                  showQueuedTotal={auth.status !== 'signed_in'}
                  onSelectGuard={(guard) => void handleGuardSelect(guard)}
                  onUsePassword={() => {
                    selectTab('staff');
                    window.setTimeout(() => document.getElementById(`${tabsId}-tab-staff`)?.focus(), 0);
                  }}
                />
              ) : (
                staffPanel
              )}
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
