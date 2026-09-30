> **OUTDATED — do not rely on this document.** It was written for the pre-audit version of Eagle Eye and describes features that were fake or have since been removed (e.g. guard PIN login, demo accounts, mock dashboards, "sent/verified" messages). For the current, verified behaviour see [README](../README.md), [FIELD_TEST_CHECKLIST](FIELD_TEST_CHECKLIST.md), [DEPLOYMENT](DEPLOYMENT.md) and [THEME](THEME.md). This manual will be rewritten after field testing.

# EAGLE EYE SECURITY OPERATIONS PLATFORM
## Supervisor Operations Center Manual

**Document Version:** 2.0.0 (Production Release)  
**Target Audience:** Security Supervisors, Control Room Operators, Farm Managers  
**Portal Route:** `/supervisor`  

---

## 1. Overview
The Supervisor Operations Center provides control-room operators and site supervisors with real-time visibility over field operations. It tracks guards on duty, live patrol compliance, gate access dwell times, and provides a unified triage console for security incidents and SOS panic alerts.

---

## 2. Command Dashboard Metrics
At the top of `/supervisor`, four tactical KPI metric cards give an instant status summary:
1. **Guards on Duty:** Count of actively clocked-in security officers.
2. **Patrol Compliance:** Percentage of expected checkpoints successfully verified during the active shift cycle.
3. **Active Alerts / Incidents:** Count of unacknowledged high-severity incidents or SOS panic dispatches.
4. **Vehicles Inside:** Count of vehicles currently logged inside the farm perimeter.

---

## 3. Real-Time Patrol Monitoring
Under **Live Patrol Compliance**:
- The dashboard lists all configured checkpoints.
- Checkpoints scanned during the current round display a green badge: `✓ Verified 21:45 (6.8m)`.
- Checkpoints not yet scanned display an amber badge: `Pending Round Scan`.
- If a patrol round is overdue by more than 10 minutes without a scan, the top banner flashes red:
  `⚠ PATROL ROUND OVERDUE — No scan for 01h 15m. Contact guard on duty.`

---

## 4. Incident Triage & Supervisor Notes
When a security officer reports an incident from the field:
1. The incident card appears at the top of the **Incident Feed**.
2. **Review Evidence:**
   - Incident type icon and category badge (e.g. `Critical: Fence cut or damaged`).
   - Reporting guard name and exact timestamp.
   - Incident description notes.
   - Attached photograph of evidence (cut wire, broken lock, vehicle).
   - GPS coordinates and Google Maps pin link.
3. **Add Supervisor Notes:**
   - Type your operational instructions (e.g. *"Investigated by Supervisor Ndlovu; fence repaired temporarily with barbed wire, owner Dawie notified"*).
   - Tap **"Save Supervisor Note"**.
4. **Acknowledge & Resolve:**
   - Tap **"Acknowledge"** to confirm control-room receipt.
   - Tap **"Mark Resolved"** once the situation has been secured.

---

## 5. Emergency SOS Panic Handling
When a guard activates the press-and-hold SOS panic button:
1. An audible alert sounds in the control room and a high-priority red alert modal triggers.
2. The guard's name, assigned site, and live GPS coordinates are displayed with a high-accuracy radar pin.
3. **Supervisor Actions:**
   - Tap **"Call Guard"** to establish voice communication.
   - Dispatch the armed response backup vehicle to the GPS coordinates.
   - If required, tap **"Call SAPS 10111"** for police tactical backup.
   - Tap **"Acknowledge SOS"** to stop the alarm chime.

---

## 6. Gate Access & Vehicles on Farm
Under **Vehicles on Premises**:
- Displays every vehicle currently inside the farm gate.
- Shows registration plate, vehicle make, colour, driver name, and entry time.
- **Dwell Timer:** Tracks how long each visitor has been inside (e.g., `02h 15m`).
- Allows supervisors to verify whether any contractor has exceeded their expected visit duration.

---

## 7. Generating & Exporting Reports
1. **CSV Data Export:** Tap **"Export CSV"** to download the complete shift audit log for spreadsheet analysis or insurance claims.
2. **WhatsApp Shift Summary:** Tap **"WhatsApp Summary"** to open a formatted operational report ready to send to Dawie or executive management.
