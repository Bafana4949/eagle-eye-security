'use client';

import React, { useState, useEffect } from 'react';
import { Wifi, WifiOff, RefreshCw, Globe } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { syncEngine } from '@/lib/offline/sync';
import { OfflineSyncSummary } from '@/types/offline';
import { SupportedLanguage } from '@/types/models';

export function HeaderBar({ guardName }: { guardName?: string }) {
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

  return (
    <header className="sticky top-0 z-30 bg-slate-950/95 backdrop-blur-md border-b border-slate-800/80 px-4 py-2.5">
      <div className="max-w-md mx-auto flex items-center justify-between">
        {/* Guard & Time */}
        <div className="flex flex-col">
          <span className="text-xs font-medium text-slate-400">
            {guardName || t('guardOnDuty') || 'Guard on Duty'}
          </span>
          <span className="text-base font-bold text-slate-100 font-mono tracking-tight">
            {timeStr || '--:--'}
          </span>
        </div>

        {/* Status Indicators & Language */}
        <div className="flex items-center gap-2">
          {/* Sync Pill */}
          <button
            onClick={handleManualSync}
            disabled={syncSummary.syncingCount > 0}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-all ${
              !syncSummary.isOnline
                ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                : syncSummary.pendingCount > 0
                ? 'bg-blue-950/80 text-blue-300 border-blue-800 animate-pulse'
                : 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
            }`}
            title={syncSummary.pendingCount > 0 ? t('pendingSync', syncSummary.pendingCount) : t('synced')}
          >
            {!syncSummary.isOnline ? (
              <>
                <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                <span>{t('offline')}</span>
              </>
            ) : syncSummary.syncingCount > 0 ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                <span>Syncing</span>
              </>
            ) : syncSummary.pendingCount > 0 ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
                <span>{syncSummary.pendingCount}</span>
              </>
            ) : (
              <>
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span>{t('online')}</span>
              </>
            )}
          </button>

          {/* Language Switcher */}
          <div className="relative">
            <button
              onClick={() => setShowLangMenu(!showLangMenu)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-700 text-xs font-bold text-slate-200 uppercase hover:bg-slate-800 active:scale-95"
            >
              <Globe className="w-3.5 h-3.5 text-slate-400" />
              <span>{language}</span>
            </button>

            {showLangMenu && (
              <div className="absolute right-0 mt-2 w-32 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                <button
                  onClick={() => handleLangSelect('af')}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                    language === 'af' ? 'text-blue-400 bg-blue-950/50' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  🇿🇦 Afrikaans
                </button>
                <button
                  onClick={() => handleLangSelect('en')}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                    language === 'en' ? 'text-blue-400 bg-blue-950/50' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  🇬🇧 English
                </button>
                <button
                  onClick={() => handleLangSelect('zu')}
                  className={`w-full text-left px-3 py-2 text-xs font-semibold ${
                    language === 'zu' ? 'text-blue-400 bg-blue-950/50' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  🇿🇦 isiZulu
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
