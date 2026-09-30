# 🦅 Eagle Eye Security Operations System

A professional, production-ready, mobile-first security operations platform built for security guards, supervisors, and estate managers. Inspired by the Aiguille Security / Dawie Boerdery farm patrol system and rebuilt from the ground up with modern offline-first web technologies, relational PostgreSQL database, and cryptographic auditability.

---

## 🌟 Key Capabilities

### 📱 1. Mobile Guard Application (PWA)
- **Installable Progressive Web App (PWA)**: Runs in standalone mode on Android and iOS devices, with offline app shell caching via Service Worker.
- **Biometric Shift Clock-In / Clock-Out**: Enforces compressed photo selfie capture at shift start and end, with client-side downsampling to keep uploads fast and light.
- **Patrol Checkpoint Engine**:
  - Live round calculation based on configurable day/night shift bounds and round intervals.
  - Checkpoint QR card scanning via integrated camera viewfinder, torch toggle, and photo upload fallback.
  - Web NFC tag support on supported Android Chrome devices.
  - GPS distance verification using the Haversine formula against configured beacon coordinates and accuracy tolerances.
- **Vehicle & Gate Access Management**:
  - South African Motor Vehicle Licence (MVL) disc PDF417 decoder extracting license plate, register number, make, model, colour, VIN, engine number, and expiry date.
  - Expiry alert warning guards when a license disc has expired.
  - Vehicle dwell-time tracker showing vehicles currently on premises and automatic duration calculation upon exit.
  - Full manual licence plate entry fallback with validation.
- **Incident Reporting**:
  - 8 operational incident categories: Damaged fence, open gate, livestock issue, suspicious person/vehicle, fire, theft, medical emergency, other.
  - Severity classification (Low, Medium, High, Critical).
  - Attached incident photographs with automatic compression and GPS coordinate stamps.
- **Deliberate SOS Panic Alarm**:
  - 2-second tactile press-and-hold activation with visual progress bar and haptic vibration feedback to prevent accidental triggering.
  - Direct one-touch phone dialers for supervisor and Police (10111).
  - Real-time alert dispatch with exact GPS coordinates.
- **True Offline-First Operation**:
  - Uses IndexedDB (Dexie) rather than fragile `localStorage`.
  - Offline event queue tracking sequence numbers, device timestamps, retry counts, and attached binary media blobs.
  - Automatic idempotent synchronization against Supabase when network connectivity returns.

### 🛡️ 2. Supervisor Operations Command Center
- **Live Guard Tracking**: Real-time status cards showing guards currently on duty, offline guards, last scanned checkpoint, and shift durations.
- **Overdue Patrol Detection**: Alerts when a checkpoint has not been visited within the required round window.
- **Active Emergency Monitoring**: Immediate high-priority banners for SOS panic events and critical incidents with acknowledgment workflows and supervisor note logging.
- **Gate Activity Feed**: Real-time timeline of vehicle movements and dwell times.

### ⚙️ 3. Administrator Portal
- **Site & Shift Configuration**: Configurable day/night shift hours, round intervals (30m, 45m, 60m, 90m, 120m), and emergency phone numbers.
- **Secure Checkpoint Management**:
  - Creates checkpoints with secure, non-predictable random identifiers (`EE-CP-XXXXXX`) instead of guessable sequential numbers.
  - Custom permitted validation radii per beacon (30m, 50m, 75m, 100m).
  - Integrated printable QR cards generator formatted for standard laminating and outdoor placement.
- **Guard Roster**: Manage guard accounts, employee numbers, and contact numbers.
- **Reporting & CSV Exports**: One-click export of patrol scan records, GPS metadata, and compliance percentages.
- **Immutable Audit Trail**: Authoritative event logs tracking critical operations.

### 🌐 4. Trilingual Support
Built-in internationalization with instant switching between:
- 🇿🇦 **Afrikaans**
- 🇬🇧 **English**
- 🇿🇦 **isiZulu**

---

## 🏗️ Technology Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router, Turbopack) |
| **Language** | TypeScript (Strict mode) |
| **Styling** | Tailwind CSS v4 |
| **Icons** | Lucide React |
| **Client Database** | IndexedDB via Dexie v4 |
| **QR Engine** | HTML5-QRCode with canvas image fallback |
| **Backend & Database** | Supabase (PostgreSQL 15+, Auth, Storage, Realtime) |
| **Validation** | Zod v4 |
| **Testing** | Node.js Test Runner with `tsx` |

---

## 🚀 Quick Start & Local Development

### 1. Prerequisites
- Node.js v20+ or v24+
- npm v10+

