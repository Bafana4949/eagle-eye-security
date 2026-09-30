import React from 'react';
import { twMerge } from 'tailwind-merge';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface BadgeProps extends React.ComponentPropsWithRef<'span'> {
  variant?: BadgeVariant;
}

/**
 * Small label. Colour is never the only signal: always put the state in words inside the badge.
 * Small danger text uses text-ee-danger-text (ee-danger alone is below 4.5:1 on tinted panels).
 */
const VARIANTS: Record<BadgeVariant, string> = {
  success: 'border-ee-success/50 bg-ee-success/15 text-ee-success',
  warning: 'border-ee-warning/50 bg-ee-warning/15 text-ee-warning',
  danger: 'border-ee-danger/60 bg-ee-danger/15 text-ee-danger-text',
  info: 'border-ee-primary/50 bg-ee-primary/10 text-ee-primary',
  neutral: 'border-ee-border bg-ee-surface text-ee-muted',
};

export function Badge({ className, variant = 'neutral', children, ...props }: BadgeProps) {
  return (
    <span
      className={twMerge(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-5',
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
