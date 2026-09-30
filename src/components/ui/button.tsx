import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { LoaderCircle } from 'lucide-react';

/**
 * Button variants (theme tokens only, see src/app/globals.css):
 * - primary:   lamp-amber fill, the main action on a screen
 * - secondary: panel fill with a border (Dawie's `.btn`)
 * - danger:    panel fill with red text and border (Dawie's `.btn.danger`) for destructive or "stop" actions
 * - sos:       solid SOS red, only for panic / emergency actions
 * - ghost:     no fill, muted text (low-emphasis actions such as "Later" or "Cancel")
 * - warning / outline: kept for existing call sites (amber tint / transparent with a border)
 *
 * Sizes: every size is at least 44 px high. Guard screens should use `md` (48 px) or larger;
 * `touch` (56 px, full width) is the main action of a guard screen; `icon` is a 48 px square for
 * icon-only buttons, which MUST get an aria-label.
 *
 * The native `type` is not changed: inside a <form> pass type="button" for buttons that must not submit.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'sos' | 'ghost' | 'warning' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'touch' | 'icon';

export interface ButtonProps extends React.ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. Keep a visible label in `children`. */
  isLoading?: boolean;
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg border font-semibold leading-tight select-none ' +
  'transition-colors duration-150 motion-reduce:transition-none ' +
  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ee-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border-ee-primary bg-ee-primary text-ee-on-primary hover:border-ee-primary-strong hover:bg-ee-primary-strong active:bg-ee-primary-strong',
  secondary: 'border-ee-border bg-ee-surface text-ee-text hover:bg-ee-surface-raised active:bg-ee-surface-raised',
  danger: 'border-ee-danger/70 bg-ee-surface text-ee-danger-text hover:bg-ee-danger/15 active:bg-ee-danger/20',
  sos: 'border-ee-sos bg-ee-sos font-bold text-ee-on-danger hover:border-ee-sos-deep hover:bg-ee-sos-deep active:bg-ee-sos-deep',
  ghost:
    'border-transparent bg-transparent text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text active:bg-ee-surface-raised',
  warning: 'border-ee-warning/60 bg-ee-warning/15 text-ee-warning hover:bg-ee-warning/25 active:bg-ee-warning/25',
  outline: 'border-ee-border bg-transparent text-ee-text hover:bg-ee-surface-raised active:bg-ee-surface-raised',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 text-sm',
  md: 'min-h-12 px-4 text-base',
  lg: 'min-h-14 px-5 text-lg',
  touch: 'min-h-14 w-full px-5 py-3 text-lg',
  icon: 'size-12 shrink-0 p-0',
};

/** The Button classes, for links or labels that must look like a button (e.g. <Link className={...}>). */
export function buttonClassName({
  variant = 'primary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return twMerge(clsx(BASE, VARIANTS[variant], SIZES[size], className));
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
  return (
    <button
      className={buttonClassName({ variant, size, className })}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      {...props}
    >
      {isLoading && <LoaderCircle aria-hidden="true" className="size-5 shrink-0 motion-safe:animate-spin" />}
      {children}
    </button>
  );
}
