'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Lock, User, ArrowRight, Eye } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { I18nProvider } from '@/lib/i18n/context';

export default function LoginPage() {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<'guard' | 'manager' | 'viewer'>('guard');
  const [selectedGuard, setSelectedGuard] = useState('55555555-5555-5555-5555-555555555555');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const guardList = [
    { id: '55555555-5555-5555-5555-555555555555', name: 'Wag 1 / Sipho Khoza', code: '1234' },
    { id: '66666666-6666-6666-6666-666666666666', name: 'Wag 2 / Petrus Ndlovu', code: '4321' }
  ];

  const handleGuardSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    const guard = guardList.find((g) => g.id === selectedGuard);
    if (!guard || pin !== guard.code) {
      setIsLoading(false);
      setErrorMsg('Invalid Guard PIN. Please try again.');
      return;
    }

    setTimeout(() => {
      setIsLoading(false);
      router.push('/guard');
    }, 400);
  };

  const handleManagerSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    if (!email || !password) {
      setIsLoading(false);
      setErrorMsg('Please enter email and password');
      return;
    }

    setTimeout(() => {
      setIsLoading(false);
      if (email.includes('admin') || email.includes('dawie')) {
        router.push('/admin');
      } else {
        router.push('/supervisor');
      }
    }, 500);
  };

  const handleViewerSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
      router.push('/viewer');
    }, 300);
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
              onClick={() => {
                setAuthMode('guard');
                setErrorMsg(null);
              }}
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
              onClick={() => {
                setAuthMode('manager');
                setErrorMsg(null);
              }}
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
              onClick={() => {
                setAuthMode('viewer');
                setErrorMsg(null);
              }}
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
              <div className="mb-4 p-3 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-300 text-xs font-semibold text-center">
                {errorMsg}
              </div>
            )}

            {authMode === 'guard' && (
              <form onSubmit={handleGuardSignIn} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1">
                    Select Guard Profile
                  </label>
                  <select
                    value={selectedGuard}
                    onChange={(e) => setSelectedGuard(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {guardList.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1">
                    Enter Security PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="Enter 4-digit PIN (demo: 1234)"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-lg font-mono text-center tracking-widest text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1 text-center">
                    Demo PIN for Sipho: <span className="font-mono text-blue-400">1234</span>
                  </p>
                </div>

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
            )}

            {authMode === 'manager' && (
              <form onSubmit={handleManagerSignIn} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-400 block mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="supervisor@aiguillesecurity.co.za"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Demo: Enter &apos;admin&apos; in email for Admin portal, or any other for Supervisor.
                  </p>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  size="touch"
                  isLoading={isLoading}
                  className="w-full mt-2 font-bold"
                >
                  <span>Sign In to Dashboard</span>
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </form>
            )}

            {authMode === 'viewer' && (
              <form onSubmit={handleViewerSignIn} className="space-y-4">
                <div className="text-center py-2 space-y-1">
                  <span className="text-xs font-bold text-slate-200 block">Dawie Boerdery Client Portal</span>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    View real-time patrol compliance, site reports, and incident history in read-only mode.
                  </p>
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  size="touch"
                  isLoading={isLoading}
                  className="w-full mt-2 font-bold bg-indigo-600 hover:bg-indigo-500"
                >
                  <span>Access Client Portal</span>
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </form>
            )}
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
