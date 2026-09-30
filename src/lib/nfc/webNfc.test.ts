import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  NFC_DEDUPE_WINDOW_MS,
  classifyNfcScanError,
  decodeNdefRecord,
  getNfcSupport,
  mapNfcScanError,
  normalizeNfcSerial,
  startNfcScan,
  type NdefReaderLike,
  type NdefReadingEventLike,
  type NfcEnvironment,
  type NfcErrorKind,
  type NfcReading
} from './webNfc';

// A fake NDEFReader that behaves like Chrome's: scan() resolves (or rejects) and readings are
// delivered through onreading / onreadingerror. Instances are recorded for inspection.
class FakeReader implements NdefReaderLike {
  static instances: FakeReader[] = [];
  static scanBehaviour: () => Promise<void> = () => Promise.resolve();
  onreading: ((event: NdefReadingEventLike) => void) | null = null;
  onreadingerror: ((event: unknown) => void) | null = null;
  scanCalls: Array<{ signal?: AbortSignal } | undefined> = [];
  constructor() {
    FakeReader.instances.push(this);
  }
  scan(options?: { signal?: AbortSignal }): Promise<void> {
    this.scanCalls.push(options);
    return FakeReader.scanBehaviour();
  }
  tap(serialNumber: string | null | undefined, records: NdefReadingEventLike['message'] = { records: [] }) {
    this.onreading?.({ serialNumber, message: records });
  }
}

function reset(behaviour: () => Promise<void> = () => Promise.resolve()) {
  FakeReader.instances = [];
  FakeReader.scanBehaviour = behaviour;
}

function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function collect(clock: { t: number }) {
  const readings: NfcReading[] = [];
  const errors: Array<{ kind: NfcErrorKind; message: string }> = [];
  return {
    readings,
    errors,
    options: {
      readerConstructor: FakeReader,
      now: () => clock.t,
      onReading: (r: NfcReading) => readings.push(r),
      onError: (kind: NfcErrorKind, message: string) => errors.push({ kind, message })
    }
  };
}

const utf8 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

describe('normalizeNfcSerial', () => {
  it('normalises the real 7-byte Fudan/NTAG serial format from Chrome', () => {
    assert.strictEqual(normalizeNfcSerial('04:a2:3b:1c:5d:80:00'), '04:a2:3b:1c:5d:80:00');
    assert.strictEqual(normalizeNfcSerial('04:A2:3B:1C:5D:80:00'), '04:a2:3b:1c:5d:80:00');
    assert.strictEqual(normalizeNfcSerial('04A23B1C5D8000'), '04:a2:3b:1c:5d:80:00');
    assert.strictEqual(normalizeNfcSerial(' 04-a2-3b-1c-5d-80-00 '), '04:a2:3b:1c:5d:80:00');
  });

  it('accepts 4-byte and 10-byte UIDs', () => {
    assert.strictEqual(normalizeNfcSerial('04:7A:B2:C1'), '04:7a:b2:c1');
    assert.strictEqual(normalizeNfcSerial('00112233445566778899'), '00:11:22:33:44:55:66:77:88:99');
  });

  it('rejects empty, odd-length and implausible lengths instead of guessing', () => {
    assert.strictEqual(normalizeNfcSerial(''), null);
    assert.strictEqual(normalizeNfcSerial(null), null);
    assert.strictEqual(normalizeNfcSerial(undefined), null);
    assert.strictEqual(normalizeNfcSerial('04:a2:3'), null); // odd
    assert.strictEqual(normalizeNfcSerial('04:a2:3b'), null); // 3 bytes
    assert.strictEqual(normalizeNfcSerial('00112233445566778899aa'), null); // 11 bytes
    assert.strictEqual(normalizeNfcSerial('tag_bbd1b8eb'), null); // the old fabricated format
    assert.strictEqual(normalizeNfcSerial('zz:yy'), null);
  });
});

describe('getNfcSupport', () => {
  const base: NfcEnvironment = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A146P) Chrome/129.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    isSecureContext: true,
    hasNdefReader: true,
    isTopLevel: true
  };

  it('reports supported for Chrome on Android over https', () => {
    assert.strictEqual(getNfcSupport(base), 'supported');
  });
  it('detects iPhone and iPadOS (desktop UA)', () => {
    assert.strictEqual(getNfcSupport({ ...base, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), 'ios');
    assert.strictEqual(
      getNfcSupport({ ...base, userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }),
      'ios'
    );
  });
  it('detects http, missing NDEFReader and iframes', () => {
    assert.strictEqual(getNfcSupport({ ...base, isSecureContext: false, hasNdefReader: false }), 'insecure_context');
    assert.strictEqual(getNfcSupport({ ...base, hasNdefReader: false }), 'unsupported_browser');
    assert.strictEqual(getNfcSupport({ ...base, isTopLevel: false }), 'iframe');
  });
  it('is unsupported outside a browser', () => {
    assert.strictEqual(getNfcSupport(null), 'unsupported_browser');
  });
});

