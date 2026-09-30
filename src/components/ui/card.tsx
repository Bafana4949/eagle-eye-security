import React from 'react';
import { twMerge } from 'tailwind-merge';

/** Panel on the page background (Dawie's `--panel`). No shadows, glows or gradients. */
export function Card({ className, children, ...props }: React.ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={twMerge('rounded-xl border border-ee-border bg-ee-surface p-4 text-ee-text sm:p-5', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={twMerge('mb-4 flex items-center justify-between gap-3 border-b border-ee-border pb-3', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.ComponentPropsWithRef<'h3'>) {
  return (
    <h3 className={twMerge('font-display text-xl font-semibold leading-tight text-ee-text', className)} {...props}>
      {children}
    </h3>
  );
}

/** Secondary text under a CardTitle. */
export function CardDescription({ className, children, ...props }: React.ComponentPropsWithRef<'p'>) {
  return (
    <p className={twMerge('text-sm text-ee-muted', className)} {...props}>
      {children}
    </p>
  );
}
