'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';

interface HeaderNavProps {
  title?: string;
  subtitle?: string;
  showBack?: boolean;
  backHref?: string;
  rightAction?: React.ReactNode;
}

export function HeaderNav({
  title,
  subtitle,
  rightAction
}: HeaderNavProps) {
  const router = useRouter();
  const { profile, roles, signOut } = useAuth();

  const handleLogout = async () => {
    try {
      await signOut();
    } finally {
      router.push('/login');
    }
  };

  const roleLabel = roles.includes('admin') || roles.includes('super_admin')
    ? 'Admin'
    : roles.includes('supervisor')
    ? 'Supervisor'
    : roles.includes('guard')
    ? 'Guard'
    : roles.includes('client_viewer')
    ? 'Viewer'
    : '';

  return (
    <header className="sticky top-0 z-40 bg-[#18212B]/95 backdrop-blur-md border-b border-[#324050] px-4 py-3">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        {/* Brand & Context */}
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/login" className="flex items-center gap-2.5 flex-none group">
            <div className="relative w-10 h-10 rounded-xl overflow-hidden shadow-md shadow-[#F0A53A]/20 border border-[#F0A53A]/70 flex-none bg-[#18212B]">
              <Image
                src="/Eagle_Eye_Logo.jpg"
                alt="Eagle Eye Logo"
                fill
                className="object-cover"
                priority
              />
            </div>
            <div className="hidden sm:block">
              <span className="text-base font-bold tracking-tight text-[#E9E4D8] block leading-none">
                EAGLE EYE
              </span>
              <span className="text-[11px] font-semibold text-[#F0A53A] tracking-wider uppercase block mt-0.5">
                Aiguille Security
              </span>
            </div>
          </Link>

          {(title || subtitle) && (
            <div className="border-l border-[#324050] pl-3 min-w-0">
              {title && (
                <h1 className="text-sm md:text-base font-bold text-[#E9E4D8] truncate leading-tight">
                  {title}
                </h1>
              )}
              {subtitle && (
                <p className="text-[11px] text-[#9AA5B1] truncate">
                  {subtitle}
                </p>
              )}
            </div>
          )}
        </div>

        {/* User Status & Log Out Button */}
        <div className="flex items-center gap-2 flex-none">
          {rightAction}

          {/* User & Role Capsule */}
          {profile && (
            <div className="hidden md:flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#212C38] border border-[#324050] text-xs">
              <span className="w-2 h-2 rounded-full bg-[#76C08F] animate-pulse" />
              <span className="font-medium text-[#E9E4D8] truncate max-w-[120px]">
                {profile.first_name || 'User'}
              </span>
              {roleLabel && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#F0A53A]/20 text-[#F0A53A] border border-[#F0A53A]/30 uppercase">
                  {roleLabel}
                </span>
              )}
            </div>
          )}

          {/* Prominent Log Out Button */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleLogout}
            className="gap-1.5 text-xs text-[#E0685C] hover:text-white hover:bg-[#B3261E] hover:border-[#B3261E] transition-colors"
            title="Log Out of Eagle Eye"
          >
            <LogOut className="w-4 h-4" />
            <span className="font-semibold">Log Out</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
