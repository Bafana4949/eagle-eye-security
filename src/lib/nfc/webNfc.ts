/**
 * Web NFC (Chrome for Android) wrapper for checkpoint tags.
 *
 * Field hardware: Shanghai Fudan Microelectronics tags, ISO/IEC 14443-A, NfcA + Ndef,
 * 7-byte UID, ATQA 0x4400, SAK 0x00 (NFC Forum Type 2 / NTAG-class). Chrome reports the
 * UID in NDEFReadingEvent.serialNumber as lower-case hex bytes joined by ':'
 * (e.g. '04:a2:3b:1c:5d:80:00'). For some tag/phone combinations the serial is ''.
 *
 * Rules enforced here:
 * - A serial is NEVER fabricated. An empty serial is reported as the 'empty_serial' error.
 * - One NDEFReader per scan session, started with an AbortSignal; stop() aborts it and
 *   suppresses every later callback, so unmounted pages cannot record scans.
 * - The same tag is reported at most once per DEDUPE window (a tag resting on the phone
 *   fires repeated readings).
 * - Record decoding never throws; unknown record types report recordType + byteLength only.
 * - startNfcScan() MUST be called directly from a click/tap handler: while the NFC permission
 *   is still 'prompt', Chrome rejects scan() without a user gesture (NotAllowedError). That case
 *   is reported as 'needs_user_gesture', not as a denied permission.
 *
 * Nothing in this module has been exercised against a physical Fudan tag; the unit tests
 * drive it with a fake NDEFReader. Field-test with the real tags before go-live.
 */

/** Same-serial readings inside this window are treated as one tap. */
export const NFC_DEDUPE_WINDOW_MS = 1500;

/** Plausible UID sizes: 4-byte (single), 7-byte (double, Fudan/NTAG) and 10-byte (triple) UIDs. */
const MIN_UID_BYTES = 4;
const MAX_UID_BYTES = 10;

export type NfcSupport = 'supported' | 'ios' | 'insecure_context' | 'iframe' | 'unsupported_browser';

export type NfcErrorKind =
  | 'permission_denied'
  | 'needs_user_gesture'
  | 'no_hardware'
  | 'nfc_disabled'
  | 'cancelled'
  | 'read_failed'
  | 'empty_serial'
  | 'invalid_serial'
  | 'insecure_context'
  | 'unsupported'
  | 'unknown';

export interface DecodedNdefRecord {
  recordType: string;
  mediaType: string | null;
  id: string | null;
  encoding: string | null;
  lang: string | null;
  /** Decoded text for text / url / absolute-url records and textual MIME records; otherwise null. */
  text: string | null;
  byteLength: number;
}

export interface NfcReading {
  /** Normalised UID (see normalizeNfcSerial); identical to what the database stores. */
  serial: string;
  /** Exactly what the browser reported. */
  serialRaw: string;
  records: DecodedNdefRecord[];
  /** Epoch ms when the reading was received. */
  timestamp: number;
}

/** Structural subset of the Web NFC NDEFRecord interface. */
export interface NdefRecordLike {
  recordType: string;
  mediaType?: string | null;
  id?: string | null;
  encoding?: string | null;
  lang?: string | null;
  data?: DataView | null;
}

/** Structural subset of NDEFReadingEvent. */
export interface NdefReadingEventLike {
  serialNumber?: string | null;
  message?: { records?: ReadonlyArray<NdefRecordLike> | null } | null;
}

/** Structural subset of NDEFReader (only what this module uses). */
export interface NdefReaderLike {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((event: NdefReadingEventLike) => void) | null;
  onreadingerror: ((event: unknown) => void) | null;
}

export type NdefReaderConstructor = new () => NdefReaderLike;

export interface NfcEnvironment {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  isSecureContext: boolean;
  hasNdefReader: boolean;
  isTopLevel: boolean;
}

