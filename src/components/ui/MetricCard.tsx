import React from 'react';
import { twMerge } from 'tailwind-merge';

export type MetricCardVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface MetricCardProps extends Omit<React.ComponentPropsWithRef<'div'>, 'children'> {
  label: string;
  /** Show real numbers only. For "no data yet" pass a dash and explain it in `subValue`. */
  value: string | number;
  subValue?: string;
  /** Optional short change text (e.g. "+2 since 06:00"), shown under the value. */
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon?: React.ReactNode;
  variant?: MetricCardVariant;
}

const BORDER: Record<MetricCardVariant, string> = {
  default: 'border-ee-border',
  success: 'border-ee-success/40',
  warning: 'border-ee-warning/40',
  danger: 'border-ee-danger/50',
  info: 'border-ee-primary/40',
};

// The value is large (30 px bold), so ee-danger meets the 3:1 large-text contrast on ee-surface.
const VALUE: Record<MetricCardVariant, string> = {
  default: 'text-ee-text',
  success: 'text-ee-success',
  warning: 'text-ee-warning',
  danger: 'text-ee-danger',
  info: 'text-ee-primary',
};

const TREND_SYMBOL: Record<NonNullable<MetricCardProps['trend']>, string> = {
  up: '▲',
  down: '▼',
  neutral: '',
};

export function MetricCard({
  label,
  value,
  subValue,
  change,
  trend,
  icon,
  variant = 'default',
  className,
  ...props
}: MetricCardProps) {
  return (
    <div className={twMerge('rounded-xl border bg-ee-surface p-4 text-ee-text', BORDER[variant], className)} {...props}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ee-muted">{label}</p>
        {icon && (
          <span aria-hidden="true" className="shrink-0 text-ee-muted">
            {icon}
          </span>
        )}
      </div>
      <p className={twMerge('mt-1 font-display text-3xl font-bold leading-none tabular-nums', VALUE[variant])}>
        {value}
      </p>
      {subValue && <p className="mt-1.5 text-xs text-ee-muted">{subValue}</p>}
      {change && (
        <p className="mt-1 text-xs text-ee-muted">
          {trend && TREND_SYMBOL[trend] && (
            <span aria-hidden="true" className="mr-1">
              {TREND_SYMBOL[trend]}
            </span>
          )}
          {change}
        </p>
      )}
    </div>
  );
}
