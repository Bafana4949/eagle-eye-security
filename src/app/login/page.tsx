'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Lock, User, ArrowRight, Eye, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { I18nProvider } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<'guard' | 'manager' | 'viewer'>('guard');
  const [email, setEmail] = useState('guard@aiguillesecurity.co.za');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const supabase = createClient();

  const handleSignIn = async (e: React.FormEvent, targetRole: 'guard' | 'manager' | 'viewer') => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    if (!email || !password) {
      setIsLoading(false);
      setErrorMsg('Please enter both email and password.');
      return;
    }

    try {
      // 1. Real Supabase Authentication
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
      });

      if (authError || !authData.user) {
        setIsLoading(false);
        setErrorMsg(authError?.message || 'Authentication failed. Please check your credentials.');
        return;
      }

      // 2. Query user_roles from Supabase database
      const { data: rolesData, error: rolesError } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', authData.user.id);

      if (rolesError) {
        setIsLoading(false);
        setErrorMsg('Failed to verify user authorization. Please contact your administrator.');
        return;
      }

      const roles = (rolesData || []).map((r) => r.role);

      // 3. Strict Role-Based Redirection
      if (targetRole === 'guard') {
        if (!roles.includes('guard') && !roles.includes('admin') && !roles.includes('super_admin')) {
          setIsLoading(false);
          setErrorMsg('Access denied: Your account does not have Guard permissions.');
          return;
        }
        router.push('/guard');
      } else if (targetRole === 'manager') {
        if (roles.includes('admin') || roles.includes('super_admin')) {
          router.push('/admin');
        } else if (roles.includes('supervisor')) {
          router.push('/supervisor');
        } else {
          setIsLoading(false);
          setErrorMsg('Access denied: Your account does not have Supervisor or Admin permissions.');
        }
      } else if (targetRole === 'viewer') {
        if (!roles.includes('client_viewer') && !roles.includes('admin') && !roles.includes('super_admin')) {
          setIsLoading(false);
          setErrorMsg('Access denied: Your account does not have Client Viewer permissions.');
          return;
        }
        router.push('/viewer');
      }
    } catch (err: unknown) {
      setIsLoading(false);
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected network error occurred.');
    }
  };

  const handleSelectPreset = (mode: 'guard' | 'manager' | 'viewer') => {
    setAuthMode(mode);
    setErrorMsg(null);
    if (mode === 'guard') {
      setEmail('guard@aiguillesecurity.co.za');
    } else if (mode === 'manager') {
      setEmail('supervisor@aiguillesecurity.co.za');
    } else if (mode === 'viewer') {
      setEmail('viewer@dawieboerdery.co.za');
    }
  };

  return (
    <I18nProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full space-y-6">
          {/* Logo & Heading */}
          <div className="text-center space-y-2">
            <div className="w-16 h-16 rounded-3xl bg-gradient-to-tr from-blue-700 to-indigo-500 mx-auto flex items-center justify-center shadow-xl shadow-blue-900/40 border border-blue-400/30">
              <ShieldCheck className="w-9 h-9 text-white" />
            </div>
            <h1 className="text-2xl font-black text-white tracking-tight">
              EAGLE EYE SECURITY
            </h1>
            <p className="text-xs text-slate-400">
              Operations & Mobile Guard Management Platform
            </p>
          </div>

          {/* Mode Selector */}
          <div className="grid grid-cols-3 gap-1.5 p-1.5 rounded-2xl bg-slate-900 border border-slate-800">
            <button
              onClick={() => handleSelectPreset('guard')}
              className={`py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
                authMode === 'guard'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <User className="w-3.5 h-3.5" />
              <span>Guard</span>
            </button>

            <button
              onClick={() => handleSelectPreset('manager')}
              className={`py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
                authMode === 'manager'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Supervisor</span>
            </button>

            <button
              onClick={() => handleSelectPreset('viewer')}
              className={`py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all ${
                authMode === 'viewer'
                  ? 'bg-blue-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Client</span>
            </button>
          </div>

          {/* Login Card */}
          <Card className="p-6 border-slate-800 rounded-3xl bg-slate-900/90 shadow-2xl">
            {errorMsg && (
              <div className="mb-4 p-3.5 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-300 text-xs font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            <form onSubmit={(e) => handleSignIn(e, authMode)} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">
                  Email Address / Identifier
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@aiguillesecurity.co.za"
                  required
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-base text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {authMode === 'guard' && (
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                  <div className="flex justify-between items-center text-slate-300 font-semibold">
                    <span>Guard Station:</span>
                    <span className="text-blue-400 font-mono">Dawie Boerdery (Hoofplaas)</span>
                  </div>
                  <p>Guards authenticate with assigned security credentials to start patrols and gate duty.</p>
                </div>
              )}

              {authMode === 'manager' && (
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                  <div className="flex justify-between items-center text-slate-300 font-semibold">
                    <span>Command Center:</span>
                    <span className="text-blue-400">Supervisor & Admin Access</span>
                  </div>
                  <p>Admins route to Admin Portal; Supervisors route to Live Operations Dashboard.</p>
                </div>
              )}

              {authMode === 'viewer' && (
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                  <div className="flex justify-between items-center text-slate-300 font-semibold">
                    <span>Client Portal:</span>
                    <span className="text-indigo-400">Dawie Snyman (Client Owner)</span>
                  </div>
                  <p>Read-only live compliance reports, patrol timeline, and gate log monitoring.</p>
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="touch"
                isLoading={isLoading}
                className="w-full mt-2 font-bold"
              >
                <span>Authenticate & Enter App</span>
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </form>
          </Card>

          <div className="text-center">
            <Link href="/" className="text-xs text-slate-500 hover:text-slate-300">
              ← Return to Portal Selection
            </Link>
          </div>
        </div>
      </div>
    </I18nProvider>
  );
}
