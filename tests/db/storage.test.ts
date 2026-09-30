/**
 * Private evidence bucket (evidence-media): storage.objects policies, exercised the way
 * the Storage API does (row INSERT / SELECT / UPDATE / DELETE as the caller's role), with
 * object paths built by the production helper buildEvidencePath().
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asSuperuser, createTestDb, tryAsUser } from './harness';
import { seedTwoTenantFixture, type Fixture } from './fixtures';
import { assertAllowed, assertNoRows, assertRefused } from './assertions';
import { buildEvidencePath } from '@/lib/storage/evidence';
import type { EvidenceCategory } from '@/types/models';

let db: PGlite;
let fx: Fixture;

before(async () => {
  db = await createTestDb();
  fx = await seedTwoTenantFixture(db);
});
after(async () => {
  await db.close();
});

function evidencePath(userId: string, siteId: string, category: EvidenceCategory, organisationId = fx.orgA, field = 'photo'): string {
  return buildEvidencePath({ organisationId, siteId, category, userId, eventId: randomUUID(), field });
}

/** Upload as the Storage API does: INSERT the object row as the caller (no upsert). */
function upload(userId: string, name: string, bucket = 'evidence-media') {
  return tryAsUser(
    db,
    userId,
    `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata)
     VALUES ($1, $2, $3::uuid, $3::text, '{"mimetype": "image/jpeg"}'::jsonb)`,
    [bucket, name, userId]
  );
}

function canRead(userId: string, name: string) {
  return tryAsUser<{ name: string }>(db, userId, `SELECT name FROM storage.objects WHERE bucket_id = 'evidence-media' AND name = $1`, [
    name
  ]);
}

describe('uploads', () => {
  test('bucket evidence-media is private with a 10 MB limit and image types only', async () => {
    const r = await asSuperuser<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>(
      db,
      `SELECT public, file_size_limit::int AS file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'evidence-media'`
    );
    assert.deepEqual(r.rows[0], {
      public: false,
      file_size_limit: 10485760,
      allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
    });
  });

  test('guard uploads a selfie to their own evidence path and can read it back', async () => {
    const g = fx.users.guardA;
    const path = evidencePath(g, fx.siteA1, 'selfie', fx.orgA, 'start_selfie');
    const up = await upload(g, path);
    assertAllowed(up, 'upload');
    assert.equal(up.affectedRows, 1);
    const read = await canRead(g, path);
    assertAllowed(read);
    assert.deepEqual(read.rows, [{ name: path }]);
  });

  test('re-uploading the same path is refused as a duplicate (never overwritten)', async () => {
    const g = fx.users.guardA;
    const path = evidencePath(g, fx.siteA1, 'vehicle');
    assertAllowed(await upload(g, path));
    // Storage maps this unique violation to 409 "The resource already exists"; the sync
    // engine treats that as "already uploaded" on a retry.
    assertRefused(await upload(g, path), '23505');
  });

  test("upload to another organisation's path is denied", async () => {
    const g = fx.users.guardA;
    assertRefused(await upload(g, evidencePath(g, fx.siteB1, 'selfie', fx.orgB)));
    assertRefused(await upload(g, evidencePath(g, fx.siteA1, 'selfie', fx.orgB)), '42501', 'own site under a foreign org folder');
  });

  test('upload to an unassigned site of the own organisation is denied', async () => {
    const g = fx.users.guardA;
    assertRefused(await upload(g, evidencePath(g, fx.siteA2, 'incident')));
  });

  test('upload with a wrong user segment is denied', async () => {
    const g = fx.users.guardA;
    assertRefused(await upload(g, evidencePath(fx.users.guardA2, fx.siteA1, 'selfie')));
  });

  test('upload with an unknown category, extra folders or a malformed path is denied', async () => {
    const g = fx.users.guardA;
    const id = randomUUID();
    for (const name of [
      `${fx.orgA}/${fx.siteA1}/documents/${g}/${id}-photo.jpg`,
      `${fx.orgA}/${fx.siteA1}/selfie/${g}/extra/${id}-photo.jpg`,
      `${fx.orgA}/not-a-uuid/selfie/${g}/${id}-photo.jpg`,
      `${fx.siteA1}/selfie/${id}-photo.jpg`
    ]) {
      assertRefused(await upload(g, name), '42501', name);
    }
    assertRefused(await upload(g, evidencePath(g, fx.siteA1, 'selfie'), 'other-bucket'), '42501', 'same layout in another bucket');
  });

  test('only canonical object names are accepted (no case aliases, empty / dot / foreign file names, other extensions)', async () => {
    const g = fx.users.guardA;
    const ev = randomUUID();
    const folder = `${fx.orgA}/${fx.siteA1}/incident/${g}`;
    for (const [label, name] of [
      ['upper-case site folder (alias of the canonical path)', `${fx.orgA}/${fx.siteA1.toUpperCase()}/incident/${g}/${ev}-photo.jpg`],
      ['upper-case organisation folder', `${fx.orgA.toUpperCase()}/${fx.siteA1}/incident/${g}/${ev}-photo.jpg`],
      ['upper-case event id', `${folder}/${ev.toUpperCase()}-photo.jpg`],
      ['empty file name', `${folder}/`],
      ['dot-dot file name', `${folder}/..`],
      ['html payload', `${folder}/payload.html`],
      ['script extension', `${folder}/${ev}-photo.js`],
      ['jpeg spelled out', `${folder}/${ev}-photo.jpeg`],
      ['no event id', `${folder}/photo.jpg`],
      ['field with a slash-like character', `${folder}/${ev}-photo%2F.jpg`],
      ['leading slash', `/${folder}/${ev}-photo.jpg`],
      ['braces around the site', `${fx.orgA}/{${fx.siteA1}}/incident/${g}/${ev}-photo.jpg`]
    ] as const) {
      assertRefused(await upload(g, name), '42501', label);
    }
    for (const ext of ['jpg', 'png', 'webp']) {
      assertAllowed(await upload(g, `${folder}/${randomUUID()}-photo_1.${ext}`), ext);
    }
  });

  test('supervisor and client viewer cannot upload evidence', async () => {
    assertRefused(await upload(fx.users.supA, evidencePath(fx.users.supA, fx.siteA1, 'incident')));
    assertRefused(await upload(fx.users.viewerA, evidencePath(fx.users.viewerA, fx.siteA1, 'incident')));
  });

  test('disabled guard can neither upload nor read their own earlier evidence', async () => {
    const g = fx.users.disabledGuardA;
    const path = evidencePath(g, fx.siteA1, 'selfie');
    await asSuperuser(db, `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('evidence-media', $1, $2)`, [path, g]);
    assertRefused(await upload(g, evidencePath(g, fx.siteA1, 'selfie')));
    assertNoRows(await canRead(g, path));
  });
});

