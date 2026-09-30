/**
 * The `test` every spec imports: Playwright's test plus
 *   fake     — the fake Supabase control client (/__test API)
 *   fixture  — a FRESH database (all migrations) + the E2E dataset, reset before each test that
 *              uses it (ids, QR tokens and passwords come from here; nothing is hard-coded).
 * Each test also gets a fresh browser context (empty IndexedDB / localStorage / cookies).
 */
import { test as base, expect } from '@playwright/test';
import { FakeSupabaseControl, type E2EFixture } from './fakeSupabase';

interface E2EFixtures {
  fake: FakeSupabaseControl;
  fixture: E2EFixture;
}

export const test = base.extend<E2EFixtures>({
  fake: async ({}, provide) => {
    await provide(new FakeSupabaseControl());
  },
  fixture: async ({ fake }, provide) => {
    const fixture = await fake.reset();
    await provide(fixture);
    await fake.clearFaults().catch(() => undefined);
  }
});

export { expect };