describe('mapNfcScanError', () => {
  it('maps each DOMException name', () => {
    assert.strictEqual(mapNfcScanError(domError('NotAllowedError')), 'permission_denied');
    assert.strictEqual(mapNfcScanError(domError('NotSupportedError')), 'no_hardware');
    assert.strictEqual(mapNfcScanError(domError('NotReadableError')), 'nfc_disabled');
    assert.strictEqual(mapNfcScanError(domError('AbortError')), 'cancelled');
    assert.strictEqual(mapNfcScanError(domError('SecurityError'), true), 'permission_denied');
    assert.strictEqual(mapNfcScanError(domError('SecurityError'), false), 'insecure_context');
    assert.strictEqual(mapNfcScanError(domError('InvalidStateError')), 'unknown');
    assert.strictEqual(mapNfcScanError('weird'), 'unknown');
  });

  it('classifyNfcScanError only consults the permission state for NotAllowedError', async () => {
    let queried = 0;
    const prompt = async () => {
      queried++;
      return 'prompt';
    };
    assert.strictEqual(await classifyNfcScanError(domError('NotAllowedError'), true, prompt), 'needs_user_gesture');
    assert.strictEqual(await classifyNfcScanError(domError('NotReadableError'), true, prompt), 'nfc_disabled');
    assert.strictEqual(await classifyNfcScanError(domError('SecurityError'), true, prompt), 'permission_denied');
    assert.strictEqual(queried, 1);
    assert.strictEqual(await classifyNfcScanError(domError('NotAllowedError'), true, async () => 'granted'), 'permission_denied');
  });
});

