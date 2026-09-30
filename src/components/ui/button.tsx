'use client';

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'warning' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg' | 'touch';
  isLoading?: boolean;
}

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  isLoading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const baseStyles =
    'inline-flex items-center justify-center font-semibold rounded-xl transition-all duration-150 select-none active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900';

  const variants = {
    primary: 'bg-[#F0A53A] hover:bg-[#FFC76A] active:bg-[#C9801C] text-[#2A1A04] font-bold border border-[#F0A53A] shadow-md shadow-[#F0A53A]/20 focus:ring-[#F0A53A]',
    secondary: 'bg-[#212C38] hover:bg-[#2B3948] text-[#E9E4D8] border border-[#324050] focus:ring-[#9AA5B1]',
    danger: 'bg-[#B3261E] hover:bg-[#E0685C] text-white border border-[#B3261E] shadow-md shadow-red-950/40 focus:ring-[#E0685C]',
    warning: 'bg-[#F0A53A] hover:bg-[#C9801C] text-[#2A1A04] border border-[#F0A53A] focus:ring-[#F0A53A]',
    outline: 'bg-transparent hover:bg-[#212C38] text-[#E9E4D8] border border-[#324050] focus:ring-[#F0A53A]',
    ghost: 'bg-transparent hover:bg-[#212C38]/70 text-[#9AA5B1] hover:text-[#E9E4D8] focus:ring-[#9AA5B1]'
  };

  const sizes = {
    sm: 'text-xs px-3 py-2 min-h-[36px]',
    md: 'text-sm px-4 py-2.5 min-h-[44px]',
    lg: 'text-base px-6 py-3 min-h-[50px]',
    touch: 'text-lg px-6 py-4 min-h-[58px] w-full' // Mobile-first primary button with large touch area
  };

  return (
    <button
      className={twMerge(clsx(baseStyles, variants[variant], sizes[size], className))}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? (
        <span className="inline-flex items-center gap-2">
          <svg className="animate-spin h-5 w-5 text-current" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Processing...</span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}
