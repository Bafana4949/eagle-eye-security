# EAGLE EYE SECURITY OPERATIONS PLATFORM
## Guard Operational Field User Manual

**Document Version:** 2.0.0 (Production Release)  
**Target Audience:** Field Security Officers, Gate Guards, Farm Patrol Watchmen  
**Supported Languages:** English, Afrikaans, isiZulu  

---

## 1. Introduction
Eagle Eye is a professional, mobile-first security operations and guard-patrol application. It provides real-time GPS-verified checkpoint patrols, South African vehicle licence-disc gate scanning, start/end shift selfie verification, emergency SOS panic signaling, and automatic offline operation during power or network outages.

---

## 2. Supported Phones & Web Browsers

| Device Type | Recommended Browser | Features Supported |
| :--- | :--- | :--- |
| **Android Phone with NFC** (Samsung, Xiaomi, Nokia, etc.) | **Google Chrome** | Camera, GPS, QR Scanning, Web NFC (13.56 MHz), Offline Sync, Audio Alerts |
| **Android Phone without NFC** | **Google Chrome** | Camera, GPS, QR Scanning, Offline Sync, Audio Alerts |
| **iPhone / iPad** | **Safari** | Camera, GPS, QR Scanning, Offline Sync, Audio Alerts (*Web NFC is not supported by Apple on web apps; use QR cards*) |

> [!NOTE]
> Always open the app in **Google Chrome** (Android) or **Safari** (iPhone). Avoid using inside WhatsApp or Facebook in-app webview frames.

---

## 3. How to Install the PWA on Your Phone

### On Android (Google Chrome):
1. Open the web link provided by your supervisor (e.g. `https://your-domain.vercel.app` or local address).
2. Tap the **three dots menu (⋮)** in the top right corner of Chrome.
3. Tap **"Install app"** or **"Add to Home screen"**.
4. The Eagle Eye eagle logo icon will now appear on your phone home screen like a normal application.

### On iPhone (Safari):
1. Open the link in Safari.
2. Tap the **Share icon** (square with an upward arrow at the bottom).
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **"Add"** in the top right corner.

---

## 4. How to Log In
1. Open Eagle Eye from your home screen.
2. Tap **"Guard Quick Login"**.
3. Enter your assigned 4-digit Guard PIN (default test PIN: `1234` or `4321`).
4. Select your name from the guard roster (e.g., *Wag 1 / Sipho Khoza*).
5. When prompted, tap **"Allow"** for **Camera** and **Location / GPS**.

---

## 5. How to Start Your Shift
1. On the Guard Home screen, tap the large blue button: **START SHIFT (SELFIE)**.
2. Position your face in the camera oval viewfinder.
3. Tap the white camera shutter button to take your clock-in selfie.
4. Review your photograph. If it is clear, tap **"Confirm Photo"**.
5. Your shift begins immediately. The live on-duty ticker starts tracking your shift time.

---

## 6. How to Take a Clear Selfie
- Stand in a well-lit area or turn towards an outdoor floodlight if on night shift.
- Make sure your face and security uniform/cap are clearly visible.
- Hold the phone steady to avoid motion blur.
- *Notice:* A selfie is attendance evidence for Dawie and your supervisor.

---

## 7. How to Start a Patrol Round
1. Check the **Next Patrol** round countdown on your home screen.
2. When the round begins, tap the bottom navigation bar tab: **Patrol**.
3. You will see the list of checkpoints to visit on your farm round (e.g., *Hoofhek Ingang*, *Pakstoor Suid*, *Diesel Depot & Pompe*, etc.).
4. Walk to the physical checkpoint beacon.

---

## 8. How to Scan an NFC Checkpoint Tag
1. On the Patrol screen, tap the purple **Tap NFC Tag** button.
2. The phone will display *"Hold your phone against the checkpoint tag"*.
3. Hold the back of your phone directly against the round plastic checkpoint tag mounted on the wall or fence.
4. When read, the phone vibrates and plays a confirmation chime.
5. The screen displays: **✓ CHECKPOINT VERIFIED** with the checkpoint name, distance from beacon, and GPS accuracy.

---

## 9. How to Scan a QR Checkpoint Card
If your phone does not have NFC or if an NFC tag is damaged:
1. Tap the blue **Scan QR Card** button.
2. Aim the rear camera at the printed checkpoint QR card.
3. If it is dark, tap the **Flashlight / Torch icon** to turn on your phone light.
4. As soon as the QR code enters the viewfinder box, the phone vibrates and confirms: **✓ CHECKPOINT VERIFIED**.

---

## 10. What to Do When NFC Doesn't Work
If you tap the NFC tag and nothing happens:
- Make sure NFC is switched ON in your phone settings: **Settings → Connections → NFC → ON**.
- Remove very thick phone covers or wallet cases that block the antenna.
- If the tag is an older 125 kHz button, tap **Scan QR Card** and scan the printed QR card instead.
- If camera is blocked, tap **"Upload Photo"** to take a picture of the QR card.

---

