# AiroDrop v4.8.8 🚀

A beautiful, self-hosted local network alternative to Apple's AirDrop and Universal Clipboard. AiroDrop allows you to seamlessly transfer text, links, images, and files between iOS/Android devices and your Windows PC over Wi-Fi — plus remote control your PC and stream your screen directly to your mobile webapp.

![Version](https://img.shields.io/badge/version-4.8.8-orange.svg?style=flat-square)
![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-blue.svg?style=flat-square&logo=node.js)
![Platform Support](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey.svg?style=flat-square)
![iOS Shortcuts](https://img.shields.io/badge/iOS%20Shortcuts-Supported-red.svg?style=flat-square&logo=shortcuts)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

---

## ⚡ Highlighted Feature: Instant Clipboard Sync

> [!IMPORTANT]
> **Text or images sent from your iPhone Shortcut are automatically synced with your PC clipboard. Just share/send on your iPhone and instantly paste (Ctrl+V) wherever you want on your PC!**

---

## 🚀 What's New in v4.8.8

This release brings version 4.8.8, wrapping up auto-update fixes and version configurations:

### ✅ New Features & Updates
1. **🚀 Instant Range-Based Video Streaming** — Added high-performance range-seeking media handlers. Buffering is now instant even for large video files.
2. **🔄 Integrated Auto-Updates** — Checks for updates on startup natively via GitHub Releases. Added check buttons in both the Settings Modal and the Windows system tray.
3. **📁 Direct File Stream Uploads** — Upgraded the chunked upload pipeline to pipe request streams directly to disk, avoiding memory constraints.
4. **🔒 iOS Iframe Download Sandbox Fix** — Triggered Blob downloads in a new tab context (`_blank`) to prevent parent iframe refreshes.
5. **💬 Clean Update Dialog Alerts** — Simplified all Electron update check prompts and alerts to short message notifications.

---

## 📥 Downloads (v4.8.8)

Get the latest pre-compiled binaries for Windows:
* **[Download Setup Installer (v4.8.8)](https://github.com/asepsayyad007/AiroDrop/releases/download/v4.8.8/AiroDrop.Setup.4.8.8.exe)** — Standard Windows wizard installation.
* **[Download Portable Version (v4.8.8)](https://github.com/asepsayyad007/AiroDrop/releases/download/v4.8.8/AiroDrop-Portable-4.8.8.exe)** — Standalone execution without installation.

---

## How It Works

* **Instant Clipboard Sync:** Copying text or sharing images on your phone pushes them to your PC's clipboard (Ctrl+V) instantly. Shared links from Safari/Chrome have clean URLs extracted automatically.
* **Bi-directional Queue:** Push links or text snippets from your PC dashboard to the mobile portal inbox, or download files directly onto your phone.
* **File Browser:** Open `http://<PC-IP>:<PORT>/files` in Safari to browse, upload, download, and manage files on your PC's shared folder.
* **Live Screencast:** Tap "Open Live Screen" on the mobile portal to stream your PC desktop at ~15fps with optional interactive mouse control.

---

## Core Features

* **⚡ Auto Clipboard Sync (iPhone → PC):** Text or images sent from your iPhone Shortcut are automatically synced with your PC clipboard. Just send on iPhone and paste (Ctrl+V) where you want.
* **📁 HTTP File Browser:** Premium mobile-first file manager served at `/files`. Browse, upload (up to 4 GB), download, rename, delete, create folders. Works in any browser — no app required.
* **📁 Files App SMB Integration:** Expose your shared folders using native Windows SMB. Connect directly via the iOS Files app &rarr; Connect to Server &rarr; `smb://[YOUR-PC-IP]` for full file browser access natively.
* **🖱️ Remote Trackpad & Keyboard:** Full touchpad gesture support: move cursor, left/right click, double-click, 2-finger scroll, and real-time keyboard typing sync.
* **🖥️ Live PC Screencast:** Stream your PC desktop to your phone at ~15fps. Interactive mode lets you tap and drag directly on the stream to control your PC.
* **🔌 Universal Connection:** Unified connection state management. Connect on portal load, with auto-reconnect fallback and status indicators.
* **🛠️ PC Remote Control Utilities:** Lock your PC, trigger Sleep mode, or perform a clean Power Off directly from your phone.
* **📊 Statistics & Storage Metrics:** Monitor total uploads, file counts, server uptime, and storage limits.
* **🔒 Security PIN Lock:** Optional Access PIN lock screen to protect your sharing dashboard on shared local networks.
* **🔔 Desktop Notifications:** Native bubble/banner notifications alert you when text, links, or images are received.
* **📱 Native-grade PWA (Progressive Web App):** Add to Home Screen on iOS and Android. Offline fallback and service worker caching.
* **🎨 5 Distinct Themes:** Sunset (default), Dark, AMOLED, Nord, and Dracula.

---

## Prerequisites

* Both your PC and mobile device must be connected to the same local network subnet (Wi-Fi).
* **Node.js v18.0.0** or higher installed on your PC.

---

## Installation & Setup (Developer Mode)

To run or modify the app locally:

1. **Clone this repository:**
   ```bash
   git clone https://github.com/asepsayyad007/AiroDrop.git
   cd AiroDrop
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Run in Development Mode:**
   ```bash
   npm start
   ```

*To package the application into standalone installers (`.exe` or portable), see the [Build Instructions Guide.md](Build%20Instructions%20Guide.md).*

---

## 📁 Using the File Browser & Files App (SMB)

### Option 1: Native iOS Files App (SMB)
1. Right-click your shared folder on Windows &rarr; **Properties** &rarr; **Sharing** &rarr; Click **Share** and add your user account with Read/Write permission.
2. Open the native **Files app** on your iPhone.
3. Tap the **•••** icon at the top right &rarr; select **Connect to Server**.
4. Enter the SMB path: `smb://<YOUR-PC-IP>` (obtained from the dashboard).
5. Choose **Registered User**, enter your Windows username and password, and tap **Connect**.

### Option 2: Web File Browser
1. Open the AiroDrop PC dashboard &rarr; click **"Setup / Connect"** &rarr; go to the **"Files App / Browser"** tab to see your URL.
2. On your iPhone/Android, open **Safari or Chrome** and navigate to: `http://<YOUR-PC-IP>:<PORT>/files`
3. Browse your PC's shared folder, tap any file to **download** it to your phone, or tap **＋** to **upload** files.
4. Long-press any file/folder for rename and delete options.

---

## 🖥️ Using Live Screencast

1. On your phone, open the mobile portal &rarr; scroll to **PC Live Screen** &rarr; tap **"📺 Open Live Screen"**.
2. If PC services are not connected, the page will auto-connect for you in the background.
3. The fullscreen overlay opens with a live ~15fps stream of your PC desktop.
4. Toggle **"👁️ View Only"** &rarr; **"🖱️ Interactive"** to enable tap-to-click and drag-to-move-mouse control.

---

## iOS Shortcuts Configuration

Easily share content directly from any iOS App Share Sheet or Home Screen widget.

### Shortcut 1: "Send to PC" (Share Sheet)
**Quick Install Link:** [Get Share to PC Shortcut](https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d)

### Shortcut 2: "Send Clipboard" (Home Screen Widget)
**Quick Install Link:** [Get Clipboard Shortcut](https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b)

### 📲 Quick Install QR Codes
| 1. Share to PC | 2. Send Clipboard |
| :-: | :-: |
| ![Share to PC](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/efd4af984d884e0eb8e8ba3ba319ce4d) | ![Send Clipboard](https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://www.icloud.com/shortcuts/1f341cd7a57041958a87ce92f8acaa8b) |

---

## Configuration (`config.json`)

Settings are stored in `<App Data Directory>/AiroDrop/config.json`. Key configuration parameters:

* `port`: Server listening port (default: `3478`).
* `deviceName`: The hostname shown to mobile clients.
* `rateLimitEnabled`: Enable connection rate limiting (default: `true`).
* `notificationsEnabled`: Trigger Windows desktop alerts for incoming transfers (default: `true`).
* `temporaryMode`: Discard session files automatically after client disconnects (default: `false`).
* `saveDir`: Target download path for transferred items.
* `shareDir`: Root shared path exposed to the HTTP File Browser.

---

## 🛠️ Credits & Authors

AiroDrop is created and maintained by **[Asep Sayyad](https://github.com/asepsayyad007)**.

---

## License

This project is licensed under the MIT License.
