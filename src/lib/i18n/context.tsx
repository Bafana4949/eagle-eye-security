'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SupportedLanguage } from '@/types/models';
import { translations, type TranslationKey } from './translations';

interface I18nContextType {
  language: SupportedLanguage;
  /** The language the user picked on this device (stored), or null when none was picked. */
  chosenLanguage: SupportedLanguage | null;
  /** Explicit choice by the user: stored on this device and applied everywhere. */
  setLanguage: (lang: SupportedLanguage) => void;
  /**
   * Language configured for the account (profiles.preferred_language). Used only while the user
   * has not picked a language on this device; never stored.
   */
  applyPreferredLanguage: (lang: SupportedLanguage | null | undefined) => void;
  t: (key: TranslationKey, ...args: (string | number)[]) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const LANGUAGE_STORAGE_KEY = 'eagle_eye_lang_v1';
/** Dawie Boerdery works in Afrikaans; the reference app starts in Afrikaans too. */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'af';
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ['af', 'en', 'zu'];

/** Same-tab notification (the 'storage' event only fires in other tabs). */
const LANGUAGE_CHANGE_EVENT = 'eagle-eye:language-change';

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === 'en' || value === 'af' || value === 'zu';
}

function readStoredLanguage(): SupportedLanguage | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

function subscribeToStoredLanguage(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LANGUAGE_STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(LANGUAGE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(LANGUAGE_CHANGE_EVENT, onChange);
  };
}

/** The server (and the hydration pass) never sees localStorage: it renders the default language. */
const serverStoredLanguage = (): SupportedLanguage | null => null;

/** Looks up `key` in `language` (falling back to English) and fills the {0}, {1}, … placeholders. */
export function translate(language: SupportedLanguage, key: TranslationKey, ...args: (string | number)[]): string {
  const dictionary = translations[language] as Record<string, string>;
  const english = translations.en as Record<string, string>;
  let template: string = dictionary[key] || english[key] || (key as string);
  args.forEach((arg, index) => {
    template = template.split(`{${index}}`).join(String(arg));
  });
  return template;
}

function RootI18nProvider({ children }: { children: React.ReactNode }) {
  // useSyncExternalStore renders the server snapshot during hydration and then the stored choice,
  // so the first client render always matches the server HTML (no hydration mismatch).
  const chosenLanguage = useSyncExternalStore(subscribeToStoredLanguage, readStoredLanguage, serverStoredLanguage);
  const [sessionLanguage, setSessionLanguage] = useState<SupportedLanguage | null>(null);
  const [preferredLanguage, setPreferredLanguage] = useState<SupportedLanguage | null>(null);
  const language: SupportedLanguage = chosenLanguage ?? sessionLanguage ?? preferredLanguage ?? DEFAULT_LANGUAGE;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((lang: SupportedLanguage) => {
    if (!isSupportedLanguage(lang)) return;
    // Applies at once even when storage is blocked (then only until the app is closed).
    setSessionLanguage(lang);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // Storage blocked or full.
    }
    window.dispatchEvent(new Event(LANGUAGE_CHANGE_EVENT));
  }, []);

  const applyPreferredLanguage = useCallback((lang: SupportedLanguage | null | undefined) => {
    setPreferredLanguage(isSupportedLanguage(lang) ? lang : null);
  }, []);

  const t = useCallback(
    (key: TranslationKey, ...args: (string | number)[]) => translate(language, key, ...args),
    [language]
  );

  const value = useMemo<I18nContextType>(
    () => ({ language, chosenLanguage, setLanguage, applyPreferredLanguage, t }),
    [language, chosenLanguage, setLanguage, applyPreferredLanguage, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Provides the UI language. The root layout mounts one for the whole app; a nested
 * <I18nProvider> (still present in some pages) passes through to it, so every screen shares
 * one language.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const parent = useContext(I18nContext);
  if (parent) return <>{children}</>;
  return <RootI18nProvider>{children}</RootI18nProvider>;
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
}
