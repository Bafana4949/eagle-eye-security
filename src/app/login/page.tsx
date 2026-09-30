'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Eye, EyeOff, ArrowRight, AlertCircle, Loader2, Globe, Check } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const { setLanguage } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [pendingDestination, setPendingDestination] = useState('/guard');
  const [selectedLang, setSelectedLang] = useState<'en' | 'af' | 'zu'>('en');

  const supabase = createClient();

  const handleSignIn = async (e: React.FormEvent) => {
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

      // 2. Query user roles from database to route automatically
      const { data: rolesData, error: rolesError } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', authData.user.id);

      if (rolesError) {
        console.error('Error fetching roles:', rolesError);
      }

      const roles = (rolesData || []).map((r) => r.role);

      let targetPath = '/guard';
      // 3. Automatic intelligent portal routing based on assigned role
      if (roles.includes('admin') || roles.includes('super_admin')) {
        targetPath = '/admin';
      } else if (roles.includes('supervisor')) {
        targetPath = '/supervisor';
      } else if (roles.includes('guard')) {
        targetPath = '/guard';
      } else if (roles.includes('client_viewer')) {
        targetPath = '/viewer';
      } else {
        // Fallback if role record not yet populated in user_roles table
        if (cleanEmail.includes('admin')) {
          targetPath = '/admin';
        } else if (cleanEmail.includes('supervisor')) {
          targetPath = '/supervisor';
        } else if (cleanEmail.includes('viewer')) {
          targetPath = '/viewer';
        } else {
          targetPath = '/guard';
        }
      }

      setPendingDestination(targetPath);
      setIsLoading(false);
      setShowLanguageModal(true);
    } catch (err: unknown) {
      setIsLoading(false);
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected network error occurred.');
    }
  };

  const handleConfirmLanguage = (chosenLang: 'en' | 'af' | 'zu') => {
    setSelectedLang(chosenLang);
    setLanguage(chosenLang);
    router.push(pendingDestination);
  };

  return (
    <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full space-y-6">
          {/* Official Eagle Eye System Logo */}
          <div className="text-center">
            <h1 className="sr-only">Eagle Eye Security</h1>
            <div className="relative w-36 h-36 sm:w-44 sm:h-44 mx-auto rounded-3xl overflow-hidden shadow-2xl shadow-[#F0A53A]/25 border-2 border-[#F0A53A]/80 bg-[#18212B] transition-transform hover:scale-105 duration-200">
              <Image
                src="/Eagle_Eye_Logo.jpg"
                alt="Eagle Eye Security"
                fill
                className="object-cover"
                priority
              />
            </div>
          </div>

          {/* Unified Login Card */}
          <Card className="p-6 border-[#324050] rounded-2xl bg-[#212C38] shadow-2xl">
            {errorMsg && (
              <div className="mb-4 p-3.5 rounded-xl bg-[#E0685C]/15 border border-[#E0685C] text-[#E0685C] text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-[#E0685C]" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-[#9AA5B1] block mb-1.5">
                  Email Address / Identifier
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="guard@aiguillesecurity.co.za"
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

          <p className="text-center text-xs text-[#9AA5B1]">
            Eagle Eye Security Operations &copy; 2026. All rights reserved.
          </p>
        </div>

        {/* Post-Login Language Prompt Modal */}
        {showLanguageModal && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
            <div className="w-full max-w-md bg-[#212C38] border-2 border-[#F0A53A] rounded-3xl p-6 shadow-2xl text-[#E9E4D8] space-y-5 animate-in fade-in zoom-in-95 duration-200">
              <div className="text-center space-y-2">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-[#18212B] border border-[#F0A53A]/60 flex items-center justify-center text-[#F0A53A] shadow-md shadow-[#F0A53A]/10">
                  <Globe className="w-6 h-6 text-[#F0A53A]" />
                </div>
                <h3 className="text-xl font-bold tracking-tight text-[#E9E4D8]">
                  Select Interface Language
                </h3>
                <p className="text-xs text-[#9AA5B1] font-medium leading-relaxed">
                  Choose your display language. English is selected by default.
                </p>
              </div>

              {/* Language Options */}
              <div className="space-y-2.5">
                {[
                  {
                    code: 'en' as const,
                    name: 'English (Default)',
                    native: 'Standard operations & reports',
                    flag: '🇬🇧'
                  },
                  {
                    code: 'af' as const,
                    name: 'Afrikaans',
                    native: 'Plaasbeveiliging & patrollieverslae',
                    flag: '🇿🇦'
                  },
                  {
                    code: 'zu' as const,
                    name: 'isiZulu',
                    native: 'Uhlelo lwezokuphepha ngesiZulu',
                    flag: '🇿🇦'
                  }
                ].map((item) => {
                  const isSelected = selectedLang === item.code;
                  return (
                    <button
                      key={item.code}
                      type="button"
                      onClick={() => setSelectedLang(item.code)}
                      className={`w-full p-3.5 rounded-2xl border text-left flex items-center justify-between transition-all duration-150 ${
                        isSelected
                          ? 'bg-[#18212B] border-[#F0A53A] ring-1 ring-[#F0A53A] shadow-lg'
                          : 'bg-[#18212B]/70 border-[#324050] text-[#9AA5B1] hover:border-[#F0A53A]/50 hover:text-[#E9E4D8]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{item.flag}</span>
                        <div>
                          <div
                            className={`text-sm font-bold ${
                              isSelected ? 'text-[#F0A53A]' : 'text-[#E9E4D8]'
                            }`}
                          >
                            {item.name}
                          </div>
                          <div className="text-[11px] text-[#9AA5B1]">{item.native}</div>
                        </div>
                      </div>
                      {isSelected ? (
                        <div className="w-6 h-6 rounded-full bg-[#F0A53A] flex items-center justify-center text-[#2A1A04]">
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                        </div>
                      ) : (
                        <div className="w-5 h-5 rounded-full border border-[#324050]" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Continue Button */}
              <button
                type="button"
                onClick={() => handleConfirmLanguage(selectedLang)}
                className="w-full py-3.5 px-4 rounded-xl bg-radial from-[#FFC76A] via-[#F0A53A] to-[#C9801C] text-[#2A1A04] font-bold text-sm tracking-wide shadow-lg shadow-[#F0A53A]/25 border border-[#F0A53A] hover:brightness-105 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                <span>Continue to Portal</span>
                <ArrowRight className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>
          </div>
        )}
      </div>
  );
}
