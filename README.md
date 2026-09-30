# Eagle Eye Security

A mobile web app (installable PWA) for farm security guards, built for Aiguille Security at Dawie Boerdery.
Guards clock in with a selfie and GPS, scan patrol checkpoints (NFC tag or QR card), log vehicles at the gate
(including the South African licence-disc barcode), report incidents with photos and raise an SOS. It keeps
working without signal and uploads when the phone is back online. Supervisors watch live activity and
acknowledge SOS alerts; admins set up sites, checkpoints and staff; clients get a read-only view.

**Status:** built and tested with emulated hardware. It has **not yet been tested on real hardware**: NFC tags,
the camera, GPS, PDF417 licence discs, offline/reconnect on a phone and the WhatsApp hand-off. Run
[docs/FIELD_TEST_CHECKLIST.md](docs/FIELD_TEST_CHECKLIST.md) on a real Android phone before real use.

## Roles

| Role | Sees / does |
| --- | --- |
| `admin`, `super_admin` | The whole organisation: sites, checkpoints (QR cards, NFC tag registration), staff accounts, audit log |
| `supervisor` | Only assigned sites: live activity, SOS alerts (acknowledge), incidents, evidence photos |
| `guard` | Assigned sites: clock in/out, patrol scans, gate log, incidents, SOS |
| `client_viewer` | Read-only, assigned sites; no SOS alerts, no selfies |

Security is enforced in PostgreSQL by Row Level Security policies and triggers, not by the screens.
Sign-in is real Supabase e-mail/password. Guards type a username; a login without `@` becomes
`<username>@<NEXT_PUBLIC_GUARD_LOGIN_DOMAIN>` (default `guards.eagleeye.local`). There is no PIN login.
Accounts are created by an admin (Admin → Staff, server route `/api/admin/users`); nobody can sign up alone.

## How key features work

- **Offline:** records are queued on the phone (IndexedDB) per user and upload only while that same user is
  signed in. Screens show "Saved on this phone" / "Uploaded"; failures are listed with the reason. SOS jumps
  the queue (Queued → Submitted → Acknowledged).
- **Evidence photos** go to the private Storage bucket `evidence-media` under
  `{org}/{site}/{category}/{user}/{uuid}-{field}.jpg`; supervisors open them with short-lived signed links.
  Selfies are resized to about 1024 px JPEG.
- **GPS confidence** is computed by the server: verified / likely / low_confidence / outside / no_fix /
  no_reference.
- **NFC** uses Web NFC (Chrome on Android over HTTPS only; iPhone → QR cards). The app reads the tag's serial
  number and never invents one. Phones hold only SHA-256 fingerprints of tag serials and QR tokens
  (`EE-CP-` + 32 hex). Tag serials are identifiers, not secrets: a cloned tag still cannot get past sign-in,
  site assignment, the active shift, the checkpoint–site match, the server GPS check or the audit log.
  Dawie's old `PLAAS-CP:<code>` cards work only where the site allows legacy QR.
- **WhatsApp:** the app prepares a message and opens WhatsApp; the guard presses Send. The app never claims a
  message was sent.

## Stack

Next.js 16 (App Router) + React 19, TypeScript, Tailwind CSS v4, Supabase (Postgres, Auth, Storage,
Realtime), Dexie (IndexedDB), zxing (PDF417) and html5-qrcode, service worker for offline use.

## Run locally

Requires Node.js 20.9 or newer.

```bash
npm install
```

Create `.env.local` (never commit it):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
# optional
NEXT_PUBLIC_GUARD_LOGIN_DOMAIN=guards.eagleeye.local
# only needed to create staff from the Admin screen locally; server-only, never NEXT_PUBLIC_
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

```bash
npm run dev     # http://localhost:3000
```

Camera, GPS and NFC need HTTPS on a phone; test hardware on a deployed (preview) HTTPS URL.

## Tests

| Command | Covers |
| --- | --- |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm test` | Unit tests that import the production modules (auth, offline sync queue, NFC wrapper, checkpoints, GPS confidence, licence-disc parser, WhatsApp summary, …) |
| `npm run test:db` | Applies the real `supabase/migrations` to PGlite (in-process Postgres, no Docker) and tests RLS, triggers, storage policies and attack cases per role |
| `npm run test:e2e` | Playwright end-to-end flows against a fake Supabase with emulated camera / GPS / NFC (when the suite is present) |
| `npm run build` | Production build |

None of these replace testing on a real phone.

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) – deploying to Supabase + Vercel, including the required security
  steps for the live project (key rotation, migration, test accounts)
- [docs/FIELD_TEST_CHECKLIST.md](docs/FIELD_TEST_CHECKLIST.md) – step-by-step test on a Samsung Android phone
- [docs/THEME.md](docs/THEME.md) – colour tokens and fonts
- Older manuals in `docs/` (user, supervisor, admin, hardware, demo) have not been re-checked against this
  build; where they disagree, the three documents above and the code win.
