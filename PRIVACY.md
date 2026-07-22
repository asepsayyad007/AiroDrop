# AiroDrop — Privacy Policy & Data Compliance

**Effective Date:** July 17, 2026  
**Core Promise:** **Zero Personal Data Collection. Zero Storage. Local First Privacy.**

---

## 1. Local Network Privacy (LAN)
AiroDrop is built from the ground up to operate over your Local Area Network (LAN):
- All local file transfers, clipboard syncs, trackpad events, and camera streams move directly between your mobile device and PC over private Wi-Fi IPs (e.g., `192.168.x.x`).
- Authentication tokens are stored in your browser's `localStorage` and on the PC in a local `paired_devices.json` file. They are never transmitted to external servers.
- No telemetry analytics, trackers, or user identity logs are collected.

---

## 2. Ephemeral Cloud Relay (`airodrop-relay`)
When generating Share-to-Friend links:
- **Zero Disk Retention:** Files stream directly through in-memory chunk buffers from sender PC to recipient browser. No file content is written to server hard drives.
- **Automatic Cleanup:** Once a share link expires (1h, 6h, or single download), memory buffer references are permanently cleared.

---

## 3. GDPR & CCPA Statement
- **GDPR (EU):** Compliant with Data Minimization (Art. 5(1)(c)) and Storage Limitation (Art. 5(1)(e)). No user accounts or personal profiles exist.
- **CCPA (USA):** We do not sell, rent, or share personal information with third parties.

---

## 4. Contact
For security disclosures or questions, visit [Creator Portfolio](https://bootstrapx007.online/).
