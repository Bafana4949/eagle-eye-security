/** Tailwind class sets for the gate screen (theme tokens from src/app/globals.css only). */

export const labelClass = 'mb-1 block text-sm font-semibold text-ee-muted';

export const inputClass =
  'block w-full min-h-12 rounded-lg border border-ee-border bg-ee-bg px-3 py-2 text-base text-ee-text placeholder:text-ee-muted focus:border-ee-primary focus:outline-none focus:ring-2 focus:ring-ee-primary/40 disabled:opacity-60';

export const primaryButtonClass =
  'flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-ee-primary px-4 text-lg font-bold text-ee-on-primary hover:bg-ee-primary-strong active:bg-ee-primary-strong disabled:opacity-60';

export const secondaryButtonClass =
  'flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-ee-border bg-ee-surface px-4 text-base font-semibold text-ee-text hover:bg-ee-surface-raised active:bg-ee-surface-raised disabled:opacity-60';

export const noticeClass = {
  warning: 'rounded-lg border border-ee-warning/40 bg-ee-warning/10 px-3 py-2 text-sm text-ee-warning',
  danger: 'rounded-lg border border-ee-danger/40 bg-ee-danger/10 px-3 py-2 text-sm text-ee-danger',
  success: 'rounded-lg border border-ee-success/40 bg-ee-success/10 px-3 py-2 text-sm text-ee-success',
  info: 'rounded-lg border border-ee-border bg-ee-surface px-3 py-2 text-sm text-ee-text'
} as const;
