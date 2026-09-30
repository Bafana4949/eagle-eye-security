/**
 * Evidence photo sizing. Photos are resized on the phone before they are queued offline and
 * uploaded to the private `evidence-media` bucket (10 MB object limit, jpeg/png/webp).
 * No facial recognition or biometric processing is performed on selfies.
 */

/** Longest edge (px) of a clock-in/clock-out selfie. */
export const SELFIE_MAX_EDGE = 1024;
/** Initial JPEG quality for selfies. */
export const SELFIE_QUALITY = 0.82;

/** Longest edge (px) of incident, vehicle and patrol evidence photos. */
export const EVIDENCE_MAX_EDGE = 1600;
/** Initial JPEG quality for evidence photos. */
export const EVIDENCE_QUALITY = 0.8;

/** Byte targets; quality is stepped down (not below MIN_JPEG_QUALITY) until the photo fits. */
export const TARGET_MAX_BYTES = {
  selfie: 400 * 1024,
  evidence: 900 * 1024
} as const;

/** Lowest JPEG quality used when stepping down to meet a byte target. */
export const MIN_JPEG_QUALITY = 0.6;
/** Quality decrement per re-encode attempt. */
export const JPEG_QUALITY_STEP = 0.08;

export const EVIDENCE_MIME_TYPE = 'image/jpeg';

export interface MediaProfile {
  maxEdge: number;
  quality: number;
  targetMaxBytes: number;
}

export const MEDIA_PROFILES: Readonly<Record<'selfie' | 'evidence', MediaProfile>> = {
  selfie: { maxEdge: SELFIE_MAX_EDGE, quality: SELFIE_QUALITY, targetMaxBytes: TARGET_MAX_BYTES.selfie },
  evidence: { maxEdge: EVIDENCE_MAX_EDGE, quality: EVIDENCE_QUALITY, targetMaxBytes: TARGET_MAX_BYTES.evidence }
};
