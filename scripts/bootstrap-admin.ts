/**
 * One-time bootstrap of a NEW Eagle Eye deployment: creates the organisation, its first site and
 * the first admin account. Run it ONCE, locally, by the operator who holds the service-role key.
 * After that, every other site, checkpoint and account is created in the admin console (/admin).
 *
 * It never prints the service-role key or the password. It refuses to run when the database
 * already has an organisation (unless explicitly allowed), and without BOOTSTRAP_CONFIRM=yes it
 * only shows what it would do (dry run).
 *
 * Usage (PowerShell example; values are placeholders you replace):
 *   $env:BOOTSTRAP_ORG_NAME = "<organisation name>"
 *   $env:BOOTSTRAP_SITE_NAME = "<first site name>"
 *   $env:BOOTSTRAP_SITE_CODE = "<short site code, no spaces>"
 *   $env:BOOTSTRAP_ADMIN_EMAIL = "<admin e-mail>"
 *   $env:BOOTSTRAP_ADMIN_FIRST_NAME = "<first name>"
 *   $env:BOOTSTRAP_ADMIN_LAST_NAME = "<last name>"
 *   $env:BOOTSTRAP_ADMIN_PASSWORD = "<a strong password, at least 12 characters>"
 *   npx tsx --env-file=.env.local scripts/bootstrap-admin.ts                 # dry run
 *   $env:BOOTSTRAP_CONFIRM = "yes"; npx tsx --env-file=.env.local scripts/bootstrap-admin.ts
 *   Remove-Item Env:BOOTSTRAP_ADMIN_PASSWORD                                 # afterwards
 *
 * Required environment:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local / the shell),
 *   BOOTSTRAP_ORG_NAME, BOOTSTRAP_SITE_NAME, BOOTSTRAP_SITE_CODE,
 *   BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_FIRST_NAME, BOOTSTRAP_ADMIN_LAST_NAME, BOOTSTRAP_ADMIN_PASSWORD
 * Optional:
 *   BOOTSTRAP_ADMIN_ROLE=admin|super_admin (default admin)
 *   BOOTSTRAP_ALLOW_EXISTING_ORGS=yes   (add another organisation to a database that has one)
 *   BOOTSTRAP_CONFIRM=yes               (actually write; otherwise dry run)
 *
 * Apply the database migrations (supabase/migrations) before running this.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const MIN_PASSWORD_LENGTH = 12;

interface BootstrapConfig {
  url: string;
  serviceRoleKey: string;
  orgName: string;
  siteName: string;
  siteCode: string;
  adminEmail: string;
  adminFirstName: string;
  adminLastName: string;
  adminPassword: string;
  adminRole: 'admin' | 'super_admin';
  allowExistingOrgs: boolean;
  confirm: boolean;
}

class BootstrapError extends Error {}

function env(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function readConfig(): BootstrapConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env(name);
    if (!value) missing.push(name);
    return value;
  };
  const url = required('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const orgName = required('BOOTSTRAP_ORG_NAME');
  const siteName = required('BOOTSTRAP_SITE_NAME');
  const siteCode = required('BOOTSTRAP_SITE_CODE');
  const adminEmail = required('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
  const adminFirstName = required('BOOTSTRAP_ADMIN_FIRST_NAME');
  const adminLastName = required('BOOTSTRAP_ADMIN_LAST_NAME');
  // The password is read as-is (not trimmed) and never printed.
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!adminPassword) missing.push('BOOTSTRAP_ADMIN_PASSWORD');
  if (missing.length > 0) throw new BootstrapError(`Missing environment variable(s): ${missing.join(', ')}`);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new BootstrapError('NEXT_PUBLIC_SUPABASE_URL is not a valid URL.');
  }
  const isLocal = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
  if (parsedUrl.protocol !== 'https:' && !isLocal) {
    throw new BootstrapError('NEXT_PUBLIC_SUPABASE_URL must use https (http is allowed only for localhost).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new BootstrapError('BOOTSTRAP_ADMIN_EMAIL is not a valid e-mail address.');
  if (adminPassword.length < MIN_PASSWORD_LENGTH || adminPassword.length > 72) {
    throw new BootstrapError(`BOOTSTRAP_ADMIN_PASSWORD must be ${MIN_PASSWORD_LENGTH} to 72 characters long.`);
  }
  if (adminPassword.trim() !== adminPassword) throw new BootstrapError('BOOTSTRAP_ADMIN_PASSWORD must not start or end with a space.');
  if (orgName.length > 255 || siteName.length > 255) throw new BootstrapError('Organisation and site names must be at most 255 characters.');
  if (siteCode.length > 50 || /\s/.test(siteCode)) throw new BootstrapError('BOOTSTRAP_SITE_CODE must be at most 50 characters without spaces.');
  if (adminFirstName.length > 100 || adminLastName.length > 100) throw new BootstrapError('Admin names must be at most 100 characters.');

  const role = env('BOOTSTRAP_ADMIN_ROLE') || 'admin';
  if (role !== 'admin' && role !== 'super_admin') throw new BootstrapError('BOOTSTRAP_ADMIN_ROLE must be admin or super_admin.');

  return {
    url,
    serviceRoleKey,
    orgName,
    siteName,
    siteCode,
    adminEmail,
    adminFirstName,
    adminLastName,
    adminPassword,
    adminRole: role,
    allowExistingOrgs: env('BOOTSTRAP_ALLOW_EXISTING_ORGS') === 'yes',
    confirm: env('BOOTSTRAP_CONFIRM') === 'yes'
  };
}

function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? `[${e.code}] ` : '';
    return `${code}${typeof e.message === 'string' ? e.message : 'unknown error'}`;
  }
  return String(error);
}

interface Created {
  userId?: string;
  organisationId?: string;
  siteId?: string;
}

async function rollback(db: SupabaseClient, created: Created): Promise<string[]> {
  const leftovers: string[] = [];
  if (created.userId) {
    // Deleting the auth user cascades to the profile, role and site assignment rows.
    const { error } = await db.auth.admin.deleteUser(created.userId);
    if (error) leftovers.push(`auth user ${created.userId} (${describeError(error)})`);
  }
  if (created.siteId) {
    const { error } = await db.from('sites').delete().eq('id', created.siteId);
    if (error) leftovers.push(`site ${created.siteId} (${describeError(error)})`);
  }
  if (created.organisationId) {
    const { error } = await db.from('organisations').delete().eq('id', created.organisationId);
    // Organisations with audit history cannot be deleted (audit rows are immutable).
    if (error) leftovers.push(`organisation ${created.organisationId} (${describeError(error)})`);
  }
  return leftovers;
}

async function main(): Promise<void> {
  const config = readConfig();
  const db = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const existing = await db.from('organisations').select('id', { count: 'exact', head: true });
  if (existing.error) throw new BootstrapError(`Cannot read organisations: ${describeError(existing.error)}. Are the migrations applied?`);
  const orgCount = existing.count ?? 0;
  if (orgCount > 0 && !config.allowExistingOrgs) {
    throw new BootstrapError(
      `The database already has ${orgCount} organisation(s). Use the admin console to add sites and people. ` +
        'Set BOOTSTRAP_ALLOW_EXISTING_ORGS=yes only if you really want another, separate organisation.'
    );
  }

  console.log('Eagle Eye bootstrap');
  console.log(`  Supabase project host: ${new URL(config.url).host}`);
  console.log(`  Organisation:          ${config.orgName}`);
  console.log(`  First site:            ${config.siteName} (${config.siteCode})`);
  console.log(`  First admin:           ${config.adminFirstName} ${config.adminLastName} <${config.adminEmail}> as ${config.adminRole}`);
  if (!config.confirm) {
    console.log('Dry run: nothing was written. Set BOOTSTRAP_CONFIRM=yes to create these records.');
    return;
  }

  const created: Created = {};
  try {
    const user = await db.auth.admin.createUser({
      email: config.adminEmail,
      password: config.adminPassword,
      email_confirm: true,
      user_metadata: { first_name: config.adminFirstName, last_name: config.adminLastName }
    });
    if (user.error || !user.data.user) throw new BootstrapError(`Could not create the admin login: ${describeError(user.error)}`);
    created.userId = user.data.user.id;

    const org = await db.from('organisations').insert({ name: config.orgName }).select('id').single();
    if (org.error || !org.data) throw new BootstrapError(`Could not create the organisation: ${describeError(org.error)}`);
    created.organisationId = (org.data as { id: string }).id;

    const site = await db
      .from('sites')
      // Phone numbers start empty ("not configured"); the admin enters the real ones in /admin.
      .insert({
        organisation_id: created.organisationId,
        name: config.siteName,
        code: config.siteCode,
        police_phone: null,
        emergency_phone: null,
        whatsapp_dispatch_number: null
      })
      .select('id')
      .single();
    if (site.error || !site.data) throw new BootstrapError(`Could not create the site: ${describeError(site.error)}`);
    created.siteId = (site.data as { id: string }).id;

    const profile = await db
      .from('profiles')
      .insert({
        id: created.userId,
        organisation_id: created.organisationId,
        first_name: config.adminFirstName,
        last_name: config.adminLastName,
        is_active: true
      })
      .select('id')
      .single();
    if (profile.error) throw new BootstrapError(`Could not create the admin profile: ${describeError(profile.error)}`);

    const role = await db.from('user_roles').insert({ user_id: created.userId, role: config.adminRole }).select('role').single();
    if (role.error) throw new BootstrapError(`Could not give the admin role: ${describeError(role.error)}`);

    const assignment = await db.from('site_assignments').insert({ user_id: created.userId, site_id: created.siteId }).select('id').single();
    if (assignment.error) throw new BootstrapError(`Could not assign the admin to the site: ${describeError(assignment.error)}`);
  } catch (error) {
    const leftovers = await rollback(db, created);
    if (leftovers.length > 0) {
      console.error('Rollback incomplete. Remove these by hand in the Supabase dashboard:');
      for (const item of leftovers) console.error(`  - ${item}`);
    } else if (created.userId) {
      console.error('Everything created by this run was removed again.');
    }
    throw error;
  }

  console.log('Done.');
  console.log(`  Organisation id: ${created.organisationId}`);
  console.log(`  Site id:         ${created.siteId}`);
  console.log(`  Admin user id:   ${created.userId}`);
  console.log('Sign in at /login with the admin e-mail and the password you set, then finish the site settings in /admin.');
  console.log('Remove BOOTSTRAP_ADMIN_PASSWORD from your shell environment now.');
}

main().catch((error: unknown) => {
  console.error(`Bootstrap failed: ${error instanceof BootstrapError ? error.message : describeError(error)}`);
  process.exitCode = 1;
});
