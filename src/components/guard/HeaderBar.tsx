'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { LogOut, Globe, Check, X } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { useAuth } from '@/context/AuthContext';
import { SupportedLanguage } from '@/types/models';

export function HeaderBar({ guardName }: { guardName?: string }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const { t, language, setLanguage } = useTranslation();
  const [timeStr, setTimeStr] = useState<string>('');
  const [showLangPicker, setShowLangPicker] = useState(false);

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
      if (typeof window !== 'undefined') {
        localStorage.removeItem('eagle_eye_selected_guard');
      }
      await signOut();
    } finally {
      router.push('/login');
    }
  };

  const handleSelectLanguage = (lang: SupportedLanguage) => {
    setLanguage(lang);
    setShowLangPicker(false);
  };

  return (
    <>
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
              <span className="text-xs font-semibold text-[#9AA5B1] truncate max-w-[150px]">
                {guardName || t('guardOnDuty') || 'Guard'}
              </span>
              <span className="text-base font-bold text-[#E9E4D8] font-mono tracking-tight leading-none mt-0.5">
                {timeStr || '--:--'}
              </span>
            </div>
          </div>

          {/* Action Buttons: Language Selector & Log Out */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowLangPicker(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#212C38] border border-[#324050] text-xs font-bold text-[#F0A53A] hover:border-[#F0A53A]/70 active:scale-95 transition-all shadow-sm"
              title="Change Language / Kies Taal / Khetha Ulimi"
            >
              <Globe className="w-3.5 h-3.5 text-[#F0A53A]" />
              <span className="uppercase font-mono tracking-wider">{language}</span>
            </button>

            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#212C38] border border-[#324050] text-xs font-bold text-[#E0685C] hover:bg-[#B3261E] hover:text-white hover:border-[#B3261E] transition-all active:scale-95 shadow-sm"
              title="Log Out / Teken Uit / Phuma"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>{t('logOut') || 'Log Out'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Language Picker Dialog */}
      {showLangPicker && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-sm bg-[#212C38] border-2 border-[#F0A53A] rounded-3xl p-5 shadow-2xl text-[#E9E4D8] space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-[#F0A53A]" />
                <h4 className="text-base font-bold text-[#E9E4D8]">
                  {t('selectLanguage') || 'Select Language'}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setShowLangPicker(false)}
                className="p-1.5 rounded-xl bg-[#18212B] border border-[#324050] text-[#9AA5B1] hover:text-[#E9E4D8]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              {[
                { code: 'en' as const, name: 'English (Default)', native: 'English', flag: '🇬🇧' },
                { code: 'af' as const, name: 'Afrikaans', native: 'Afrikaans', flag: '🇿🇦' },
                { code: 'zu' as const, name: 'isiZulu', native: 'isiZulu', flag: '🇿🇦' }
              ].map((item) => {
                const isSelected = language === item.code;
                return (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => handleSelectLanguage(item.code)}
                    className={`w-full p-3 rounded-2xl border text-left flex items-center justify-between transition-all ${
                      isSelected
                        ? 'bg-[#18212B] border-[#F0A53A] ring-1 ring-[#F0A53A] text-[#F0A53A] font-bold shadow-md'
                        : 'bg-[#18212B]/70 border-[#324050] text-[#9AA5B1] hover:border-[#F0A53A]/50 hover:text-[#E9E4D8]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{item.flag}</span>
                      <div>
                        <div className={`text-sm ${isSelected ? 'font-bold text-[#F0A53A]' : 'text-[#E9E4D8]'}`}>
                          {item.name}
                        </div>
                        <div className="text-[11px] text-[#9AA5B1]">{item.native}</div>
                      </div>
                    </div>
                    {isSelected && (
                      <div className="w-5 h-5 rounded-full bg-[#F0A53A] flex items-center justify-center text-[#2A1A04]">
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
