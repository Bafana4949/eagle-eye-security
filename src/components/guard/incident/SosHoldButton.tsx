'use client';

import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { Siren } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/context';
import { SOS_HOLD_MS, holdProgress, holdSecondsLeft } from './incidentLogic';

interface SosHoldButtonProps {
  /** Called once when the button has been held for the full 2 s. */
  onTrigger: () => void;
  disabled?: boolean;
  describedById?: string;
}

type HoldFeedback = 'idle' | 'holding' | 'released_early';

/**
 * Press-and-hold SOS control (reference app behaviour: 2 s hold with a filling bar).
 * - Pointer: pointer capture keeps the hold alive while the thumb drifts; lifting early,
 *   pointercancel, pointerleave or losing capture cancels. A tap does nothing.
 * - Keyboard: holding Space or Enter for 2 s also triggers; releasing early cancels.
 * - Fires as soon as the 2 s are complete (no second "release to send" step to get wrong).
 * - The bar is hidden under prefers-reduced-motion; the text countdown is always shown.
 */
export const SosHoldButton = forwardRef<HTMLButtonElement, SosHoldButtonProps>(function SosHoldButton(
  { onTrigger, disabled = false, describedById },
  ref
) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const [feedback, setFeedback] = useState<HoldFeedback>('idle');
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const onTriggerRef = useRef(onTrigger);

  useEffect(() => {
    onTriggerRef.current = onTrigger;
  }, [onTrigger]);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startRef.current = null;
    pointerIdRef.current = null;
  }, []);

  /**
   * Ends a hold that did not reach 2 s. A no-op when no hold is running, so the trailing
   * pointerleave / lostpointercapture after a release does not clear the "released early" note.
   */
  const cancelHold = useCallback(() => {
    if (startRef.current === null) return;
    const early = !firedRef.current;
    stopLoop();
    setElapsed(0);
    if (early) setFeedback('released_early');
  }, [stopLoop]);

  const beginHold = useCallback(() => {
    if (disabled || startRef.current !== null) return;
    firedRef.current = false;
    startRef.current = performance.now();
    setElapsed(0);
    setFeedback('holding');
    const step = () => {
      if (startRef.current === null) return;
      const ms = performance.now() - startRef.current;
      if (holdProgress(ms) >= 1) {
        firedRef.current = true;
        stopLoop();
        setElapsed(SOS_HOLD_MS);
        setFeedback('idle');
        try {
          navigator.vibrate?.([300, 100, 300]);
        } catch {
          // Vibration is a nicety only.
        }
        onTriggerRef.current();
        return;
      }
      setElapsed(ms);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [disabled, stopLoop]);

  // Stop the animation loop on unmount; cancel a hold when the page is hidden.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') cancelHold();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [cancelHold]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best effort (older browsers); the hold still works without it.
    }
    pointerIdRef.current = event.pointerId;
    beginHold();
  };

  const endPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current) return;
    cancelHold();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) beginHold();
  };

  const onKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    cancelHold();
  };

  const holding = feedback === 'holding';
  const progress = holdProgress(elapsed);

  return (
    <div className="space-y-2">
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-describedby={describedById}
        data-testid="sos-hold-button"
        data-holding={holding ? 'true' : 'false'}
        onPointerDown={onPointerDown}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
        onLostPointerCapture={endPointer}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={cancelHold}
        onContextMenu={(event) => event.preventDefault()}
        style={{ WebkitTouchCallout: 'none' }}
        className="relative flex min-h-24 w-full touch-none select-none items-center justify-center overflow-hidden rounded-xl border-2 border-ee-on-danger/40 bg-ee-sos px-4 py-5 text-ee-on-danger disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-full origin-left bg-ee-on-danger/30 motion-reduce:hidden"
          style={{ transform: `scaleX(${progress})` }}
        />
        <span className="relative flex items-center gap-3 font-display text-2xl font-bold uppercase tracking-wide">
          <Siren className="h-7 w-7 shrink-0" aria-hidden="true" />
          {t('incident.sos.hold')}
        </span>
      </button>
      {/* Visual countdown (updates every frame, so it is not a live region). */}
      <p
        aria-hidden="true"
        className="min-h-6 text-center text-base font-semibold text-ee-text"
        data-testid="sos-hold-countdown"
      >
        {holding
          ? t('incident.sos.holding', holdSecondsLeft(elapsed))
          : feedback === 'released_early'
            ? t('incident.sos.released')
            : ''}
      </p>
      {/* Screen-reader announcements: once when the hold starts, once when it is released early. */}
      <p className="sr-only" aria-live="polite">
        {holding ? t('incident.sos.holdStarted') : feedback === 'released_early' ? t('incident.sos.released') : ''}
      </p>
    </div>
  );
});
