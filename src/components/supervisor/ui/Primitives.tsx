'use client';

import React, { useRef } from 'react';
import { twMerge } from 'tailwind-merge';
import { sastDateString, sastTimeHM } from '@/lib/config/siteTime';
import type { Tone } from '../data/derive';
import { TONE_CHIP, TONE_TEXT } from './labels';

/** Status label with a tone. The text always carries the meaning (never colour alone). */
export function Chip({
  tone,
  children,
  className,
  ...rest
}: { tone: Tone; children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={twMerge(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold leading-5',
        TONE_CHIP[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/** Section with a condensed heading (Dawie's h2 style) and an optional right-hand element. */
export function Section({
  title,
  id,
  aside,
  children,
  className,
  testId
}: {
  title: string;
  id: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section aria-labelledby={id} className={twMerge('space-y-2', className)} data-testid={testId}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id={id} className="font-display text-xl font-semibold text-ee-text">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Honest empty state: one muted line, no illustration. */
export function EmptyLine({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="rounded-lg border border-ee-border bg-ee-surface px-3 py-3 text-sm text-ee-muted" data-testid={testId}>
      {children}
    </p>
  );
}

/** Simple list with dividers (Dawie style). */
export function DividedList({ children, label, testId }: { children: React.ReactNode; label?: string; testId?: string }) {
  return (
    <ul
      aria-label={label}
      className="divide-y divide-ee-border overflow-hidden rounded-lg border border-ee-border bg-ee-surface"
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number;
  countTone?: Tone;
  icon?: React.ReactNode;
}

/**
 * Accessible tab bar (arrow keys move between tabs). Panels must use id `${idPrefix}-panel-${key}`
 * and aria-labelledby `${idPrefix}-tab-${key}`.
 */
export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
  label,
  testIdPrefix
}: {
  tabs: ReadonlyArray<TabItem<K>>;
  active: K;
  onChange: (key: K) => void;
  idPrefix: string;
  label: string;
  testIdPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className="grid gap-1 rounded-lg border border-ee-border bg-ee-surface p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((tab, index) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
            data-testid={`${testIdPrefix}-tab-${tab.key}`}
            className={twMerge(
              'flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 font-display text-sm font-semibold leading-tight transition-colors motion-reduce:transition-none',
              selected ? 'bg-ee-primary text-ee-on-primary' : 'text-ee-muted hover:bg-ee-surface-raised hover:text-ee-text'
            )}
          >
            {/* Phones (down to 320 px): icon above a label that may wrap; wider screens: one line. */}
            <span className="flex min-w-0 max-w-full flex-col items-center gap-0.5 sm:flex-row sm:gap-1">
              {tab.icon}
              <span className="max-w-full text-center wrap-anywhere">{tab.label}</span>
            </span>
            {tab.count !== undefined && (
              <span
                className={twMerge(
                  'text-xs font-bold tabular-nums',
                  selected || tab.count === 0
                    ? ''
                    : tab.countTone === 'danger'
                      ? 'text-ee-danger-text'
                      : tab.countTone === 'warning'
                        ? 'text-ee-warning'
                        : ''
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Label / value line used in detail lists. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-x-1.5 text-sm">
      <span className="text-ee-muted">{label}</span>
      <span className="min-w-0 break-words text-ee-text">{children}</span>
    </div>
  );
}

/** Dawie's time column: large SAST HH:MM, with the month-day underneath when not today. */
export function TimeCell({ ms, now }: { ms: number | null; now: number }) {
  if (ms === null) {
    return <span className="w-14 flex-none pt-0.5 font-display text-lg font-semibold text-ee-muted">–</span>;
  }
  const date = sastDateString(ms);
  return (
    <span className="w-14 flex-none pt-0.5 leading-tight">
      <span className="block font-display text-lg font-semibold tabular-nums text-ee-text">{sastTimeHM(ms)}</span>
      {date !== sastDateString(now) && <span className="block text-xs tabular-nums text-ee-muted">{date.slice(5)}</span>}
    </span>
  );
}

/** Summary figure (Dawie's stats grid cell). A button that opens the matching detail. */
export function Tile({
  label,
  value,
  sub,
  tone,
  onClick,
  testId
}: {
  label: string;
  value: string;
  sub?: string;
  tone: Tone;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button type="button" onClick={onClick} className="min-h-20 bg-ee-surface p-3 text-left hover:bg-ee-surface-raised" data-testid={testId}>
      <span className={`block font-display text-3xl font-bold leading-none tabular-nums ${tone === 'muted' ? 'text-ee-text' : TONE_TEXT[tone]}`}>
        {value}
      </span>
      <span className="mt-1 block text-sm text-ee-muted">{label}</span>
      {sub && <span className="block text-xs text-ee-muted">{sub}</span>}
    </button>
  );
}
