'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Wifi, WifiOff, RefreshCw, Globe, LogOut } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { syncEngine } from '@/lib/offline/sync';
import { OfflineSyncSummary } from '@/types/offline';
import { SupportedLanguage } from '@/types/models';
import { useAuth } from '@/context/AuthContext';

export function HeaderBar({ guardName }: { guardName?: string }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const { language, setLanguage, t } = useTranslation();
  const [timeStr, setTimeStr] = useState<string>('');
  const [syncSummary, setSyncSummary] = useState<OfflineSyncSummary>({
    isOnline: true,
    pendingCount: 0,
    syncingCount: 0,
    failedCount: 0
  });
  const [showLangMenu, setShowLangMenu] = useState(false);

  useEffect(() => {
    const updateClock = () => {
      const d = new Date();
      setTimeStr(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
    };
    updateClock();
    const interval = setInterval(updateClock, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (syncEngine) {
      const unsub = syncEngine.subscribe(setSyncSummary);
      return unsub;
    }
  }, []);

  const handleManualSync = () => {
    if (syncEngine) {
      syncEngine.triggerSync();
    }
  };

  const handleLangSelect = (lang: SupportedLanguage) => {
    setLanguage(lang);
    setShowLangMenu(false);
  };

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
          <div className="relative w-8 h-8 rounded-lg overflow-hidden border border-[#F0A53A]/60 flex-none bg-[#18212B]">
            <Image
              src="/Eagle_Eye_Logo.jpg"
              alt="Eagle Eye"
              fill
              className="object-cover"
            />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-[#9AA5B1] truncate max-w-[130px]">
              {guardName || t('guardOnDuty') || 'Wag op diens'}
            </span>
            <span className="text-base font-bold text-[#E9E4D8] font-mono tracking-tight leading-none mt-0.5">
              {timeStr || '--:--'}
            </span>
          </div>
        </div>

        {/* Status Indicators, Language & Logout */}
        <div className="flex items-center gap-1.5">
          {/* Sync Pill */}
          <button
            onClick={handleManualSync}
            disabled={syncSummary.syncingCount > 0}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${
              !syncSummary.isOnline
                ? 'bg-[#E0685C]/20 text-[#E0685C] border-[#E0685C]'
                : syncSummary.pendingCount > 0
                ? 'bg-[#F0A53A]/20 text-[#F0A53A] border-[#F0A53A] animate-pulse'
                : 'bg-[#76C08F]/20 text-[#76C08F] border-[#76C08F]'
            }`}
            title={syncSummary.pendingCount > 0 ? t('pendingSync', syncSummary.pendingCount) : t('synced')}
          >
            {!syncSummary.isOnline ? (
              <>
                <WifiOff className="w-3.5 h-3.5 text-[#E0685C]" />
                <span>{t('offline')}</span>
              </>
            ) : syncSummary.syncingCount > 0 ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 text-[#F0A53A] animate-spin" />
                <span>Sync</span>
              </>
            ) : syncSummary.pendingCount > 0 ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 text-[#F0A53A]" />
                <span>{syncSummary.pendingCount}</span>
              </>
            ) : (
              <>
                <Wifi className="w-3.5 h-3.5 text-[#76C08F]" />
                <span>{t('online')}</span>
              </>
            )}
          </button>

          {/* Language Switcher */}
          <div className="relative">
            <button
              onClick={() => setShowLangMenu(!showLangMenu)}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#212C38] border border-[#324050] text-xs font-bold text-[#E9E4D8] uppercase hover:bg-[#283644] active:scale-95"
            >
              <Globe className="w-3.5 h-3.5 text-[#9AA5B1]" />
              <span>{language}</span>
            </button>

            {showLangMenu && (
              <div className="absolute right-0 mt-2 w-32 bg-[#212C38] border border-[#324050] rounded-xl shadow-2xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                <button
                  onClick={() => handleLangSelect('af')}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                    language === 'af' ? 'text-[#F0A53A] bg-[#18212B]' : 'text-[#E9E4D8] hover:bg-[#18212B]'
                  }`}
                >
                  🇿🇦 Afrikaans
                </button>
                <button
                  onClick={() => handleLangSelect('en')}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                    language === 'en' ? 'text-[#F0A53A] bg-[#18212B]' : 'text-[#E9E4D8] hover:bg-[#18212B]'
                  }`}
                >
                  🇬🇧 English
                </button>
                <button
                  onClick={() => handleLangSelect('zu')}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                    language === 'zu' ? 'text-[#F0A53A] bg-[#18212B]' : 'text-[#E9E4D8] hover:bg-[#18212B]'
                  }`}
                >
                  🇿🇦 isiZulu
                </button>
              </div>
            )}
          </div>

          {/* Log Out Button */}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#212C38] border border-[#324050] text-xs font-bold text-[#E0685C] hover:bg-[#B3261E] hover:text-white transition-all active:scale-95"
            title="Log Out / Teken Uit"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden xs:inline">Uit</span>
          </button>
        </div>
      </div>
    </header>
  );
}