describe('startNfcScan with a fake NDEFReader', () => {
  it('creates exactly one reader, passes an AbortSignal and reports a normalised reading', async () => {
    reset();
    const clock = { t: 1000 };
    const c = collect(clock);
    let startedCalls = 0;
    const session = startNfcScan({ ...c.options, onStarted: () => startedCalls++ });
    assert.strictEqual(await session.started, true);
    assert.strictEqual(startedCalls, 1);
    assert.strictEqual(FakeReader.instances.length, 1);
    const reader = FakeReader.instances[0];
    assert.strictEqual(reader.scanCalls.length, 1);
    assert.ok(reader.scanCalls[0]?.signal instanceof AbortSignal);

    reader.tap('04:A2:3B:1C:5D:80:00');
    assert.strictEqual(c.readings.length, 1);
    assert.strictEqual(c.readings[0].serial, '04:a2:3b:1c:5d:80:00');
    assert.strictEqual(c.readings[0].serialRaw, '04:A2:3B:1C:5D:80:00');
    assert.strictEqual(c.readings[0].timestamp, 1000);
    assert.deepStrictEqual(c.errors, []);
    session.stop();
  });

  it('dedupes the same tag within the window but not after it, nor different tags', async () => {
    reset();
    const clock = { t: 0 };
    const c = collect(clock);
    const session = startNfcScan(c.options);
    await session.started;
    const reader = FakeReader.instances[0];

    reader.tap('04:a2:3b:1c:5d:80:00');
    clock.t = 500;
    reader.tap('04:A2:3B:1C:5D:80:00'); // same tag, different case → duplicate
    clock.t = NFC_DEDUPE_WINDOW_MS - 1;
    reader.tap('04:a2:3b:1c:5d:80:00');
    assert.strictEqual(c.readings.length, 1);

    clock.t = NFC_DEDUPE_WINDOW_MS - 1 + NFC_DEDUPE_WINDOW_MS;
    reader.tap('04:a2:3b:1c:5d:80:00'); // window elapsed since the last accepted read
    assert.strictEqual(c.readings.length, 2);

    clock.t += 10;
    reader.tap('04:11:22:33:44:55:66'); // different tag → accepted immediately
    assert.strictEqual(c.readings.length, 3);
    assert.strictEqual(c.readings[2].serial, '04:11:22:33:44:55:66');
    session.stop();
  });

  it('never fabricates a serial: empty serial → empty_serial error, no reading', async () => {
    reset();
    const clock = { t: 0 };
    const c = collect(clock);
    const session = startNfcScan(c.options);
    await session.started;
    const reader = FakeReader.instances[0];

    reader.tap('');
    reader.tap(null);
    reader.tap(undefined);
    assert.strictEqual(c.readings.length, 0);
    assert.strictEqual(c.errors.length, 1, 'repeated empty reads inside the window are one error');
    assert.strictEqual(c.errors[0].kind, 'empty_serial');

    clock.t = 5000;
    reader.tap('   ');
    assert.strictEqual(c.errors.length, 2);
    assert.strictEqual(c.errors[1].kind, 'empty_serial');
    session.stop();
  });

  it('reports an unparseable serial as invalid_serial', async () => {
    reset();
    const c = collect({ t: 0 });
    const session = startNfcScan(c.options);
    await session.started;
    FakeReader.instances[0].tap('04:a2:3');
    assert.strictEqual(c.readings.length, 0);
    assert.strictEqual(c.errors[0].kind, 'invalid_serial');
    session.stop();
  });

  for (const [name, kind] of [
    ['NotAllowedError', 'permission_denied'],
    ['NotSupportedError', 'no_hardware'],
    ['NotReadableError', 'nfc_disabled'],
    ['AbortError', 'cancelled'],
    ['SomethingElse', 'unknown']
  ] as const) {
    it(`maps a scan() rejection ${name} → ${kind} and stops the session`, async () => {
      reset(() => Promise.reject(domError(name, `${name} message`)));
      const c = collect({ t: 0 });
      const session = startNfcScan(c.options);
      assert.strictEqual(await session.started, false);
      assert.deepStrictEqual(c.errors, [{ kind, message: `${name} message` }]);
      const signal = FakeReader.instances[0].scanCalls[0]?.signal;
      assert.strictEqual(signal?.aborted, true, 'reader is aborted after a failed start');
      FakeReader.instances[0].tap('04:a2:3b:1c:5d:80:00');
      assert.strictEqual(c.readings.length, 0);
    });
  }

  it('NotAllowedError while the permission is still "prompt" → needs_user_gesture, not denied', async () => {
    reset(() => Promise.reject(domError('NotAllowedError', 'Must be handling a user gesture to show a permission request.')));
    const c = collect({ t: 0 });
    let queried = 0;
    const session = startNfcScan({
      ...c.options,
      queryNfcPermission: async () => {
        queried++;
        return 'prompt';
      }
    });
    assert.strictEqual(await session.started, false);
    assert.strictEqual(queried, 1);
    assert.strictEqual(c.errors.length, 1);
    assert.strictEqual(c.errors[0].kind, 'needs_user_gesture');
    assert.match(c.errors[0].message, /Start NFC/);
  });

  it('NotAllowedError with the permission denied (or unknown) stays permission_denied', async () => {
    for (const state of ['denied', null] as const) {
      reset(() => Promise.reject(domError('NotAllowedError', 'NFC permission request denied.')));
      const c = collect({ t: 0 });
      const session = startNfcScan({ ...c.options, queryNfcPermission: async () => state });
      assert.strictEqual(await session.started, false);
      assert.deepStrictEqual(c.errors, [{ kind: 'permission_denied', message: 'NFC permission request denied.' }]);
    }
    reset(() => Promise.reject(domError('NotAllowedError', 'x')));
    const c = collect({ t: 0 });
    const session = startNfcScan({
      ...c.options,
      queryNfcPermission: async () => {
        throw new TypeError("'nfc' is not a valid PermissionName");
      }
    });
    await session.started;
    assert.strictEqual(c.errors[0].kind, 'permission_denied');
  });

  it('stopping while the permission state is being read reports nothing', async () => {
    reset(() => Promise.reject(domError('NotAllowedError')));
    const c = collect({ t: 0 });
    let release: (s: string) => void = () => undefined;
    const session = startNfcScan({ ...c.options, queryNfcPermission: () => new Promise<string>((r) => (release = r)) });
    await new Promise((resolve) => setImmediate(resolve));
    session.stop();
    release('prompt');
    assert.strictEqual(await session.started, false);
    assert.deepStrictEqual(c.errors, []);
  });

  it('reports onreadingerror (tag removed too quickly) as read_failed and keeps listening', async () => {
    reset();
    const c = collect({ t: 0 });
    const session = startNfcScan(c.options);
    await session.started;
    const reader = FakeReader.instances[0];
    reader.onreadingerror?.({ type: 'readingerror' });
    assert.strictEqual(c.errors.length, 1);
    assert.strictEqual(c.errors[0].kind, 'read_failed');
    reader.tap('04:a2:3b:1c:5d:80:00');
    assert.strictEqual(c.readings.length, 1);
    session.stop();
  });

  it('stop() aborts the reader and suppresses every later callback (unmount safety)', async () => {
    reset();
    const c = collect({ t: 0 });
    const session = startNfcScan(c.options);
    await session.started;
    const reader = FakeReader.instances[0];
    session.stop();
    session.stop(); // idempotent
    assert.strictEqual(reader.scanCalls[0]?.signal?.aborted, true);
    reader.tap('04:a2:3b:1c:5d:80:00');
    reader.onreadingerror?.({});
    assert.strictEqual(c.readings.length, 0);
    assert.strictEqual(c.errors.length, 0);
  });

  it('honours an external AbortSignal, including one aborted before start', async () => {
    reset();
    const c = collect({ t: 0 });
    const external = new AbortController();
    const session = startNfcScan({ ...c.options, signal: external.signal });
    await session.started;
    external.abort();
    assert.strictEqual(FakeReader.instances[0].scanCalls[0]?.signal?.aborted, true);
    FakeReader.instances[0].tap('04:a2:3b:1c:5d:80:00');
    assert.strictEqual(c.readings.length, 0);

    reset();
    const pre = new AbortController();
    pre.abort();
    const session2 = startNfcScan({ ...c.options, signal: pre.signal });
    assert.strictEqual(await session2.started, false);
    assert.strictEqual(FakeReader.instances.length, 0, 'no reader is created when already aborted');
  });

  it('a scan aborted while starting reports nothing', async () => {
    let rejectScan: (e: Error) => void = () => undefined;
    reset(() => new Promise<void>((_, reject) => (rejectScan = reject)));
    const c = collect({ t: 0 });
    const session = startNfcScan(c.options);
    session.stop();
    rejectScan(domError('AbortError'));
    assert.strictEqual(await session.started, false);
    assert.deepStrictEqual(c.errors, []);
  });

  it('refuses to start outside a browser when no reader is injected', async () => {
    const errors: NfcErrorKind[] = [];
    const session = startNfcScan({ onReading: () => undefined, onError: (k) => errors.push(k) });
    assert.strictEqual(await session.started, false);
    assert.deepStrictEqual(errors, ['unsupported']);
  });

  it('decodes records delivered with a reading', async () => {
    reset();
    const c = collect({ t: 0 });
    const session = startNfcScan(c.options);
    await session.started;
    FakeReader.instances[0].tap('04:a2:3b:1c:5d:80:00', {
      records: [
        { recordType: 'text', encoding: 'utf-8', lang: 'af', data: utf8('Kontrolepunt 3') },
        { recordType: 'url', data: utf8('https://example.org/cp/3') }
      ]
    });
    assert.strictEqual(c.readings[0].records.length, 2);
    assert.strictEqual(c.readings[0].records[0].text, 'Kontrolepunt 3');
    assert.strictEqual(c.readings[0].records[0].lang, 'af');
    assert.strictEqual(c.readings[0].records[1].text, 'https://example.org/cp/3');
    session.stop();
  });
});

