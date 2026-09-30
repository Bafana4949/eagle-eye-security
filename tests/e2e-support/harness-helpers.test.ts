/**
 * Self-test of the browser helpers in e2e/support (no app, no servers): the fake Web NFC reader
 * behaves like Chrome's (readings, abort, DOMException names, gesture rule for 'prompt'), the QR
 * PNG and the Y4M fake-camera feed contain a QR code that a real decoder (ZXing) reads back.
 *
 *   npx tsx --test tests/e2e-support/harness-helpers.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from '@playwright/test';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { installFakeNfc, nfcActiveReaders, nfcFailNextScan, nfcReadingError, nfcTap, waitForNfcScanning } from '../../e2e/support/nfc';
import { launchWithCameraFeed, qrPng, writeQrY4m } from '../../e2e/support/qr';
import { FAKE_MEDIA_ARGS, resolveChromiumExecutable } from './chromium';

/** A secure-context origin served by request interception (no server needed). */
const ORIGIN = 'http://127.0.0.1:9';

const HARNESS_HTML = `<!doctype html><html><body>
<button id="start">Start NFC</button><button id="stop">Stop</button>
<script>
  window.events = [];
  let controller = null;
  window.startScan = () => {
    controller = new AbortController();
    const reader = new NDEFReader();
    reader.onreading = (e) => {
      const records = e.message.records.map((r) => ({ recordType: r.recordType, text: r.data ? new TextDecoder(r.encoding || 'utf-8').decode(r.data) : null }));
      window.events.push({ type: 'reading', serial: e.serialNumber, records });
    };
    reader.onreadingerror = () => window.events.push({ type: 'readingerror' });
    return reader.scan({ signal: controller.signal }).then(
      () => window.events.push({ type: 'started' }),
      (err) => window.events.push({ type: 'rejected', name: err.name })
    );
  };
  document.getElementById('start').addEventListener('click', () => window.startScan());
  document.getElementById('stop').addEventListener('click', () => controller && controller.abort());
  // ?autostart: scan() during page load, i.e. WITHOUT a user gesture (page.evaluate would count as one).
  window.autostarted = location.search.includes('autostart') ? window.startScan() : null;
</script></body></html>`;

type HarnessEvent = { type: string; serial?: string; name?: string; records?: Array<{ recordType: string; text: string | null }> };

async function events(page: Page): Promise<HarnessEvent[]> {
  return page.evaluate(() => (window as unknown as { events: HarnessEvent[] }).events);
}

async function openHarness(browser: Browser, options: Parameters<typeof installFakeNfc>[1] = {}, query = ''): Promise<Page> {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: HARNESS_HTML }));
  await installFakeNfc(page, options);
  await page.goto(`${ORIGIN}/harness${query}`);
  return page;
}

function decodeQr(gray: Uint8ClampedArray, width: number, height: number): string {
  const source = new RGBLuminanceSource(gray, width, height);
  return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
}

/** Draws an image/video in the page and returns its grey-scale pixels. */
async function grayPixels(page: Page, script: string): Promise<{ gray: number[]; width: number; height: number }> {
  return page.evaluate(script) as Promise<{ gray: number[]; width: number; height: number }>;
}

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), args: FAKE_MEDIA_ARGS });
});

after(async () => {
  await browser?.close();
});

