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
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-[#212C38]/95 backdrop-blur-md border-t border-[#324050] px-2 py-1 safe-area-pb">
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
                  ? 'text-[#F0A53A] font-bold bg-[#18212B]/60 shadow-inner'
                  : 'text-[#9AA5B1] hover:text-[#E9E4D8] active:scale-95'
              }`}
            >
              <Icon className={`w-5 h-5 mb-1 ${isActive ? 'stroke-[2.5]' : 'stroke-[1.75]'}`} />
              <span className="text-[11px] leading-tight truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
