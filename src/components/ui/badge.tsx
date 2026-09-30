import React from 'react';
import { twMerge } from 'tailwind-merge';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

export function Badge({
  className,
  variant = 'neutral',
  children,
  ...props
}: BadgeProps) {
  const variants = {
    success: 'bg-emerald-950/80 text-emerald-400 border-emerald-800/80',
    warning: 'bg-amber-950/80 text-amber-400 border-amber-800/80',
    danger: 'bg-rose-950/80 text-rose-400 border-rose-800/80',
    info: 'bg-blue-950/80 text-blue-400 border-blue-800/80',
    neutral: 'bg-slate-800/80 text-slate-300 border-slate-700/80'
  };

  return (
    <span
      className={twMerge(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
