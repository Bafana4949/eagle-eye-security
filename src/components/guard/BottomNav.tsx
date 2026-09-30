'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Shield, MapPin, Car, AlertTriangle, Menu } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import type { TranslationKey } from '@/lib/i18n/translations';

const NAV_ITEMS: Array<{ key: TranslationKey; href: string; icon: typeof Shield; testId: string }> = [
  { key: 'home', href: '/guard', icon: Shield, testId: 'chrome-nav-home' },
  { key: 'patrol', href: '/guard/patrol', icon: MapPin, testId: 'chrome-nav-patrol' },
  { key: 'gate', href: '/guard/gate', icon: Car, testId: 'chrome-nav-gate' },
  { key: 'incident', href: '/guard/incident', icon: AlertTriangle, testId: 'chrome-nav-incident' },
  { key: 'more', href: '/guard/more', icon: Menu, testId: 'chrome-nav-more' }
];

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/guard') return pathname === '/guard';
  // History is reached from "More", so it keeps that tab highlighted.
  if (href === '/guard/more' && pathname.startsWith('/guard/history')) return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNav() {
  const pathname = usePathname() || '';
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t('authNavLabel')}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ee-border bg-ee-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto grid max-w-md grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                // Five tabs on a 320 px phone leave 64 px each: the smaller label keeps "Patrollie" /
                // "Isigameko" whole instead of truncated.
                className={`flex min-h-14 flex-col items-center justify-center gap-1 px-0.5 py-2 font-display text-sm font-semibold leading-none no-underline min-[360px]:text-base ${
                  active
                    ? 'text-ee-primary shadow-[inset_0_3px_0_var(--color-ee-primary)]'
                    : 'text-ee-muted hover:text-ee-text'
                }`}
                data-testid={item.testId}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.5 : 1.75} aria-hidden="true" />
                <span className="max-w-full truncate">{t(item.key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