## 11. How to Scan a Vehicle Licence Disc (Gate Access)
1. Tap the **Gate** tab at the bottom of the screen.
2. Ensure the direction toggle is set to **Vehicle IN**.
3. Tap **"Scan Licence Disc"**.
4. Aim the camera at the rectangular barcode printed on the South African round vehicle licence disc on the windscreen.
5. Keep the barcode flat and illuminated inside the yellow box.
6. The phone decodes:
   - Registration Number (e.g. `ABC 123 MP`)
   - Vehicle Make & Model (e.g. `TOYOTA HILUX`)
   - Vehicle Colour (e.g. `WHITE`)
   - Expiry Date (highlights red if expired)
   - VIN and Engine numbers
7. The verification popup will appear. Check the details and tap **"Confirm Information"**.

---

## 12. How to Manually Enter a Vehicle
If a vehicle has no licence disc or a cracked windscreen:
1. On the Gate screen, tap **"Enter Manually"**.
2. Type the vehicle registration plate into the box.
3. Type the driver's name, company, and reason for visit.
4. Tap **"Log Vehicle"**.

---

## 13. How to Record a Vehicle Exit (Vehicle OUT)
1. On the Gate screen, tap the **Vehicle OUT** toggle.
2. Look at the **"Vehicles Currently on Farm"** list.
3. Tap the vehicle that is leaving.
4. Tap **"Record Exit"**.
5. The system calculates the dwell time (e.g. *On premises for 01h 45m*) and logs the exit.

---

## 14. How to Report an Incident
1. Tap the **Incident** tab in the bottom navigation.
2. Select one of the 8 category buttons:
   - *Fence cut or damaged*
   - *Gate left open or broken*
   - *Livestock missing or loose*
   - *Suspicious person / vehicle*
   - *Fire hazard or smoke*
   - *Theft or break-in*
   - *Medical emergency*
   - *Other incident*
3. Type a brief description of what you observed.
4. Tap **"Add Photograph"** to photograph the damage, cut fence, or suspicious vehicle.
5. Tap **"Submit Incident Report"**. The incident is tagged with your current GPS coordinates.

---

## 15. How to Activate the SOS Panic Alarm
In an emergency (intruders, armed robbery, assault, fire):
1. On any guard screen, locate the red **SOS PANIC** button at the top right.
2. **Press and hold the button firmly for 2 full seconds.**
3. A progress ring fills and the phone vibrates strongly.
4. As soon as you let go:
   - The emergency alert is transmitted with your live GPS location.
   - You can tap **"Call Supervisor"** to speak directly to the operations desk.
   - You can tap **"Call Police (10111)"** to reach the South African Police Service.

---

## 16. How to Send a WhatsApp Shift Summary
1. When your shift ends and you take your clock-out selfie, the **Shift Completed** summary appears automatically.
2. Review the summary (rounds completed, scans, vehicles, incidents).
3. Tap the green button: **"Send Summary to WhatsApp"**.
4. WhatsApp opens with the pre-formatted report ready to send to your supervisor.
5. Tap **Send** in WhatsApp.

---

## 17. How Offline Mode Works
If the mobile network goes down or you have no data:
- Eagle Eye continues to work 100% normally.
- Checkpoints, gate entries, selfies, and incident photos are saved safely on your phone's memory (IndexedDB).
- The top sync badge shows: `Offline — 4 records waiting`.
- You will never lose patrol records because of no reception.

---

## 18. How Synchronization Works
As soon as your phone gets internet or Wi-Fi signal:
- The top badge turns blue: `Syncing 4 records...`.
- In a few seconds, it turns green: `✓ All records synced`.
- You do not need to do anything manually.

---

## 19. How to Clock Out at the End of Your Shift
1. Tap the **End Shift (Selfie)** button on your home screen.
2. Take a clear clock-out selfie.
3. Tap **Confirm Photo**.
4. Send your WhatsApp summary when prompted.
5. Your duty session is closed.

---

## 20. Common Errors & How to Fix Them

| Message on Screen | What It Means | What to Do |
| :--- | :--- | :--- |
| **"Camera access blocked"** | Chrome or Safari does not have camera permission. | Open phone **Settings → Apps → Chrome → Permissions → Camera → Allow**. |
| **"GPS signal not available"** | Phone location is off or indoors. | Turn on phone Location, enable **Precise Location**, and step outside into the open air. |
| **"Unrecognized checkpoint code"** | You scanned a card from another farm. | Scan only the authorized Eagle Eye checkpoint cards for this site. |
| **"NFC scanning not supported"** | Phone does not have Web NFC or is an iPhone. | Use the rear camera to scan the printed checkpoint QR card. |

---

## 21. Phone Settings Troubleshooting Checklist
- **Screen Sleeping:** During shifts, the app uses Screen WakeLock to keep the screen active. Ensure your battery saver is not set to "Ultra Battery Saver".
- **Flashlight in Dark:** When scanning at night, tap the flashlight icon in the camera window.

---

## 22. Safety Guidance for Security Officers
- Always stay alert. Do not look down at your phone while walking in unlit areas.
- When approaching a checkpoint, look around and ensure the perimeter is secure before taking out your phone to scan.
- If you feel threatened, trigger the SOS button immediately. Your safety comes first.
