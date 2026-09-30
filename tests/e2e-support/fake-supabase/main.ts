/**
 * E2E TEST SUPPORT ONLY: process entry for the fake Supabase server
 * (`npx tsx tests/e2e-support/fake-supabase/main.ts`, started by playwright.config.ts).
 */
import { startFakeSupabase } from './server';

async function main(): Promise<void> {
  const started = Date.now();
  const fake = await startFakeSupabase();
  console.log(
    `[fake-supabase] listening on ${fake.url} (${fake.state.migrations.length} migrations, fixture seeded) in ${Date.now() - started} ms`
  );
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    fake
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('[fake-supabase] failed to start:', error);
  process.exit(1);
});
