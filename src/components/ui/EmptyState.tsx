import React from 'react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = ''
}: EmptyStateProps) {
  return (
    <div
      className={`p-8 text-center rounded-2xl border border-dashed border-slate-800 bg-slate-900/50 flex flex-col items-center justify-center ${className}`}
    >
      {icon && <div className="text-slate-500 mb-3">{icon}</div>}
      <h3 className="text-sm font-bold text-slate-200">{title}</h3>
      {description && (
        <p className="text-xs text-slate-400 max-w-sm mt-1 mb-4 leading-relaxed">
          {description}
        </p>
      )}
      {action && <div>{action}</div>}
    </div>
  );
}
