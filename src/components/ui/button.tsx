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
    primary: 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/30 focus:ring-blue-500',
    secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 focus:ring-slate-400',
    danger: 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/30 focus:ring-rose-500',
    warning: 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/30 focus:ring-amber-500',
    outline: 'bg-transparent hover:bg-slate-800/60 text-slate-200 border border-slate-600 focus:ring-slate-400',
    ghost: 'bg-transparent hover:bg-slate-800/40 text-slate-300 focus:ring-slate-400'
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
