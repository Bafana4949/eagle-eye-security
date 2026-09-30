# Eagle Eye Security – Field Test Checklist (Samsung Android + Chrome)

Use this sheet to test the app on a real phone. Everything here has been built and tested only with
emulated hardware so far: **NFC, camera, GPS, PDF417 licence discs, offline/reconnect on a phone and the
WhatsApp hand-off have not yet been tested on real hardware.** This test is that first run. Write down what
you actually see, including exact messages and numbers. A FAIL with a clear note is more useful than a PASS
you are unsure about.

Tester: ____________________ Date: ____________ Phone model / Android version: ______________________

Chrome version (Chrome → ⋮ → Settings → About Chrome): ____________ App URL: _______________________________

---

## Before you start

1. **Use the repaired deployment over HTTPS.** Web NFC, the camera, GPS and offline mode only work on an
   `https://` address. Do **not** test on the old `eagle-eye-security.vercel.app` build until it has been
   redeployed with the repaired code (see `docs/DEPLOYMENT.md`).
2. **Accounts** (created by an admin in Admin → Staff; nobody signs up alone):
   - 1 admin (e-mail login)
   - 1 supervisor, assigned to the test site
   - 2 guards, both assigned to the test site (guard A and guard B; guard B is needed for TEST 20).
     Guards sign in with a short username such as `wag1`; the app turns it into
     `wag1@<guard login domain>` (default `guards.eagleeye.local`). There is no PIN login.
   - 1 client viewer, assigned to the test site
3. **One test site** (Admin → Sites) with: name and code, map position, default radius, day/night shift times,
   round interval, **WhatsApp number** (a South African mobile you can see, e.g. your second phone),
   **emergency / control-room number** (use your own number for testing), police number (empty = 10111).
4. **At least 2 checkpoints** on that site (Admin → Checkpoints): one with a printed QR card
   (`EE-CP-…`), one for Dawie's NFC tag. Capture each checkpoint's position while standing at it
   (use the current-location button; accept only a fix with good accuracy).
5. **Phone settings:** Settings → Connections → **NFC and contactless payments ON**; **Location ON**
   (Settings → Location, with Google Location Accuracy on); WhatsApp installed; volume up.
6. **A second device** (laptop or phone) signed in as the supervisor on `/supervisor` for TEST 14 and to
   watch live updates.
7. **Supabase Dashboard access** (Table Editor + Storage) to check what reached the server.
8. **Physical items:** Dawie's NFC tag(s); one spare NFC tag that is **not** registered; a vehicle with a
   South African licence disc; a torch; a printed QR checkpoint card.

**NFC tips for Samsung:** the NFC antenna is on the back, roughly in the middle. Hold the tag flat against the
back of the phone and keep it still for 1–2 seconds. If Android shows its own "tag scanned / no app" pop-up,
the app was not listening at that moment – tap the app's Start NFC button first.

**Where to verify in Supabase (general):** Dashboard → Table Editor → table → sort by `created_at`
descending. Photos: Dashboard → Storage → `evidence-media` (a **private** bucket) → folder
`<organisation id>/<site id>/<selfie|incident|vehicle|patrol>/<user id>/`. Database `*_url` columns hold the
storage **path**, not a web link; the supervisor screen opens photos with short-lived signed links.

---

### TEST 1 – Install the app (PWA)

**Preconditions:** Chrome on the phone; app URL known; not yet installed.

**Steps:**
1. Open the app URL in Chrome.
2. Tap ⋮ (menu) → **Install app** (or **Add to home screen** → Install).
3. Go to the home screen and open **Eagle Eye**.

**Expected result:** An "Eagle Eye" icon appears on the home screen. It opens full screen without the Chrome
address bar and shows the sign-in page (or the guard home when already signed in).

**Where to verify in Supabase:** nothing to check.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 2 – Camera permission

**Preconditions:** TEST 1 done. Signed in as admin.

**Steps:**
1. Open `/admin/device-test` (Admin → device test link).
2. Tap the camera test button. When Chrome asks for the camera, tap **Allow**.
3. Read the result. Then sign out, sign in as guard A and start the clock-in (TEST 3) to confirm the guard
   side also gets the camera.