describe('fake Web NFC', () => {
  it('delivers taps (serial + decoded records) to onreading while scanning, and nothing after abort', async () => {
    const page = await openHarness(browser);
    await page.click('#start');
    await waitForNfcScanning(page);
    assert.equal(await nfcTap(page, '04:a2:3b:1c:5d:80:00', [{ recordType: 'text', data: 'Workshop' }]), 1);
    await nfcReadingError(page);
    await page.click('#stop');
    assert.equal(await nfcActiveReaders(page), 0);
    assert.equal(await nfcTap(page, '04:a2:3b:1c:5d:80:00'), 0, 'a stopped reader receives nothing');
    assert.deepEqual(await events(page), [
      { type: 'started' },
      { type: 'reading', serial: '04:a2:3b:1c:5d:80:00', records: [{ recordType: 'text', text: 'Workshop' }] },
      { type: 'readingerror' }
    ]);
    await page.context().close();
  });

  it('rejects scan() with the scripted DOMException (NFC switched off = NotReadableError)', async () => {
    const page = await openHarness(browser);
    await nfcFailNextScan(page, 'NotReadableError');
    await page.click('#start');
    await page.waitForFunction(() => (window as unknown as { events: unknown[] }).events.length > 0);
    assert.deepEqual(await events(page), [{ type: 'rejected', name: 'NotReadableError' }]);
    await page.context().close();
  });

  it("permission 'prompt': scan() outside a tap is refused, from a tap it starts (like Chrome)", async () => {
    const page = await openHarness(browser, { permission: 'prompt' }, '?autostart');
    await page.waitForFunction(() => (window as unknown as { events: unknown[] }).events.length > 0);
    assert.deepEqual(await events(page), [{ type: 'rejected', name: 'NotAllowedError' }]);
    const state = await page.evaluate(async () => (await navigator.permissions.query({ name: 'nfc' as PermissionName })).state);
    assert.equal(state, 'prompt');
    await page.click('#start');
    await waitForNfcScanning(page);
    assert.equal((await events(page)).at(-1)?.type, 'started');
    await page.context().close();
  });

  it("permission 'denied' → NotAllowedError; supported:false → no NDEFReader", async () => {
    const denied = await openHarness(browser, { permission: 'denied' });
    await denied.click('#start');
    await denied.waitForFunction(() => (window as unknown as { events: unknown[] }).events.length > 0);
    assert.deepEqual(await events(denied), [{ type: 'rejected', name: 'NotAllowedError' }]);
    await denied.context().close();
    const unsupported = await openHarness(browser, { supported: false });
    assert.equal(await unsupported.evaluate(() => 'NDEFReader' in window), false);
    await unsupported.context().close();
  });
});

describe('QR helpers', () => {
  it('qrPng produces an image a QR decoder reads back exactly', async () => {
    const token = 'EE-CP-0123456789ABCDEF0123456789ABCDEF';
    const png = await qrPng(token);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.request().url().endsWith('.png')
        ? route.fulfill({ status: 200, contentType: 'image/png', body: png })
        : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><img id="qr" src="/qr.png">' })
    );
    await page.goto(`${ORIGIN}/page`);
    await page.waitForFunction(() => (document.getElementById('qr') as HTMLImageElement).complete);
    const pixels = await grayPixels(
      page,
      `(() => { const img = document.getElementById('qr'); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const d = ctx.getImageData(0, 0, c.width, c.height).data; const gray = [];
        for (let i = 0; i < d.length; i += 4) gray.push(Math.round((d[i] + d[i + 1] + d[i + 2]) / 3)); return { gray, width: c.width, height: c.height }; })()`
    );
    assert.equal(decodeQr(Uint8ClampedArray.from(pixels.gray), pixels.width, pixels.height), token);
    await context.close();
  });

  it('writeQrY4m + launchWithCameraFeed: the fake camera shows a decodable QR code', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ee-y4m-'));
    const file = path.join(dir, 'qr.y4m');
    const payload = 'PLAAS-CP:CP1';
    writeQrY4m(payload, file);
    const cameraBrowser = await launchWithCameraFeed(file);
    try {
      const context = await cameraBrowser.newContext({ permissions: ['camera'] });
      const page = await context.newPage();
      await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><video id="v" autoplay muted playsinline></video>' }));
      await page.goto(`${ORIGIN}/camera`);
      const pixels = await grayPixels(
        page,
        `(async () => { const v = document.getElementById('v'); v.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
          await v.play(); await new Promise((r) => setTimeout(r, 700)); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
          const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0); const d = ctx.getImageData(0, 0, c.width, c.height).data; const gray = [];
          for (let i = 0; i < d.length; i += 4) gray.push(Math.round((d[i] + d[i + 1] + d[i + 2]) / 3)); v.srcObject.getTracks().forEach((t) => t.stop());
          return { gray, width: c.width, height: c.height }; })()`
      );
      assert.equal(pixels.width, 640);
      assert.equal(decodeQr(Uint8ClampedArray.from(pixels.gray), pixels.width, pixels.height), payload);
      await context.close();
    } finally {
      await cameraBrowser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
