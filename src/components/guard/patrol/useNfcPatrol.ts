'use client';

/**
 * One Web NFC scan session for the patrol screen.
 *
 * - start() must be called directly from the "Start NFC patrol" tap (Chrome needs the user
 *   gesture for the permission prompt); it never creates a second reader while one is running.
 * - The session is stopped when the guard taps Stop, when the page is hidden (Chrome does not
 *   deliver NFC readings to hidden pages anyway) and when the component unmounts.
 * - After the page becomes visible again the session is resumed automatically only when the NFC
 *   permission is already 'granted'; otherwise the guard is asked to tap Start again.
 * - Readings go to the latest onReading callback (kept in a ref), so a long-running reader
 *   never uses stale page state.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getNfcSupport,
  startNfcScan,
  type NfcErrorKind,
  type NfcReading,
  type NfcScanSession,
  type NfcSupport
} from '@/lib/nfc/webNfc';

export type NfcUiState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'listening' }
  /** Stopped because the guard left the app (screen off, other app). */
  | { status: 'paused' }
  /** The reader could not start or stopped with an error; the guard must act (see kind). */
  | { status: 'error'; kind: NfcErrorKind; message: string };

/** Problems with one reading while the reader keeps listening. */
export type NfcReadIssue = { kind: Extract<NfcErrorKind, 'read_failed' | 'empty_serial' | 'invalid_serial'>; seq: number };

const READ_ISSUES: ReadonlySet<NfcErrorKind> = new Set<NfcErrorKind>(['read_failed', 'empty_serial', 'invalid_serial']);

const noopSubscribe = () => () => undefined;
const serverSupport = (): NfcSupport | null => null;

async function nfcPermissionState(): Promise<string | null> {
  try {
    const permissions = (navigator as { permissions?: { query(d: { name: string }): Promise<{ state: string }> } })
      .permissions;
    if (!permissions || typeof permissions.query !== 'function') return null;
    const status = await permissions.query({ name: 'nfc' });
    return typeof status?.state === 'string' ? status.state : null;
  } catch {
    return null;
  }
}

export interface NfcPatrolControls {
  /** null while rendering on the server / before hydration. */
  support: NfcSupport | null;
  state: NfcUiState;
  readIssue: NfcReadIssue | null;
  start: () => void;
  stop: () => void;
}

export function useNfcPatrol(onReading: (reading: NfcReading) => void): NfcPatrolControls {
  const support = useSyncExternalStore(noopSubscribe, getNfcSupport, serverSupport);
  const [state, setState] = useState<NfcUiState>({ status: 'idle' });
  const [readIssue, setReadIssue] = useState<NfcReadIssue | null>(null);

  const onReadingRef = useRef(onReading);
  useEffect(() => {
    onReadingRef.current = onReading;
  });

  /** Identifies the current session; callbacks of an older session are ignored. */
  const tokenRef = useRef<object | null>(null);
  const sessionRef = useRef<NfcScanSession | null>(null);
  const resumeOnVisibleRef = useRef(false);
  const issueSeqRef = useRef(0);

  const release = useCallback(() => {
    tokenRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.stop();
  }, []);

  const start = useCallback(() => {
    if (tokenRef.current) return; // a session is starting or running: never a second reader
    const token = {};
    tokenRef.current = token;
    resumeOnVisibleRef.current = false;
    const isCurrent = () => tokenRef.current === token;
    setReadIssue(null);
    setState({ status: 'starting' });

    // Called synchronously from the tap handler: scan() runs before startNfcScan's first await.
    const session = startNfcScan({
      onReading: (reading) => {
        if (!isCurrent()) return;
        setReadIssue(null);
        onReadingRef.current(reading);
      },
      onError: (kind, message) => {
        if (!isCurrent()) return;
        if (READ_ISSUES.has(kind)) {
          issueSeqRef.current += 1;
          setReadIssue({ kind: kind as NfcReadIssue['kind'], seq: issueSeqRef.current });
          return;
        }
        // Start-up failure (or the reader was aborted): the session is over.
        tokenRef.current = null;
        sessionRef.current?.stop();
        sessionRef.current = null;
        setState(kind === 'cancelled' ? { status: 'idle' } : { status: 'error', kind, message });
      },
      onStarted: () => {
        if (isCurrent()) setState({ status: 'listening' });
      }
    });
    if (isCurrent()) {
      sessionRef.current = session;
      void session.started.then((ok) => {
        if (!ok && isCurrent()) {
          release();
          setState((prev) => (prev.status === 'error' ? prev : { status: 'idle' }));
        }
      });
    } else {
      session.stop();
    }
  }, [release]);

  const stop = useCallback(() => {
    resumeOnVisibleRef.current = false;
    release();
    setReadIssue(null);
    setState({ status: 'idle' });
  }, [release]);

  useEffect(() => {
    const onHidden = () => {
      if (!tokenRef.current) return;
      release();
      resumeOnVisibleRef.current = true;
      setReadIssue(null);
      setState({ status: 'paused' });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        onHidden();
        return;
      }
      if (!resumeOnVisibleRef.current || tokenRef.current) return;
      // Resume without a tap only when Chrome will not need to show a permission prompt.
      void nfcPermissionState().then((permission) => {
        if (permission === 'granted' && resumeOnVisibleRef.current && !tokenRef.current && document.visibilityState === 'visible') {
          start();
        }
      });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHidden);
      resumeOnVisibleRef.current = false;
      release();
    };
  }, [release, start]);

  return { support, state, readIssue, start, stop };
}
