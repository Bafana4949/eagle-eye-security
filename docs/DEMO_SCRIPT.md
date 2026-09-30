# EAGLE EYE SECURITY OPERATIONS PLATFORM
## Client Demonstration Script for Dawie Boerdery & Aiguille Security

**Target Audience:** Dawie Snyman (Client / Farm Owner), Operations Directors  
**Demonstration Time:** 10 – 15 minutes  
**Demonstration Devices:** 1 Android Phone (Guard role) + 1 Laptop or Tablet (Supervisor role)  

---

### Step 1: System Introduction & Landing Hub (1 Minute)
1. Open the landing page on the laptop: `http://localhost:3000` (or production URL).
2. Show Dawie the unified landing hub:
   > *"Dawie, here is the new Eagle Eye platform. It connects all 4 operational tiers of the business: the Guard Field App, the Supervisor Command Center, the Farm Owner Client Portal, and the Administration Suite."*

---

### Step 2: Device Hardware & Tag Diagnostics (2 Minutes)
1. On the guard smartphone, open `/admin/device-test`.
2. Demonstrate the automated sensor checks:
   - Green checks for Rear Camera, GPS Geolocation (show current GPS accuracy in meters), IndexedDB offline storage, and Service Worker.
3. Tap **"Test Alarm Tone & Vibration"**:
   - The phone sounds the 880Hz square-wave patrol beep and vibrates.
4. Tap **"Test Physical Tag"**:
   - Tap Dawie's physical checkpoint tag against the phone.
   - If compatible, show the green serial number; if it is a 125 kHz button, explain how the app automatically uses the QR fallback without crashing.

---

### Step 3: Checkpoint QR & NFC Enrolment (2 Minutes)
1. Open the **Admin Portal** (`/admin`).
2. Show the configured farm checkpoints (*Hoofhek Ingang*, *Pakstoor Suid*, *Diesel Depot*, etc.).
3. Tap **"Print QR Cards"**:
   - Show the clean, print-ready sheets with high-contrast QR cards and Aiguille Security branding.
4. Tap **"Register / Enrol NFC Tag"** on a checkpoint, tap a tag to the phone, and show how it instantly binds `NFC: 04:5f:a2...` to the checkpoint.

---

### Step 4: Guard Shift Clock-In with Attendance Selfie (1.5 Minutes)
1. On the phone, navigate to `/guard` and select guard *Wag 1 / Sipho Khoza*.
2. Tap the large blue button: **"START SHIFT (SELFIE)"**.
3. Point the phone at yourself, tap the shutter, review the photo, and tap **"Confirm Photo"**.
4. The shift begins. Point out:
   - The **Live Duty Ticker** starts counting seconds.
   - The **Next Patrol Round** countdown begins.
   - The top sync badge shows: `✓ All records synced`.

---

### Step 5: Checkpoint Patrol Verification (2 Minutes)
1. Tap the **Patrol** tab.
2. Tap **"Tap NFC Tag"** and tap a tag (or tap **"Scan QR Card"** and scan one of the printed cards).
3. The phone vibrates with a success chime.
4. The prominent verification card pops up:
   - **✓ CHECKPOINT VERIFIED**
   - *Diesel Depot & Pompe*
   - *Distance from Beacon: 4.2 meters*
   - *GPS Accuracy: ±3m*
5. Switch to the laptop (`/supervisor`):
   - Show Dawie that the supervisor dashboard immediately shows the checkpoint turn green in real-time.

---

### Step 6: South African Vehicle Licence-Disc Scanning (2 Minutes)
1. On the guard phone, tap the **Gate** tab.
2. Tap **"Scan Licence Disc"**.
3. Aim the camera at a South African vehicle licence disc (or demo barcode).
4. The native PDF417 decoder instantly extracts:
   - Registration Number: `ABC 123 MP`
   - Make & Model: `TOYOTA HILUX`
   - Colour: `WHITE`
   - Expiry Date: `30 November 2026`
   - VIN and Engine Numbers
5. The **Confirmation Modal** opens. Tap **"Confirm Information"**.
6. Tap **"Log Vehicle"**.
7. The vehicle is recorded, and the dwell timer begins under **"Vehicles Currently on Farm"**.

---

### Step 7: Incident Reporting with GPS Tagging (1.5 Minutes)
1. Tap the **Incident** tab on the phone.
2. Select **"Fence cut or damaged"** (high contrast red tile).
3. Type: *"Perimeter fence near Dam 2 wire cut; foot tracks observed heading south."*
4. Tap **"Add Photograph"** and snap a quick photo.
5. Tap **"Submit Incident Report"**.
6. Switch to the supervisor screen:
   - The incident appears at the top of the feed with photo and GPS map pin.
   - Type a supervisor note: *"Patrol team dispatched to track footprints; fence team notified"* and tap **"Save Note"**.

---

### Step 8: Offline Power & Network Outage Test (1.5 Minutes)
1. Turn on **Airplane Mode** on the guard phone (disconnect Wi-Fi and mobile data).
2. Point out the sync badge updates to: `Offline — 0 records waiting`.
3. Scan a checkpoint and log a vehicle exit.
4. Show Dawie that the app works smoothly without freezing: `Offline — 2 records waiting`.
5. Turn **Airplane Mode OFF**.
6. Within 3 seconds, the badge turns blue (`Syncing 2 records...`), then green (`✓ All records synced`).
7. Show that zero records were lost and no duplicates were created.

---

### Step 9: Clock-Out & WhatsApp Shift Summary Dispatch (1.5 Minutes)
1. On the phone home screen, tap **"End Shift (Selfie)"**.
2. Take the clock-out selfie and confirm.
3. The **Shift Completed** summary modal pops up with:
   - Site, Guard name, Shift hours
   - Patrol Compliance (100%)
   - Checkpoints scanned, vehicles logged, incidents recorded
4. Tap **"Send Summary to WhatsApp"**:
   - WhatsApp opens with the supervisor's number prefilled and the entire professional operational report ready to send.
5. Tap **"Copy Summary"** to demonstrate clipboard backup.

---

### Conclusion (30 Seconds)
> *"Dawie, what you have just seen is not a prototype. It is a hardened, production-grade security operations system engineered specifically for South African farms and security companies. It works offline, supports both NFC and QR, scans vehicle licence discs natively, and enforces strict accountability."*
