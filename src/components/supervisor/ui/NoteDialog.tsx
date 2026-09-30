'use client';

import React, { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/Dialog';
import { useTranslation } from '@/lib/i18n/context';

export interface NoteDialogProps {
  title: string;
  description?: string;
  noteLabel: string;
  initialNote?: string;
  confirmLabel: string;
  /** Resolve / close needs a note; acknowledge does not. */
  noteRequired?: boolean;
  confirmVariant?: 'primary' | 'danger';
  /** Performs the database write. Returns an error message to show, or null on success. */
  onConfirm: (note: string) => Promise<string | null>;
  onClose: () => void;
  testId: string;
}

const MAX_NOTE = 2000;

/**
 * Supervisor action with a note, on the shared accessible Dialog (focus moves to the note, Tab
 * stays inside, Escape / Cancel close it and focus returns to the opener). While the write is
 * running the dialog cannot be dismissed, and it only closes after the server returned the row;
 * a failure stays visible in the dialog with the note kept.
 */
export function NoteDialog({
  title,
  description,
  noteLabel,
  initialNote = '',
  confirmLabel,
  noteRequired = false,
  confirmVariant = 'primary',
  onConfirm,
  onClose,
  testId
}: NoteDialogProps) {
  const { t } = useTranslation();
  const noteId = useId();
  const errorId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = note.trim();
  const canSave = !busy && (!noteRequired || trimmed.length > 0);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    let problem: string | null;
    try {
      problem = await onConfirm(trimmed);
    } catch (caught) {
      problem = caught instanceof Error ? caught.message : String(caught);
    }
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      description={description}
      dismissible={!busy}
      closeLabel={t('supClose')}
      initialFocusRef={textareaRef}
      data-testid={testId}
      footer={
        <>
          <Button type="button" variant="secondary" size="lg" onClick={onClose} disabled={busy} data-testid={`${testId}-cancel`}>
            {t('supCancel')}
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            size="lg"
            onClick={() => void save()}
            disabled={!canSave}
            data-testid={`${testId}-confirm`}
          >
            {busy ? t('supSaving') : confirmLabel}
          </Button>
        </>
      }
    >
      <label htmlFor={noteId} className="block text-sm text-ee-muted">
        {noteLabel}
        {noteRequired ? ` (${t('supRequired')})` : ''}
      </label>
      <textarea
        id={noteId}
        ref={textareaRef}
        value={note}
        maxLength={MAX_NOTE}
        onChange={(event) => setNote(event.target.value)}
        rows={4}
        aria-required={noteRequired || undefined}
        aria-describedby={error ? errorId : undefined}
        className="mt-1 w-full resize-y rounded-lg border border-ee-border bg-ee-bg px-3 py-2 text-base text-ee-text"
        data-testid={`${testId}-note`}
      />
      <div aria-live="assertive" className="min-h-5">
        {error && (
          <p id={errorId} className="mt-2 text-sm font-semibold text-ee-danger-text" data-testid={`${testId}-error`}>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
