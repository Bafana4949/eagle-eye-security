import React from 'react';

export type StatusVariant =
  | 'online'
  | 'offline'
  | 'syncing'
  | 'verified'
  | 'pending'
  | 'warning'
  | 'danger'
  | 'active'
  | 'completed';

interface StatusBadgeProps {
  status: StatusVariant;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className = '' }: StatusBadgeProps) {
  const configs: Record<StatusVariant, { text: string; bg: string; textCol: string; dot: string }> = {
    online: {
      text: 'ONLINE',
      bg: 'bg-emerald-950/60 border-emerald-700/60',
      textCol: 'text-emerald-300',
      dot: 'bg-emerald-400'
    },
    offline: {
      text: 'OFFLINE',
      bg: 'bg-amber-950/60 border-amber-700/60',
      textCol: 'text-amber-300',
      dot: 'bg-amber-400'
    },
    syncing: {
      text: 'SYNCING',
      bg: 'bg-blue-950/60 border-blue-700/60',
      textCol: 'text-blue-300',
      dot: 'bg-blue-400 animate-ping'
    },
    verified: {
      text: 'VERIFIED',
      bg: 'bg-emerald-950/60 border-emerald-700/60',
      textCol: 'text-emerald-300',
      dot: 'bg-emerald-400'
    },
    pending: {
      text: 'PENDING',
      bg: 'bg-slate-900 border-slate-700',
      textCol: 'text-slate-400',
      dot: 'bg-slate-500'
    },
    warning: {
      text: 'WARNING',
      bg: 'bg-amber-950/60 border-amber-700/60',
      textCol: 'text-amber-300',
      dot: 'bg-amber-400'
    },
    danger: {
      text: 'CRITICAL',
      bg: 'bg-rose-950/60 border-rose-700/60',
      textCol: 'text-rose-300',
      dot: 'bg-rose-400'
    },
    active: {
      text: 'ACTIVE',
      bg: 'bg-blue-950/60 border-blue-700/60',
      textCol: 'text-blue-300',
      dot: 'bg-blue-400'
    },
    completed: {
      text: 'COMPLETED',
      bg: 'bg-emerald-950/60 border-emerald-700/60',
      textCol: 'text-emerald-300',
      dot: 'bg-emerald-400'
    }
  };

  const config = configs[status] || configs.pending;
  const displayText = label || config.text;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wider uppercase border shadow-sm ${config.bg} ${config.textCol} ${className}`}
    >
      <span className={`w-2 h-2 rounded-full ${config.dot}`} />
      <span>{displayText}</span>
    </span>
  );
}
