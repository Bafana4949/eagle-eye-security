import React from 'react';
import { twMerge } from 'tailwind-merge';

export interface EmptyStateProps extends Omit<React.ComponentPropsWithRef<'div'>, 'title'> {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Heading level of the title; use 'p' when the surrounding page already has the right heading. */
  titleAs?: 'h2' | 'h3' | 'h4' | 'p';
}

/** Honest "nothing here yet" state. Never fill an empty list with sample data. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  titleAs: Title = 'h3',
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={twMerge(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-ee-border px-4 py-8 text-center',
        className
      )}
      {...props}
    >
      {icon && (
        <div aria-hidden="true" className="mb-3 text-ee-muted">
          {icon}
        </div>
      )}
      <Title className="font-display text-lg font-semibold text-ee-text">{title}</Title>
      {description && <p className="mt-1 max-w-sm text-sm leading-relaxed text-ee-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
