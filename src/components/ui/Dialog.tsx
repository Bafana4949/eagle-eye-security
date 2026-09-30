'use client';

import React, { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';
import { buttonClassName } from './button';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0
  );
}

const noopSubscribe = () => () => {};
/** true on the client after hydration, false during server rendering (no hydration mismatch). */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Visible title; the dialog is labelled by it (aria-labelledby). */
  title: React.ReactNode;
  /** Optional short text under the title (aria-describedby). */
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Action buttons. On phones they stack full-width with the first child at the bottom (thumb reach). */
  footer?: React.ReactNode;
  /**
   * true (default): Escape, the backdrop and the X button close the dialog.
   * false: for critical flows (e.g. an SOS that is being recorded) only the dialog's own buttons close it.
   */
  dismissible?: boolean;
  /** Translated aria-label for the X button. The X is shown only when this is set and dismissible. */
  closeLabel?: string;
  /** Element to focus when the dialog opens (default: first control in the body, then the footer). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** 'danger' uses the SOS palette (deep red panel). */
  tone?: 'default' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'full';
  className?: string;
  'data-testid'?: string;
}

const SIZE: Record<NonNullable<DialogProps['size']>, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-2xl',
  full: 'h-full max-h-none rounded-none sm:rounded-none',
};

/**
 * Accessible modal dialog: role="dialog", aria-modal, labelled by its title, focus moves in on open,
 * Tab stays inside, Escape closes it when dismissible, focus returns to the opener on close, and the
 * page behind does not scroll. No animation, no blur.
 */
export function Dialog(props: DialogProps) {
  const isClient = useIsClient();
  if (!props.open || !isClient) return null;
  return createPortal(<DialogPanel {...props} />, document.body);
}

function DialogPanel({
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  closeLabel,
  initialFocusRef,
  tone = 'default',
  size = 'md',
  className,
  'data-testid': testId,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target =
      initialFocusRef?.current ?? focusableIn(bodyRef.current)[0] ?? focusableIn(footerRef.current)[0] ?? panelRef.current;
    target?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [initialFocusRef]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (dismissible) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableIn(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const danger = tone === 'danger';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" data-testid={testId}>
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-ee-bg/85"
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={twMerge(
          'relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border text-ee-text sm:rounded-2xl',
          danger ? 'border-ee-sos bg-ee-sos-deep' : 'border-ee-border bg-ee-surface',
          SIZE[size],
          className
        )}
      >
        <div
          className={twMerge(
            'flex items-start gap-3 border-b px-4 py-3',
            danger ? 'border-ee-sos' : 'border-ee-border'
          )}
        >
          <div className="min-w-0 flex-1 py-1">
            <h2 id={titleId} className="font-display text-2xl font-bold leading-tight">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className={twMerge('mt-1 text-sm', danger ? 'text-ee-text' : 'text-ee-muted')}>
                {description}
              </p>
            )}
          </div>
          {dismissible && closeLabel && (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className={buttonClassName({ variant: 'ghost', size: 'icon', className: '-mr-2 text-ee-text' })}
            >
              <X aria-hidden="true" className="size-6" />
            </button>
          )}
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {children}
        </div>
        {footer && (
          <div
            ref={footerRef}
            className={twMerge(
              'flex flex-col-reverse gap-2 border-t px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end',
              danger ? 'border-ee-sos' : 'border-ee-border'
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
