import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeTargetDimensions, planQualitySteps } from './media';
import {
  EVIDENCE_MAX_EDGE,
  EVIDENCE_QUALITY,
  MEDIA_PROFILES,
  MIN_JPEG_QUALITY,
  SELFIE_MAX_EDGE,
  SELFIE_QUALITY,
  TARGET_MAX_BYTES
} from '@/lib/config/media';

describe('media configuration', () => {
  it('uses evidence-grade sizes (not the old 320 px selfie)', () => {
    assert.strictEqual(SELFIE_MAX_EDGE, 1024);
    assert.strictEqual(SELFIE_QUALITY, 0.82);
    assert.strictEqual(EVIDENCE_MAX_EDGE, 1600);
    assert.strictEqual(EVIDENCE_QUALITY, 0.8);
    assert.strictEqual(TARGET_MAX_BYTES.selfie, 400 * 1024);
    assert.strictEqual(TARGET_MAX_BYTES.evidence, 900 * 1024);
    assert.strictEqual(MIN_JPEG_QUALITY, 0.6);
    assert.deepStrictEqual(MEDIA_PROFILES.selfie, { maxEdge: 1024, quality: 0.82, targetMaxBytes: 400 * 1024 });
  });
});

describe('computeTargetDimensions', () => {
  it('scales landscape and portrait photos by their long edge', () => {
    assert.deepStrictEqual(computeTargetDimensions(4000, 3000, 1024), { width: 1024, height: 768 });
    assert.deepStrictEqual(computeTargetDimensions(3000, 4000, 1024), { width: 768, height: 1024 });
    assert.deepStrictEqual(computeTargetDimensions(4032, 3024, 1600), { width: 1600, height: 1200 });
  });

  it('never upscales small photos', () => {
    assert.deepStrictEqual(computeTargetDimensions(800, 600, 1600), { width: 800, height: 600 });
    assert.deepStrictEqual(computeTargetDimensions(1024, 1024, 1024), { width: 1024, height: 1024 });
  });

  it('keeps extreme aspect ratios at least 1 px wide', () => {
    assert.deepStrictEqual(computeTargetDimensions(1, 10000, 1024), { width: 1, height: 1024 });
  });

  it('rejects invalid input', () => {
    assert.throws(() => computeTargetDimensions(0, 100, 1024), RangeError);
    assert.throws(() => computeTargetDimensions(100, Number.NaN, 1024), RangeError);
    assert.throws(() => computeTargetDimensions(100, 100, 0), RangeError);
  });
});

describe('planQualitySteps', () => {
  it('steps selfie quality down to the 0.6 floor', () => {
    assert.deepStrictEqual(planQualitySteps(0.82, 0.6, 0.08), [0.82, 0.74, 0.66, 0.6]);
  });
  it('steps evidence quality down to the 0.6 floor', () => {
    assert.deepStrictEqual(planQualitySteps(0.8, 0.6, 0.08), [0.8, 0.72, 0.64, 0.6]);
  });
  it('never goes below the floor or above 1', () => {
    assert.deepStrictEqual(planQualitySteps(0.6, 0.6, 0.08), [0.6]);
    assert.strictEqual(planQualitySteps(1.5, 0.6, 0.1)[0], 1);
    assert.ok(planQualitySteps(0.95, 0.6, 0.01).every((q) => q >= 0.6));
  });
  it('rejects a non-positive step', () => {
    assert.throws(() => planQualitySteps(0.8, 0.6, 0), RangeError);
  });
});
