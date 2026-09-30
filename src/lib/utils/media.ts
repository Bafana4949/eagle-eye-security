/**
 * Media compression utilities for mobile browsers
 * Compresses camera photos before storing in IndexedDB or uploading to Supabase Storage.
 * Sizes and qualities come from src/lib/config/media.ts. No facial recognition is performed.
 */

import {
  EVIDENCE_MIME_TYPE,
  JPEG_QUALITY_STEP,
  MEDIA_PROFILES,
  MIN_JPEG_QUALITY
} from '@/lib/config/media';

export interface CompressedImageResult {
  blob: Blob;
  /** data: URL of the final blob (for previews); prefer URL.createObjectURL(blob) for large images. */
  dataUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: string;
  /** JPEG quality of the final encode. */
  quality: number;
  /** false when the byte target could not be met even at the minimum quality (photo is still kept). */
  metTarget: boolean;
}

export interface CompressOptions {
  /** Re-encode at lower quality while the blob is larger than this. */
  targetMaxBytes?: number;
  minQuality?: number;
  qualityStep?: number;
}

/**
 * Scales (width, height) so the longest edge is at most maxEdge, preserving aspect ratio.
 * Never upscales; each side is at least 1 px.
 */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  if (![width, height, maxEdge].every((v) => Number.isFinite(v) && v > 0)) {
    throw new RangeError(`Invalid image dimensions: ${width}x${height} (max edge ${maxEdge})`);
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Quality ladder used when stepping down to meet a byte target, e.g.
 * (0.82, 0.6, 0.08) → [0.82, 0.74, 0.66, 0.6].
 */
export function planQualitySteps(
  initialQuality: number,
  minQuality: number = MIN_JPEG_QUALITY,
  step: number = JPEG_QUALITY_STEP
): number[] {
  if (!(step > 0)) throw new RangeError('Quality step must be positive');
  const start = Math.min(1, Math.max(0.05, initialQuality));
  const floor = Math.min(start, Math.max(0.05, minQuality));
  const steps: number[] = [];
  for (let q = start; q > floor + 1e-9; q -= step) steps.push(Math.round(q * 100) / 100);
  if (steps.length === 0 || steps[steps.length - 1] !== floor) steps.push(Math.round(floor * 100) / 100);
  return steps;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to create compressed image blob'))),
      mimeType,
      quality
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read compressed image'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(fileOrBlob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(fileOrBlob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This photo could not be opened (unsupported format?). Please take the photo again.'));
    };
    img.src = url;
  });
}

/**
 * Resizes an image file/blob to a maximum dimension and compresses it to JPEG, stepping the
 * quality down (to options.minQuality) until it fits options.targetMaxBytes when given.
 */
export async function compressImage(
  fileOrBlob: File | Blob,
  maxDimension: number = MEDIA_PROFILES.evidence.maxEdge,
  quality: number = MEDIA_PROFILES.evidence.quality,
  options: CompressOptions = {}
): Promise<CompressedImageResult> {
  const img = await loadImage(fileOrBlob);
  const { width, height } = computeTargetDimensions(img.naturalWidth || img.width, img.naturalHeight || img.height, maxDimension);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, width, height);

  const mimeType = EVIDENCE_MIME_TYPE;
  const qualities =
    options.targetMaxBytes !== undefined
      ? planQualitySteps(quality, options.minQuality ?? MIN_JPEG_QUALITY, options.qualityStep ?? JPEG_QUALITY_STEP)
      : [quality];

  let blob: Blob | null = null;
  let usedQuality = qualities[0];
  for (const q of qualities) {
    blob = await canvasToBlob(canvas, mimeType, q);
    usedQuality = q;
    if (options.targetMaxBytes === undefined || blob.size <= options.targetMaxBytes) break;
  }
  if (!blob) throw new Error('Failed to create compressed image blob');

  // Release the canvas bitmap early on low-memory phones.
  canvas.width = 0;
  canvas.height = 0;

  return {
    blob,
    dataUrl: await blobToDataUrl(blob),
    width,
    height,
    sizeBytes: blob.size,
    mimeType,
    quality: usedQuality,
    metTarget: options.targetMaxBytes === undefined || blob.size <= options.targetMaxBytes
  };
}

/**
 * Clock-in/clock-out selfie: 1024 px long edge, JPEG 0.82 stepping down to 0.6 to fit ~400 KB.
 */
export async function compressSelfie(fileOrBlob: File | Blob): Promise<CompressedImageResult> {
  const p = MEDIA_PROFILES.selfie;
  return compressImage(fileOrBlob, p.maxEdge, p.quality, { targetMaxBytes: p.targetMaxBytes });
}

/**
 * Incident, vehicle and patrol photos: 1600 px long edge, JPEG 0.8 stepping down to 0.6 to fit ~900 KB.
 */
export async function compressEvidencePhoto(fileOrBlob: File | Blob): Promise<CompressedImageResult> {
  const p = MEDIA_PROFILES.evidence;
  return compressImage(fileOrBlob, p.maxEdge, p.quality, { targetMaxBytes: p.targetMaxBytes });
}
