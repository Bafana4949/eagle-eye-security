import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PATROL_DEVICE_COLUMNS, countQueuedByUser, loadPatrolDevices, sortPatrolDevices, type PatrolDeviceRow } from './devicesData';

const SUPERVISOR = 'b1111111-2222-4333-8444-555555555555';
const GUARD = 'a1111111-2222-4333-8444-555555555555';

function row(overrides: Partial<PatrolDeviceRow> & Pick<PatrolDeviceRow, 'id'>): PatrolDeviceRow {
  return {
    organisation_id: '0b8e4f1c-1d2e-4f3a-9b5c-6d7e8f9a0b1c',
    site_id: 'e1111111-2222-4333-8444-555555555555',
    label: 'Phone',
    enrolled_by: SUPERVISOR,
    enrolled_at: '2026-10-01T10:00:00Z',
    last_used_at: null,
    last_guard_id: null,
    revoked_at: null,
    revoked_by: null,
    created_at: '2026-10-01T10:00:00Z',
    ...overrides
  };
}

type Answer = { data: unknown; error: { message: string; code?: string } | null };

function fakeDb(answers: Record<string, Answer>) {
  const calls: Array<{ table: string; select: string; filters: unknown[] }> = [];
  const db = {
    from(table: string) {
      const call = { table, select: '', filters: [] as unknown[] };
      calls.push(call);
      const builder = {
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        order(...args: unknown[]) {
          call.filters.push(['order', ...args]);
          return builder;
        },
        limit(n: number) {
          call.filters.push(['limit', n]);
          return builder;
        },
        in(column: string, values: unknown[]) {
          call.filters.push(['in', column, values]);
          return builder;
        },
        then(resolve: (value: Answer) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve(answers[table] ?? { data: [], error: null }).then(resolve, reject);
        }
      };
      return builder;
    }
  };
  return { db: db as unknown as Pick<SupabaseClient, 'from'>, calls };
}

describe('patrol phones list', () => {
  it('never asks for the secret hash', () => {
    assert.doesNotMatch(PATROL_DEVICE_COLUMNS, /secret/);
    assert.doesNotMatch(PATROL_DEVICE_COLUMNS, /\*/);
  });

  it('lists active phones first (newest first), then revoked ones (latest revocation first)', () => {
    const sorted = sortPatrolDevices([
      row({ id: 'old-active', enrolled_at: '2026-09-01T10:00:00Z' }),
      row({ id: 'revoked-early', revoked_at: '2026-09-10T10:00:00Z' }),
      row({ id: 'new-active', enrolled_at: '2026-10-01T10:00:00Z' }),
      row({ id: 'revoked-late', revoked_at: '2026-09-20T10:00:00Z' })
    ]);
    assert.deepEqual(
      sorted.map((r) => r.id),
      ['new-active', 'old-active', 'revoked-late', 'revoked-early']
    );
  });

  it('loads the phones and the names RLS lets the caller see', async () => {
    const { db, calls } = fakeDb({
      patrol_devices: { data: [row({ id: 'p1', last_guard_id: GUARD, last_used_at: '2026-10-01T19:00:00Z' })], error: null },
      profiles: { data: [{ id: GUARD, first_name: 'Thabo', last_name: 'Guard' }], error: null }
    });
    const result = await loadPatrolDevices(db);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.devices.length, 1);
    assert.deepEqual(result.value.names, { [GUARD]: 'Thabo Guard' });
    assert.equal(calls[0].table, 'patrol_devices');
    assert.equal(calls[0].select, PATROL_DEVICE_COLUMNS);
    assert.deepEqual(calls[1].filters, [['in', 'id', [SUPERVISOR, GUARD]]]);
  });

  it('still lists the phones when names cannot be read, and reports a list failure as an error', async () => {
    const withoutNames = await loadPatrolDevices(
      fakeDb({
        patrol_devices: { data: [row({ id: 'p1' })], error: null },
        profiles: { data: null, error: { message: 'permission denied', code: '42501' } }
      }).db
    );
    assert.equal(withoutNames.ok, true);
    assert.deepEqual(withoutNames.ok && withoutNames.value.names, {});

    const failed = await loadPatrolDevices(fakeDb({ patrol_devices: { data: null, error: { message: 'permission denied', code: '42501' } } }).db);
    assert.equal(failed.ok, false);
    assert.equal(!failed.ok && failed.error.kind, 'not_allowed');
  });
});

describe('countQueuedByUser (records waiting on a shared phone, per person)', () => {
  it('counts per user id and in total', () => {
    assert.deepEqual(countQueuedByUser([]), { byUser: {}, total: 0 });
    assert.deepEqual(countQueuedByUser([GUARD, SUPERVISOR, GUARD, GUARD]), { byUser: { [GUARD]: 3, [SUPERVISOR]: 1 }, total: 4 });
  });

  it('an item without a user id still counts in the total', () => {
    assert.deepEqual(countQueuedByUser([GUARD, null, undefined, '']), { byUser: { [GUARD]: 1 }, total: 4 });
  });
});
