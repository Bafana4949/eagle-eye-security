'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Shield, MapPin, Car, AlertTriangle, Menu } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';

export function BottomNav() {
  const pathname = usePathname();
  const { t } = useTranslation();

  const navItems = [
    { label: t('home'), href: '/guard', icon: Shield },
    { label: t('patrol'), href: '/guard/patrol', icon: MapPin },
    { label: t('gate'), href: '/guard/gate', icon: Car },
    { label: t('incident'), href: '/guard/incident', icon: AlertTriangle },
    { label: t('more'), href: '/guard/more', icon: Menu }
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-md border-t border-slate-800/80 px-2 py-1 safe-area-pb">
      <div className="max-w-md mx-auto grid grid-cols-5 gap-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl transition-all duration-150 min-h-[58px] ${
                isActive
                  ? 'text-blue-400 font-bold bg-blue-950/40'
                  : 'text-slate-400 hover:text-slate-200 active:scale-95'
              }`}
            >
              <Icon className={`w-6 h-6 mb-1 ${isActive ? 'stroke-[2.5]' : 'stroke-[1.75]'}`} />
              <span className="text-[11px] leading-tight truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
