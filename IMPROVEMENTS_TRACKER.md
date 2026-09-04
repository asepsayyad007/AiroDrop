# AiroDrop UX & Connection Improvements Tracker

This document tracks the specification, implementation, and verification of the 3 UX improvements designed to elevate the AiroDrop mobile onboarding and connection flow to a seamless 5.0 / 5.0 experience.

---

## 📋 Status Overview

| # | Improvement | Platform | Status | Target Files |
|---|---|---|---|---|
| **1** | **Zero-Tap Auto-Connect**<br>Countdown timer (1.5s) with Cancel when exactly 1 PC is discovered | Android, iOS, Desktop | 🟡 Planned / Tracking | `relay-server/pages/installer.html`<br>`relay-server/public/installer.html` |
| **2** | **Animated Safari Pointer**<br>Pulsing downward arrow & tooltip pointing to iOS Safari Share button | iOS (Safari browser) | 🟡 Planned / Tracking | `relay-server/pages/installer.html`<br>`relay-server/public/installer.html` |
| **3** | **Standalone PWA Auto-Detection**<br>Detect installed PWA mode, suppress install banners & fast-track | iOS, Android (Installed PWA) | 🟡 Planned / Tracking | `relay-server/pages/installer.html`<br>`relay-server/public/installer.html`<br>`relay-server/public/mobile-app.js`<br>`public/mobile-app.js` |

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

## 🛠️ Verification Checklist
- [ ] Auto-connect starts smoothly when 1 device is discovered.
- [ ] Clicking "Cancel" stops the countdown and preserves manual connection.
- [ ] Auto-connect is suppressed when 2+ devices are present.
- [ ] Safari pointer appears only on iOS Safari (not on Chrome Android, not in standalone PWA).
- [ ] Safari pointer dismiss button functions properly.
- [ ] In standalone mode (`navigator.standalone` or `display-mode: standalone`), install banners are completely hidden.
- [ ] Remote deployment to `myserver` (`airodrop-relay` container) updated and verified via HTTPS.
