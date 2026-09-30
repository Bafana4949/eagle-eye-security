'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { LogOut } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { useAuth } from '@/context/AuthContext';

export function HeaderBar({ guardName }: { guardName?: string }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const { t } = useTranslation();
  const [timeStr, setTimeStr] = useState<string>('');

  useEffect(() => {
    const updateClock = () => {
      const d = new Date();
      setTimeStr(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    updateClock();
    const interval = setInterval(updateClock, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = async () => {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  };

  return (
    <header className="sticky top-0 z-30 bg-[#18212B]/95 backdrop-blur-md border-b border-[#324050] px-4 py-2.5">
      <div className="max-w-md mx-auto flex items-center justify-between">
        {/* Guard & Time with Official Eagle Eye Logo */}
        <div className="flex items-center gap-2.5">
          <div className="relative w-9 h-9 rounded-xl overflow-hidden border border-[#F0A53A]/70 flex-none bg-[#18212B] shadow-md shadow-[#F0A53A]/15">
            <Image
              src="/Eagle_Eye_Logo.jpg"
              alt="Eagle Eye"
              fill
              className="object-cover"
              priority
            />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-[#9AA5B1] truncate max-w-[170px]">
              {guardName || t('guardOnDuty') || 'Wag op diens'}
            </span>
            <span className="text-base font-bold text-[#E9E4D8] font-mono tracking-tight leading-none mt-0.5">
              {timeStr || '--:--'}
            </span>
          </div>
        </div>

        {/* Prominent Log Out Button Only */}
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#212C38] border border-[#324050] text-xs font-bold text-[#E0685C] hover:bg-[#B3261E] hover:text-white hover:border-[#B3261E] transition-all active:scale-95 shadow-sm"
          title="Log Out / Teken Uit"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>{t('logOut') || 'Log Out'}</span>
        </button>
      </div>
    </header>
  );
}
