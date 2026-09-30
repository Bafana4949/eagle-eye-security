# EAGLE EYE SECURITY OPERATIONS PLATFORM
## Production Deployment & Infrastructure Guide

**Document Version:** 2.0.0 (Production Release)  
**Target Infrastructure:** Next.js (Vercel) + Supabase (PostgreSQL, Private Storage & Realtime)  
**Git Repository:** `https://github.com/Bafana4949/eagle-eye-security.git`  

---

## 1. Architecture Overview

```
                      [ Client Smartphones / Desktops ]
                                     │
                                     ▼ (HTTPS)
                    ┌─────────────────────────────────┐
                    │    Vercel Edge & Serverless     │
                    │      Next.js 15 App Router      │
                    │   PWA Service Worker & Assets   │
                    └────────────────┬────────────────┘
                                     │
               ┌─────────────────────┴─────────────────────┐
               ▼ (SSL / RLS)                               ▼ (S3 API)
   ┌───────────────────────┐                   ┌───────────────────────┐
   │  Supabase PostgreSQL  │                   │ Supabase Storage (S3) │
   │  • Multi-Tenant RLS   │                   │  • incident-photos    │
   │  • Immutable Audit    │                   │  • vehicle-scans      │
   │  • Realtime Events    │                   │  • private signed URLs│
   └───────────────────────┘                   └───────────────────────┘
```

---

## 2. Prerequisites
1. **Node.js:** v20.x or v22.x LTS installed.
2. **Git:** Configured with access to `https://github.com/Bafana4949/eagle-eye-security.git`.
3. **Supabase Account:** Active project with database access.
4. **Vercel Account:** Free or Pro team plan for web hosting.

---

## 3. Supabase Database & Storage Setup

### A. Run Database Migrations
In your Supabase project dashboard (**SQL Editor**), execute the two migration scripts located in the repository:
1. First, apply [`supabase/migrations/20260930_init_schema.sql`](file:///c:/Users/Bafana%20Bhuda/Downloads/Eagle%20Eye_Aiguille%20Security%20application/eagle-eye-security/supabase/migrations/20260930_init_schema.sql)
   - Creates all enums, tables, foreign keys, and RLS policies.
2. Next, apply [`supabase/migrations/20260930_phase2_hardening.sql`](file:///c:/Users/Bafana%20Bhuda/Downloads/Eagle%20Eye_Aiguille%20Security%20application/eagle-eye-security/supabase/migrations/20260930_phase2_hardening.sql)
   - Configures storage buckets, immutable audit log triggers, and client viewer access.

### B. Verify Storage Buckets
In the Supabase dashboard under **Storage → Buckets**, verify:
- `incident-photos` (Private bucket: enabled)
- `vehicle-scans` (Private bucket: enabled)

---

## 4. Environment Variables Configuration

Create a `.env.local` file (or add to your Vercel Dashboard under **Project Settings → Environment Variables**):

```bash
# =================================================================
# CLIENT SAFE — Public credentials bundled to client browser
# =================================================================
NEXT_PUBLIC_SUPABASE_URL=https://zuqcmqrfdousdcjybycr.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWNtcXJmZG91c2RjanlieWNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NTQ5ODgsImV4cCI6MjEwNjMzMDk4OH0.O_kAVfI1ume-5eBE4qYzGZ2XSTN43Z1XcLcIQgU6N-4

# =================================================================
# SERVER ONLY — Highly sensitive secrets (NEVER expose to browser)
# =================================================================
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWNtcXJmZG91c2RjanlieWNyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDc1NDk4OCwiZXhwIjoyMTA2MzMwOTg4fQ.Qm9Oo6Dq3rBwE30yv_weuj8ysC9aMjIHnow6DrQ82VQ

# =================================================================
# OPTIONAL — Custom Domain & Analytics
# =================================================================
NEXT_PUBLIC_APP_URL=https://eagle-eye-security.vercel.app
```

> [!CAUTION]
> The `SUPABASE_SERVICE_ROLE_KEY` bypasses all Row Level Security. Never prefix it with `NEXT_PUBLIC_` and never commit it to Git.

---

## 5. Deploying to Vercel (Step-by-Step)

1. Open your [Vercel Dashboard](https://vercel.com).
2. Tap **"Add New..." → "Project"**.
3. Select the GitHub repository: `Bafana4949/eagle-eye-security`.
4. In the Project Configuration:
   - **Framework Preset:** Next.js
   - **Root Directory:** `./`
   - **Build Command:** `next build`
   - **Output Directory:** `.next`
5. Expand **Environment Variables** and paste the keys from Section 4:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
6. Tap **"Deploy"**.
7. Vercel will build the production bundle and assign your live production URL (e.g. `https://eagle-eye-security-*.vercel.app`).

---

## 6. Production Verification & Smoke Test
Once the deployment finishes:
1. Open the live URL on an Android smartphone in Google Chrome.
2. Tap the browser menu and select **"Install app"** to test PWA installation.
3. Open `/admin/device-test` to verify Camera, GPS, Web NFC, IndexedDB, and Audio alerts.
4. Log into the Guard portal (PIN `1234`), take a clock-in selfie, and verify the shift begins.
5. In another tab or laptop, open `/supervisor` and verify the active guard on duty is displayed in real-time.

---

## 7. Rollback Procedures
If an issue occurs in production:
1. In the Vercel dashboard, navigate to **Deployments**.
2. Locate the previous successful deployment.
3. Tap the three dots menu (⋮) and click **"Promote to Production"**.
4. The previous stable build is restored in under 5 seconds with zero downtime.
