'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { I18nProvider, useTranslation } from '@/lib/i18n/context';
import { Button } from '@/components/ui/button';

/** Build version inlined by next.config.ts (generateBuildId / env). */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '';
const SW_PATH = '/sw.js';
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Response header set by next.config.ts on every route; tells us which build the server runs now. */
const SERVER_VERSION_HEADER = 'x-app-version';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
/** If the new worker never takes control (e.g. it was replaced by an even newer one), reload anyway. */
const RELOAD_SAFETY_MS = 10 * 1000;

type UpdateState = 'none' | 'waiting' | 'reloading' | 'applied_elsewhere';

export function serviceWorkerUrl(version: string): string {
  const v = VERSION_PATTERN.test(version) ? version : 'unversioned';
  return `${SW_PATH}?v=${encodeURIComponent(v)}`;
}

export function versionOfWorker(worker: ServiceWorker | null | undefined): string | null {
  if (!worker) return null;
  try {
    return new URL(worker.scriptURL).searchParams.get('v');
  } catch {
    return null;
  }
}

function registrationRunsVersion(reg: ServiceWorkerRegistration, version: string): boolean {
  return [reg.installing, reg.waiting, reg.active].some((w) => versionOfWorker(w) === version);
}

/**
 * Registers the service worker (production builds, secure contexts only) and shows an accessible
 * "Update available — Reload" banner when a new build is installed and waiting. The worker never
 * activates itself: the banner posts {type: 'SKIP_WAITING'} and the page reloads once the new worker
 * has taken control. Updates are checked on load, every 30 minutes, when the app comes back to the
 * foreground and when the phone comes back online, so a guard cannot stay on an obsolete build.
 */