**Expected result:** A success message with the camera name, resolution and facing direction. No second
permission prompt later. If you tapped Block: the app says the camera is blocked and offers
**Use the phone's camera** instead (fix: Chrome → lock icon → Permissions → Camera → Allow).

**Where to verify in Supabase:** nothing to check.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 3 – Selfie clock-in

**Preconditions:** Signed in as guard A, online, not on duty. Location allowed (or allow when asked).

**Steps:**
1. On Home tap the round **Clock in** button (Selfie + GPS).
2. Confirm the shift shown under **Start shift** → **Continue – take selfie**.
3. Take the selfie → **Use photo**. Wait while it gets your location (or note if you had to tap
   **Save without location**).
4. Watch the clock-in status line.

**Expected result:** "Clocked in at HH:MM – …", Home shows **On duty since …**. The clock-in line changes
from "saved on this phone – will upload when online" to "received by the server" / "on the server".
"Location recorded (±N m)" shows the accuracy.

**Where to verify in Supabase:** `shifts` – new row for guard A, `status = active`, `actual_start` set,
`start_latitude/start_longitude` filled, `start_selfie_url` = a path. Storage `evidence-media/…/selfie/<guard A id>/`
has a `.jpg` (about 1024 px on the long side, usually well under 400 KB).

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 4 – GPS

**Preconditions:** Location on. Outdoors with open sky.

**Steps:**
1. As admin: `/admin/device-test` → GPS test. Allow location if asked. Note the accuracy (±m) and age.
2. As guard: look at the GPS status on Home / Patrol ("GPS ready ±N m" / "Waiting for GPS…").
3. Walk indoors and repeat step 1.

**Expected result:** Outdoors a fix within about 30 s, accuracy typically ±3–15 m. Indoors accuracy gets
worse (larger ±) or the app says it is waiting / the position is old. The app never shows a position without
an accuracy value.

**Where to verify in Supabase:** nothing for this step (positions are stored with the records in later tests).

**Actual result:** outdoors ±_____ m   indoors ±_____ m

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 5 – QR checkpoint scan

**Preconditions:** Guard A on duty (TEST 3). Printed `EE-CP-…` QR card of a checkpoint on this site. Online.

**Steps:**
1. Home → **Scan checkpoints** (or bottom bar → **Patrol**).
2. Check the checkpoint list line ("N checkpoints, up to date").
3. Tap **Scan QR card**, allow the camera, point at the card. (If it will not focus: **Scan from photo**.)