export interface StartNfcScanOptions {
  /** Aborting this signal stops the scan (same as calling stop()). */
  signal?: AbortSignal;
  onReading: (reading: NfcReading) => void;
  onError: (kind: NfcErrorKind, message: string) => void;
  /** Called once the browser has granted permission and the reader is listening. */
  onStarted?: () => void;
  /** Test/advanced injection: reader constructor. Defaults to window.NDEFReader. */
  readerConstructor?: NdefReaderConstructor;
  /** Injectable clock (tests). */
  now?: () => number;
  dedupeWindowMs?: number;
  /**
   * Test injection: the NFC permission state ('granted' | 'denied' | 'prompt'), or null when it
   * cannot be read. Defaults to navigator.permissions.query({ name: 'nfc' }).
   */
  queryNfcPermission?: () => Promise<string | null>;
}

export interface NfcScanSession {
  /** Aborts the reader. After stop() no onReading/onError callback fires. Idempotent. */
  stop: () => void;
  /** Resolves true once scanning is active, false if it failed to start or was stopped first. */
  started: Promise<boolean>;
}

/**
 * Normalises an NFC UID to lower-case hex byte pairs joined by ':'.
 * Must stay byte-for-byte identical to the SQL trigger that normalises checkpoints.nfc_uid:
 *   1. strip every character that is not [0-9a-fA-F]
 *   2. lower-case
 *   3. reject when empty, odd length, fewer than 4 bytes or more than 10 bytes (returns null)
 *   4. join byte pairs with ':'
 */
export function normalizeNfcSerial(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const hex = input.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = hex.length / 2;
  if (bytes < MIN_UID_BYTES || bytes > MAX_UID_BYTES) return null;
  const pairs: string[] = [];
  for (let i = 0; i < hex.length; i += 2) pairs.push(hex.slice(i, i + 2));
  return pairs.join(':');
}

function readEnvironment(): NfcEnvironment | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  let isTopLevel = true;
  try {
    isTopLevel = window.top === window.self;
  } catch {
    // Cross-origin parent: accessing window.top throws, which also means we are framed.
    isTopLevel = false;
  }
  return {
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    maxTouchPoints: navigator.maxTouchPoints || 0,
    isSecureContext: window.isSecureContext === true,
    hasNdefReader: 'NDEFReader' in window,
    isTopLevel
  };
}

/**
 * Reports whether Web NFC can be used here. Order matches the reference app:
 * iOS (no Web NFC at all) → insecure context (NDEFReader is [SecureContext]) → browser
 * without NDEFReader → embedded iframe (Web NFC is top-level only).
 */
export function getNfcSupport(env: NfcEnvironment | null = readEnvironment()): NfcSupport {
  if (!env) return 'unsupported_browser';
  const isIos =
    /iPhone|iPad|iPod/.test(env.userAgent) || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);
  if (isIos) return 'ios';
  if (!env.isSecureContext) return 'insecure_context';
  if (!env.hasNdefReader) return 'unsupported_browser';
  if (!env.isTopLevel) return 'iframe';
  return 'supported';
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return '';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** Maps a scan() rejection (DOMException) to an NfcErrorKind. */
export function mapNfcScanError(error: unknown, isSecureContext: boolean = true): NfcErrorKind {
  switch (errorName(error)) {
    case 'NotAllowedError':
      return 'permission_denied';
    case 'NotSupportedError':
      return 'no_hardware';
    case 'NotReadableError':
      return 'nfc_disabled';
    case 'AbortError':
      return 'cancelled';
    case 'SecurityError':
      return isSecureContext ? 'permission_denied' : 'insecure_context';
    default:
      return 'unknown';
  }
}

/** Reads the NFC permission state; null when the Permissions API cannot tell. Never throws. */
async function defaultQueryNfcPermission(): Promise<string | null> {
  try {
    if (typeof navigator === 'undefined') return null;
    const permissions = (navigator as { permissions?: { query(d: { name: string }): Promise<{ state: string }> } })
      .permissions;
    if (!permissions || typeof permissions.query !== 'function') return null;
    const status = await permissions.query({ name: 'nfc' });
    return typeof status?.state === 'string' ? status.state : null;
  } catch {
    return null;
  }
}