export function PwaRegistrar() {
  const [state, setState] = useState<UpdateState>('none');
  const [dismissed, setDismissed] = useState(false);
  // Remounts the banner's language provider each time it opens, so it follows the latest language choice.
  const [openCount, setOpenCount] = useState(0);
  const waitingRef = useRef<ServiceWorker | null>(null);
  const reloadRequestedRef = useRef(false);
  const reloadedRef = useRef(false);
  // Mirrors of render state for the event handlers below (updated after each render).
  const stateRef = useRef<UpdateState>('none');
  const visibleRef = useRef(false);

  const visible = state !== 'none' && !dismissed;
  useEffect(() => {
    stateRef.current = state;
    visibleRef.current = visible;
  }, [state, visible]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const sw = navigator.serviceWorker;

    if (process.env.NODE_ENV !== 'production') {
      // A worker left over from a production build on this origin would serve stale pages in dev.
      void removeEagleEyeWorkers();
      return;
    }
    if (!window.isSecureContext) return;

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    let lastCheckAt = 0;
    let previousController = sw.controller;
    const watched = new WeakSet<ServiceWorkerRegistration>();

    const showBanner = (next: 'waiting' | 'applied_elsewhere') => {
      if (disposed || stateRef.current === 'reloading') return;
      if (!visibleRef.current || stateRef.current !== next) setOpenCount((c) => c + 1);
      stateRef.current = next;
      visibleRef.current = true;
      setDismissed(false);
      setState(next);
    };

    const showWaiting = (reg: ServiceWorkerRegistration, worker: ServiceWorker | null) => {
      // Without an active worker this is the very first install: nothing to update.
      if (disposed || !worker || !reg.active) return;
      waitingRef.current = worker;
      showBanner('waiting');
    };

    const watch = (reg: ServiceWorkerRegistration) => {
      if (watched.has(reg)) return;
      watched.add(reg);
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') showWaiting(reg, reg.waiting ?? installing);
        });
      });
    };

    const register = async (version: string) => {
      const reg = await sw.register(serviceWorkerUrl(version), { scope: '/', updateViaCache: 'none' });
      registration = reg;
      watch(reg);
      if (reg.waiting) showWaiting(reg, reg.waiting);
      return reg;
    };

    const checkForUpdate = async (force = false) => {
      const reg = registration;
      if (disposed || !reg) return;
      const now = Date.now();
      if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) return;
      lastCheckAt = now;

      // A waiting worker the guard postponed with "Later": show the banner again.
      if (reg.waiting) showWaiting(reg, reg.waiting);
      if (navigator.onLine === false) return;

      try {
        await reg.update();
      } catch {
        // Offline or server unreachable: the next check tries again.
      }
      // /sw.js is byte-identical between builds, so also ask the server which build it runs now.
      // HEAD requests are not handled by the service worker, so this reaches the server.
      try {
        const res = await fetch('/manifest.json', { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
        const serverVersion = res.ok ? res.headers.get(SERVER_VERSION_HEADER)?.trim() : null;
        if (
          serverVersion &&
          VERSION_PATTERN.test(serverVersion) &&
          serverVersion !== APP_VERSION &&
          !registrationRunsVersion(reg, serverVersion)
        ) {
          await register(serverVersion);
        }
      } catch {
        // Offline: try again later.
      }
    };

    const onControllerChange = () => {
      const hadController = previousController !== null;
      previousController = sw.controller;
      if (reloadRequestedRef.current) {
        if (!reloadedRef.current) {
          reloadedRef.current = true;
          window.location.reload();
        }
        return;
      }
      // Another tab activated the update; this tab still runs the old code.
      if (hadController) showBanner('applied_elsewhere');
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkForUpdate();
    };
    const onOnline = () => void checkForUpdate();

    sw.addEventListener('controllerchange', onControllerChange);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);

    register(APP_VERSION)
      .then(() => checkForUpdate(true))
      .catch(() => {
        // Registration failed (e.g. private mode or blocked storage): the app still works online.
      });

    return () => {
      disposed = true;
      sw.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (state !== 'reloading') return;
    const timer = window.setTimeout(() => {
      if (!reloadedRef.current) {
        reloadedRef.current = true;
        window.location.reload();
      }
    }, RELOAD_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const applyUpdate = () => {
    const worker = waitingRef.current;
    if (state === 'applied_elsewhere' || !worker || worker.state === 'redundant') {
      reloadedRef.current = true;
      window.location.reload();
      return;
    }
    reloadRequestedRef.current = true;
    stateRef.current = 'reloading';
    setState('reloading');
    worker.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <>
      {/* Always mounted so the announcement is read when the text appears. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="pwa-update-status">
        {visible && (
          <I18nProvider key={openCount}>
            <UpdateAnnouncement state={state} />
          </I18nProvider>
        )}
      </div>
      {visible && (
        <I18nProvider key={openCount}>
          <UpdateBanner state={state} onReload={applyUpdate} onLater={() => setDismissed(true)} />
        </I18nProvider>
      )}
    </>
  );
}

function UpdateAnnouncement({ state }: { state: UpdateState }) {
  const { t } = useTranslation();
  return <>{state === 'applied_elsewhere' ? t('pwaUpdateAppliedElsewhere') : t('pwaUpdateAnnouncement')}</>;
}

function UpdateBanner({
  state,
  onReload,
  onLater,
}: {
  state: UpdateState;
  onReload: () => void;
  onLater: () => void;
}) {
  const { t } = useTranslation();
  const reloading = state === 'reloading';
  return (
    <section
      aria-labelledby="pwa-update-title"
      data-testid="pwa-update-banner"
      className="fixed inset-x-0 top-0 z-40 border-b-2 border-ee-primary bg-ee-surface pt-[env(safe-area-inset-top)] text-ee-text"
    >
      <div className="mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <RefreshCw aria-hidden="true" className="size-5 shrink-0 text-ee-primary" />
        <div className="min-w-0 flex-1">
          <h2 id="pwa-update-title" className="font-display text-lg font-semibold leading-tight">
            {t('pwaUpdateAvailable')}
          </h2>
          <p className="text-sm text-ee-muted">
            {state === 'applied_elsewhere' ? t('pwaUpdateAppliedElsewhere') : t('pwaUpdateHint')}
          </p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          {!reloading && (
            <Button
              type="button"
              variant="ghost"
              size="md"
              className="flex-1 sm:flex-none"
              onClick={onLater}
              data-testid="pwa-update-later"
            >
              {t('pwaUpdateLater')}
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            size="md"
            className="flex-1 sm:flex-none"
            onClick={onReload}
            isLoading={reloading}
            data-testid="pwa-update-reload"
          >
            {reloading ? t('pwaUpdateReloading') : t('pwaUpdateReload')}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Development only: unregister Eagle Eye workers and delete their caches on this origin. */
async function removeEagleEyeWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs
        .filter((reg) =>
          [reg.active, reg.waiting, reg.installing].some((w) => {
            if (!w) return false;
            try {
              return new URL(w.scriptURL).pathname === SW_PATH;
            } catch {
              return false;
            }
          })
        )
        .map((reg) => reg.unregister())
    );
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('ee-')).map((k) => caches.delete(k)));
    }
  } catch {
    // Nothing to clean up.
  }
}
