/**
 * Fake Web NFC for browser tests (desktop Chromium has no NDEFReader).
 *
 * installFakeNfc(page) injects, before any app script runs, a `window.NDEFReader` that behaves
 * like Chrome on Android from the page's point of view:
 *   - scan({ signal }) resolves once "listening"; aborting the signal stops the reader;
 *   - permission 'granted' | 'prompt' | 'denied' (prompt: scan() needs a user gesture — like
 *     Chrome, a scan() started outside a tap is rejected with NotAllowedError);
 *   - readings are delivered to `onreading` AND 'reading' listeners with serialNumber + message.
 * Test hooks on window.__eeFakeNfc (driven from Node with the helpers below):
 *   tap(serial, records) · tapEmptySerial() · readingError() · failNextScan(name, message)
 *   setPermission(state) · activeReaders() · scanCalls() · log()
 * The fake never invents serials: a test passes the exact serial the "tag" has.
 * The in-page code lives in fakeNfc.browser.js (plain JavaScript, injected as text).
 * Note: Playwright's page.evaluate() runs WITH a user gesture; to exercise the "scan() without a
 * tap" rule, the scan must be started by app code running on its own (e.g. on mount).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

export interface FakeNfcOptions {
  /** false: no NDEFReader at all (browser without Web NFC). Default true. */
  supported?: boolean;
  permission?: 'granted' | 'prompt' | 'denied';
  /** Delay before scan() resolves (permission prompt / radio start-up). */
  scanDelayMs?: number;
}

export interface FakeNdefRecordInit {
  recordType: 'text' | 'url' | 'absolute-url' | 'mime' | 'empty' | 'unknown' | string;
  /** String data is UTF-8 encoded; a number array is used as raw bytes. */
  data?: string | number[];
  mediaType?: string;
  id?: string;
  encoding?: string;
  lang?: string;
}

export type NfcScanErrorName = 'NotAllowedError' | 'NotSupportedError' | 'NotReadableError' | 'AbortError' | 'SecurityError' | 'NetworkError';

interface FakeNfcHandle {
  tap(serial: string, records?: FakeNdefRecordInit[]): number;
  tapEmptySerial(records?: FakeNdefRecordInit[]): number;
  readingError(): number;
  failNextScan(name: string, message?: string): void;
  setPermission(state: 'granted' | 'prompt' | 'denied'): void;
  activeReaders(): number;
  scanCalls(): number;
  log(): Array<Record<string, unknown>>;
}

type WindowWithFakeNfc = { __eeFakeNfc?: FakeNfcHandle };

/** The in-page fake (plain JavaScript read as text: no transform can alter what the page runs). */
const FAKE_NFC_SOURCE_FILE = path.join(__dirname, 'fakeNfc.browser.js');
let cachedSource: string | null = null;

function fakeNfcSource(): string {
  cachedSource ??= readFileSync(FAKE_NFC_SOURCE_FILE, 'utf8');
  return cachedSource;
}

/** The init script for `options` (exported for the helper self-test). */
export function fakeNfcInitScript(options: FakeNfcOptions = {}): string {
  return `${fakeNfcSource()}\nwindow.__eeInstallFakeNfc(${JSON.stringify(options)});\n`;
}

/** Must be called before page.goto(): the fake is installed by an init script. */
export async function installFakeNfc(page: Page, options: FakeNfcOptions = {}): Promise<void> {
  await page.addInitScript({ content: fakeNfcInitScript(options) });
}

/** Waits until the page has a listening reader (the guard tapped "Start NFC"). */
export async function waitForNfcScanning(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.waitForFunction(() => ((window as unknown as WindowWithFakeNfc).__eeFakeNfc?.activeReaders() ?? 0) > 0, undefined, {
    timeout: timeoutMs
  });
}

/** Holds a tag with `serial` to the phone. Returns how many readers received it. */
export function nfcTap(page: Page, serial: string, records: FakeNdefRecordInit[] = []): Promise<number> {
  return page.evaluate(
    ([s, r]) => {
      const h = (window as unknown as WindowWithFakeNfc).__eeFakeNfc;
      if (!h) throw new Error('Fake NFC is not installed (call installFakeNfc before page.goto)');
      return h.tap(s, r);
    },
    [serial, records] as [string, FakeNdefRecordInit[]]
  );
}

/** A tag whose serial the phone does not report (empty serialNumber). */
export function nfcTapEmptySerial(page: Page): Promise<number> {
  return nfcTap(page, '');
}

/** The tag was removed too quickly / is unreadable (onreadingerror). */
export function nfcReadingError(page: Page): Promise<number> {
  return page.evaluate(() => {
    const h = (window as unknown as WindowWithFakeNfc).__eeFakeNfc;
    if (!h) throw new Error('Fake NFC is not installed (call installFakeNfc before page.goto)');
    return h.readingError();
  });
}

/** The next scan() rejects with this DOMException (NotAllowedError, NotReadableError = NFC off, ...). */
export function nfcFailNextScan(page: Page, name: NfcScanErrorName, message?: string): Promise<void> {
  return page.evaluate(
    ([n, m]) => {
      const h = (window as unknown as WindowWithFakeNfc).__eeFakeNfc;
      if (!h) throw new Error('Fake NFC is not installed (call installFakeNfc before page.goto)');
      h.failNextScan(n, m ?? undefined);
    },
    [name, message ?? null] as [string, string | null]
  );
}

export function nfcSetPermission(page: Page, state: 'granted' | 'prompt' | 'denied'): Promise<void> {
  return page.evaluate((next) => {
    const h = (window as unknown as WindowWithFakeNfc).__eeFakeNfc;
    if (!h) throw new Error('Fake NFC is not installed (call installFakeNfc before page.goto)');
    h.setPermission(next);
  }, state);
}

export function nfcActiveReaders(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as WindowWithFakeNfc).__eeFakeNfc?.activeReaders() ?? 0);
}

export function nfcScanCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as WindowWithFakeNfc).__eeFakeNfc?.scanCalls() ?? 0);
}

export function nfcLog(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => (window as unknown as WindowWithFakeNfc).__eeFakeNfc?.log() ?? []);
}
