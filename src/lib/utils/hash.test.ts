import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256, uuidFromName } from './hash';

describe('sha256', () => {
  it('matches the standard test vectors', async () => {
    assert.equal(await sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(await sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes UTF-8 like node:crypto', async () => {
    const text = 'Plaas-hek ✓ isiZulu: ukuphepha';
    assert.equal(await sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'));
  });

  it('never returns a constant fallback: throws without Web Crypto', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      await assert.rejects(sha256('abc'), /crypto\.subtle\) is unavailable/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
    assert.equal((await sha256('abc')).length, 64);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively, drops undefined, keeps null', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: null, c: 'x' }, u: undefined, l: [2, 1] }), '{"a":{"c":"x","d":null},"b":1,"l":[2,1]}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it('rejects values JSON cannot represent unambiguously', () => {
    assert.throws(() => canonicalJson({ x: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ x: () => 1 }), /unsupported/);
  });
});

describe('uuidFromName', () => {
  it('is deterministic and UUID-shaped', async () => {
    const a = await uuidFromName('incident_media:e1:photo');
    assert.equal(a, await uuidFromName('incident_media:e1:photo'));
    assert.notEqual(a, await uuidFromName('incident_media:e1:photo2'));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
