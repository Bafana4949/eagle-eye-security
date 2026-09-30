import React from 'react';
import { twMerge } from 'tailwind-merge';
import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

export interface NoticeProps extends Omit<React.ComponentPropsWithRef<'div'>, 'title' | 'role'> {
  tone?: NoticeTone;
  title?: React.ReactNode;
  /**
   * 'polite' → role="status" (default), 'assertive' → role="alert" (errors that block the guard),
   * 'off' → no live region. Screen readers announce CHANGES inside a live region reliably, so keep the
   * Notice mounted and change its text rather than mounting a new one for every message.
   */
  live?: 'polite' | 'assertive' | 'off';
  /** Custom icon, or false for none. Defaults to an icon that matches the tone. */
  icon?: React.ReactNode | false;
  action?: React.ReactNode;
}

const TONE: Record<NoticeTone, { box: string; accent: string; Icon: typeof Info }> = {
  info: { box: 'border-ee-border bg-ee-surface', accent: 'text-ee-primary', Icon: Info },
  success: { box: 'border-ee-success/50 bg-ee-success/10', accent: 'text-ee-success', Icon: CircleCheck },
  warning: { box: 'border-ee-warning/50 bg-ee-warning/10', accent: 'text-ee-warning', Icon: TriangleAlert },
  danger: { box: 'border-ee-danger/60 bg-ee-danger/10', accent: 'text-ee-danger-text', Icon: CircleX },
};

/** Inline message for success / queued / error feedback. Body text stays high-contrast ee-text. */
export function Notice({
  tone = 'info',
  title,
  live = 'polite',
  icon,
  action,
  className,
  children,
  ...props
}: NoticeProps) {
  const { box, accent, Icon } = TONE[tone];
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  const hasContent = Boolean(title) || Boolean(children);
  return (
    <div
      role={role}
      aria-live={live === 'off' ? undefined : live}
      data-tone={tone}
      className={twMerge(
        hasContent ? 'flex items-start gap-3 rounded-lg border px-3 py-3 text-sm text-ee-text' : 'sr-only',
        hasContent && box,
        className
      )}
      {...props}
    >
      {hasContent && icon !== false && (
        <span aria-hidden="true" className={twMerge('mt-0.5 shrink-0', accent)}>
          {icon ?? <Icon className="size-5" />}
        </span>
      )}
      {hasContent && (
        <div className="min-w-0 flex-1">
          {title && <p className={twMerge('font-semibold', accent)}>{title}</p>}
          {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
          {action && <div className="mt-3">{action}</div>}
        </div>
      )}
    </div>
  );
}