/**
 * Refines a NotAllowedError from scan(): while the permission is still 'prompt' the browser
 * refused only because scan() was not started from a tap (no prompt was shown), so the guard
 * must tap "Start NFC" – telling them NFC was denied would send them to site settings for
 * nothing. Other errors keep mapNfcScanError's kind.
 */
export async function classifyNfcScanError(
  error: unknown,
  isSecureContext: boolean = true,
  queryNfcPermission: () => Promise<string | null> = defaultQueryNfcPermission
): Promise<NfcErrorKind> {
  const kind = mapNfcScanError(error, isSecureContext);
  if (kind !== 'permission_denied' || errorName(error) !== 'NotAllowedError') return kind;
  let state: string | null = null;
  try {
    state = await queryNfcPermission();
  } catch {
    state = null;
  }
  return state === 'prompt' ? 'needs_user_gesture' : 'permission_denied';
}

const NEEDS_GESTURE_MESSAGE = 'Tap “Start NFC” to allow NFC scanning, then hold the phone against the tag.';

const TEXTUAL_MIME = /^(text\/|application\/(json|xml|[\w.+-]+\+(json|xml))$)/i;

function decodeText(data: DataView, encoding: string | null | undefined): string | null {
  const label = encoding && encoding.trim() ? encoding.trim() : 'utf-8';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    // Unknown encoding label: fall back to UTF-8 rather than failing the whole reading.
    try {
      return new TextDecoder('utf-8').decode(data);
    } catch {
      return null;
    }
  }
}

/** Decodes one NDEF record defensively. Never throws. */
export function decodeNdefRecord(record: NdefRecordLike): DecodedNdefRecord {
  const recordType = typeof record?.recordType === 'string' ? record.recordType : 'unknown';
  const data = record?.data instanceof DataView ? record.data : null;
  const decoded: DecodedNdefRecord = {
    recordType,
    mediaType: typeof record?.mediaType === 'string' ? record.mediaType : null,
    id: typeof record?.id === 'string' && record.id !== '' ? record.id : null,
    encoding: typeof record?.encoding === 'string' ? record.encoding : null,
    lang: typeof record?.lang === 'string' ? record.lang : null,
    text: null,
    byteLength: data ? data.byteLength : 0
  };
  if (!data) return decoded;

  try {
    if (recordType === 'text') {
      decoded.text = decodeText(data, decoded.encoding);
    } else if (recordType === 'url' || recordType === 'absolute-url') {
      decoded.text = decodeText(data, 'utf-8');
    } else if (recordType === 'mime' && decoded.mediaType && TEXTUAL_MIME.test(decoded.mediaType)) {
      decoded.text = decodeText(data, 'utf-8');
    }
  } catch {
    decoded.text = null;
  }
  return decoded;
}

function decodeRecords(event: NdefReadingEventLike): DecodedNdefRecord[] {
  try {
    const records = event?.message?.records;
    if (!records) return [];
    return Array.from(records, (record) => decodeNdefRecord(record));
  } catch {
    return [];
  }
}

function resolveReaderConstructor(): NdefReaderConstructor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as unknown as { NDEFReader?: NdefReaderConstructor }).NDEFReader;
  return typeof ctor === 'function' ? ctor : null;
}

const SUPPORT_MESSAGES: Record<Exclude<NfcSupport, 'supported'>, string> = {
  ios: 'Web NFC is not available on iPhone/iPad. Scan the checkpoint QR card instead.',
  insecure_context: 'NFC needs a secure (https) connection. Open the app from its https link.',
  unsupported_browser: 'This browser does not support Web NFC. Use Chrome on Android, or scan the QR card.',
  iframe: 'NFC cannot run inside an embedded frame. Open the app directly in Chrome.'
};

