# Eagle Eye Security – Deployment Guide

Stack: Next.js 16 on Vercel, Supabase (Postgres + Row Level Security, Auth, private Storage, Realtime).
Follow the steps **in order**. Never paste real key values into this file, into Git, or into a chat;
placeholders look like `<your-anon-key>`.

## Current state of the live project (read first)

- The production schema was created by **pasting SQL into the SQL Editor** (checked 2026-09-30): there is
  no `supabase_migrations.schema_migrations` table, **no storage policies** and **nothing in the
  `supabase_realtime` publication**. So only `20260930000000_init_schema.sql` is effectively live; phase 2
  never ran (or failed). The repo's phase-2 file is the Gemini version, which would have opened the
  `evidence-media` bucket to every signed-in user of every organisation — do **not** paste it.
- Four test accounts were created by a Gemini script: `admin@aiguillesecurity.co.za`,
  `supervisor@aiguillesecurity.co.za`, `guard@aiguillesecurity.co.za`, `viewer@dawieboerdery.co.za`.
- The Supabase **service_role key was committed to Git** (commit `8ef252c`, pushed to GitHub). Treat it as
  public. It bypasses all Row Level Security.
- `eagle-eye-security.vercel.app` runs **pre-repair code**.

---

## Step 0 – Security first (do this before anything else)

### 0.1 Rotate the leaked service_role key

Anyone with the leaked key can read and change every row and file. Rotating it is what makes it useless.

In the Supabase Dashboard → **Project Settings → API Keys** (older dashboards: **Settings → API**):

- **If the project shows the new keys** (`sb_publishable_…` / `sb_secret_…`): create a new **secret** key,
  then delete / revoke the old secret key.
- **If the project uses the legacy JWT keys** (`anon` and `service_role`, both starting `eyJ…`): the legacy
  service_role key cannot be rolled on its own. Either
  - (recommended) create new **publishable** and **secret** keys, put them in Vercel (step 4) and your
    local `.env.local`, redeploy, then **disable the legacy JWT-based API keys** – this kills the leaked key; or
  - roll the project's legacy **JWT secret** (Project Settings → JWT Keys). That issues a new anon and
    service_role key **and signs every user out**.

Then update every place that used the old key: Vercel environment variables, your local `.env.local`, any
script or CI secret. The new key goes **only** into `SUPABASE_SERVICE_ROLE_KEY` (server side).

**Purging Git history (optional).** You can remove the key from history with
`git filter-repo --replace-text <file-with-the-old-key>` and then `git push --force` to every branch.
Trade-off: it rewrites every commit hash, everyone must re-clone, open pull requests break, and copies that
already exist (clones, forks, GitHub caches, anyone who pulled) keep the key anyway. **Rotation is mandatory;
purging is only extra tidying.** If you purge, ask GitHub Support to clear cached views of the old commits.

### 0.2 Remove or lock the four test accounts

**For today's field test** you may keep them (they already have profiles, roles and the site assignment the app
needs), but first give each one a **new strong password** (Dashboard → **Authentication → Users** → user →
*Send password recovery* or update the password), because the old passwords were set by a script. They sign in
with the full e-mail address. **Before real operations**, delete or deactivate them as below and create real
staff accounts from the Admin screen.

Dashboard → **Authentication → Users** → for each of the four addresses above: **Delete user**. If deletion is
refused because the account already has records (shifts, scans), instead set a new strong password
(or ban the user) and run:

```sql
update public.profiles set is_active = false
where id in (select id from auth.users where email in (
  'admin@aiguillesecurity.co.za', 'supervisor@aiguillesecurity.co.za',
  'guard@aiguillesecurity.co.za', 'viewer@dawieboerdery.co.za'));
```

Inactive profiles have no data access (enforced by RLS). Keep at least one working admin (step 3) before you
lock the test admin.

### 0.3 Restrict the current Vercel deployment until it is redeployed