describe('decodeNdefRecord', () => {
  it('decodes UTF-16 text records using the record encoding', () => {
    const bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00]); // "Hi" UTF-16LE
    const r = decodeNdefRecord({ recordType: 'text', encoding: 'utf-16le', lang: 'en', data: new DataView(bytes.buffer) });
    assert.strictEqual(r.text, 'Hi');
    assert.strictEqual(r.byteLength, 4);
  });

  it('falls back to UTF-8 for an unknown encoding label instead of throwing', () => {
    const r = decodeNdefRecord({ recordType: 'text', encoding: 'no-such-encoding', data: utf8('abc') });
    assert.strictEqual(r.text, 'abc');
  });

  it('decodes textual MIME records and reports only type + length for binary / unknown types', () => {
    const json = decodeNdefRecord({ recordType: 'mime', mediaType: 'application/json', data: utf8('{"cp":3}') });
    assert.strictEqual(json.text, '{"cp":3}');
    assert.strictEqual(json.mediaType, 'application/json');

    const bin = decodeNdefRecord({ recordType: 'mime', mediaType: 'image/png', data: new DataView(new ArrayBuffer(12)) });
    assert.strictEqual(bin.text, null);
    assert.strictEqual(bin.byteLength, 12);

    const ext = decodeNdefRecord({ recordType: 'example.com:cp', id: 'x1', data: new DataView(new ArrayBuffer(5)) });
    assert.deepStrictEqual(
      { recordType: ext.recordType, text: ext.text, byteLength: ext.byteLength, id: ext.id },
      { recordType: 'example.com:cp', text: null, byteLength: 5, id: 'x1' }
    );
  });

  it('never throws on malformed records', () => {
    const empty = decodeNdefRecord({ recordType: 'empty', data: null });
    assert.strictEqual(empty.byteLength, 0);
    assert.strictEqual(empty.text, null);
    const garbage = decodeNdefRecord({ recordType: undefined as unknown as string, data: 'x' as unknown as DataView });
    assert.strictEqual(garbage.recordType, 'unknown');
    assert.strictEqual(garbage.byteLength, 0);
  });
});
