> **OUTDATED — do not rely on this document.** It was written for the pre-audit version of Eagle Eye and describes features that were fake or have since been removed (e.g. guard PIN login, demo accounts, mock dashboards, "sent/verified" messages). For the current, verified behaviour see [README](../README.md), [FIELD_TEST_CHECKLIST](FIELD_TEST_CHECKLIST.md), [DEPLOYMENT](DEPLOYMENT.md) and [THEME](THEME.md). This manual will be rewritten after field testing.

# EAGLE EYE SECURITY OPERATIONS PLATFORM
## Hardware & Checkpoint Beacon Compatibility Guide

**Document Version:** 2.0.0 (Production Release)  
**Target Audience:** Hardware Technicians, Procurement Officers, Security Consultants  

---

## 1. Executive Summary

A critical aspect of deploying a modern digital patrol system is understanding the technical difference between **NFC (Near Field Communication)** and **legacy RFID (Radio Frequency Identification)** tags. 

Modern commercial smartphones equipped with Google Chrome support **Web NFC**, which operates strictly at **13.56 MHz (High Frequency)**. They **CANNOT** directly read legacy **125 kHz (Low Frequency)** guard patrol buttons or proprietary access control keyfobs.

This guide provides the technical specifications, compatibility matrices, and procurement guidelines for Dawie Boerdery and Aiguille Security.

---

## 2. Technical Comparison: NFC vs. RFID

| Specification | 13.56 MHz Web NFC (Supported) | 125 kHz Legacy RFID (Requires QR Fallback) | UHF 860-960 MHz RFID (Unsupported) |
| :--- | :--- | :--- | :--- |
| **Operating Frequency** | **13.56 MHz** (HF) | **125 kHz** (LF) | **860 – 960 MHz** (UHF) |
| **Standard Protocols** | ISO/IEC 14443 Type A/B, NDEF, ISO 15693 | EM4100, TK4100, T5577, HID Prox | EPC Gen2, ISO 18000-6C |
| **Read Range** | 1 to 4 cm (touch / tap) | 2 to 10 cm | 1 to 12 meters |
| **Read by Smartphone Browser?** | **YES** (Android + Chrome via Web NFC API) | **NO** (Phone antennas do not emit 125 kHz) | **NO** (Requires specialized UHF gun readers) |
| **Typical Physical Form** | NTAG213 / NTAG215 / NTAG216 plastic coin/disc | Metal-encased guard baton buttons, Dallas iButtons | Windscreen toll tags, pallet tags |

---

## 3. Platform & Browser Compatibility Matrix

| Phone Platform | Browser / Environment | Web NFC Support | QR Code Support | Recommended Field Workflow |
| :--- | :--- | :---: | :---: | :--- |
| **Android Smartphone with NFC** | **Google Chrome (v89+)** | **FULL SUPPORT** | **FULL SUPPORT** | Primary: Tap 13.56 MHz NFC Tag<br>Backup: Scan QR Card |
| **Android Smartphone with NFC** | Samsung Internet / Opera | Not Exposed | FULL SUPPORT | Scan QR Card (or switch to Chrome) |
| **Android Smartphone without NFC** | Google Chrome | Not Available | **FULL SUPPORT** | Scan QR Card |
| **Apple iPhone (iOS 15–18+)** | Safari / PWA Standalone | *Blocked by Apple* | **FULL SUPPORT** | Scan QR Card |
| **Desktop / Laptop** | Chrome / Edge | Not Available | Camera / File | Management / Control Room |

> [!IMPORTANT]
> Apple strictly restricts the Web NFC API on iOS browsers. Therefore, on iPhones, Eagle Eye automatically disables the NFC button and provides the high-performance camera QR scanner without crashing.

---

## 4. How to Test Dawie's Existing Physical Tags

To determine whether Dawie's existing physical checkpoint tags can be read by phone NFC:

1. Take an Android smartphone with NFC enabled (e.g. Samsung Galaxy A series, Xiaomi Redmi, Nokia G series).
2. Open **Google Chrome** and navigate to:
   `https://<your-domain>/admin/device-test`
3. Scroll down to **"Interactive Physical Tag Test"**.
4. Tap the button: **"Test Physical Tag"**.
5. Hold Dawie's physical checkpoint tag firmly against the center-back of the phone for 2 seconds.
6. **Result Interpretation:**
   - **✓ Tag Read Successfully:** The tag is a compatible 13.56 MHz NFC/NDEF chip. The serial number is displayed. These tags can be immediately enrolled in `/admin`.
   - **Tag Incompatible with Browser / No Reaction:** The tag is a legacy 125 kHz RFID button (e.g. EM4100 or Dallas iButton). Use the high-contrast printed QR checkpoint cards, or procure compatible 13.56 MHz NTAG discs.

---

## 5. Recommended Procurement Specifications

If purchasing new checkpoint tags for the farm perimeter, order the following standard, low-cost commercial specification:

- **Chip Type:** **NXP NTAG213** or **NXP NTAG215**
- **Operating Frequency:** **13.56 MHz**
- **Form Factor:** **30 mm Waterproof On-Metal ABS Disc** (with center screw hole or industrial 3M foam adhesive)
- **Ingress Protection:** **IP68** (Waterproof, dustproof, UV-resistant for outdoor farm fences)
- **Anti-Metal Layer:** **Required** if mounting on steel poles, zinc shed walls, or metal gateposts (metal surfaces detune NFC antennas unless an anti-metal ferrite barrier is included).
- **Approximate Cost:** R15 – R25 per tag (readily available in South Africa from RFID suppliers or online distributors).

---

## 6. Guard Smartphone Hardware Requirements

For security officers assigned to patrol and gate duties:
1. **Operating System:** Android 11.0 or higher.
2. **Browser:** Google Chrome (kept up to date via Play Store).
3. **Rear Camera:** Minimum 8 Megapixels with LED Flashlight / Torch.
4. **Location:** GPS + GLONASS chip with "High Accuracy / Precise Location" enabled.
5. **NFC:** Integrated NFC controller (NXP or Broadcom).
6. **Battery Capacity:** Minimum 5,000 mAh recommended for full 12-hour night shifts.
7. **Protective Casing:** Rugged shockproof silicone case with tempered glass screen protector.