The old build must not be used for real work. Options (use one): deploy the repaired build as soon as step 5
is possible; or Vercel → Project → **Settings → Deployment Protection** and protect the deployments (some
options need a paid plan); or temporarily remove the production domain from the project. Rotating the key and
locking the test accounts (0.1, 0.2) already removes the main data risk.

---

## Step 1 – Apply the security migration to the LIVE project

Migrations in `supabase/migrations/`:

| File | Status on live project |
| --- | --- |
| `20260930000000_init_schema.sql` | applied by hand (SQL Editor) |
| `20260930000100_phase2_hardening.sql` | **not effective on live** (no storage policies, no realtime) — do NOT paste it; the hardening migration supersedes it |
| `20261001000000_security_audit_hardening.sql` | **must be applied now** (paste this one file) |

This exact path — initial schema + the live demo data + **only** the hardening migration, pasted twice — is
covered by `tests/db/live-upgrade.test.ts` (bucket private, exactly two scoped storage policies, five realtime
tables, PIN oracle removed, demo tokens rotated, existing accounts still work, anon reads nothing).

The third migration is idempotent (safe to re-run). It drops every old or unknown policy on the app tables and
every storage policy that concerns `evidence-media`, recreates the correct policies, keeps the bucket private,
removes the insecure guard PIN function (`verify_guard_pin`) and `profiles.pin_hash`, pins `search_path` on
security-definer functions, and adds `shifts`, `patrol_scans`, `incidents`, `panic_alerts`, `gate_entries` to the
`supabase_realtime` publication. It also clears the fake NFC serials of the original demo seed and gives the
demo QR checkpoints new tokens: **re-register real NFC tags and reprint QR cards** for any demo checkpoints you
kept.

### Option A – SQL Editor (recommended for this project)

Dashboard → **SQL Editor** → New query → paste the **full** contents of
`supabase/migrations/20261001000000_security_audit_hardening.sql` → **Run**. Then run the verification queries
below. If you start using the Supabase CLI later, first record all three files as applied so the CLI never
re-runs them:
`supabase migration repair --status applied 20260930000000 20260930000100 20261001000000`.

### Option B – Supabase CLI

The live project has no CLI migration history, so a plain `supabase db push` would try to re-run the initial
schema and fail. Record the first two as applied first (phase 2 is superseded by the hardening migration), then
push only the hardening migration:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase migration repair --status applied 20260930000000 20260930000100
supabase db push --dry-run   # must list only 20261001000000
supabase db push
```

### Verify (SQL Editor)

```sql
-- 1. Storage policies. For the evidence bucket only ee_evidence_insert and ee_evidence_select may exist.
select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects';

-- 2. Realtime: expect shifts, patrol_scans, incidents, panic_alerts, gate_entries
select tablename from pg_publication_tables where pubname = 'supabase_realtime';

-- 3. PIN oracle gone: expect 0
select count(*) from pg_proc where proname = 'verify_guard_pin';

-- 4. Bucket private: expect public = false
select id, public, file_size_limit from storage.buckets where id = 'evidence-media';
```

If query 1 shows any other policy that mentions evidence, re-run the migration (it removes them).

---

## Step 2 – Supabase Auth settings

Dashboard → **Authentication**:

1. **Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Staff accounts are created only
   by an admin (step 3 and the Admin screen).
2. **Minimum password length:** 10 or more (email / password settings).
3. **URL Configuration:** Site URL = `https://<your-domain>`; add Redirect URL `https://<your-domain>/auth/reset`
   (the password-reset page).
4. Guards sign in with a username that becomes `<username>@<guard login domain>`
   (default `guards.eagleeye.local`). Those addresses cannot receive e-mail, so guards cannot use
   "forgot password": an admin sets a new password (Dashboard → Authentication → Users). Staff with real e-mail
   addresses can use the reset link. For real e-mail volume configure custom SMTP (Authentication → SMTP).