**Expected result:** "<Checkpoint> scanned at HH:MM" via **QR card**, a GPS line (for example "At the checkpoint:
N m away, ±N m" – marked "Phone estimate – the server re-checks"), then "Saved on this phone" → "Uploaded to the
server". The checkpoint is ticked in **This round**. Scanning the same card again within 2 minutes shows
"… was already scanned at …" and records nothing new.

**Where to verify in Supabase:** `patrol_scans` – one new row: `method = qr`, `checkpoint_id` = that checkpoint,
`payload_verified = true`, `gps_confidence` filled by the server, `distance_to_checkpoint_meters`,
`accuracy_meters`, `scan_timestamp_device` and `scan_timestamp_server`.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 6 – Dawie's real NFC tag (device test, nothing is saved)

**Preconditions:** Admin signed in, NFC on in Android settings, Dawie's tag in hand. The expected tag is a
Shanghai Fudan Microelectronics tag: NfcA + Ndef, ISO/IEC 14443-A, 13.56 MHz, 7-byte UID, ATQA 0x4400, SAK 0x00.

**Steps:**
1. Open `/admin/device-test`. Check the NFC support line says NFC is supported.
2. Tap **Start NFC test**. If Chrome asks to allow NFC, tap **Allow**.
3. Hold the tag flat against the middle of the phone's back for 1–2 s.
4. Write down the serial number, the number of records and the time shown.
5. Repeat steps 2–3 twice with the same tag.

**Expected result:** The result shows the read time (SAST), the raw serial and the normalised serial number:
**7 bytes** separated by colons, e.g. `04:a2:3b:1c:5d:80:00` (14 hex digits; the first byte is the chip-maker
code, so it may not be `04` – Fudan's registered code is `1d`). The same tag gives the **same serial every
time**. The record list shows each NDEF record (type, text) or "no records" for an empty tag. A mapping line
says whether the tag is registered to a checkpoint. If Chrome gives no serial the app shows an error and tells
you to use QR – it never invents a serial.

**Where to verify in Supabase:** nothing is written by this test.

**Actual result:** serial `__:__:__:__:__:__:__` records: ____ time: ________ same serial 3×? ☐ yes ☐ no

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 7 – Register the NFC tag on a checkpoint

**Preconditions:** Admin signed in on the phone (registration needs the phone's NFC). Online. TEST 6 passed.

**Steps:**
1. Admin → **Checkpoints** → choose the test site.
2. On the checkpoint for this tag tap **Register NFC tag** (says **Replace tag** if one is already registered).
3. Hold the tag to the phone until the dialog shows the serial and confirms.
4. If the tag is already registered to another checkpoint, the dialog offers to move it here – only accept if
   that is what you want.
5. Tap **Test tag** and read the tag again.

**Expected result:** The checkpoint shows "tag registered" with the registration time; the serial matches
TEST 6. **Test tag** reports that the tag belongs to this checkpoint.

**Where to verify in Supabase:** `checkpoints` – that row has `nfc_uid_sha256` filled, `nfc_enrolled_at`
and `nfc_enrolled_by` (your admin id) set. `audit_logs` has an entry for the change. Guards' phones only ever
receive the SHA-256 fingerprint, not the serial.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 8 – Guard scans the registered tag

**Preconditions:** TEST 7 done. Sign out admin, sign in as guard A, on duty. Online. Stand at the checkpoint.

**Steps:**
1. Patrol → pull the list fresh ("N checkpoints, up to date"; reopen Patrol if it says "from this phone").
2. Tap **Start NFC patrol** ("NFC is on – hold the phone against a tag").
3. Hold the registered tag to the phone.

**Expected result:** "<Checkpoint> scanned at HH:MM" via **NFC tag**, a GPS line, then "Uploaded to the
server". The round list ticks this checkpoint. A second tap within 2 minutes says "already scanned" and records
nothing.

**Where to verify in Supabase:** `patrol_scans` – new row `method = nfc`, right `checkpoint_id`,
`payload_verified = true`, `gps_confidence` set.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 9 – Wrong / unregistered NFC tag

**Preconditions:** Guard A on duty, Patrol open, NFC patrol started. A tag that is **not** registered to this site.

**Steps:**
1. Hold the unregistered tag to the phone.
2. (Optional) Hold a bank card: it is not an NDEF tag, so the app may only say "Hold the phone still
   against the tag".

**Expected result:** "Unknown tag – not registered at this site. Scan not recorded." (or a read error for a
non-NDEF card). The round list does not change.

**Where to verify in Supabase:** `patrol_scans` – **no** new row.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 10 – GPS radius (inside, edge, outside, poor accuracy)

**Preconditions:** A checkpoint with a captured position and a known radius (e.g. 50 m). Its QR card (or the
loose NFC tag before it is mounted) so you can scan it away from the checkpoint. Guard A on duty.
Wait more than 2 minutes between scans of the same checkpoint (duplicate rule).

The server decides the verdict from distance **d**, reported accuracy **a** and radius **r**:
`d + a ≤ r` → verified; `d ≤ r` and `a ≤ r` → likely; `d − a > r` → outside; otherwise low_confidence;
no fix → no_fix; checkpoint without a position → no_reference.

**Steps:**
1. **Inside:** stand at the checkpoint in the open. Scan.
2. **Near the edge:** stand about r metres away. Scan.
3. **Outside:** walk about 200 m away. Scan.
4. **Poor accuracy:** go indoors (accuracy worse than r). Scan.

**Expected result:**
1. "At the checkpoint" (verified) or "Probably at the checkpoint" (likely).
2. "Probably at the checkpoint" or "GPS too inaccurate to confirm", depending on accuracy.
3. "Outside checkpoint area: ~200 m away".
4. "GPS too inaccurate to confirm" – **never** "At the checkpoint" when ± is larger than the radius.
All four scans are still recorded (the verdict is evidence, not a block).

**Where to verify in Supabase:** `patrol_scans` – 4 rows; `gps_confidence` = verified/likely, likely/low_confidence,
outside, low_confidence; `distance_to_checkpoint_meters` and `accuracy_meters` match what the phone showed.

**Actual result:** 1 ______ 2 ______ 3 ______ 4 ______

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 11 – Physical South African licence disc (PDF417)

**Preconditions:** Guard A on duty. A vehicle with a current SA licence disc (the "MVL" disc with the stacked
PDF417 barcode). Torch.

**Steps:**
1. Bottom bar → **Gate** (`/guard/gate`) → **Scan licence disc**. Allow the camera.
2. Hold the phone 10–20 cm from the barcode, keep still; turn the phone sideways if needed.
3. **Low light:** repeat at dusk/in shade. When it says "Too dark", tap **Torch on**.
4. **Blurred attempt:** move the phone quickly / hold it too close so the barcode is blurred.
5. If live scanning fails: **Scan from photo**; last resort **Type the number**.

**Expected result:** "Licence disc read" and the fields that are on the disc: plate, register number, vehicle
type (description), make, model, colour, VIN, engine number, expiry. Fields missing on the disc stay empty
(nothing is invented). You can correct any field. An expired disc shows **EXPIRED**. A blurred picture gives
**no** result (or "No barcode found…") – never wrong data. Manual entry always works. The app says "read",
never "verified" (the barcode does not prove the disc is genuine).

**Where to verify in Supabase:** after saving in TEST 12: `gate_entries` – `is_disc_scanned = true`,
`license_plate`, `register_number`, `vin_number`, `engine_number`, `disc_expiry_date` as read.

**Actual result:** good light ☐ read  low light + torch ☐ read  blurred ☐ no false read

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 12 – Vehicle IN / OUT

**Preconditions:** TEST 11 disc read (or type a plate). Guard A on duty. Online.

**Steps:**
1. Direction **In** → check the details → optional photo → **Save vehicle IN**.
2. Check **Vehicles on site**: the vehicle shows "In since HH:MM".
3. Try **Save vehicle IN** again for the same plate: the "Vehicle already on site" dialog must appear → Cancel.
4. Wait at least 3 minutes. Pick the vehicle from **Vehicles on site**, direction **Out** → **Save vehicle OUT**.

**Expected result:** "Vehicle IN recorded: <plate>", status "Saved on this phone" → "Received by server.".
OUT shows "Booked in HH:MM – N min on site" and "Time on site: …"; the vehicle leaves the on-site list.

**Where to verify in Supabase:** `gate_entries` – an `in` row and an `out` row; the OUT row has
`linked_entry_id` = the IN row and `dwell_duration_seconds` ≈ the time shown. Vehicle photo (if taken) under
`evidence-media/…/vehicle/<guard id>/`.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 13 – Incident with photo

**Preconditions:** Guard A signed in (on duty links the report to the shift). Online.

**Steps:**
1. Bottom bar → **Incident** (`/guard/incident`, "Report incident").
2. Choose **What happened?** and **How serious?**, type a short description.
3. **Take photo (optional)** → take it → **Use photo**.
4. **Save report**.
5. On the supervisor device open the incident and its photo. As client viewer, check the incident is visible.

**Expected result:** "Report saved" with a Record ID, status "Saved on this phone" → "Received by server".
Supervisor sees the incident and the photo loads. Client viewer sees it read-only.

**Where to verify in Supabase:** `incidents` – new row (type, severity, `shift_id`, location);
`incident_media` – row with `media_url` = a storage path; file under `evidence-media/…/incident/<guard id>/`.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 14 – SOS (hold 2 seconds)

**Preconditions:** Guard A on duty on the phone. Supervisor signed in on the second device at `/supervisor`
(tap the page once so it may play sound). **Do not press "Call police" during the test.**

**Steps:**
1. Tap **SOS** → the **Emergency SOS** screen opens.
2. **Quick tap** on **HOLD FOR SOS** and let go at once.
3. Now **press and hold for 2 seconds** (countdown "Keep holding… N s").
4. Watch the status on the phone.
5. On the supervisor device: find the active SOS → **Acknowledge**.
6. Watch the phone again. Check that the client viewer does **not** see the SOS.

**Expected result:**
- Step 2: "Released too early – no alert was raised." Nothing recorded.
- Step 3–4: "SOS raised", time, Alert ID, then **Queued on this phone** → **Submitted to control room** →
  "Waiting for someone to acknowledge it."
- Step 5–6: supervisor sees the alert (alarm/announcement). Phone then shows
  **Acknowledged by <supervisor> at HH:MM**. Client viewer sees no SOS.
- **Send WhatsApp alert** opens WhatsApp with a message (you press Send); **Call control room** dials the site
  number.

**Where to verify in Supabase:** `panic_alerts` – exactly **one** new row (none for the quick tap);
after step 5 `status = acknowledged`, `acknowledged_by` = supervisor, `acknowledged_at` set by the server.

**Actual result:** quick tap ☐ nothing  Queued ☐ Submitted ☐ Acknowledged ☐

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 15 – Go offline (airplane mode)

**Preconditions:** Guard A on duty, Patrol opened once online (so the checkpoint list is on the phone).

**Steps:**
1. Turn on **Airplane mode**. Make sure Wi-Fi is off too.
2. Pull down quick settings: if NFC turned off with airplane mode, turn **NFC** back on (keep airplane mode).
3. Look at the sync indicator in the app header and open its details.

**Expected result:** The app keeps working. The header shows you are offline; the sync details show the
pending count (0 so far). No error pages.

**Where to verify in Supabase:** nothing yet.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 16 – Scan while offline (NFC + QR)

**Preconditions:** TEST 15 (still offline). More than 2 minutes since the last scan of each checkpoint.

**Steps:**
1. Patrol shows "N checkpoints from this phone, saved …".
2. **Start NFC patrol** → scan the registered tag.
3. **Scan QR card** → scan the QR card.
4. Also save one incident (TEST 13 steps, with photo) and one vehicle IN.

**Expected result:** Each scan shows "<Checkpoint> scanned at HH:MM" and "Saved on this phone – will upload
when online". GPS still works (it does not need data; the first fix may be slower). An unknown tag is still
rejected. The pending count in the sync details goes up (4 in this test).

**Where to verify in Supabase:** these rows must **not** exist yet.

**Actual result:** pending count: ______

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 17 – Close and reopen the app while offline

**Preconditions:** TEST 16 done, still offline, records pending.

**Steps:**
1. Open Android's recent apps and swipe Eagle Eye away.
2. Open **Eagle Eye** from the home screen (still offline).

**Expected result:** The app opens (not a Chrome "no internet" page), guard A is still signed in
("Signed in offline. Records stay on this phone until you are online again."), the shift is still running and
the pending count is the same as before.

**Where to verify in Supabase:** still nothing.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 18 – Reconnect and sync

**Preconditions:** TEST 17 done, records pending.

**Steps:**
1. Turn **Airplane mode off** (mobile data or Wi-Fi on).
2. Keep the app open. Open the sync details; tap **Sync now** if nothing happens within a minute.
3. Open Patrol / incident / gate: each record's status.

**Expected result:** The pending count drops to 0. Records change to "Uploaded to the server" /
"Received by server". If the server refuses a record, it is listed as failed **with a reason** and a
retry button – it is never silently dropped.

**Where to verify in Supabase:**
- `shifts` – guard A's shift still `active` (or `completed` after clock-out)
- `patrol_scans` – the offline NFC + QR scans (`scan_timestamp_device` = when scanned,
  `scan_timestamp_server` = when uploaded, so the delay is visible)
- `incidents` + `incident_media`; `gate_entries`; `panic_alerts` (from TEST 14)
- Storage `evidence-media` – the incident / vehicle photos from TEST 16
- No duplicates: every record appears exactly once.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 19 – WhatsApp shift summary

**Preconditions:** Guard A has done the tests above in this shift. Online (so everything is uploaded).
The site WhatsApp number is set in Admin → Sites. WhatsApp installed.

**Steps:**
1. Home → **Shift summary for WhatsApp** (after clock-out: **Last shift summary for WhatsApp**).
2. Check **WhatsApp to: …** is the site's number from Admin.
3. Read the summary and compare it with what you did: checkpoints scanned / round completion, incidents,
   SOS, vehicles in / out, clock-in time.
4. Tap **Open in WhatsApp**. In WhatsApp, check the chat and text, then press **Send** yourself.

**Expected result:** Status "Summary prepared. It has not been sent." → after step 4
"Opened in WhatsApp. Press Send in WhatsApp to send it." The app never says "sent". Numbers match reality
(completion shows "–" when nothing was due, not 100 %). If records are still waiting to upload, a warning
says how many. No number set → the app says so and offers **Copy summary**.

**Where to verify in Supabase:** nothing is written; compare the counts with the rows in TEST 18.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 20 – Second guard on the same phone (queue isolation)

**Preconditions:** Guard A and guard B exist and are assigned to the site. Guard A signed in on the phone.

**Steps:**
1. Guard A: turn on airplane mode, scan a checkpoint and save an incident (2 records pending).
2. Still offline, guard A signs out. The app warns that records are not uploaded → choose to sign out anyway.
3. Turn airplane mode off. Sign in as **guard B**.
4. Open guard B's sync details. Wait 2 minutes.
5. Sign out B, sign in as guard A again, wait for sync.

**Expected result:** Step 4: guard B's pending count is 0; the details mention records from **another account**
on this phone; none of A's records upload while B is signed in and B cannot see them in history. Step 5: A's 2
records upload under guard A.

**Where to verify in Supabase:** after step 4: **no** new `patrol_scans` / `incidents` rows for either guard
from step 1. After step 5: the rows exist with `guard_id` = guard A.

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

### TEST 21 – App update

**Preconditions:** App installed and open. Someone redeploys the app (any new Vercel deployment; leave
`NEXT_PUBLIC_APP_VERSION` unset or change it, otherwise the version does not change).

**Steps:**
1. After the new deployment is live, bring the app to the front (or reopen it). Wait up to a minute.
2. When **Update available** appears, tap **Later** once, then open it again and tap **Reload**.

**Expected result:** The banner "Update available" appears with **Reload** and **Later**. Reload loads the new
version; records saved on the phone are kept (pending count unchanged) and you stay signed in.

**Where to verify in Supabase:** nothing to check. (Vercel → Deployments shows the new deployment.)

**Actual result:** ____________________________________________________________

**PASS / FAIL:** ☐ PASS ☐ FAIL

**Notes:** ____________________________________________________________

---

## Summary

| Test | PASS | FAIL | Short note |
| --- | --- | --- | --- |
| 1 Install | ☐ | ☐ | |
| 2 Camera permission | ☐ | ☐ | |
| 3 Selfie clock-in | ☐ | ☐ | |
| 4 GPS | ☐ | ☐ | |
| 5 QR checkpoint | ☐ | ☐ | |
| 6 Dawie NFC tag | ☐ | ☐ | |
| 7 Register tag | ☐ | ☐ | |
| 8 Guard NFC scan | ☐ | ☐ | |
| 9 Unknown tag | ☐ | ☐ | |
| 10 GPS radius | ☐ | ☐ | |
| 11 Licence disc | ☐ | ☐ | |
| 12 Vehicle IN/OUT | ☐ | ☐ | |
| 13 Incident photo | ☐ | ☐ | |
| 14 SOS | ☐ | ☐ | |
| 15 Offline | ☐ | ☐ | |
| 16 Offline scans | ☐ | ☐ | |
| 17 Reopen offline | ☐ | ☐ | |
| 18 Sync | ☐ | ☐ | |
| 19 WhatsApp summary | ☐ | ☐ | |
| 20 Second guard | ☐ | ☐ | |
| 21 App update | ☐ | ☐ | |

**Security notes for testers:** NFC tag serials are identifiers, not secrets – a tag can be cloned. A cloned
serial still cannot get past sign-in, site assignment, the active shift, the checkpoint–site match, the
server's GPS verdict or the audit log. Dawie's old `PLAAS-CP:<code>` cards only scan when the site allows legacy
QR and the checkpoint has that legacy code; they are marked "legacy – not verified by the server".
