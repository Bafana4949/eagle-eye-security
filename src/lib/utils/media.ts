/**
 * Media compression utilities for mobile browsers
 * Compresses camera photos before storing in IndexedDB or uploading to Supabase Storage.
 */

export interface CompressedImageResult {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Resizes an image file/blob to a maximum dimension and compresses it to JPEG/WebP.
 */
export async function compressImage(
  fileOrBlob: File | Blob,
  maxDimension: number = 800,
  quality: number = 0.7
): Promise<CompressedImageResult> {
  const url = URL.createObjectURL(fileOrBlob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return reject(new Error('Canvas 2D context unavailable'));
      }

      ctx.drawImage(img, 0, 0, width, height);

      const mimeType = 'image/jpeg';
      const dataUrl = canvas.toDataURL(mimeType, quality);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            return reject(new Error('Failed to create compressed image blob'));
          }

          resolve({
            blob,
            dataUrl,
            width,
            height,
            sizeBytes: blob.size
          });
        },
        mimeType,
        quality
      );
    };

    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };

    img.src = url;
  });
}

/**
 * Helper to compress guard selfie specifically (compact 320px JPEG)
 */
export async function compressSelfie(fileOrBlob: File | Blob): Promise<CompressedImageResult> {
  return compressImage(fileOrBlob, 320, 0.65);
}

/**
 * Helper to compress incident & vehicle photos (640px JPEG)
 */
export async function compressEvidencePhoto(fileOrBlob: File | Blob): Promise<CompressedImageResult> {
  return compressImage(fileOrBlob, 800, 0.75);
}
