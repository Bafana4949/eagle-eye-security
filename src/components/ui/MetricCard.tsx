import React from 'react';

export interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon?: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}

export function MetricCard({
  label,
  value,
  subValue,
  icon,
  variant = 'default',
  className = ''
}: MetricCardProps) {
  const variantStyles = {
    default: 'border-slate-800 bg-slate-900/90 text-slate-100',
    success: 'border-emerald-800/60 bg-emerald-950/30 text-emerald-400',
    warning: 'border-amber-800/60 bg-amber-950/30 text-amber-400',
    danger: 'border-rose-800/60 bg-rose-950/30 text-rose-400',
    info: 'border-blue-800/60 bg-blue-950/30 text-blue-400'
  };

  const valueColors = {
    default: 'text-white',
    success: 'text-emerald-400',
    warning: 'text-amber-400',
    danger: 'text-rose-400',
    info: 'text-blue-400'
  };

  return (
    <div
      className={`p-4 rounded-2xl border transition-all shadow-sm ${variantStyles[variant]} ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          {label}
        </span>
        {icon && <div className="text-slate-400">{icon}</div>}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-2xl font-black tracking-tight ${valueColors[variant]}`}>
          {value}
        </span>
        {subValue && (
          <span className="text-xs font-medium text-slate-400 truncate">
            {subValue}
          </span>
        )}
      </div>
    </div>
  );
}
