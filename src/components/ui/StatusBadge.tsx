import React from 'react';
import { twMerge } from 'tailwind-merge';

/**
 * Sync / connection / record state. Use the truthful words from the product rules in `label`
 * (translated by the caller), e.g. queued = "Saved on this phone", synced = "Received by server".
 */
export type StatusVariant =
  | 'online'
  | 'offline'
  | 'syncing'
  | 'synced'
  | 'queued'
  | 'failed'
  | 'verified'
  | 'pending'
  | 'warning'
  | 'danger'
  | 'active'
  | 'completed';

type Tone = 'success' | 'warning' | 'primary' | 'danger' | 'neutral';

const TONE_OF: Record<StatusVariant, Tone> = {
  online: 'success',
  synced: 'success',
  verified: 'success',
  completed: 'success',
  offline: 'warning',
  queued: 'warning',
  warning: 'warning',
  syncing: 'primary',
  active: 'primary',
  failed: 'danger',
  danger: 'danger',
  pending: 'neutral',
};

const TONE_CLASS: Record<Tone, string> = {
  success: 'border-ee-success/50 bg-ee-success/15 text-ee-success',
  warning: 'border-ee-warning/50 bg-ee-warning/15 text-ee-warning',
  primary: 'border-ee-primary/50 bg-ee-primary/10 text-ee-primary',
  danger: 'border-ee-danger/60 bg-ee-danger/15 text-ee-danger-text',
  neutral: 'border-ee-border bg-ee-surface text-ee-muted',
};

export interface StatusBadgeProps extends Omit<React.ComponentPropsWithRef<'span'>, 'children'> {
  status: StatusVariant;
  /** Visible, translated text. Required: the colour alone never carries the meaning. */
  label: string;
}

export function StatusBadge({ status, label, className, ...props }: StatusBadgeProps) {
  const tone = TONE_OF[status] ?? 'neutral';
  return (
    <span
      data-status={status}
      className={twMerge(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase leading-5 tracking-wide',
        TONE_CLASS[tone],
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-current" />
      <span>{label}</span>
    </span>
  );
}