### 2. Installation
```bash
cd eagle-eye-security
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```
Configure your Supabase credentials:
```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. Database Setup (Supabase)
1. Open your Supabase SQL Editor.
2. Run the migration script located at:
   [`supabase/migrations/20260930_init_schema.sql`](file:///c:/Users/Bafana%20Bhuda/Downloads/Eagle%20Eye_Aiguille%20Security%20application/eagle-eye-security/supabase/migrations/20260930_init_schema.sql)
3. For local or staging demo data, run the seed script:
   [`supabase/seed.sql`](file:///c:/Users/Bafana%20Bhuda/Downloads/Eagle%20Eye_Aiguille%20Security%20application/eagle-eye-security/supabase/seed.sql)
4. In Supabase Storage, create a bucket named `evidence-media` and set appropriate private access policies with signed URLs.

### 5. Running the Application
```bash
# Start local development server
npm run dev

# Run test suite
npm test

# Run TypeScript typecheck
npm run typecheck

# Build for production
npm run build
```

---

## 📲 How Security Guards Install the PWA

### On Android (Google Chrome):
1. Open the deployed application URL in Chrome over HTTPS.
2. Tap the browser menu (three vertical dots in top-right) and select **"Install app"** or **"Add to Home screen"**.
3. Allow camera and location permissions when prompted.
4. Launch Eagle Eye from the home screen for the full app experience.

### On iPhone (Apple Safari):
1. Open the URL in Safari.
2. Tap the **Share** button (box with an upward arrow) at the bottom.
3. Scroll down and tap **"Add to Home Screen"**.
4. Confirm name and tap **Add**.

---

## 🔒 Security & POPIA Compliance

- **Row Level Security (RLS)**: Guards can only view and insert records assigned to their active shifts. Supervisors can oversee their assigned site. Company A cannot access Company B.
- **Private Media Storage**: Photos are not publicly accessible via static predictable URLs. Signed URLs with short expiration are generated for supervisor review.
- **Authoritative Timestamps**: Offline client timestamps are strictly differentiated from authoritative server reception timestamps (`scan_timestamp_device` vs `scan_timestamp_server`) to prevent clock manipulation.
- **POPIA Data Minimisation**: Licence disc VIN and engine numbers are stored securely with restricted access and retained only for the required operational period.

---

## 📁 Project Structure

```
eagle-eye-security/
├── public/
│   ├── manifest.json         # PWA Manifest
│   ├── sw.js                 # Service Worker with offline caching
│   ├── offline.html          # Offline fallback template
│   ├── icon-192.png          # App icon (192x192)
│   └── icon-512.png          # App icon (512x512)
├── src/
│   ├── app/
│   │   ├── (auth)/login/     # Guard PIN & Supervisor login
│   │   ├── guard/            # Mobile Guard Operations
│   │   │   ├── page.tsx      # Guard Dashboard & Clock In/Out
│   │   │   ├── patrol/       # Route checkpoints & QR/NFC scan
│   │   │   ├── gate/         # SA Disc decoding & vehicle access
│   │   │   ├── incident/     # Incident reporting & photo evidence
│   │   │   ├── history/      # Scan history & shift log
│   │   │   └── more/         # Sync status & language settings
│   │   ├── supervisor/       # Real-time Supervisor Command Center
│   │   ├── admin/            # Checkpoints, QR Cards & Site Settings
│   │   ├── layout.tsx        # PWA root layout
│   │   └── page.tsx          # Portal landing & role router
│   ├── components/
│   │   ├── guard/            # BottomNav, HeaderBar, SosPanicModal
│   │   ├── shared/           # QrScannerModal, CameraCaptureModal
│   │   └── ui/               # Button, Card, Badge primitives
│   ├── features/
│   │   └── shifts/           # Shift & round window calculator
│   ├── lib/
│   │   ├── gps/              # Haversine distance & proximity check
│   │   ├── i18n/             # Trilingual dictionaries & hook
│   │   ├── license-disc/     # SA PDF417 MVL disc decoder
│   │   ├── offline/          # Dexie IndexedDB & idempotent sync
│   │   ├── supabase/         # Supabase client & connection helpers
│   │   └── utils/            # Image compression & SHA-256 hash
│   └── types/                # Domain models, offline queue, database types
└── supabase/
    ├── migrations/           # PostgreSQL schema & RLS policies
    └── seed.sql              # Staging / demo seed data
```

---

## 📄 License & Attribution
Built for **Aiguille Security & Dawie Boerdery**, 2026. All rights reserved.