---

## Step 3 – Create the first admin

After this, all other staff are created in the app: **Admin → Staff → create account** (server route
`/api/admin/users`, which needs `SUPABASE_SERVICE_ROLE_KEY` on the server).

**Option A – `scripts/bootstrap-admin.ts`** (if it is in your checkout). Read the comment at the top of the
script for its exact arguments and environment variables. It needs the project URL and the **new**
service-role key, set only in your local shell (never committed). Run it once from your computer:

```bash
npx tsx scripts/bootstrap-admin.ts   # arguments / env vars: see the script header
```

**Option B – Dashboard + SQL.**

1. Authentication → Users → **Add user → Create new user**: the admin's real e-mail, a strong password,
   **Auto Confirm User** ticked.
2. SQL Editor (runs as the database owner, so the checks meant for app users do not block it):

```sql
-- Organisation: reuse an existing one ...
select id, name from public.organisations;
-- ... or create it:
-- insert into public.organisations (name) values ('<Organisation name>') returning id;

insert into public.profiles (id, organisation_id, first_name, last_name, is_active)
select u.id, '<organisation-id>', '<First name>', '<Last name>', true
from auth.users u where u.email = '<admin-email>';

insert into public.user_roles (user_id, role)
select u.id, 'admin' from auth.users u where u.email = '<admin-email>';
```

Sign in with that e-mail; you should land on `/admin`.

Do **not** run `scripts/setup-test-accounts.ts` or `scripts/seed-db.ts` against the production project: the
first recreates the test accounts removed in step 0.2, the second is for demo data.

---

## Step 4 – Vercel environment variables

| Variable | Scope | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | `https://<your-project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | `<your-anon-key>` (or the new publishable key) |
| `NEXT_PUBLIC_GUARD_LOGIN_DOMAIN` | client + server | e.g. `guards.eagleeye.local` (the default when unset). Do not change it once guards exist – their logins depend on it. |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only**, mark Sensitive | `<your-new-service-role-key>` – the **rotated** key. Used only by `/api/admin/users`. |
| `NEXT_PUBLIC_APP_VERSION` | optional | Best left **unset**: the build then uses the Git commit + build time, so every deploy shows "Update available" on phones. A fixed value suppresses the update prompt. |

**Never** name the service key `NEXT_PUBLIC_…` – that would ship it to every browser. `NEXT_PUBLIC_*` values are
built into the app, so redeploy after changing them.

---

## Step 5 – Deploy

```bash
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_GUARD_LOGIN_DOMAIN production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel --prod
```

`vercel env add` asks for each value; add the same variables for `preview` if you test on preview URLs.
Alternatively push to GitHub with the Vercel Git integration; the production branch then deploys automatically.
Run the quality gates (step 7) before every production deploy.

---

## Step 6 – Post-deploy smoke checks

1. Open `https://<your-domain>` – HTTPS padlock, sign-in page loads.
2. Sign in as each role and check the landing page: admin → `/admin`, supervisor → `/supervisor`,
   guard → `/guard`, client viewer → `/viewer`. A guard who opens `/admin` is sent back to `/guard`.
3. Admin → Staff: create one throw-away guard account (proves the server key works), then deactivate it.
4. On the Android phone: `/admin/device-test` – camera, GPS and NFC tests.
5. Run the full [field test checklist](FIELD_TEST_CHECKLIST.md).

**Rollback:** Vercel → Deployments → previous deployment → Promote to Production. Never roll back to a build
from before the security repair. Vercel does not roll back database migrations.

---

## Step 7 – Quality gates (before each deploy)

```bash
npm run lint
npm run typecheck
npm test          # unit tests (import the production modules)
npm run test:db   # real migrations + RLS in PGlite (in-process Postgres, no Docker)
npm run build
npm run test:e2e  # when the Playwright E2E suite is present (emulated hardware)
```

All must pass. None of them replaces the field test on a real phone.
