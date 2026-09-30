'use client';

import React from 'react';
import { HeaderBar } from '@/components/guard/HeaderBar';
import { BottomNav } from '@/components/guard/BottomNav';
import { SosPanicModal } from '@/components/guard/SosPanicModal';
import { I18nProvider } from '@/lib/i18n/context';

export default function GuardLayout({ children }: { children: React.ReactNode }) {
  // Demo default context for seamless offline mobile operation
  const guardId = '55555555-5555-5555-5555-555555555555';
  const siteId = '22222222-2222-2222-2222-222222222222';
  const guardName = 'Wag 1 / Guard Sipho';

  return (
    <I18nProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
        <HeaderBar guardName={guardName} />
        <main className="flex-1 max-w-md mx-auto w-full px-4 pt-4 pb-28">
          {children}
        </main>
        <SosPanicModal userId={guardId} siteId={siteId} guardName={guardName} />
        <BottomNav />
      </div>
    </I18nProvider>
  );
}