describe('reading evidence', () => {
  let selfieA2: string;
  let incidentA2: string;
  let vehicleA2: string;
  let selfieA3: string;

  before(async () => {
    selfieA2 = evidencePath(fx.users.guardA2, fx.siteA1, 'selfie', fx.orgA, 'start_selfie');
    incidentA2 = evidencePath(fx.users.guardA2, fx.siteA1, 'incident');
    vehicleA2 = evidencePath(fx.users.guardA2, fx.siteA1, 'vehicle');
    selfieA3 = evidencePath(fx.users.guardA3, fx.siteA2, 'selfie');
    for (const [user, path] of [
      [fx.users.guardA2, selfieA2],
      [fx.users.guardA2, incidentA2],
      [fx.users.guardA2, vehicleA2],
      [fx.users.guardA3, selfieA3]
    ] as const) {
      assertAllowed(await upload(user, path), `fixture upload ${path}`);
    }
  });

  test("guard cannot read another guard's selfie (same site)", async () => {
    assertNoRows(await canRead(fx.users.guardA, selfieA2));
    assertNoRows(await canRead(fx.users.guardA, incidentA2));
  });

  test('supervisor of the site reads guard evidence; not evidence of a site they do not manage', async () => {
    const s = fx.users.supA;
    for (const path of [selfieA2, incidentA2, vehicleA2]) {
      const r = await canRead(s, path);
      assertAllowed(r);
      assert.equal(r.rows.length, 1, path);
    }
    assertNoRows(await canRead(s, selfieA3));
  });

  test('org admin reads evidence of every site of the organisation; another org admin reads none', async () => {
    for (const path of [selfieA2, selfieA3]) {
      const r = await canRead(fx.users.adminA, path);
      assertAllowed(r);
      assert.equal(r.rows.length, 1);
    }
    assertNoRows(await canRead(fx.users.adminB, selfieA2));
  });

  test('client viewer reads incident and vehicle photos of the assigned site but not selfies', async () => {
    const v = fx.users.viewerA;
    for (const path of [incidentA2, vehicleA2]) {
      const r = await canRead(v, path);
      assertAllowed(r);
      assert.equal(r.rows.length, 1, path);
    }
    assertNoRows(await canRead(v, selfieA2));
  });

  test('evidence objects cannot be updated or deleted by anyone signed in (owner and admin included)', async () => {
    for (const user of [fx.users.guardA2, fx.users.supA, fx.users.adminA]) {
      assertNoRows(
        await tryAsUser(db, user, `UPDATE storage.objects SET name = name || '.x' WHERE bucket_id = 'evidence-media' AND name = $1`, [
          selfieA2
        ]),
        `update by ${user}`
      );
      assertNoRows(
        await tryAsUser(db, user, `DELETE FROM storage.objects WHERE bucket_id = 'evidence-media' AND name = $1`, [selfieA2]),
        `delete by ${user}`
      );
    }
    const r = await asSuperuser<{ n: number }>(db, `SELECT count(*)::int AS n FROM storage.objects WHERE name = $1`, [selfieA2]);
    assert.equal(r.rows[0].n, 1);
  });
});
