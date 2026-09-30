# EAGLE EYE SECURITY OPERATIONS PLATFORM
## Administrator Configuration & Operations Manual

**Document Version:** 2.0.0 (Production Release)  
**Target Audience:** System Administrators, Security Operations Directors, Site Technicians  
**Portal Route:** `/admin`  

---

## 1. Introduction
The Eagle Eye Administration Portal allows security managers and farm administrators to configure sites, define patrol schedules, enroll and manage checkpoint beacons (QR codes and NFC tags), configure emergency WhatsApp contacts, manage the guard roster, and audit system integrity.

---

## 2. Managing Sites & Shift Schedules
Navigate to **Admin Portal → Site & Shift Schedules** tab:
1. **Site Name & Code:** Define the primary operational facility (e.g. *Dawie Boerdery - Hoofplaas*, code *DW-01*).
2. **Day Shift Hours:** Configure standard daytime schedule (default: `06:00` to `18:00`).
3. **Night Shift Hours:** Configure nighttime schedule (default: `18:00` to `06:00`).
4. **Patrol Round Interval:** Set how frequently guards must complete a perimeter round (`30`, `45`, `60`, `90`, or `120` minutes).
5. **Supervisor WhatsApp Summary Recipient:** Configure the telephone number in international format (e.g., `+27 82 123 4567` or `27821234567`). Shift summaries are pre-filled and sent to this contact.
6. **Emergency Phone:** Primary contact for farm owner / client (e.g. Dawie).
7. Tap **"Save Operations Schedule"** to persist changes.

---

## 3. Checkpoints & Beacon Management
Navigate to **Admin Portal → Checkpoints & QR / NFC** tab:

### A. Creating a New Checkpoint
1. Enter the **Checkpoint Name / Description** (e.g., *Pompstasie Dam 2*).
2. Select the **Validation Radius**:
   - `30 m`: High-precision gate or entrance.
   - `50 m`: Standard building corner or workshop.
   - `75 m`: Open field / orchard perimeter.
   - `100 m`: Distant boundary beacon with tree canopy.
3. Tap **"Generate Checkpoint QR & Beacon"**.
4. The system automatically creates a cryptographically secure random token (e.g. `EE-CP-F48E92B1`), avoiding sequential or predictable tokens.

### B. Enrolling NFC Checkpoint Tags
Eagle Eye supports native Web NFC enrolment directly from the admin smartphone:
1. Find the checkpoint card in the grid.
2. Tap the button: **"Register / Enrol NFC Tag"**.
3. Hold a compatible 13.56 MHz NFC tag (such as an NTAG213 / NTAG215 / NTAG216 plastic disc) against the back of the phone.
4. When the reader detects the tag, the tag's hardware serial number is captured and securely linked to that checkpoint.
5. The button updates to **"Re-enrol NFC Tag"** and displays `NFC: 04:5f:a2...`.

### C. Printing QR Checkpoint Cards
1. From the top header or checkpoint card list, tap **"Print QR Cards"**.
2. The print preview generates a print-ready sheet with:
   - High-contrast, sharp QR codes rendered via SVG/Canvas.
   - Checkpoint number and name in large, bold typography.
   - Distinctive border frame for physical laminate mounting.
   - Branding: *Aiguille Security & Dawie Boerdery*.
3. Use a standard desktop printer, laminate the cards, and mount them at each patrol station.

---

## 4. Hardware Diagnostics Tool (`/admin/device-test`)
Before deploying a new smartphone to a security guard, open the diagnostic suite:
- Navigate to: `https://<your-domain>/admin/device-test`
- The system runs automated hardware and software checks:
  1. **Rear Camera:** Verifies camera hardware, auto-focus, and permission.
  2. **GPS Geolocation:** Measures accuracy in meters and coordinates.
  3. **Web NFC:** Verifies NDEFReader availability, Chrome on Android context, and secure HTTPS.
  4. **PDF417 Barcode Engine:** Validates native `BarcodeDetector` or ZXing multi-scale fallback.
  5. **IndexedDB:** Tests local database read/write speed for offline queueing.
  6. **Service Worker:** Checks offline cache readiness.
  7. **PWA Mode:** Detects whether running inside Chrome or installed on the home screen.
  8. **Interactive Physical Tag Test:** Allows testing the customer's physical tags to verify if they are readable by the phone.
  9. **Audio Synthesizer & Wake Lock Test:** Tests the 880Hz alert tone and screen keep-awake sentinel.

---

## 5. Guard Roster & User Access
Navigate to **Admin Portal → Guard Roster & Users** tab:
1. Enter the guard's full name (e.g. *Thabo Mokoena*).
2. Enter their contact phone number.
3. Tap **"Add Guard"**.
4. The system assigns a unique employee identifier (e.g. `G-104`).
5. Guards can immediately select their name on the Guard Login screen.

---

## 6. Cryptographic Audit Trail
Under the **Audit Trail Logs** tab, the system maintains a tamper-evident audit log:
- Every shift start/end, patrol scan, gate entry, and incident is signed with SHA-256.
- Prevents tampering with scan times or backdating logs.
- Detects if a phone clock was rolled back.
