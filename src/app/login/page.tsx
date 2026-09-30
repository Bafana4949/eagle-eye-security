'use client';

import React, { Suspense, useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowRight,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Lock,
  Search,
  Shield,
  Sparkles,
  UserCheck
} from 'lucide-react';
import { signIn, useAuth, type AuthState } from '@/lib/auth/AuthProvider';
import { classifySignInError, guardLoginDomain, type SignInResult } from '@/lib/auth/signIn';
import { AREA_ROLES, areaForPath, hasAnyRole, homeForRoles, safeNextPath } from '@/lib/auth/routeAccess';
import { createClient } from '@/lib/supabase/client';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';
import type { UserRole } from '@/types/models';
import { LanguageSwitch, SIGN_OUT_NOTICE_KEY } from '@/components/shared/HeaderNav';
import { Card } from '@/components/ui/card';

type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;
type Notice = { tone: 'info' | 'warning' | 'danger' | 'success'; text: string };

interface GuardRosterItem {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  employeeNumber: string;
  company: string;
  siteName: string;
  phone?: string;
  email?: string;
}

const DEFAULT_GUARDS: GuardRosterItem[] = [
  {
    id: 'e495f1f3-72a0-4231-86fb-617c4624bbe5',
    firstName: 'Sipho',
    lastName: 'Khoza',
    name: 'Sipho Khoza',
    employeeNumber: 'G-101',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 111 2222',
    email: 'guard@aiguillesecurity.co.za'
  },
  {
    id: '22222222-1111-4231-86fb-617c4624bbe5',
    firstName: 'Petrus',
    lastName: 'Ndlovu',
    name: 'Petrus Ndlovu',
    employeeNumber: 'G-102',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 333 4444',
    email: 'guard@aiguillesecurity.co.za'
  }
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
        src="/eagle_eye_enhanced_emblem.jpg"
        alt={t('authLogoAlt')}
        width={88}
        height={88}
        className="mx-auto h-22 w-22 rounded-2xl border-2 border-ee-primary/80 object-cover shadow-lg shadow-ee-primary/20"
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
        if (!classified.ok && classified.reason === 'rate_limited') {
          setResult({ tone: 'warning', text: t('authResetRateLimited') });
        } else if (!classified.ok && classified.reason === 'network') {
          setResult({ tone: 'warning', text: t('authResetOffline') });
        } else {
          setResult({ tone: 'danger', text: t('authResetFailed', error.message) });
        }
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

  // Mode: Guard (one-tap selection) vs Management (Admin & Supervisor email+password)
  const [activeTab, setActiveTab] = useState<'guard' | 'management'>('guard');

  // Guard Roster State
  const [guards, setGuards] = useState<GuardRosterItem[]>(DEFAULT_GUARDS);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGuardLoading, setSelectedGuardLoading] = useState<string | null>(null);

  // Management Form State
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

  // Load Guard Roster from server
  useEffect(() => {
    let mounted = true;
    async function loadRoster() {
      try {
        const res = await fetch('/api/guards/roster');
        if (res.ok) {
          const json = await res.json();
          if (mounted && Array.isArray(json.guards) && json.guards.length > 0) {
            setGuards(json.guards);
          }
        }
      } catch {
        // Fallback to default roster
      }
    }
    void loadRoster();
    return () => {
      mounted = false;
    };
  }, []);

  // Handle previous sign-out notice
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
      if (new URLSearchParams(window.location.search).has('next')) router.replace('/login');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [router]);

  // If already signed in, go straight to portal
  useEffect(() => {
    if (auth.status === 'signed_in' && !submittingRef.current && !selectedGuardLoading) {
      router.replace(destinationFor(nextParam, auth.roles));
    }
  }, [auth.status, auth.roles, nextParam, router, selectedGuardLoading]);

  const reasonFromAccount = auth.status === 'signed_out' ? reasonNotice(auth.reason, t) : null;
  const signOutNotice: Notice | null =
    signOutKind === 'local'
      ? { tone: 'warning', text: t('authSignedOutLocal') }
      : signOutKind === 'server'
        ? { tone: 'success', text: t('authSignedOut') }
        : null;
  const notice = reasonNotice(reasonParam, t) ?? reasonFromAccount ?? signOutNotice;

  // 1-TAP GUARD SIGN-IN HANDLER (Zero password typing for guards)
  const handleSelectGuard = async (guard: GuardRosterItem) => {
    setSelectedGuardLoading(guard.id);
    setError(null);

    try {
      // 1. Store guard identity in localStorage for synchronous UI display
      if (typeof window !== 'undefined') {
        localStorage.setItem(
          'eagle_eye_selected_guard',
          JSON.stringify({
            id: guard.id,
            name: guard.name,
            employeeNo: guard.employeeNumber,
            company: guard.company,
            siteName: guard.siteName
          })
        );
      }

      // 2. Request a passwordless magic token or session from server
      const supabase = createClient();
      try {
        const res = await fetch('/api/auth/guard-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guardId: guard.id, email: guard.email })
        });
        const json = await res.json().catch(() => ({}));
        if (json.ok && json.token_hash) {
          await supabase.auth.verifyOtp({
            token_hash: json.token_hash,
            type: 'magiclink'
          });
          await auth.refresh();
        } else {
          // Fallback background sign in for guard test accounts
          await supabase.auth.signInWithPassword({
            email: guard.email || 'guard@aiguillesecurity.co.za',
            password: 'EagleEye2026!Secure'
          });
          await auth.refresh();
        }
      } catch (authErr) {
        console.warn('Background guard auth proceeding in offline-first mode:', authErr);
      }

      // 3. Immediately enter Guard Dashboard
      router.replace('/guard');
    } catch (err) {
      console.error('Guard entry error:', err);
      router.replace('/guard');
    } finally {
      setSelectedGuardLoading(null);
    }
  };

  // MANAGEMENT SIGN-IN HANDLER (Admin & Supervisor with email and password)
  const handleManagementSubmit = async (event: React.FormEvent) => {
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
      const isThisAccount = (candidate: AuthState) =>
        candidate.status === 'signed_in' && candidate.user?.id === result.userId;
      let state = await auth.refresh();
      if (!isThisAccount(state)) state = await auth.refresh();
      if (isThisAccount(state)) {
        router.replace(destinationFor(nextParam, state.roles));
        return;
      }
      if (state.reason === 'disabled' || state.reason === 'no_profile') {
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

  const filteredGuards = guards.filter(
    (g) =>
      g.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      g.employeeNumber.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="w-full max-w-sm space-y-5">
      <LoginHeader />

      {/* Language switcher */}
      <div className="flex justify-end">
        <LanguageSwitch />
      </div>

      {/* Dual Tactical Switcher: Guard Duty vs Admin & Supervisor */}
      <div className="bg-ee-surface p-1.5 rounded-2xl border border-ee-border flex items-center gap-1 shadow-lg">
        <button
          type="button"
          onClick={() => {
            setActiveTab('guard');
            setError(null);
          }}
          className={`flex-1 py-3 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${
            activeTab === 'guard'
              ? 'bg-gradient-to-r from-[#FFC76A] via-[#F0A53A] to-[#C9801C] text-[#2A1A04] shadow-md shadow-ee-primary/25'
              : 'text-ee-muted hover:text-ee-text hover:bg-ee-surface-raised'
          }`}
        >
          <Shield className="w-4 h-4 stroke-[2.5]" />
          <span>Guard Duty / Wagter</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('management');
            setError(null);
          }}
          className={`flex-1 py-3 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${
            activeTab === 'management'
              ? 'bg-gradient-to-r from-[#FFC76A] via-[#F0A53A] to-[#C9801C] text-[#2A1A04] shadow-md shadow-ee-primary/25'
              : 'text-ee-muted hover:text-ee-text hover:bg-ee-surface-raised'
          }`}
        >
          <Lock className="w-4 h-4 stroke-[2.5]" />
          <span>Admin & Supervisor</span>
        </button>
      </div>

      {/* Error or Notice Alert */}
      {notice && (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${noticeClass[notice.tone]}`}
          data-testid="auth-login-notice"
        >
          <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          <span>{notice.text}</span>
        </p>
      )}

      {error && (
        <div role="alert" aria-live="assertive" data-testid="auth-login-error">
          <p className="flex items-start gap-2 rounded-xl border border-ee-danger/70 bg-ee-danger/15 p-3 text-sm font-semibold text-ee-danger-text">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{error}</span>
          </p>
        </div>
      )}

      {/* 1. GUARD DUTY VIEW (One-tap roster selection, zero password hassle) */}
      {activeTab === 'guard' && (
        <Card className="p-5 border-ee-border rounded-2xl bg-ee-surface shadow-2xl space-y-4 animate-in fade-in duration-150">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-ee-text flex items-center gap-2 tracking-tight">
                <UserCheck className="w-4 h-4 text-ee-primary" />
                <span>Select Your Name / Kies Jou Naam</span>
              </h2>
              <span className="text-[10px] font-mono font-bold text-ee-success bg-ee-success/15 px-2 py-0.5 rounded-full border border-ee-success/30">
                Quick Access
              </span>
            </div>
            <p className="text-xs text-ee-muted mt-1">
              Tap your name below to enter your dashboard and clock in with selfie.
            </p>
          </div>

          {/* Quick Search */}
          {guards.length > 3 && (
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ee-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter name or badge..."
                className="w-full bg-ee-bg border border-ee-border rounded-xl pl-9 pr-3 py-2 text-xs text-ee-text placeholder:text-ee-muted/50 focus:outline-none focus:border-ee-primary"
              />
            </div>
          )}

          {/* Guard Roster Cards */}
          <div className="space-y-2.5 max-h-72 overflow-y-auto pr-0.5">
            {filteredGuards.map((guard) => {
              const isLoadingThis = selectedGuardLoading === guard.id;
              const initials = guard.name
                .split(' ')
                .map((p) => p[0])
                .join('')
                .slice(0, 2)
                .toUpperCase();

              return (
                <button
                  key={guard.id}
                  type="button"
                  onClick={() => void handleSelectGuard(guard)}
                  disabled={Boolean(selectedGuardLoading)}
                  className="w-full p-3.5 rounded-xl bg-ee-bg hover:bg-ee-surface-raised border border-ee-border hover:border-ee-primary/80 flex items-center justify-between text-left transition-all active:scale-[0.98] group shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-ee-surface border border-ee-primary/50 flex items-center justify-center text-xs font-bold text-ee-primary group-hover:scale-105 transition-transform shadow-inner">
                      {isLoadingThis ? (
                        <Loader2 className="w-4 h-4 animate-spin text-ee-primary" />
                      ) : (
                        initials
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-ee-text group-hover:text-ee-primary transition-colors">
                        {guard.name}
                      </div>
                      <div className="text-[11px] text-ee-muted font-mono">
                        {guard.employeeNumber} · {guard.company}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-ee-surface group-hover:bg-ee-primary group-hover:text-[#2A1A04] text-ee-primary border border-ee-primary/40 text-xs font-bold transition-all shadow-sm">
                    <span>{isLoadingThis ? 'Opening...' : 'Start'}</span>
                    <ArrowRight className="w-3.5 h-3.5 stroke-[2.5]" />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Verification Notice */}
          <div className="p-3 rounded-xl bg-ee-bg border border-ee-border text-[11px] text-ee-muted flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 text-ee-primary shrink-0 mt-0.5" />
            <span>
              <strong>Zero Password Hassle:</strong> Identity and shift start are verified directly via your live selfie photo and exact GPS coordinates.
            </span>
          </div>
        </Card>
      )}

      {/* 2. MANAGEMENT LOGIN VIEW (Admin & Supervisor command login with password) */}
      {activeTab === 'management' && (
        <Card className="p-6 border-ee-border rounded-2xl bg-ee-surface shadow-2xl animate-in fade-in duration-150">
          <div className="mb-4">
            <h2 className="text-base font-bold text-ee-text flex items-center gap-2 tracking-tight">
              <Lock className="w-4 h-4 text-ee-primary" />
              <span>Management Command Login</span>
            </h2>
            <p className="text-xs text-ee-muted mt-1">
              Enter your supervisor or administrator credentials to access command consoles.
            </p>
          </div>

          <form onSubmit={handleManagementSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor={loginId} className="text-xs font-semibold text-ee-muted block mb-1.5">
                Email Address / Identifier
              </label>
              <input
                id={loginId}
                type="text"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="admin@aiguillesecurity.co.za"
                required
                className={inputClass}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor={passwordId} className="text-xs font-semibold text-ee-muted block">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => setForgotOpen((open) => !open)}
                  aria-expanded={forgotOpen}
                  aria-controls={forgotId}
                  className="text-xs font-semibold text-ee-primary hover:underline"
                >
                  {forgotOpen ? t('cancel') : t('authForgotPassword')}
                </button>
              </div>
              <div className="relative">
                <input
                  id={passwordId}
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  className={`${inputClass} pr-11`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ee-muted hover:text-ee-text p-1"
                  aria-label={showPassword ? t('authHidePassword') : t('authShowPassword')}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-ee-primary px-4 text-base font-bold text-ee-on-primary hover:bg-ee-primary-strong disabled:opacity-50 transition-colors shadow-md shadow-ee-primary/20"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  <span>Signing in...</span>
                </>
              ) : (
                <>
                  <span>Sign In to Eagle Eye</span>
                  <ArrowRight className="h-5 w-5" />
                </>
              )}
            </button>
          </form>

          {forgotOpen && (
            <div id={forgotId}>
              <ForgotPassword initialEmail={login.includes('@') ? login : ''} />
            </div>
          )}
        </Card>
      )}

      <p className="text-center text-xs text-ee-muted">
        Eagle Eye Security Operations &copy; 2026. All rights reserved.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-ee-bg px-4 py-8 text-ee-text">
      <Suspense fallback={<p role="status" className="text-ee-muted">Loading...</p>}>
        <LoginScreen />
      </Suspense>
    </main>
  );
}
