import { createClient } from '@/lib/supabase/client';
import { toAdminError, type AdminDb, type AdminResult } from './adminData';

/**
 * Runs an admin data function with the browser Supabase client. createClient() is only called
 * here (inside effects / handlers, never during render) and a configuration error becomes an
 * ordinary failed result instead of an exception.
 */
export async function withDb<T>(fn: (db: AdminDb) => Promise<AdminResult<T>>): Promise<AdminResult<T>> {
  let db: AdminDb;
  try {
    db = createClient();
  } catch (error) {
    return { ok: false, error: toAdminError(error) };
  }
  try {
    return await fn(db);
  } catch (error) {
    return { ok: false, error: toAdminError(error) };
  }
}
