# AiroDrop Legal Documents & Compliance Policy
**Last Updated:** July 17, 2026

This document contains the unified Privacy Policy, Terms of Service, and Data Compliance Statement for the **AiroDrop** application ecosystem.

---

## Part 1: Privacy Policy & Data Compliance

### 1. Core Privacy Guarantee
AiroDrop is engineered with a strict **Local-First, Zero-Data Retention** architecture. Transfers performed over your local Wi-Fi network stay entirely within your Local Area Network (LAN) and are never routed through or stored on external servers.

### 2. Data Handling & Processing Architecture

| Data Type | Processed Locally (LAN)? | Sent to Cloud Relay? | Stored on Server? |
| :--- | :--- | :--- | :--- |
| **Files & Media** | Yes | Only when using Share-to-Friend links | ❌ **No (Streamed in-memory)** |
| **Clipboard Content** | Yes | ❌ No | ❌ **No** |
| **Auth Tokens & Keys** | Yes (Browser LocalStorage) | ❌ No | ❌ **No** |
| **IP Addresses** | Yes (LAN Pairing) | Temporary network socket connection | ❌ **No logs retained** |

### 3. Cloud Relay Sharing (`airodrop-relay`)
When you create a Share-to-Friend link (`/d/:token`):
* **Ephemeral Memory Streaming:** Data streams directly from memory buffer to recipient browser chunks. No file content is written to disk storage on our servers.
* **Automatic Expiration:** Once a share link expires (1h, 6h, or single download completion), memory references are immediately cleared.

### 4. GDPR & CCPA Compliance
* **GDPR (EU):** We adhere to Data Minimization (Art. 5(1)(c)) and Storage Limitation (Art. 5(1)(e)). No user accounts or personal profiling are required.
* **CCPA (USA):** AiroDrop does not sell, rent, or trade personal information to third parties.

---

## Part 2: Terms of Service & Usage Conditions

### 1. Acceptance of Terms
By downloading, accessing, or using AiroDrop (desktop software, PWA mobile web app, or cloud relay services), you agree to be bound by these Terms of Service.

### 2. Proprietary Status & Intellectual Property
* **Ownership:** AiroDrop (including all source code, design assets, and logos) is proprietary software. All rights are reserved by the original creator, Asep Sayyad.
* **Usage Rights:** You are granted a personal, non-exclusive, non-transferable license to run AiroDrop on your personal devices. You may not decompile, reverse-engineer, redistribute, or sell the software without express written consent.

### 3. Permitted Use & Conduct
You agree NOT to:
* Use the cloud relay network to transmit illegal, malicious, or infringing content.
* Attempt to exploit, tamper with, or brute-force device pairing PINs or secret key headers.
* Distribute malware or execute denial-of-service (DoS) attacks against relay endpoints.

### 4. Disclaimer of Warranties
AiroDrop is provided **"AS IS"** and **"AS AVAILABLE"** without warranties of any kind, express or implied. We do not guarantee uninterrupted transfer speeds or zero packet loss on third-party Wi-Fi networks.

### 5. Limitation of Liability
In no event shall the developer or maintainers be liable for any indirect, incidental, or consequential damages arising out of your use or inability to use the software.
