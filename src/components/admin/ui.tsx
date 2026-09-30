'use client';

/**
 * Small building blocks for the admin console: labelled fields, status notices, dialogs.
 * Colours come only from the ee-* theme tokens (src/app/globals.css).
 */
import React, { useEffect, useId, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/lib/i18n/context';
import type { AdminError } from './adminData';
import { adminErrorKey } from './format';

export const inputClass =
  'w-full min-h-12 rounded-xl bg-ee-bg border border-ee-border px-3 py-2 text-base text-ee-text placeholder:text-ee-muted focus:outline-none focus:ring-2 focus:ring-ee-primary disabled:opacity-60';

export const errorInputClass = 'border-ee-danger';

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

/** Label + control + hint / error text wired with aria-describedby by the caller via ids. */
export function Field({ id, label, hint, error, className, children }: FieldProps) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-sm font-semibold text-ee-muted mb-1">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-ee-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-ee-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** aria-describedby value for a Field's control. */
export function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hint?: string;
  error?: string;
  testId?: string;
  fieldClassName?: string;
}

export function TextField({ id, label, value, onValueChange, hint, error, testId, fieldClassName, className, ...rest }: TextFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} className={fieldClassName}>
      <input
        id={id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        data-testid={testId}
        className={`${inputClass} ${error ? errorInputClass : ''} ${className ?? ''}`}
        {...rest}
      />
    </Field>
  );
}

interface CheckboxRowProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  testId?: string;
}

/** A full-width, 48 px+ tap target checkbox with a visible label. */
export function CheckboxRow({ id, label, description, checked, onChange, disabled, testId }: CheckboxRowProps) {
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 min-h-12 py-2 px-1 rounded-lg ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-ee-surface-raised'}`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
        className="mt-1 h-5 w-5 flex-none accent-ee-primary"
        aria-describedby={description ? `${id}-desc` : undefined}
      />
      <span className="min-w-0">
        <span className="block text-base text-ee-text">{label}</span>
        {description && (
          <span id={`${id}-desc`} className="block text-xs text-ee-muted">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export type NoticeTone = 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASSES: Record<NoticeTone, string> = {
  success: 'border-ee-success/50 bg-ee-success/10 text-ee-success',
  warning: 'border-ee-warning/50 bg-ee-warning/10 text-ee-warning',
  danger: 'border-ee-danger/50 bg-ee-danger/10 text-ee-danger-text',
  info: 'border-ee-border bg-ee-surface text-ee-text'
};

const TONE_ICONS: Record<NoticeTone, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info
};

interface NoticeProps {
  tone: NoticeTone;
  title?: string;
  children?: React.ReactNode;
  testId?: string;
  className?: string;
}

/**
 * Status message. Danger notices are announced assertively, others politely. Small danger text uses
 * ee-danger-text (ee-danger itself is below 4.5:1 on the dark surfaces).
 */
export function Notice({ tone, title, children, testId, className }: NoticeProps) {
  const Icon = TONE_ICONS[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
      data-testid={testId}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${TONE_CLASSES[tone]} ${className ?? ''}`}
    >
      <Icon className="h-5 w-5 flex-none mt-0.5" aria-hidden />
      <div className="min-w-0 break-words">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5 text-ee-text' : 'text-ee-text'}>{children}</div>}
      </div>
    </div>
  );
}

/**
 * Translated summary of an admin error plus the server's technical detail. `write`: the error
 * belongs to a save / delete; when no usable answer came back (network, not confirmed) the write
 * may still have happened, so the title says "not confirmed" instead of the caller's "not saved".
 */
export function ErrorNotice({ error, testId, title, write }: { error: AdminError; testId?: string; title?: string; write?: boolean }) {
  const { t } = useTranslation();
  const unconfirmed = write === true && (error.kind === 'network' || error.kind === 'not_confirmed');
  return (
    <Notice tone="danger" title={unconfirmed ? t('admWriteNotConfirmed') : (title ?? t(adminErrorKey(error)))} testId={testId}>
      {title && <p>{t(adminErrorKey(error))}</p>}
      {error.message && (
        <p className="text-xs text-ee-muted break-words">
          {t('admTechnicalDetail')}: {error.code ? `[${error.code}] ` : ''}
          {error.message}
        </p>
      )}
    </Notice>
  );
}

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** false: Escape and the close button are disabled (e.g. while a write is in flight). */
  dismissible?: boolean;
  children: React.ReactNode;
  testId?: string;
  wide?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog: role="dialog", aria-modal, labelled by its title, focus moved inside and trapped. */
export function Dialog({ open, title, onClose, dismissible = true, children, testId, wide }: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    if (!open) return;
    const previous = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dismissibleRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ee-bg/90 p-2 sm:p-4 print:hidden">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[92vh] overflow-y-auto rounded-2xl border border-ee-border bg-ee-surface p-4 text-ee-text focus:outline-none`}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 id={titleId} className="font-display text-xl font-bold leading-tight text-ee-text">
            {title}
          </h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              className="min-h-12 min-w-12 -mt-2 -mr-2 rounded-xl text-ee-muted hover:text-ee-text hover:bg-ee-surface-raised"
              aria-label={t('admClose')}
            >
              <span aria-hidden="true" className="text-2xl leading-none">
                ×
              </span>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

export function ConfirmDialog({ open, title, children, confirmLabel, tone = 'primary', busy, onConfirm, onCancel, testId }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} title={title} onClose={onCancel} dismissible={!busy} testId={testId}>
      <div className="space-y-3 text-sm text-ee-text">{children}</div>
      <div className="mt-4 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        <Button type="button" variant="secondary" className="min-h-12" onClick={onCancel} disabled={busy} data-autofocus>
          {t('admCancel')}
        </Button>
        <Button
          type="button"
          variant={tone === 'danger' ? 'danger' : 'primary'}
          className="min-h-12"
          onClick={onConfirm}
          disabled={busy}
          data-testid={testId ? `${testId}-confirm` : undefined}
        >
          {busy ? t('admWorking') : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** Section heading in the Barlow Condensed display face. */
export function SectionTitle({ children, id, action }: { children: React.ReactNode; id?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id={id} className="font-display text-2xl font-bold text-ee-text">
        {children}
      </h2>
      {action}
    </div>
  );
}
