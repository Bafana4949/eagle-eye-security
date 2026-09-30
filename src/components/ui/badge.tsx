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
    success: 'bg-[#76C08F]/15 text-[#76C08F] border-[#76C08F]/40',
    warning: 'bg-[#F0A53A]/15 text-[#F0A53A] border-[#F0A53A]/40',
    danger: 'bg-[#E0685C]/15 text-[#E0685C] border-[#E0685C]/40',
    info: 'bg-[#F0A53A]/20 text-[#FFC76A] border-[#F0A53A]/50',
    neutral: 'bg-[#212C38] text-[#9AA5B1] border-[#324050]'
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
