<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project constraints

## Sign-in model (owner requirement, 2026-10-01)

- **Guards never type an e-mail or a password on a patrol phone.** Guards work night shifts in the dark, cold
  and rain, often in gloves, on shared patrol / gate phones. On an **enrolled patrol phone** a guard taps their
  name on the **Guard duty** tab of `/login` and lands on `/guard`.
- **Admins and supervisors always sign in with e-mail + password** (the **Admin & supervisor** tab, with
  forgot-password). A manager can never get a session through a patrol phone, and guards can never open
  `/admin` or `/supervisor` (`src/proxy.ts` + `resolveRouteAccess()` + RLS).
- **The roster is only shown to an enrolled phone.** A supervisor assigned to the site (or an org admin), signed
  in on the phone, enrols it for one site (Patrol phones panel → confirmation → RPC `enrol_patrol_device`) and is
  signed out on that phone at once. The phone keeps a random device secret; the database stores only its SHA-256
  (`supabase/migrations/20261001000200_patrol_devices.sql`). Only a request carrying a valid, non-revoked secret
  gets that site's active guards (names only; accounts whose ONLY role is `guard`) from
  `POST /api/auth/device-roster`, and a session for one of them from `POST /api/auth/device-login` (server-side
  service-role magic-link token hash → `verifyOtp`). A phone stops working (and is revoked) as soon as its
  enroller can no longer manage the site or the site is switched off. Any other phone gets e-mail / username +
  password only. Enrolment, revocation and every approved patrol-phone sign-in request are written to
  `audit_logs`; a lost phone is revoked.
- **Shared-phone hand-over:** the next person's session is created first; only then is the previous person
  forgotten on the phone (`src/lib/auth/handOver.ts`) - never a `signOut()` racing the new sign-in. A manager is
  never left signed in on a patrol phone (sign-out after enrolment, only "Sign out" on `/login`, portal banner,
  idle sign-out). Queued records stay per person on the phone and upload only when that person signs in on that
  phone again (within 7 days); the roster shows how many are waiting per guard.
- **The live selfie + GPS at clock-in are attendance evidence** for supervisors to review (stored in `shifts`
  and the private `evidence-media` bucket). They are **not biometric or identity verification** — there is no
  face recognition — so do not describe them as "biometric" in code, UI or docs.
- **Never reintroduce:** a login route that accepts an e-mail or user identity from the client, any shared or
  hard-coded password, an unauthenticated roster, or a "fallback" success when sign-in fails. The reverted
  `/api/auth/guard-login` and `/api/guards/roster` did exactly that (account takeover).
