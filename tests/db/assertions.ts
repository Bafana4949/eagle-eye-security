/** Small assertion helpers for query outcomes returned by tryAsUser(). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, type QueryOk, type QueryOutcome } from './harness';

/** The statement must fail with the given SQLSTATE (default 42501: RLS / privilege). */
export function assertRefused(outcome: QueryOutcome<unknown>, code = '42501', label = 'statement'): void {
  if (outcome.ok) {
    assert.fail(`${label} was expected to fail with ${code} but succeeded (${outcome.affectedRows} row(s))`);
  }
  assert.equal(outcome.code, code, `${label} failed with ${outcome.code} (${outcome.message}), expected ${code}`);
}

/** The statement must succeed. */
export function assertAllowed<T>(outcome: QueryOutcome<T>, label = 'statement'): asserts outcome is QueryOk<T> {
  if (!outcome.ok) assert.fail(`${label} was expected to succeed but failed: ${outcome.code} ${outcome.message}`);
}

/** The statement must succeed but touch / return no rows (RLS filtered everything). */
export function assertNoRows(outcome: QueryOutcome<unknown>, label = 'statement'): void {
  assertAllowed(outcome, label);
  assert.equal(outcome.rows.length, 0, `${label} returned ${outcome.rows.length} row(s), expected none`);
  assert.equal(outcome.affectedRows, 0, `${label} affected ${outcome.affectedRows} row(s), expected none`);
}

/** Opens a shift for `guardId` at `siteId` exactly like the app does (as that guard). Returns the shift id. */
export async function startShiftAs(
  db: PGlite,
  guardId: string,
  siteId: string,
  options: { actualStart?: string; latitude?: number; longitude?: number; accuracy?: number } = {}
): Promise<string> {
  const shiftId = randomUUID();
  await asUser(
    db,
    guardId,
    `INSERT INTO shifts (id, site_id, guard_id, shift_type, scheduled_start, scheduled_end, actual_start,
                         start_latitude, start_longitude, start_accuracy_meters, status)
     VALUES ($1, $2, $3, 'night', now() - interval '5 minutes', now() + interval '12 hours',
             coalesce($4::timestamptz, now()), $5, $6, $7, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [shiftId, siteId, guardId, options.actualStart ?? null, options.latitude ?? null, options.longitude ?? null, options.accuracy ?? null]
  );
  return shiftId;
}
