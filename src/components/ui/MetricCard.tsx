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
    default: 'border-[#324050] bg-[#212C38] text-[#E9E4D8]',
    success: 'border-[#76C08F]/40 bg-[#76C08F]/10 text-[#76C08F]',
    warning: 'border-[#F0A53A]/40 bg-[#F0A53A]/10 text-[#F0A53A]',
    danger: 'border-[#E0685C]/40 bg-[#E0685C]/10 text-[#E0685C]',
    info: 'border-[#F0A53A]/40 bg-[#F0A53A]/10 text-[#FFC76A]'
  };

  const valueColors = {
    default: 'text-[#E9E4D8]',
    success: 'text-[#76C08F]',
    warning: 'text-[#F0A53A]',
    danger: 'text-[#E0685C]',
    info: 'text-[#F0A53A]'
  };

  return (
    <div
      className={`p-4 rounded-2xl border transition-all shadow-md ${variantStyles[variant]} ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#9AA5B1]">
          {label}
        </span>
        {icon && <div className="text-[#9AA5B1]">{icon}</div>}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-2xl font-bold tracking-tight ${valueColors[variant]}`}>
          {value}
        </span>
        {subValue && (
          <span className="text-xs font-medium text-[#9AA5B1] truncate">
            {subValue}
          </span>
        )}
      </div>
    </div>
  );
}
