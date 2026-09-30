/**
 * South African Licence Disc Barcode Scanner Engine (PDF417 only).
 *
 * 1. Native BarcodeDetector – used only when getSupportedFormats() explicitly lists 'pdf417'
 *    (not on iOS Safari, nor on Android phones without Google Play services, e.g. Huawei).
 * 2. @zxing/library PDF417Reader with hints { POSSIBLE_FORMATS: [PDF_417] } over a
 *    HybridBinarizer. PDF417Reader can only decode PDF417, so QR codes, 1D barcodes etc. in
 *    frame are never returned. (The previous MultiFormatReader.setHints() + decode(bitmap)
 *    combination silently reset the hints and decoded every format.)
 *    ZXing-js 0.23 only detects PDF417 at 0 and 180 degrees (its TRY_HARDER hint is not
 *    implemented for PDF417). The PWA is locked to portrait, so a guard who turns the phone
 *    sideways to fit the wide barcode produces frames rotated by 90 degrees. The luminance
 *    buffer is therefore also tried rotated by 90 degrees (ZXing's own 180-degree pass then
 *    covers 270): photos try both orientations, live frames alternate between them so the
 *    per-frame cost stays flat.
 * 3. Uploaded photos: multi-scale retry at 2000 / 1400 / 2800 px long edge (reference app).
 *
 * Results are the raw barcode text; callers validate with parseSouthAfricanLicenseDisc and
 * must show "not a licence disc" when it returns null.
 */

import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  PDF417Reader,
  RGBLuminanceSource
} from '@zxing/library';

/** Long-edge sizes tried for uploaded photos, in order (same ladder as the reference app). */
export const PHOTO_DECODE_SCALES = [2000, 1400, 2800] as const;

interface BarcodeDetectorInstance {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string; format: string }>>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

export interface LuminanceImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type Canvas2DSource = HTMLCanvasElement | OffscreenCanvas;

// Native detector is created once per page load.
let nativeDetectorPromise: Promise<BarcodeDetectorInstance | null> | null = null;

function getBarcodeDetectorClass(): BarcodeDetectorConstructor | null {
  if (typeof globalThis === 'undefined') return null;
  const ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** true only when the browser's BarcodeDetector explicitly supports 'pdf417'. */
export async function isNativePdf417Supported(): Promise<boolean> {
  const Detector = getBarcodeDetectorClass();
  if (!Detector || typeof Detector.getSupportedFormats !== 'function') return false;
  try {
    const formats = await Detector.getSupportedFormats();
    return Array.isArray(formats) && formats.includes('pdf417');
  } catch {
    return false;
  }
}

async function getNativeDetector(): Promise<BarcodeDetectorInstance | null> {
  if (!nativeDetectorPromise) {
    nativeDetectorPromise = (async () => {
      try {
        if (!(await isNativePdf417Supported())) return null;
        const Detector = getBarcodeDetectorClass();
        return Detector ? new Detector({ formats: ['pdf417'] }) : null;
      } catch {
        return null;
      }
    })();
  }
  return nativeDetectorPromise;
}

async function detectNative(detector: BarcodeDetectorInstance, source: ImageBitmapSource): Promise<string | null> {
  try {
    const detections = await detector.detect(source);
    const hit = detections?.find((d) => d && d.rawValue && (!d.format || d.format === 'pdf417'));
    return hit ? hit.rawValue : null;
  } catch {
    return null;
  }
}

/** Converts RGBA pixels to 8-bit luminance (same weights as ZXing's HTML canvas source). */
export function rgbaToLuminance(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const size = width * height;
  if (rgba.length < size * 4) throw new RangeError('RGBA buffer is smaller than width × height × 4');
  const luminances = new Uint8ClampedArray(size);
  for (let i = 0; i < size; i++) {
    const o = i * 4;
    luminances[i] = (rgba[o] * 306 + rgba[o + 1] * 601 + rgba[o + 2] * 117) >> 10;
  }
  return luminances;
}

function pdf417Hints(): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]);
  return hints;
}

/**
 * Which orientations ZXing tries: 'both' = as captured, then rotated 90 degrees; 0 / 90 = only
 * that one. (ZXing itself also checks 180 degrees of whatever it is given, so 90 covers 270.)
 */
export type Pdf417Orientation = 'both' | 0 | 90;

/** Rotates a luminance buffer 90 degrees clockwise: the result is height x width. O(width x height). */
export function rotateLuminance90(luminances: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  if (luminances.length < width * height) throw new RangeError('Luminance buffer is smaller than width × height');
  const out = new Uint8ClampedArray(width * height);
  // Source (x, y) goes to destination (height - 1 - y, x) in an image `height` pixels wide.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const dx = height - 1 - y;
    for (let x = 0; x < width; x++) out[x * height + dx] = luminances[row + x];
  }
  return out;
}

