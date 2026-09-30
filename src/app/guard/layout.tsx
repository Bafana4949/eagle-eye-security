'use client';

import React, { useState } from 'react';
import { HeaderBar } from '@/components/guard/HeaderBar';
import { BottomNav } from '@/components/guard/BottomNav';
import { SosPanicModal } from '@/components/guard/SosPanicModal';
import { useAuth } from '@/context/AuthContext';

export default function GuardLayout({ children }: { children: React.ReactNode }) {
  const { user, profile, assignedSite } = useAuth();
  
  const [selectedGuard] = useState<{ id: string; name: string; employeeNo?: string } | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('eagle_eye_selected_guard');
        if (stored) return JSON.parse(stored);
      } catch {
        // ignore
      }
    }
    return null;
  });

  const guardId = selectedGuard?.id || user?.id || 'e495f1f3-72a0-4231-86fb-617c4624bbe5';
  const siteId = assignedSite?.id || '22222222-2222-2222-2222-222222222222';
  const guardName = selectedGuard?.name || (profile ? `${profile.first_name} ${profile.last_name}` : 'Sipho Khoza');

  return (
    <div className="min-h-screen bg-[#18212B] text-[#E9E4D8] flex flex-col font-sans selection:bg-[#F0A53A] selection:text-[#2A1A04]">
      <HeaderBar guardName={guardName} />
      <main className="flex-1 max-w-md mx-auto w-full px-4 pt-4 pb-28">
        {children}
      </main>
      <SosPanicModal userId={guardId} siteId={siteId} guardName={guardName} />
      <BottomNav />
    </div>
  );
}
