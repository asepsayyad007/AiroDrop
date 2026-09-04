# AiroDrop UX & Connection Improvements Tracker

This document tracks the specification, implementation, and verification of the 3 UX improvements designed to elevate the AiroDrop mobile onboarding and connection flow to a seamless 5.0 / 5.0 experience.

---

## 📋 Status Overview

| # | Improvement | Platform | Status | Target Files |
|---|---|---|---|---|
| **1** | **Zero-Tap Auto-Connect**<br>Countdown timer (1.5s) with Cancel when exactly 1 PC is discovered | Android, iOS, Desktop | 🟢 Implemented & Deployed | `relay-server/pages/installer.html`<br>`relay-server/public/installer.html` |
| **2** | **Animated Safari Pointer**<br>Pulsing downward arrow & tooltip pointing to iOS Safari Share button | iOS (Safari browser) | 🟢 Implemented & Deployed | `relay-server/pages/installer.html`<br>`relay-server/public/installer.html` |
| **3** | **Standalone PWA Auto-Detection**<br>Detect installed PWA mode, suppress install banners & fast-track | iOS, Android (Installed PWA) | 🟢 Implemented & Deployed | `relay-server/pages/installer.html`<br>`relay-server/public/installer.html`<br>`public/mobile-app.js` |
| **4** | **PC IP Change Detection & Warning Window**<br>Detect DHCP IP change, show alert modal with reconnect QR | Windows (PC Dashboard) | 🟢 Implemented | `src/ipMonitor.js`<br>`server.js`<br>`main.js`<br>`public/index.html`<br>`public/app.js` |

---

## 🎯 Detailed Improvement Specifications

### 1. Zero-Tap Auto-Connect
- **Goal**: Eliminate the manual tap on "Connect" when a user scans the QR code at home or in an office where only 1 AiroDrop PC exists.
- **Behavior**:
  - When radar discovery (or last-known host check) detects **exactly 1 online PC**, initiate an automatic **1.5-second countdown**.
  - The Connect button displays an active countdown animation:
    `Connecting in 1.5s... [Cancel]`
  - If the user clicks **[Cancel]**:
    - Abort the timer immediately.
    - Restore the normal static "Connect" button.
    - Set `userCancelledAutoConnect = true` for the session so it does not auto-trigger again unexpectedly.
  - If more than 1 PC is detected at any point:
    - Cancel any active countdown immediately so the user can choose which PC to connect to.
  - If the countdown reaches 0 without interruption:
    - Automatically execute `selectDevice(host, name, pin, proto)`.

---

### 2. Animated Safari Pointer (iOS Safari)
- **Goal**: Guide non-technical iPhone/iPad users directly to Apple's native "Share" button for 1-tap "Add to Home Screen".
- **Behavior**:
  - Detect iOS Safari browser mode:
    `isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)` and `!isStandalone`.
  - Render a frosted glass tooltip at the bottom of the viewport with a gentle bouncing neon arrow pointing down towards the Safari navigation toolbar.
  - Tooltip content:
    *“Tap **Share** (icon) below, then **'Add to Home Screen'** for offline access”*
  - Includes a quick dismiss button `[✕]`.
  - Automatically hidden if dismissed or once connected to a PC.

---

### 3. Standalone PWA Auto-Detection & Fast-Track
- **Goal**: If the user has already installed AiroDrop to their Home Screen and opens it as a standalone app, skip all installation guides and connect instantly.
- **Behavior**:
  - Detect standalone mode:
    `const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;`
  - In standalone mode:
    - Apply `.pwa-standalone` CSS state to `<body>`.
    - Completely hide all install banners, installation cards (`#viewInstall`), and the iOS Safari pointer.
    - Render a sleek `[✓ Installed App]` status pill in the header.
    - Expedite auto-connect (fast-track in 1s) directly to the paired local PC portal.

---

### 4. PC IP Change Detection, Warning Window & Mobile LAN Reconnect
- **Goal**: Alert user when the PC local IP changes due to DHCP reassignment or network switching, display warning window with clean QR code, and automatically reconnect mobile PWA on the new IP while preserving HTTPS for microphone streaming and screen mirroring.
- **Behavior**:
  - **Disk Persistence**: Saves `last_known_ip.json` to userData. On startup, detects if IP changed while AiroDrop was closed or system rebooted.
  - **3s Polling Monitor**: Actively monitors network interfaces and catches live transitions.
  - **PC Warning Window**: Frosted glass dark overlay with glowing amber border, old IP ➔ new IP comparison, pairing PIN, clean QR code (`https://airodrop.site/install`), and Got It / Setup Guide buttons.
  - **Guaranteed Display**: Exposes `ipChangePending` on `GET /api/info` so the modal is never missed on dashboard load or refresh.
  - **HTTPS Preserved**: Mobile UI remains on `https://${ip}:3478/m` for WebRTC mic and screen mirroring.
  - **Mobile Auto-Recovery**: If phone loses connection, `attemptBackgroundLanRecovery()` scans the local subnet on port 3479 and automatically reconnects to the new IP over HTTPS port 3478.

---

## 🛠️ Verification Checklist
- [x] Auto-connect starts smoothly when 1 device is discovered.
- [x] Clicking "Cancel" stops the countdown and preserves manual connection.
- [x] Auto-connect is suppressed when 2+ devices are present.
- [x] Safari pointer appears only on iOS Safari (not on Chrome Android, not in standalone PWA).
- [x] Safari pointer dismiss button functions properly.
- [x] In standalone mode (`navigator.standalone` or `display-mode: standalone`), install banners are completely hidden.
- [x] IP Change Detection persists last known IP on disk (`last_known_ip.json`).
- [x] Startup IP change detection triggers warning modal on PC dashboard.
- [x] `GET /api/info` delivers `ipChangePending` so dashboard refresh shows modal reliably.
- [x] Dismissing modal calls `POST /api/settings/acknowledge-ip-change` to clear pending alert.
- [x] Mobile UI preserves HTTPS on port 3478 for WebRTC mic and screen mirroring.
- [x] Subnet scan automatically detects PC on new IP and reconnects mobile phone.
- [x] Remote deployment to `myserver` (`airodrop-relay` container) updated and verified via HTTPS.
