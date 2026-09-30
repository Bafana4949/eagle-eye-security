import React from 'react';
import { twMerge } from 'tailwind-merge';

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={twMerge(
        'bg-slate-900/90 border border-slate-800/80 rounded-2xl p-5 shadow-xl backdrop-blur-sm',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={twMerge('flex items-center justify-between pb-3 border-b border-slate-800/60 mb-4', className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={twMerge('text-lg font-bold text-slate-100 tracking-tight', className)} {...props}>
      {children}
    </h3>
  );
}
