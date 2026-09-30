'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { 
  Eye, 
  EyeOff, 
  ArrowRight, 
  AlertCircle, 
  Loader2, 
  Shield, 
  UserCheck, 
  Lock, 
  Search,
  Sparkles
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';

interface GuardRosterItem {
  id: string;
  firstName?: string;
  lastName?: string;
  name: string;
  employeeNumber: string;
  company: string;
  siteName: string;
  phone?: string;
}

const DEFAULT_GUARDS: GuardRosterItem[] = [
  {
    id: 'e495f1f3-72a0-4231-86fb-617c4624bbe5',
    name: 'Sipho Khoza',
    employeeNumber: 'G-101',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 111 2222'
  },
  {
    id: '22222222-1111-4231-86fb-617c4624bbe5',
    name: 'Petrus Ndlovu',
    employeeNumber: 'G-102',
    company: 'Aiguille Security',
    siteName: 'Dawie Boerdery - Main Farm',
    phone: '+27 82 333 4444'
  }
];

export default function LoginPage() {
  const router = useRouter();
  const { t } = useTranslation();
  
  // Login Tab: 'guard' (One-Tap selection) or 'management' (Admin/Supervisor email+pass)
  const [activeTab, setActiveTab] = useState<'guard' | 'management'>('guard');

  // Guard Roster State
  const [guards, setGuards] = useState<GuardRosterItem[]>(DEFAULT_GUARDS);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGuardLoading, setSelectedGuardLoading] = useState<string | null>(null);

  // Management Form State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const supabase = createClient();

  // Fetch dynamic roster of guards from API
  useEffect(() => {
    let isMounted = true;
    async function fetchRoster() {
      try {
        const res = await fetch('/api/guards/roster');
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.guards && data.guards.length > 0) {
            setGuards(data.guards);
          }
        }
      } catch (err) {
        console.warn('Using default guard roster:', err);
      }
    }
    void fetchRoster();
    return () => {
      isMounted = false;
    };
  }, []);

  // Filter guards by search query
  const filteredGuards = guards.filter((g) =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    g.employeeNumber.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // One-Tap Guard Sign-In Handler
  const handleSelectGuard = async (guard: GuardRosterItem) => {
    setSelectedGuardLoading(guard.id);
    setErrorMsg(null);

    try {
      // 1. Store the selected guard identity in localStorage for synchronous UI display
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

      // 2. Sign in to Supabase in the background using standard guard credentials so tokens & RLS operate
      try {
        await supabase.auth.signInWithPassword({
          email: 'guard@aiguillesecurity.co.za',
          password: 'EagleEye2026!Secure'
        });
      } catch (authErr) {
        console.warn('Background Supabase auth skipped (offline-first mode):', authErr);
      }

      // 3. Immediately route directly to Guard Dashboard
      router.push('/guard');
    } catch (err: unknown) {
      console.error('Guard routing error:', err);
      router.push('/guard');
    } finally {
      setSelectedGuardLoading(null);
    }
  };

  // Management Sign-In Handler (Admins & Supervisors)
  const handleManagementSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    const cleanEmail = email.trim();

    if (!cleanEmail || !password) {
      setIsLoading(false);
      setErrorMsg('Please enter both your email address and password.');
      return;
    }

    try {
      // 1. Supabase Authentication
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password
      });

      if (authError || !authData.user) {
        setIsLoading(false);
        setErrorMsg(authError?.message || 'Authentication failed. Please verify your credentials.');
        return;
      }

      // 2. Clear any lingering guard selection so manager sees manager profile
      if (typeof window !== 'undefined') {
        localStorage.removeItem('eagle_eye_selected_guard');
      }

      // 3. Query roles for routing
      const { data: rolesData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', authData.user.id);

      const roles = (rolesData || []).map((r) => r.role);

      let targetPath = '/supervisor';
      if (roles.includes('admin') || roles.includes('super_admin')) {
        targetPath = '/admin';
      } else if (roles.includes('supervisor')) {
        targetPath = '/supervisor';
      } else if (roles.includes('client_viewer')) {
        targetPath = '/viewer';
      } else {
        if (cleanEmail.includes('admin')) {
          targetPath = '/admin';
        } else if (cleanEmail.includes('viewer')) {
          targetPath = '/viewer';
        } else {
          targetPath = '/supervisor';
        }
      }

      router.push(targetPath);
    } catch (err: unknown) {
      setIsLoading(false);
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected network error occurred.');
    }
  };

  return (
    <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col justify-center items-center p-4">
      <div className="max-w-md w-full space-y-5">
        {/* Official Enlarged Eagle Eye System Logo */}
        <div className="text-center">
          <h1 className="sr-only">Eagle Eye Security Operations</h1>
          <div className="relative w-36 h-36 sm:w-44 sm:h-44 mx-auto rounded-3xl overflow-hidden shadow-2xl shadow-[#F0A53A]/25 border-2 border-[#F0A53A]/80 bg-[#18212B] transition-transform hover:scale-105 duration-200">
            <Image
              src="/Eagle_Eye_Logo.jpg"
              alt="Eagle Eye Emblem"
              fill
              className="object-cover"
              priority
            />
          </div>
        </div>

        {/* Tactical Mode Switcher Tabs */}
        <div className="bg-[#212C38] p-1.5 rounded-2xl border border-[#324050] flex items-center gap-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              setActiveTab('guard');
              setErrorMsg(null);
            }}
            className={`flex-1 py-3 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${
              activeTab === 'guard'
                ? 'bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] text-[#2A1A04] shadow-md shadow-[#F0A53A]/25'
                : 'text-[#9AA5B1] hover:text-[#E9E4D8] hover:bg-[#283644]'
            }`}
          >
            <Shield className="w-4 h-4 stroke-[2.5]" />
            <span>Guard Duty / Wagter</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab('management');
              setErrorMsg(null);
            }}
            className={`flex-1 py-3 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${
              activeTab === 'management'
                ? 'bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] text-[#2A1A04] shadow-md shadow-[#F0A53A]/25'
                : 'text-[#9AA5B1] hover:text-[#E9E4D8] hover:bg-[#283644]'
            }`}
          >
            <Lock className="w-4 h-4 stroke-[2.5]" />
            <span>Admin &amp; Supervisor</span>
          </button>
        </div>

        {/* Error Alert if any */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-[#E0685C]/15 border border-[#E0685C] text-[#E0685C] text-xs font-semibold flex items-center gap-2 animate-in fade-in duration-150">
            <AlertCircle className="w-4 h-4 shrink-0 text-[#E0685C]" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* 1. GUARD ONE-TAP ACCESS VIEW */}
        {activeTab === 'guard' && (
          <Card className="p-5 border-[#324050] rounded-2xl bg-[#212C38] shadow-2xl space-y-4 animate-in fade-in duration-150">
            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-[#E9E4D8] flex items-center gap-2 tracking-tight">
                  <UserCheck className="w-4 h-4 text-[#F0A53A]" />
                  <span>Select Your Name / Kies Jou Naam</span>
                </h2>
                <span className="text-[10px] font-mono font-bold text-[#76C08F] bg-[#76C08F]/15 px-2 py-0.5 rounded-full border border-[#76C08F]/30">
                  Quick Access
                </span>
              </div>
              <p className="text-xs text-[#9AA5B1] mt-1">
                Tap your name below to enter your dashboard and clock in with selfie.
              </p>
            </div>

            {/* Quick Search if more than 3 guards */}
            {guards.length > 3 && (
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#9AA5B1]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter name or badge..."
                  className="w-full bg-[#18212B] border border-[#324050] rounded-xl pl-9 pr-3 py-2 text-xs text-[#E9E4D8] placeholder-[#9AA5B1]/50 focus:outline-none focus:border-[#F0A53A]"
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
                    className="w-full p-3.5 rounded-xl bg-[#18212B] hover:bg-[#283644] border border-[#324050] hover:border-[#F0A53A]/80 flex items-center justify-between text-left transition-all active:scale-[0.98] group shadow-sm"
                  >
                    <div className="flex items-center gap-3">
                      {/* Initials Avatar */}
                      <div className="w-10 h-10 rounded-xl bg-[#212C38] border border-[#F0A53A]/50 flex items-center justify-center text-xs font-bold text-[#F0A53A] group-hover:scale-105 transition-transform shadow-inner">
                        {isLoadingThis ? (
                          <Loader2 className="w-4 h-4 animate-spin text-[#F0A53A]" />
                        ) : (
                          initials
                        )}
                      </div>

                      {/* Name & Badge */}
                      <div>
                        <div className="text-sm font-bold text-[#E9E4D8] group-hover:text-[#F0A53A] transition-colors">
                          {guard.name}
                        </div>
                        <div className="text-[11px] text-[#9AA5B1] font-mono">
                          {guard.employeeNumber} · {guard.company}
                        </div>
                      </div>
                    </div>

                    {/* Clock In Action Pill */}
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#212C38] group-hover:bg-[#F0A53A] group-hover:text-[#2A1A04] text-[#F0A53A] border border-[#F0A53A]/40 text-xs font-bold transition-all shadow-sm">
                      <span>{isLoadingThis ? 'Opening...' : 'Start'}</span>
                      <ArrowRight className="w-3.5 h-3.5 stroke-[2.5]" />
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Verification Notice */}
            <div className="p-3 rounded-xl bg-[#18212B] border border-[#324050] text-[11px] text-[#9AA5B1] flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 text-[#F0A53A] shrink-0 mt-0.5" />
              <span>
                <strong>Zero Password Hassle:</strong> Identity and shift start are verified directly via your live selfie photo and exact GPS coordinates.
              </span>
            </div>
          </Card>
        )}

        {/* 2. MANAGEMENT LOGIN VIEW (Admin & Supervisor) */}
        {activeTab === 'management' && (
          <Card className="p-6 border-[#324050] rounded-2xl bg-[#212C38] shadow-2xl animate-in fade-in duration-150">
            <div className="mb-4">
              <h2 className="text-base font-bold text-[#E9E4D8] flex items-center gap-2 tracking-tight">
                <Lock className="w-4 h-4 text-[#F0A53A]" />
                <span>Management Command Login</span>
              </h2>
              <p className="text-xs text-[#9AA5B1] mt-1">
                Enter your supervisor or administrator credentials to access command consoles.
              </p>
            </div>

            <form onSubmit={handleManagementSignIn} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-[#9AA5B1] block mb-1.5">
                  Email Address / Identifier
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@aiguillesecurity.co.za"
                  required
                  autoComplete="username"
                  className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-4 py-3 text-sm text-[#E9E4D8] placeholder-[#9AA5B1]/50 focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-[#9AA5B1] block mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    required
                    autoComplete="current-password"
                    className="w-full bg-[#18212B] border border-[#324050] rounded-xl px-4 py-3 pr-11 text-base text-[#E9E4D8] placeholder-[#9AA5B1]/50 focus:outline-none focus:border-[#F0A53A] focus:ring-1 focus:ring-[#F0A53A]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9AA5B1] hover:text-[#E9E4D8] p-1"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                size="touch"
                disabled={isLoading}
                className="w-full mt-4 font-bold text-base flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <span>Sign In to Eagle Eye</span>
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </Button>
            </form>
          </Card>
        )}

        <p className="text-center text-xs text-[#9AA5B1]">
          Eagle Eye Security Operations &copy; 2026. All rights reserved.
        </p>
      </div>
    </div>
  );
}