function decodeLuminanceOnce(luminances: Uint8ClampedArray, width: number, height: number): string | null {
  try {
    const source = new RGBLuminanceSource(luminances, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result = new PDF417Reader().decode(bitmap, pdf417Hints());
    return result.getBarcodeFormat() === BarcodeFormat.PDF_417 ? result.getText() : null;
  } catch {
    return null; // NotFound / Checksum / Format exceptions
  }
}

/** Decodes a PDF417 barcode from a luminance buffer with ZXing. Returns null when none is found. */
export function decodePdf417FromLuminance(
  luminances: Uint8ClampedArray,
  width: number,
  height: number,
  orientation: Pdf417Orientation = 'both'
): string | null {
  if (!(width > 0 && height > 0)) return null;
  if (orientation !== 90) {
    const upright = decodeLuminanceOnce(luminances, width, height);
    if (upright !== null || orientation === 0) return upright;
  }
  return decodeLuminanceOnce(rotateLuminance90(luminances, width, height), height, width);
}

/** Decodes a PDF417 barcode from RGBA ImageData (or an equivalent object). */
export function decodePdf417FromImageData(
  image: { data: Uint8ClampedArray; width: number; height: number },
  orientation: Pdf417Orientation = 'both'
): string | null {
  if (!(image.width > 0 && image.height > 0)) return null;
  return decodePdf417FromLuminance(
    rgbaToLuminance(image.data, image.width, image.height),
    image.width,
    image.height,
    orientation
  );
}

/** Decodes a PDF417 barcode from a canvas with ZXing (no native detector). */
export function decodePdf417FromCanvas(canvas: Canvas2DSource, orientation: Pdf417Orientation = 'both'): string | null {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
    return decodePdf417FromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height), orientation);
  } catch {
    return null;
  }
}

/**
 * Decodes an ImageBitmap (e.g. from createImageBitmap) by drawing it to a scratch canvas.
 * Tries the native detector first when available.
 */
export async function decodePdf417FromImageBitmap(bitmap: ImageBitmap): Promise<string | null> {
  const native = await getNativeDetector();
  if (native) {
    const text = await detectNative(native, bitmap);
    if (text) return text;
  }
  const canvas = createScratchCanvas(bitmap.width, bitmap.height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  return decodePdf417FromCanvas(canvas);
}

function createScratchCanvas(width: number, height: number): Canvas2DSource | null {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return null;
}

export interface ScanFrameOptions {
  /**
   * Also run ZXing when the native detector exists but found nothing (default true, as in the
   * reference app). PDF417-only ZXing costs ~15 ms per 1280×720 frame on a desktop CPU and
   * several times that on budget phones; pass false for live frames if the UI becomes sluggish.
   */
  zxingWhenNative?: boolean;
  /**
   * ZXing orientations for this frame. Default 'alternate': successive calls with the same
   * canvas buffer (a live camera loop) try 0 degrees, then 90, then 0 ... so a sideways disc is
   * found within two frames at the cost of one decode per frame. 'both' tries both every time
   * (uploaded photos).
   */
  orientation?: 'alternate' | 'both';
}

/** Per-canvas frame counter for alternating orientations in live scanning. */
const liveFrameCounter = new WeakMap<object, number>();

function nextLiveOrientation(canvasBuffer: object): 0 | 90 {
  const n = liveFrameCounter.get(canvasBuffer) ?? 0;
  liveFrameCounter.set(canvasBuffer, n + 1);
  return n % 2 === 0 ? 0 : 90;
}

/**
 * Scans a single video frame or canvas for a PDF417 barcode.
 * `canvasBuffer` must already contain the frame's pixels (used for the ZXing path).
 */
export async function scanPdf417(
  source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
  canvasBuffer: HTMLCanvasElement,
  options: ScanFrameOptions = {}
): Promise<string | null> {
  const native = await getNativeDetector();
  if (native) {
    const text = await detectNative(native, source);
    if (text) return text;
    if (options.zxingWhenNative === false) return null;
  }
  const orientation = options.orientation === 'both' ? 'both' : nextLiveOrientation(canvasBuffer);
  return decodePdf417FromCanvas(canvasBuffer, orientation);
}

/**
 * Canvas sizes to try for an uploaded photo: each ladder entry scales the long edge down to
 * that size (never up); duplicate sizes are skipped (small photos get a single pass).
 */
export function computeDecodeScales(
  width: number,
  height: number,
  ladder: ReadonlyArray<number> = PHOTO_DECODE_SCALES
): Array<{ width: number; height: number }> {
  if (!(width > 0 && height > 0)) return [];
  const sizes: Array<{ width: number; height: number }> = [];
  const seen = new Set<string>();
  for (const maxEdge of ladder) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.floor(width * scale));
    const h = Math.max(1, Math.floor(height * scale));
    const key = `${w}x${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push({ width: w, height: h });
  }
  return sizes;
}

function loadImage(file: Blob): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The photo could not be opened.'));
    };
    img.src = url;
  });
}

/**
 * Decodes a PDF417 barcode from a photo (multi-scale retry). Returns null when no PDF417 is
 * found; rejects only when the photo itself cannot be opened.
 */
export async function decodePdf417FromImageFile(file: Blob): Promise<string | null> {
  const { img, revoke } = await loadImage(file);
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    for (const size of computeDecodeScales(img.naturalWidth || img.width, img.naturalHeight || img.height)) {
      canvas.width = size.width;
      canvas.height = size.height;
      ctx.drawImage(img, 0, 0, size.width, size.height);
      const decoded = await scanPdf417(canvas, canvas, { orientation: 'both' });
      if (decoded) return decoded;
    }
    return null;
  } finally {
    revoke();
  }
}
