'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Eye, EyeOff, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { I18nProvider } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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

      // 3. Automatic intelligent portal routing based on assigned role
      if (roles.includes('admin') || roles.includes('super_admin')) {
        router.push('/admin');
      } else if (roles.includes('supervisor')) {
        router.push('/supervisor');
      } else if (roles.includes('guard')) {
        router.push('/guard');
      } else if (roles.includes('client_viewer')) {
        router.push('/viewer');
      } else {
        // Fallback if role record not yet populated in user_roles table
        if (cleanEmail.includes('admin')) {
          router.push('/admin');
        } else if (cleanEmail.includes('supervisor')) {
          router.push('/supervisor');
        } else if (cleanEmail.includes('viewer')) {
          router.push('/viewer');
        } else {
          router.push('/guard');
        }
      }
    } catch (err: unknown) {
      setIsLoading(false);
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected network error occurred.');
    }
  };

  return (
    <I18nProvider>
      <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full space-y-6">
          {/* Official Eagle Eye System Logo */}
          <div className="text-center space-y-3">
            <div className="relative w-24 h-24 mx-auto rounded-2xl overflow-hidden shadow-2xl shadow-[#F0A53A]/20 border-2 border-[#F0A53A]/80 bg-[#18212B]">
              <Image
                src="/Eagle_Eye_Logo.jpg"
                alt="Eagle Eye Security"
                fill
                className="object-cover"
                priority
              />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-[#E9E4D8]">
                EAGLE EYE SECURITY
              </h1>
              <p className="text-xs text-[#9AA5B1] uppercase tracking-wider font-semibold mt-1">
                Aiguille Security &amp; Dawie Boerdery
              </p>
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
      </div>
    </I18nProvider>
  );
}
