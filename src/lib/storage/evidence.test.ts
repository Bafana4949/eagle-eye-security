import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EVIDENCE_BUCKET,
  buildEvidencePath,
  evidenceCategoryForEvent,
  getEvidenceSignedUrl,
  parseEvidencePath
} from './evidence';
import { FakeSupabase } from '@/lib/offline/testing/fakeSupabase';

const ORG = '0b8e4f1c-1d2e-4f3a-9b5c-6d7e8f9a0b1c';
const SITE = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const USER = 'a1111111-2222-4333-8444-555555555555';
const EVENT = 'f1111111-2222-4333-8444-555555555555';

describe('buildEvidencePath', () => {
  it('follows {org}/{site}/{category}/{user}/{event}-{field}.jpg (the storage RLS layout)', () => {
    const path = buildEvidencePath({ organisationId: ORG, siteId: SITE, category: 'selfie', userId: USER, eventId: EVENT, field: 'selfie' });
    assert.equal(path, `${ORG}/${SITE}/selfie/${USER}/${EVENT}-selfie.jpg`);
    const segments = path.split('/');
    assert.equal(segments[0], ORG, '[1] organisation');
    assert.equal(segments[1], SITE, '[2] site');
    assert.equal(segments[2], 'selfie', '[3] category');
    assert.equal(segments[3], USER, '[4] uploader');
  });

  it('is deterministic and lower-cases ids (policies compare against uuid::text)', () => {
    const parts = { organisationId: ORG.toUpperCase(), siteId: SITE, category: 'incident' as const, userId: USER, eventId: EVENT, field: 'photo2' };
    assert.equal(buildEvidencePath(parts), buildEvidencePath({ ...parts, organisationId: ORG }));
    assert.equal(buildEvidencePath({ ...parts, mimeType: 'image/webp' }).endsWith('-photo2.webp'), true);
  });

  it('rejects anything that could escape the layout', () => {
    const base = { organisationId: ORG, siteId: SITE, category: 'vehicle' as const, userId: USER, eventId: EVENT, field: 'photo' };
    assert.throws(() => buildEvidencePath({ ...base, siteId: '../other-org' }), /siteId must be a UUID/);
    assert.throws(() => buildEvidencePath({ ...base, field: 'photo/../../x' }), /field/);
    assert.throws(() => buildEvidencePath({ ...base, category: 'public' as never }), /category/);
    assert.throws(() => buildEvidencePath({ ...base, mimeType: 'image/gif' }), /content type/);
  });

  it('round-trips through parseEvidencePath and rejects public URLs', () => {
    const path = buildEvidencePath({ organisationId: ORG, siteId: SITE, category: 'patrol', userId: USER, eventId: EVENT, field: 'photo' });
    assert.deepEqual(parseEvidencePath(path), { organisationId: ORG, siteId: SITE, category: 'patrol', userId: USER, eventId: EVENT, field: 'photo' });
    assert.equal(parseEvidencePath(`https://x.supabase.co/storage/v1/object/public/evidence-media/${path}`), null);
  });

  it('maps event types to evidence categories', () => {
    assert.equal(evidenceCategoryForEvent('shift_start'), 'selfie');
    assert.equal(evidenceCategoryForEvent('shift_end'), 'selfie');
    assert.equal(evidenceCategoryForEvent('incident'), 'incident');
    assert.equal(evidenceCategoryForEvent('gate_entry'), 'vehicle');
    assert.equal(evidenceCategoryForEvent('checkpoint_scan'), 'patrol');
    assert.equal(evidenceCategoryForEvent('panic'), null);
  });
});

describe('getEvidenceSignedUrl', () => {
  it('creates a short-lived signed URL with the caller’s own client', async () => {
    const fake = new FakeSupabase(USER);
    const path = buildEvidencePath({ organisationId: ORG, siteId: SITE, category: 'incident', userId: USER, eventId: EVENT, field: 'photo' });
    fake.objects.set(`${EVIDENCE_BUCKET}/${path}`, { blob: new Blob(['x']) });
    const url = await getEvidenceSignedUrl(path, 120, fake.client as Pick<SupabaseClient, 'storage'>);
    assert.match(url, /token=signed&expires=120$/);
  });

  it('fails loudly for non-evidence paths, bad expiry and denied objects', async () => {
    const fake = new FakeSupabase(USER);
    const client = fake.client as Pick<SupabaseClient, 'storage'>;
    await assert.rejects(getEvidenceSignedUrl('https://example.com/a.jpg', 60, client), /Not an evidence storage path/);
    const path = buildEvidencePath({ organisationId: ORG, siteId: SITE, category: 'selfie', userId: USER, eventId: EVENT, field: 'selfie' });
    await assert.rejects(getEvidenceSignedUrl(path, 0, client), /expiresInSeconds/);
    await assert.rejects(getEvidenceSignedUrl(path, 60, client), /Could not open evidence: Object not found/);
  });
});
