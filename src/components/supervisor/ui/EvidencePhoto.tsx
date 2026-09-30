'use client';

import React, { useEffect, useState } from 'react';
import { Camera, EyeOff, ImageOff, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { getEvidenceSignedUrl, parseEvidencePath } from '@/lib/storage/evidence';

/** Signed URLs live 5 minutes; the image is dropped a little earlier and re-signed on demand. */
const SIGNED_URL_SECONDS = 300;
const DROP_AFTER_MS = 280_000;

type PhotoState =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'shown'; url: string }
  | { kind: 'no_access'; message: string }
  | { kind: 'broken' };

/**
 * One evidence photo from the private bucket. Nothing is fetched until the user asks: then a
 * short-lived signed URL is created with the viewer's own session (RLS decides; a denied read
 * shows "no access", never a broken image). Public URLs are never used.
 */
export function EvidencePhoto({ path, label, testId }: { path: string; label: string; testId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<PhotoState>({ kind: 'closed' });
  const validPath = parseEvidencePath(path) !== null;

  useEffect(() => {
    if (state.kind !== 'shown') return;
    const id = window.setTimeout(() => setState({ kind: 'closed' }), DROP_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [state]);

  const open = async () => {
    setState({ kind: 'loading' });
    try {
      const url = await getEvidenceSignedUrl(path, SIGNED_URL_SECONDS);
      setState({ kind: 'shown', url });
    } catch (error) {
      setState({ kind: 'no_access', message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!validPath) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ee-muted" data-testid={`${testId}-invalid`}>
        <ImageOff className="h-4 w-4 flex-none" aria-hidden="true" />
        {t('supPhotoOldFormat')}
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      {state.kind !== 'shown' && (
        <button
          type="button"
          onClick={() => void open()}
          disabled={state.kind === 'loading'}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-ee-border bg-ee-bg px-3 text-sm font-semibold text-ee-text hover:bg-ee-surface-raised disabled:opacity-60"
          data-testid={`${testId}-open`}
        >
          {state.kind === 'no_access' || state.kind === 'broken' ? (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Camera className="h-4 w-4" aria-hidden="true" />
          )}
          {state.kind === 'loading' ? t('supPhotoLoading') : label}
        </button>
      )}
      <div aria-live="polite">
        {state.kind === 'no_access' && (
          <p className="flex items-start gap-1.5 text-xs text-ee-danger-text" data-testid={`${testId}-error`}>
            <EyeOff className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>
              {t('supPhotoNoAccess')} <span className="text-ee-muted">({state.message})</span>
            </span>
          </p>
        )}
        {state.kind === 'broken' && (
          <p className="text-xs text-ee-warning" data-testid={`${testId}-expired`}>
            {t('supPhotoExpired')}
          </p>
        )}
      </div>
      {state.kind === 'shown' && (
        <figure className="space-y-1">
          {/* A short-lived signed URL from private storage: next/image optimisation is not wanted here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.url}
            alt={label}
            className="max-h-72 w-auto max-w-full rounded-lg border border-ee-border bg-ee-bg object-contain"
            onError={() => setState({ kind: 'broken' })}
            data-testid={`${testId}-img`}
          />
          <figcaption className="flex flex-wrap items-center gap-3 text-xs">
            <a href={state.url} target="_blank" rel="noopener noreferrer" className="underline">
              {t('supPhotoOpenFull')}
            </a>
            <button type="button" onClick={() => setState({ kind: 'closed' })} className="min-h-11 px-1 text-ee-muted underline">
              {t('supPhotoHide')}
            </button>
          </figcaption>
        </figure>
      )}
    </div>
  );
}
