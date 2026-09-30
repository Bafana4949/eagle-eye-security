'use client';

import React from 'react';
import { HeaderBar } from '@/components/guard/HeaderBar';
import { BottomNav } from '@/components/guard/BottomNav';
import { SosPanicModal } from '@/components/guard/SosPanicModal';
import { I18nProvider } from '@/lib/i18n/context';

import { useAuth } from '@/context/AuthContext';

export default function GuardLayout({ children }: { children: React.ReactNode }) {
  const { user, profile, assignedSite } = useAuth();
  
  const guardId = user?.id || '';
  const siteId = assignedSite?.id || '';
  const guardName = profile ? `${profile.first_name} ${profile.last_name}` : 'Wag op diens';

  return (
    <I18nProvider>
      <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col font-sans selection:bg-[#F0A53A] selection:text-[#2A1A04]">
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
