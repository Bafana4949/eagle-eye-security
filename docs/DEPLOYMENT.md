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
| `20261001000200_patrol_devices.sql` | **apply right after the hardening migration** – see [Step 1b](#step-1b--apply-20261001000200_patrol_devicessql-after-the-hardening-migration-sql-editor) |

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
below. If you start using the Supabase CLI later, first record every file you applied by hand as applied so
the CLI never re-runs them (after Step 1b that includes the patrol-phone migration):
`supabase migration repair --status applied 20260930000000 20260930000100 20261001000000 20261001000200`.

### Option B – Supabase CLI

The live project has no CLI migration history, so a plain `supabase db push` would try to re-run the initial
schema and fail. Record the first two as applied first (phase 2 is superseded by the hardening migration), then
push the hardening migration and the patrol-phone migration (the CLI applies them in version order):

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase migration repair --status applied 20260930000000 20260930000100
supabase db push --dry-run   # must list only 20261001000000 and 20261001000200
supabase db push
```

With the CLI, Step 1b is done by this push; run its verification queries anyway.

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

If query 1 shows any other policy that mentions evidence, re-run the migration (it removes them). **If you
re-run the hardening migration after Step 1b, re-run Step 1b as well** (the hardening file re-grants every
public function to signed-in users; the patrol-phone file puts its own grants back).

---

## Step 1b – Apply `20261001000200_patrol_devices.sql` after the hardening migration (SQL Editor)

This migration adds **patrol phones**: a shared patrol / gate phone that a supervisor (or an admin) has
enrolled for one site. On an enrolled phone guards sign in by **tapping their name** – no e-mail, no password.
Any other phone shows no guard list at all; there everyone signs in with e-mail / username and password.
Admins and supervisors always sign in with e-mail and password.

What it creates:

- table `public.patrol_devices` – one row per enrolled phone (site, label, who enrolled it, last use,
  revoked). It stores only the **SHA-256** of the phone's random device secret, never the secret, and signed-in
  users cannot read even that hash. Admins see the phones of their organisation, supervisors those of their
  assigned sites; guards, client viewers and anon see nothing. Nobody can write the table directly.
- `enrol_patrol_device(site, label)` and `revoke_patrol_device(device)` – for an active org admin, or an
  active supervisor assigned to that site. Both are written to the audit log.
- `device_roster(secret)` and `device_guard_login(secret, guard)` – callable **only with the service-role key**
  (the server routes `/api/auth/device-roster` and `/api/auth/device-login`). A phone gets a guard list and a
  sign-in only for **active guards assigned to its own site** in its own organisation whose **only** role is
  `guard` (anyone who also holds admin, super_admin, supervisor, client_viewer or any later role is never offered
  and never signed in this way). Every approved device sign-in request is audited (`patrol_device.guard_signed_in`).
- Automatic revocation (triggers): a phone is revoked – and stops working on its next request – as soon as the
  person who enrolled it is deactivated, deleted, unassigned from the site, loses the supervisor / admin role, or
  the site is switched off (`patrol_device.revoked` with a `reason`). Switching the person or site back on does
  not revive the phone: enrol it again.
- Guard names are admin-controlled: a guard cannot change their own first or last name (the names are the
  buttons on the patrol phone). Phone number and language stay self-service.

The migration is idempotent (safe to paste twice) and stops with a clear message if the hardening migration
has not been applied yet.

Dashboard → **SQL Editor** → New query → paste the **full** contents of
`supabase/migrations/20261001000200_patrol_devices.sql` → **Run**. Then verify:

```sql
-- 1. Table with RLS on and exactly one policy: expect ee_patrol_devices_select | SELECT | {authenticated}
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'patrol_devices';

-- 2. The secret hash is hidden: expect false / false
select has_column_privilege('authenticated', 'public.patrol_devices', 'secret_sha256', 'SELECT') as signed_in_can_read_hash,
       has_table_privilege('anon', 'public.patrol_devices', 'SELECT') as anon_can_read;

-- 3. Who may call what: expect
--    device_guard_login | f | f | t
--    device_roster      | f | f | t
--    enrol_patrol_device | f | t | f
--    revoke_patrol_device | f | t | f
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as signed_in,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('enrol_patrol_device', 'revoke_patrol_device', 'device_roster', 'device_guard_login')
order by p.proname;
```

If query 3 shows `t` under `signed_in` for `device_roster` or `device_guard_login` (for example because the
hardening migration was pasted again afterwards), paste this migration again. (Even then the two functions
refuse signed-in callers, but the grants should be exact.) If patrol phones report "failed" right after the
migration, the API may not have picked up the new functions yet: wait a minute, or run
`notify pgrst, 'reload schema';` in the SQL Editor.

Covered by `tests/db/patrol-devices.test.ts` (who may enrol / revoke, what each role can read, the roster and
sign-in rules, the audit rows, re-runs, and the live path initial schema → hardening → patrol phones).

---

## Step 2 – Supabase Auth settings

Dashboard → **Authentication**:

1. **Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Staff accounts are created only
   by an admin (step 3 and the Admin screen).
2. **Minimum password length:** 10 or more (email / password settings).
3. **URL Configuration:** Site URL = `https://<your-domain>`; add Redirect URL `https://<your-domain>/auth/reset`
   (the password-reset page).
4. Every guard account still has a username that becomes `<username>@<guard login domain>`
   (default `guards.eagleeye.local`) and a password. On an **enrolled patrol phone** (Step 3b) guards do not
   use them – they tap their name; on any other phone they sign in with username + password. Those addresses
   cannot receive e-mail, so guards cannot use "forgot password": an admin sets a new password (Dashboard →
   Authentication → Users). Staff with real e-mail addresses can use the reset link. For real e-mail volume
   configure custom SMTP (Authentication → SMTP).
5. Patrol-phone sign-in uses a one-time magic-link token that the **server** creates with the service-role key
   and the phone redeems at once; **no e-mail is sent**, so it works for the `guards.eagleeye.local` addresses.
   Leave the **Email** provider enabled (it is also what password sign-in uses). If many guards sign in on
   several patrol phones behind the same mobile connection and some sign-ins fail, check
   **Authentication → Rate Limits** (token verifications).

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

## Step 3b – Enrol each patrol phone

Do this after the app is deployed (Step 5) and the site, its supervisor and its guards exist (Admin → Sites,
Admin → Staff, with each guard **assigned to the site**). Only assigned, active guards appear on a patrol phone.
Repeat for every shared patrol / gate phone; each phone is enrolled for **one** site.

1. On the patrol phone, open the app (installed PWA or Chrome) and sign in on the **Admin & supervisor** tab with
   the e-mail and password of a **supervisor assigned to that site** (or an org admin).
2. Open **Patrol phones** (supervisor: dashboard **Overview** tab, at the bottom; admin: the **Phones** tab in the
   admin console).
3. Tap **Enrol this phone as a patrol phone**, choose the site, give the phone a label you can recognise later
   (for example `Main gate phone` – up to 80 characters), tap **Enrol this phone**, read the confirmation (anyone
   holding the phone can sign in as any guard of the site; never a personal phone) and tap **Enrol and sign out**.
4. The app signs you out on this phone at once and opens the **Guard duty** tab with
   "This phone is now a patrol phone for <site>. You have been signed out: hand the phone to the guards." It shows
   the site, the phone label and one large button per guard. Check that the names are right (two guards with the
   same name look identical – an admin should make the names distinct, e.g. with a middle initial). Hand the
   phone to the guards. (From another device the list shows the phone; on the phone itself it has a **This
   phone** badge.)

Rules to tell the site:

- An enrolled phone is a **shared key to that site's guard accounts**: whoever holds it can sign in as any
  guard on its list. Keep patrol phones on site and under control, and do not enrol personal phones.
- **Never leave a supervisor or admin signed in on a patrol phone.** Enrolling signs you out automatically. If you
  sign in on a patrol phone later (to check the list), the portal shows a red "This is a patrol phone" banner and
  signs you out after 10 minutes without use; the sign-in page then offers only **Sign out**, never "Continue as".
  Tap **Never** if Chrome offers to save your password on a patrol phone.
- **Queued records belong to the person who recorded them, on that phone.** A guard's records that have not
  uploaded yet stay on the patrol phone and upload only when **that guard signs in on that same phone again**,
  within **7 days** (the server refuses older evidence). The **Guard duty** list shows "N record(s) waiting" under
  each name, and the Patrol phones **This phone** card shows the total. **Before a guard is unassigned from the
  site, deactivated, moved to another site or phone, or goes on leave**, have them tap their name on the patrol
  phone with signal and wait until nothing of theirs is waiting.
- **Hand over where there is signal.** Signing in on a patrol phone needs the server. If a guard signs out with no
  signal, nobody – not even that guard – can sign in on the phone, and the SOS button is not available, until
  there is signal again. The app warns before such a sign-out and its default is **Stay signed in**.
- The device secret lives only in this phone's browser storage. Clearing Chrome's site data, uninstalling the app
  or using another browser removes the enrolment **and deletes every guard's records and photos on the phone
  that have not uploaded yet**. First check that the sync pill / the **This phone** card shows nothing waiting,
  then enrol the phone again (and revoke the old entry).
- **A lost or stolen patrol phone must be revoked at once:** Patrol phones → the phone → **Revoke** (from any
  other signed-in device). From then on that phone gets no guard list and cannot sign anyone in. Revoking does
  **not** end a session that is already open on the phone: if a guard was signed in on it, **ask an admin** to
  deactivate that guard in Admin → Staff until the phone is back (supervisors cannot; a deactivated account loses
  all data access at once - and any of that guard's records still on the lost phone are lost with it).
  **Remove enrolment from this phone** (signed in as a manager of the site, with signal) clears this phone's copy
  **and** revokes its server entry; without signal it only clears the copy – then revoke it in the list.
- Phones are revoked automatically when the supervisor who enrolled them leaves the site / is deactivated, or the
  site is switched off. Enrol them again (with a current supervisor) when needed.
- **Fallback when the patrol phone is lost, wiped or revoked:** keep a second enrolled phone in the site office,
  or an admin sets a temporary password for the guard (Admin → Staff / Supabase Dashboard → Authentication →
  Users) so the guard can sign in with username + password on any phone until a supervisor enrols a replacement.
  One-tap sign-in works only on an enrolled phone; that is what keeps the guard list away from strangers.
- A tap on a name shows that someone holding the enrolled phone chose that guard. It is not identity
  verification. The clock-in selfie and GPS position are **attendance evidence for supervisors to review**
  (there is no face recognition), so supervisors should look at clock-in selfies. For one minute after a tap the
  guard home shows "Signed in as <name> – Not you? Switch guard" to catch a gloved mis-tap.
- Enrolment, revocation (manual and automatic) and every **approved** patrol-phone sign-in request are in the audit
  log (`patrol_device.enrolled`, `patrol_device.revoked`, `patrol_device.guard_signed_in`). The sign-in row is
  written when the server approves the request, just before the one-time token is created; refused attempts are
  not audited (they return an error and change nothing).

---

## Step 4 – Vercel environment variables

| Variable | Scope | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | `https://<your-project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | `<your-anon-key>` (or the new publishable key) |
| `NEXT_PUBLIC_GUARD_LOGIN_DOMAIN` | client + server | e.g. `guards.eagleeye.local` (the default when unset). Do not change it once guards exist – their logins depend on it. |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only**, mark Sensitive | `<your-new-service-role-key>` – the **rotated** key. Used only by the server routes `/api/admin/users`, `/api/auth/device-roster` and `/api/auth/device-login` (patrol phones). Without it patrol phones show "server not configured" and guards must use username + password. |
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
4. Patrol phones: enrol one phone (Step 3b), sign out, tap a guard's name on **Guard duty** – you land on
   `/guard` as that guard. On a phone that was never enrolled (or a private browser window) the **Guard duty**
   tab shows no names, only the explanation and the link to password sign-in.
5. On the Android phone: `/admin/device-test` – camera, GPS and NFC tests.
6. Run the full [field test checklist](FIELD_TEST_CHECKLIST.md).

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
