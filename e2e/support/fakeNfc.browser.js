/**
 * E2E TEST SUPPORT ONLY — runs INSIDE the browser page (injected by e2e/support/nfc.ts through
 * page.addInitScript before any app script). Plain JavaScript on purpose: it is read from disk as
 * text, so no TypeScript transform (Playwright's Babel, tsx/esbuild `__name` helpers) can change
 * what the page receives.
 *
 * Defines window.__eeInstallFakeNfc(options), which installs a `window.NDEFReader` that behaves
 * like Chrome on Android from the page's point of view:
 *   - scan({ signal }) resolves once "listening"; aborting the signal stops the reader;
 *   - permission 'granted' | 'prompt' | 'denied' (prompt: scan() needs a user gesture — like
 *     Chrome, a scan() started outside a tap is rejected with NotAllowedError);
 *   - readings go to `onreading` AND 'reading' listeners with serialNumber + message.records;
 *   - navigator.permissions.query({ name: 'nfc' }) reports the fake permission state.
 * Test hooks on window.__eeFakeNfc: tap(serial, records) · tapEmptySerial() · readingError()
 * failNextScan(name, message) · setPermission(state) · activeReaders() · scanCalls() · log().
 * The fake never invents serials: the test passes the exact serial the "tag" has.
 */
window.__eeInstallFakeNfc = function installFakeNfc(opts) {
  'use strict';
  var options = opts || {};
  var w = window;
  var state = {
    permission: options.permission || 'granted',
    nextScanError: null,
    readers: new Set(),
    scanCalls: 0,
    log: []
  };

  function toRecord(init) {
    var bytes;
    if (init.data === undefined || init.data === null) bytes = new Uint8Array(0);
    else if (typeof init.data === 'string') bytes = new TextEncoder().encode(init.data);
    else bytes = new Uint8Array(init.data);
    var isText = init.recordType === 'text';
    return {
      recordType: init.recordType,
      mediaType: init.mediaType === undefined ? null : init.mediaType,
      id: init.id === undefined ? '' : init.id,
      encoding: init.encoding !== undefined ? init.encoding : isText ? 'utf-8' : null,
      lang: init.lang !== undefined ? init.lang : isText ? 'en' : null,
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      toRecords: function () {
        return null;
      }
    };
  }

  function deliver(type, extra) {
    var delivered = 0;
    Array.from(state.readers).forEach(function (reader) {
      if (!reader.active) return;
      var event = new Event(type);
      Object.keys(extra).forEach(function (key) {
        Object.defineProperty(event, key, { value: extra[key], enumerable: true });
      });
      var handler = type === 'reading' ? reader.onreading : reader.onreadingerror;
      if (typeof handler === 'function') handler.call(reader, event);
      reader.dispatchEvent(event);
      delivered += 1;
    });
    return delivered;
  }

  var handle = {
    tap: function (serial, records) {
      var list = Array.isArray(records) ? records : [];
      var delivered = deliver('reading', { serialNumber: serial, message: { records: list.map(toRecord) } });
      state.log.push({ type: 'tap', serial: serial, records: list.length, delivered: delivered, at: Date.now() });
      return delivered;
    },
    tapEmptySerial: function (records) {
      return handle.tap('', records);
    },
    readingError: function () {
      var delivered = deliver('readingerror', {});
      state.log.push({ type: 'readingerror', delivered: delivered, at: Date.now() });
      return delivered;
    },
    failNextScan: function (name, message) {
      state.nextScanError = { name: name, message: message || name + ' (E2E fake NFC)' };
    },
    setPermission: function (next) {
      state.permission = next;
    },
    activeReaders: function () {
      return Array.from(state.readers).filter(function (r) {
        return r.active;
      }).length;
    },
    scanCalls: function () {
      return state.scanCalls;
    },
    log: function () {
      return state.log.slice();
    }
  };
  w.__eeFakeNfc = handle;

  if (options.supported === false) {
    try {
      delete w.NDEFReader;
    } catch {
      // not deletable: nothing was installed anyway
    }
    return;
  }

  class FakeNDEFReader extends EventTarget {
    constructor() {
      super();
      this.onreading = null;
      this.onreadingerror = null;
      this.active = false;
    }

    scan(scanOptions) {
      state.scanCalls += 1;
      var signal = scanOptions && scanOptions.signal;
      // Chrome checks the user gesture synchronously, before the promise settles.
      var activation = navigator.userActivation;
      var hasGesture = activation ? activation.isActive : true;
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(new DOMException('The NFC operation was cancelled.', 'AbortError'));
          return;
        }
        if (state.nextScanError) {
          var failure = state.nextScanError;
          state.nextScanError = null;
          state.log.push({ type: 'scan_rejected', name: failure.name, at: Date.now() });
          reject(new DOMException(failure.message, failure.name));
          return;
        }
        if (state.permission === 'denied') {
          reject(new DOMException('NFC permission request denied.', 'NotAllowedError'));
          return;
        }
        if (state.permission === 'prompt') {
          if (!hasGesture) {
            reject(new DOMException('Must be handling a user gesture to show a permission request.', 'NotAllowedError'));
            return;
          }
          state.permission = 'granted';
        }
        // Like Chrome: readings only arrive once scan() has resolved (the radio is listening).
        setTimeout(() => {
          if (signal && signal.aborted) {
            reject(new DOMException('The NFC operation was cancelled.', 'AbortError'));
            return;
          }
          this.active = true;
          state.readers.add(this);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                this.active = false;
                state.readers.delete(this);
                state.log.push({ type: 'scan_aborted', at: Date.now() });
              },
              { once: true }
            );
          }
          state.log.push({ type: 'scan_started', at: Date.now() });
          resolve();
        }, options.scanDelayMs || 0);
      });
    }

    write() {
      return Promise.reject(new DOMException('Writing tags is not supported by the E2E fake NFC reader.', 'NotSupportedError'));
    }

    makeReadOnly() {
      return Promise.reject(new DOMException('Not supported by the E2E fake NFC reader.', 'NotSupportedError'));
    }
  }
  w.NDEFReader = FakeNDEFReader;

  var permissions = navigator.permissions;
  if (permissions && typeof permissions.query === 'function') {
    var original = permissions.query.bind(permissions);
    permissions.query = function (descriptor) {
      if (descriptor && descriptor.name === 'nfc') {
        return Promise.resolve({
          name: 'nfc',
          state: state.permission,
          onchange: null,
          addEventListener: function () {},
          removeEventListener: function () {},
          dispatchEvent: function () {
            return true;
          }
        });
      }
      return original(descriptor);
    };
  }
};
