'use client';

import React, { createContext, useContext, useState } from 'react';
import { SupportedLanguage } from '@/types/models';
import { translations, TranslationKey } from './translations';

interface I18nContextType {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
  t: (key: TranslationKey, ...args: (string | number)[]) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

const LANGUAGE_STORAGE_KEY = 'eagle_eye_lang_v1';

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<SupportedLanguage>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY) as SupportedLanguage;
        if (stored === 'en' || stored === 'af' || stored === 'zu') {
          return stored;
        }
      } catch {
        // Storage unavailable
      }
    }
    return 'en'; // Default language is English as requested
  });

  const setLanguage = (lang: SupportedLanguage) => {
    setLanguageState(lang);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
        document.documentElement.lang = lang;
      } catch {
        // Fallback
      }
    }
  };

  const t = (key: TranslationKey, ...args: (string | number)[]): string => {
    const langDict = translations[language] || translations.en;
    let template: string = langDict[key] || translations.en[key] || (key as string);

    if (args.length > 0) {
      args.forEach((arg, index) => {
        template = template.replace(new RegExp(`\\{${index}\\}`, 'g'), String(arg));
      });
    }

    return template;
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
}
