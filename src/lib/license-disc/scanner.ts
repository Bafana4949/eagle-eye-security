/**
 * South African Licence Disc Barcode Scanner Engine
 * 
 * Supports:
 * 1. Native Chromium BarcodeDetector API with format 'pdf417' (fast, hardware-accelerated on Android)
 * 2. @zxing/library fallback with MultiFormatReader configured for PDF_417 with TRY_HARDER
 * 3. Multi-resolution canvas scaling (1400px, 2000px, 2800px) for dense photo uploads
 */

import {
  BinaryBitmap,
  HybridBinarizer,
  RGBLuminanceSource,
  MultiFormatReader,
  DecodeHintType,
  BarcodeFormat
} from '@zxing/library';

interface BarcodeDetectorInstance {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string; format: string }>>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

// Global detector instance if available
let nativeBarcodeDetector: BarcodeDetectorInstance | null = null;
let nativeDetectorChecked = false;

export async function isNativePdf417Supported(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!('BarcodeDetector' in window)) return false;

  try {
    const BarcodeDetectorClass = (window as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector;
    if (typeof BarcodeDetectorClass.getSupportedFormats === 'function') {
      const formats = await BarcodeDetectorClass.getSupportedFormats();
      return formats.includes('pdf417');
    }
    return true;
  } catch {
    return false;
  }
}

async function getNativeDetector(): Promise<BarcodeDetectorInstance | null> {
  if (nativeDetectorChecked) return nativeBarcodeDetector;
  nativeDetectorChecked = true;

  try {
    if (await isNativePdf417Supported()) {
      const BarcodeDetectorClass = (window as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector;
      nativeBarcodeDetector = new BarcodeDetectorClass({ formats: ['pdf417'] });
    }
  } catch {
    nativeBarcodeDetector = null;
  }

  return nativeBarcodeDetector;
}

/**
 * ZXing fallback reader for PDF417 from HTMLCanvasElement
 */
function decodeZxingPdf417(canvas: HTMLCanvasElement): string | null {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luminances = new Uint8ClampedArray(canvas.width * canvas.height);

    for (let i = 0; i < luminances.length; i++) {
      const offset = i * 4;
      // Standard luminance calculation
      luminances[i] = (imageData.data[offset] * 306 + imageData.data[offset + 1] * 601 + imageData.data[offset + 2] * 117) >> 10;
    }

    const source = new RGBLuminanceSource(luminances, canvas.width, canvas.height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));

    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new MultiFormatReader();
    reader.setHints(hints);

    const result = reader.decode(bitmap);
    return result.getText();
  } catch {
    return null;
  }
}

/**
 * Scan a single video frame or canvas for PDF417
 */
export async function scanPdf417(
  source: HTMLVideoElement | HTMLCanvasElement,
  canvasBuffer: HTMLCanvasElement
): Promise<string | null> {
  // 1. Try Native BarcodeDetector first
  const nativeDetector = await getNativeDetector();
  if (nativeDetector) {
    try {
      const detections = await nativeDetector.detect(source);
      if (detections && detections.length > 0 && detections[0].rawValue) {
        return detections[0].rawValue;
      }
    } catch {
      // Fall through to ZXing
    }
  }

  // 2. Fallback to ZXing decoding from the canvas buffer
  return decodeZxingPdf417(canvasBuffer);
}

/**
 * Decode PDF417 from a high-resolution photo file with multi-resolution scaling
 */
export async function decodePdf417FromImageFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // Multi-scale passes: South African disc PDF417 barcodes can be dense
    const targetScales = [1600, 2200, 1000, 2800];

    for (const maxDim of targetScales) {
      const scale = Math.min(1.0, maxDim / Math.max(img.width, img.height));
      canvas.width = Math.floor(img.width * scale);
      canvas.height = Math.floor(img.height * scale);

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const decoded = await scanPdf417(canvas, canvas);
      if (decoded) {
        return decoded;
      }
    }

    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
