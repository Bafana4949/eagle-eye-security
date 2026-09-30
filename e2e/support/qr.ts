/**
 * QR code images for checkpoint scanning tests (generated with the `qrcode` package the app
 * already depends on).
 *
 *  - qrImageFile(text)  → a PNG for `locator.setInputFiles(...)` ("scan QR from photo" fallback).
 *  - writeQrY4m(text, path) + launchWithCameraFeed(path) → a browser whose fake camera shows the
 *    QR code (Chromium --use-file-for-fake-video-capture), for live-camera scanning tests.
 *    The camera feed is fixed per browser launch, so this launches a separate browser.
 */
import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import QRCode from 'qrcode';
import { FAKE_MEDIA_ARGS, resolveChromiumExecutable } from '../../tests/e2e-support/chromium';

export interface InputFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** PNG of `text` (quiet zone included), as a phone photo of a printed card would decode. */
export async function qrPng(text: string, options: { width?: number; margin?: number } = {}): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: options.margin ?? 4, width: options.width ?? 480 });
}

export async function qrImageFile(text: string, name = 'checkpoint-qr.png'): Promise<InputFilePayload> {
  return { name, mimeType: 'image/png', buffer: await qrPng(text) };
}

/**
 * Writes a one-frame YUV4MPEG2 video showing `text` as a QR code (black on white, centred).
 * Chromium loops the file as the camera picture.
 */
export function writeQrY4m(text: string, filePath: string, options: { width?: number; height?: number } = {}): void {
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('Y4M 4:2:0 needs even dimensions');
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const modules = qr.modules;
  const quiet = 4;
  const total = modules.size + quiet * 2;
  const scale = Math.max(1, Math.floor((Math.min(width, height) * 0.85) / total));
  const side = total * scale;
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  const luma = Buffer.alloc(width * height, 235);
  for (let y = 0; y < side; y += 1) {
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < side; x += 1) {
      const mx = Math.floor(x / scale) - quiet;
      const dark = my >= 0 && mx >= 0 && my < modules.size && mx < modules.size && modules.get(my, mx) === 1;
      if (dark) luma[(top + y) * width + left + x] = 16;
    }
  }
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`, 'ascii');
  const frame = Buffer.concat([Buffer.from('FRAME\n', 'ascii'), luma, chroma, chroma]);
  writeFileSync(filePath, Buffer.concat([header, frame, frame]));
}

/** A browser whose camera shows the given Y4M file (close it yourself). */
export function launchWithCameraFeed(y4mPath: string, options: { headless?: boolean } = {}): Promise<Browser> {
  return chromium.launch({
    executablePath: resolveChromiumExecutable(),
    headless: options.headless ?? true,
    args: [...FAKE_MEDIA_ARGS, `--use-file-for-fake-video-capture=${y4mPath}`]
  });
}