/**
 * Starts one Web NFC scan session. Call it synchronously from the guard's click/tap handler
 * (e.g. the "Start NFC" button): the permission prompt needs that user gesture, and scan() is
 * invoked before the first await so the gesture is not lost. The caller must keep the returned
 * session and call stop() on unmount, after a successful enrolment and before starting another
 * session.
 */
export function startNfcScan(options: StartNfcScanOptions): NfcScanSession {
  const now = options.now ?? (() => Date.now());
  const dedupeWindowMs = options.dedupeWindowMs ?? NFC_DEDUPE_WINDOW_MS;
  const controller = new AbortController();
  let stopped = false;
  let lastKey: string | null = null;
  let lastAt = -Infinity;

  const externalSignal = options.signal;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    externalSignal?.removeEventListener('abort', onExternalAbort);
  };
  function onExternalAbort() {
    stop();
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      stop();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const emitError = (kind: NfcErrorKind, message: string) => {
    if (stopped) return;
    try {
      options.onError(kind, message);
    } catch {
      // A throwing UI callback must not break the reader.
    }
  };

  // Repeated readings of the same tag (or repeated empty serials) inside the window are one tap.
  const isDuplicate = (key: string, at: number): boolean => {
    if (key === lastKey && at - lastAt < dedupeWindowMs) return true;
    lastKey = key;
    lastAt = at;
    return false;
  };

  const started = (async (): Promise<boolean> => {
    if (stopped) return false;

    let Reader = options.readerConstructor ?? null;
    if (!Reader) {
      const support = getNfcSupport();
      if (support !== 'supported') {
        emitError(support === 'insecure_context' ? 'insecure_context' : 'unsupported', SUPPORT_MESSAGES[support]);
        return false;
      }
      Reader = resolveReaderConstructor();
      if (!Reader) {
        emitError('unsupported', SUPPORT_MESSAGES.unsupported_browser);
        return false;
      }
    }

    let reader: NdefReaderLike;
    try {
      reader = new Reader();
    } catch (error) {
      emitError('unknown', `Could not create NFC reader: ${errorMessage(error)}`);
      return false;
    }

    reader.onreading = (event: NdefReadingEventLike) => {
      if (stopped) return;
      const timestamp = now();
      const serialRaw = typeof event?.serialNumber === 'string' ? event.serialNumber : '';

      if (serialRaw.trim() === '') {
        if (isDuplicate('', timestamp)) return;
        emitError(
          'empty_serial',
          'The tag was read but the phone did not report its serial number. This tag cannot be used for NFC check-in on this phone; use the QR card.'
        );
        return;
      }

      const serial = normalizeNfcSerial(serialRaw);
      if (!serial) {
        if (isDuplicate(`raw:${serialRaw}`, timestamp)) return;
        emitError('invalid_serial', `Unrecognised tag serial format (${serialRaw.length} characters).`);
        return;
      }

      if (isDuplicate(serial, timestamp)) return;
      const reading: NfcReading = { serial, serialRaw, records: decodeRecords(event), timestamp };
      try {
        options.onReading(reading);
      } catch {
        // UI callback errors are the caller's responsibility; keep the reader alive.
      }
    };

    reader.onreadingerror = () => {
      emitError('read_failed', 'The tag could not be read. Hold the phone still against the tag and try again.');
    };

    try {
      await reader.scan({ signal: controller.signal });
    } catch (error) {
      if (stopped) return false;
      const secure = typeof window === 'undefined' ? true : window.isSecureContext === true;
      const kind = await classifyNfcScanError(error, secure, options.queryNfcPermission);
      if (stopped) return false;
      emitError(kind, kind === 'needs_user_gesture' ? NEEDS_GESTURE_MESSAGE : errorMessage(error));
      stop();
      return false;
    }

    if (stopped) return false;
    try {
      options.onStarted?.();
    } catch {
      // ignore UI callback failure
    }
    return true;
  })();

  return { stop, started };
}
